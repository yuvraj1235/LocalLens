/**
 * src/ocr/ocrEngine.ts
 *
 * Local, on-device OCR engine for the privacy-preserving browser agent.
 *
 * Pipeline:
 *   Screenshot (canvas/ImageBitmap)
 *       -> Text Detection (DB-style probability map, PP-OCR-detector compatible)
 *       -> Region extraction + connected-component -> axis-aligned boxes
 *       -> Text Recognition (CTC-based recognizer, PP-OCR-rec compatible)
 *       -> { text, bbox, confidence }[]
 *
 * Design goals (per ISRO project spec):
 *   - Runs 100% locally via ONNX Runtime Web (WebGPU, falls back to WASM)
 *   - No raw text/image ever leaves the device from this module
 *   - Cheap enough to run inside an adaptive-inference cascade (see
 *     src/adaptive/adaptiveInference.ts), so this module does NOT decide
 *     when to run — it just runs efficiently when asked to.
 *   - Output matches the unified perception contract used by
 *     src/fusion/bboxFusion.ts and src/fusion/screenUnderstanding.ts.
 *
 * NOTE: Detection post-processing here uses a simplified DB (Differentiable
 * Binarization) decode — binarize -> connected components -> axis-aligned
 * box + unclip padding. It intentionally skips rotated min-area-rect boxes
 * for v1 (most web UI text is horizontal). Track rotated-text support as a
 * follow-up (see TODO near `regionsFromProbabilityMap`).
 */

import * as ort from 'onnxruntime-web';

// ---------------------------------------------------------------------------
// Public types (align with the Phase 1 output contract / uiGraph schema)
// ---------------------------------------------------------------------------

export interface OCRResult {
  /** Recognized text (already local — never sent raw to the server). */
  text: string;
  /** Axis-aligned bounding box in source-image pixel coords: [x0, y0, x1, y1]. */
  bbox: [number, number, number, number];
  /** Recognition confidence, 0..1 (mean of per-char max softmax probs). */
  confidence: number;
  /** Detector confidence for the region itself, 0..1. */
  detectionScore: number;
}

export interface OCREngineConfig {
  /** URL/path to the ONNX text-detection model (e.g. PP-OCRv5 det, exported). */
  detModelUrl: string;
  /** URL/path to the ONNX text-recognition model (e.g. PP-OCRv5 rec, exported). */
  recModelUrl: string;
  /** URL/path to a newline-delimited character dictionary for CTC decoding. */
  charDictUrl: string;
  /** Explicit execution providers; if omitted, WebGPU is tried then WASM. */
  executionProviders?: ort.InferenceSession.ExecutionProviderConfig[];
  /** Longer side the input image is resized to before detection. */
  detInputSize?: number;
  /** Fixed height the recognizer expects (PP-OCR default is 48). */
  recInputHeight?: number;
  /** Max width fed to the recognizer per crop (wider crops are downscaled). */
  recMaxWidth?: number;
  /** Probability threshold to binarize the detector's prob map. */
  dbThresh?: number;
  /** Minimum average region score to keep a detected box. */
  dbBoxThresh?: number;
  /** Fractional padding applied around each detected region before crop. */
  unclipRatio?: number;
  /** Hard cap on number of regions processed per call (perf guard). */
  maxCandidates?: number;
  /** Minimum pixel area for a detected region to be kept (noise filter). */
  minRegionArea?: number;
}

const DEFAULTS: Required<
  Pick<
    OCREngineConfig,
    | 'detInputSize'
    | 'recInputHeight'
    | 'recMaxWidth'
    | 'dbThresh'
    | 'dbBoxThresh'
    | 'unclipRatio'
    | 'maxCandidates'
    | 'minRegionArea'
  >
> = {
  detInputSize: 960,
  recInputHeight: 48,
  recMaxWidth: 320,
  dbThresh: 0.3,
  dbBoxThresh: 0.6,
  unclipRatio: 1.5,
  maxCandidates: 300,
  minRegionArea: 24,
};

const CTC_BLANK_INDEX = 0;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface RawRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  score: number;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * 4-connected component labeling over a binary mask, returning bounding
 * boxes + mean probability per component. Runs on typed arrays only —
 * no external CV dependency, safe for a browser extension bundle.
 */
function connectedComponents(
  binary: Uint8Array,
  probMap: Float32Array,
  width: number,
  height: number,
  minArea: number
): RawRegion[] {
  const visited = new Uint8Array(width * height);
  const regions: RawRegion[] = [];
  const stackX = new Int32Array(width * height);
  const stackY = new Int32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (binary[idx] === 0 || visited[idx]) continue;

      let sp = 0;
      stackX[sp] = x;
      stackY[sp] = y;
      sp++;
      visited[idx] = 1;

      let minX = x, maxX = x, minY = y, maxY = y;
      let sumProb = 0;
      let count = 0;

      while (sp > 0) {
        sp--;
        const cx = stackX[sp];
        const cy = stackY[sp];
        const cIdx = cy * width + cx;

        sumProb += probMap[cIdx];
        count++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const neighbors: Array<[number, number]> = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (binary[nIdx] === 1 && !visited[nIdx]) {
            visited[nIdx] = 1;
            stackX[sp] = nx;
            stackY[sp] = ny;
            sp++;
          }
        }
      }

      const area = count;
      if (area < minArea) continue;

      regions.push({
        x0: minX,
        y0: minY,
        x1: maxX + 1,
        y1: maxY + 1,
        score: sumProb / count,
      });
    }
  }

  return regions;
}

/** Expands a box outward by `ratio` of its own size (approximate "unclip"). */
function unclipBox(r: RawRegion, ratio: number, maxW: number, maxH: number): RawRegion {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const padX = (w * (ratio - 1)) / 2;
  const padY = (h * (ratio - 1)) / 2;
  return {
    x0: Math.max(0, Math.floor(r.x0 - padX)),
    y0: Math.max(0, Math.floor(r.y0 - padY)),
    x1: Math.min(maxW, Math.ceil(r.x1 + padX)),
    y1: Math.min(maxH, Math.ceil(r.y1 + padY)),
    score: r.score,
  };
}

// ---------------------------------------------------------------------------
// OCREngine
// ---------------------------------------------------------------------------

export class OCREngine {
  private detSession: ort.InferenceSession | null = null;
  private recSession: ort.InferenceSession | null = null;
  private charDict: string[] = [];
  private readonly config: OCREngineConfig & typeof DEFAULTS;
  private ready = false;

  constructor(config: OCREngineConfig) {
    this.config = { ...DEFAULTS, ...config };
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Loads both ONNX sessions and the char dictionary. Call once at startup. */
  async initialize(): Promise<void> {
    if (this.ready) return;

    const executionProviders =
      this.config.executionProviders ?? (await this.resolveExecutionProviders());

    const sessionOptions: ort.InferenceSession.SessionOptions = {
      executionProviders,
      graphOptimizationLevel: 'all',
    };

    const [detSession, recSession, charDict] = await Promise.all([
      ort.InferenceSession.create(this.config.detModelUrl, sessionOptions),
      ort.InferenceSession.create(this.config.recModelUrl, sessionOptions),
      this.loadCharDict(this.config.charDictUrl),
    ]);

    this.detSession = detSession;
    this.recSession = recSession;
    this.charDict = charDict;
    this.ready = true;
  }

  /** Frees ONNX runtime resources. Call on extension teardown / model swap. */
  async dispose(): Promise<void> {
    await this.detSession?.release();
    await this.recSession?.release();
    this.detSession = null;
    this.recSession = null;
    this.ready = false;
  }

  /**
   * Runs the full detect -> crop -> recognize pipeline on a canvas.
   * `source` should already be the region of interest (e.g. viewport
   * screenshot) — this module does no capture, only perception.
   */
  async run(source: HTMLCanvasElement | OffscreenCanvas): Promise<OCRResult[]> {
    if (!this.ready || !this.detSession || !this.recSession) {
      throw new Error('OCREngine.initialize() must be awaited before run().');
    }

    const srcCtx = source.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!srcCtx) throw new Error('OCREngine: unable to acquire 2D context from source canvas.');

    const srcWidth = source.width;
    const srcHeight = source.height;

    const regions = await this.detectRegions(srcCtx, srcWidth, srcHeight);
    if (regions.length === 0) return [];

    const capped = regions
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.maxCandidates);

    const results: OCRResult[] = [];
    for (const region of capped) {
      const crop = this.cropRegion(srcCtx, region);
      if (!crop) continue;
      const { text, confidence } = await this.recognizeCrop(crop);
      if (!text) continue;
      results.push({
        text,
        bbox: [region.x0, region.y0, region.x1, region.y1],
        confidence,
        detectionScore: region.score,
      });
    }

    // Reading order: top-to-bottom, then left-to-right within a row band.
    results.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
    return results;
  }

  // -------------------------------------------------------------------
  // Detection stage
  // -------------------------------------------------------------------

  private async detectRegions(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    srcWidth: number,
    srcHeight: number
  ): Promise<RawRegion[]> {
    const target = this.config.detInputSize;
    const scale = target / Math.max(srcWidth, srcHeight);
    const resizedW = Math.max(32, Math.round((srcWidth * scale) / 32) * 32);
    const resizedH = Math.max(32, Math.round((srcHeight * scale) / 32) * 32);

    const imageData = ctx.getImageData(0, 0, srcWidth, srcHeight);
    const tensor = this.imageDataToDetTensor(imageData, resizedW, resizedH);

    const feeds: Record<string, ort.Tensor> = { x: tensor };
    const outputs = await this.detSession!.run(feeds);
    const probTensor = outputs[Object.keys(outputs)[0]];
    const probData = probTensor.data as Float32Array;
    const [, , outH, outW] = probTensor.dims as number[];

    const binary = new Uint8Array(outW * outH);
    for (let i = 0; i < probData.length; i++) {
      binary[i] = probData[i] > this.config.dbThresh ? 1 : 0;
    }

    // TODO(rotated-text): swap connectedComponents + axis-aligned box for a
    // min-area-rect contour method once rotated/vertical UI text matters.
    const rawRegions = connectedComponents(
      binary,
      probData,
      outW,
      outH,
      this.config.minRegionArea
    ).filter((r) => r.score >= this.config.dbBoxThresh);

    const scaleX = srcWidth / outW;
    const scaleY = srcHeight / outH;

    return rawRegions
      .map((r) => ({
        x0: r.x0 * scaleX,
        y0: r.y0 * scaleY,
        x1: r.x1 * scaleX,
        y1: r.y1 * scaleY,
        score: r.score,
      }))
      .map((r) => unclipBox(r, this.config.unclipRatio, srcWidth, srcHeight));
  }

  private imageDataToDetTensor(
    imageData: ImageData,
    resizedW: number,
    resizedH: number
  ): ort.Tensor {
    const off = new OffscreenCanvas(resizedW, resizedH);
    const offCtx = off.getContext('2d')!;
    const tmp = new OffscreenCanvas(imageData.width, imageData.height);
    const tmpCtx = tmp.getContext('2d')!;
    tmpCtx.putImageData(imageData, 0, 0);
    offCtx.drawImage(tmp, 0, 0, resizedW, resizedH);
    const resized = offCtx.getImageData(0, 0, resizedW, resizedH);

    // NCHW, normalized to ImageNet-style mean/std (PP-OCR-det convention).
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    const chw = new Float32Array(3 * resizedW * resizedH);
    const plane = resizedW * resizedH;

    for (let i = 0; i < plane; i++) {
      const r = resized.data[i * 4] / 255;
      const g = resized.data[i * 4 + 1] / 255;
      const b = resized.data[i * 4 + 2] / 255;
      chw[i] = (r - mean[0]) / std[0];
      chw[plane + i] = (g - mean[1]) / std[1];
      chw[plane * 2 + i] = (b - mean[2]) / std[2];
    }

    return new ort.Tensor('float32', chw, [1, 3, resizedH, resizedW]);
  }

  // -------------------------------------------------------------------
  // Recognition stage
  // -------------------------------------------------------------------

  private cropRegion(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    region: RawRegion
  ): ImageData | null {
    const w = Math.round(region.x1 - region.x0);
    const h = Math.round(region.y1 - region.y0);
    if (w <= 0 || h <= 0) return null;
    try {
      return ctx.getImageData(Math.round(region.x0), Math.round(region.y0), w, h);
    } catch {
      // Region fell outside the canvas bounds (e.g. due to rounding) — skip it.
      return null;
    }
  }

  private async recognizeCrop(
    crop: ImageData
  ): Promise<{ text: string; confidence: number }> {
    const targetH = this.config.recInputHeight;
    const aspect = crop.width / crop.height;
    const targetW = Math.min(this.config.recMaxWidth, Math.max(8, Math.round(targetH * aspect)));

    const off = new OffscreenCanvas(targetW, targetH);
    const offCtx = off.getContext('2d')!;
    const tmp = new OffscreenCanvas(crop.width, crop.height);
    const tmpCtx = tmp.getContext('2d')!;
    tmpCtx.putImageData(crop, 0, 0);
    offCtx.drawImage(tmp, 0, 0, targetW, targetH);
    const resized = offCtx.getImageData(0, 0, targetW, targetH);

    // PP-OCR-rec normalization: (pixel/255 - 0.5) / 0.5, grayscale-ish RGB kept.
    const chw = new Float32Array(3 * targetW * targetH);
    const plane = targetW * targetH;
    for (let i = 0; i < plane; i++) {
      const r = resized.data[i * 4] / 255;
      const g = resized.data[i * 4 + 1] / 255;
      const b = resized.data[i * 4 + 2] / 255;
      chw[i] = (r - 0.5) / 0.5;
      chw[plane + i] = (g - 0.5) / 0.5;
      chw[plane * 2 + i] = (b - 0.5) / 0.5;
    }

    const tensor = new ort.Tensor('float32', chw, [1, 3, targetH, targetW]);
    const feeds: Record<string, ort.Tensor> = { x: tensor };
    const outputs = await this.recSession!.run(feeds);
    const logits = outputs[Object.keys(outputs)[0]];
    const data = logits.data as Float32Array;
    const [, seqLen, numClasses] = logits.dims as number[];

    return this.ctcGreedyDecode(data, seqLen, numClasses);
  }

  private ctcGreedyDecode(
    data: Float32Array,
    seqLen: number,
    numClasses: number
  ): { text: string; confidence: number } {
    let text = '';
    let lastIndex = -1;
    let probSum = 0;
    let charCount = 0;

    for (let t = 0; t < seqLen; t++) {
      const offset = t * numClasses;
      let bestIdx = 0;
      let bestVal = data[offset];
      for (let c = 1; c < numClasses; c++) {
        const v = data[offset + c];
        if (v > bestVal) {
          bestVal = v;
          bestIdx = c;
        }
      }

      if (bestIdx !== CTC_BLANK_INDEX && bestIdx !== lastIndex) {
        const ch = this.charDict[bestIdx - 1]; // dict excludes the blank slot
        if (ch) {
          text += ch;
          probSum += sigmoid(bestVal);
          charCount++;
        }
      }
      lastIndex = bestIdx;
    }

    return {
      text,
      confidence: charCount > 0 ? probSum / charCount : 0,
    };
  }

  // -------------------------------------------------------------------
  // Setup helpers
  // -------------------------------------------------------------------

  private async resolveExecutionProviders(): Promise<
    ort.InferenceSession.ExecutionProviderConfig[]
  > {
    const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
    return hasWebGPU ? ['webgpu', 'wasm'] : ['wasm'];
  }

  private async loadCharDict(url: string): Promise<string[]> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`OCREngine: failed to load char dictionary from ${url} (${res.status})`);
    }
    const text = await res.text();
    return text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
  }
}

export default OCREngine;
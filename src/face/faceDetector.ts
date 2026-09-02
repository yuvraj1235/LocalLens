/**
 * Phase 5 — Face Detection
 *
 * Wraps YuNet, following the widely-used OpenCV Zoo export
 * (face_detection_yunet_2023mar.onnx and compatible variants). This
 * detector is anchor/prior-box based across 4 feature map strides.
 *
 * Expected model I/O (verify against your actual .onnx with Netron —
 * tensor names below match the OpenCV Zoo export; adjust the constants
 * in MODEL_IO if yours differ):
 *
 *   input:  "input"  -> float32 [1, 3, H, W], BGR, not normalized (raw 0-255)
 *   outputs (one per stride, 4 strides -> 12 tensors total):
 *     "cls_8", "obj_8", "bbox_8", "kps_8"     (stride 8)
 *     "cls_16","obj_16","bbox_16","kps_16"    (stride 16)
 *     "cls_32","obj_32","bbox_32","kps_32"    (stride 32)
 *     "cls_64","obj_64","bbox_64","kps_64"    (stride 64)
 *
 *   cls_*  -> [1, N, 1]  face classification logit (needs sigmoid)
 *   obj_*  -> [1, N, 1]  objectness logit (needs sigmoid)
 *   bbox_* -> [1, N, 4]  box regression (cx, cy, w, h offsets against the prior)
 *   kps_*  -> [1, N, 10] 5 facial landmarks (unused here, we only need bbox)
 *
 * Final face score = sqrt(sigmoid(cls) * sigmoid(obj)), matching YuNet's
 * own postprocessing.
 *
 * Model placement: /models/yunet.onnx
 */

import * as ort from "onnxruntime-web";
import { getSession } from "../runtime/onnxRuntime.js";
import type { DetectedFace } from "../schema/uiGraph.js";

const YUNET_MODEL_PATH = "/models/yunet.onnx";
const INPUT_NAME = "input";
const INPUT_W = 320;
const INPUT_H = 320;

const STRIDES = [8, 16, 32, 64];
// One prior box size (in input-pixel units) per stride, matching the
// OpenCV Zoo YuNet 2023mar config. If your export was trained/exported
// with different anchor sizes, update this to match.
const MIN_SIZES: Record<number, number[]> = {
  8: [10, 16, 24],
  16: [32, 48],
  32: [64, 96],
  64: [128, 192, 256],
};

export interface FaceDetectionOptions {
  confidenceThreshold?: number;
  iouThreshold?: number;
}

export async function runFaceDetection(
  image: ImageData,
  options: FaceDetectionOptions = {}
): Promise<DetectedFace[]> {
  const confidenceThreshold = options.confidenceThreshold ?? 0.6;
  const iouThreshold = options.iouThreshold ?? 0.3;

  const session = await getSession("yunet", YUNET_MODEL_PATH);

  const { tensor, scaleX, scaleY } = preprocess(image, INPUT_W, INPUT_H);
  const output = await session.run({ [INPUT_NAME]: tensor });

  const priors = generatePriors(INPUT_W, INPUT_H, STRIDES, MIN_SIZES);
  const candidates = decode(output, priors, confidenceThreshold);
  const kept = nonMaxSuppression(candidates, iouThreshold);

  return kept.map((c, idx) => ({
    id: `face_${idx}`,
    confidence: c.confidence,
    bbox: [
      c.bbox[0] / scaleX,
      c.bbox[1] / scaleY,
      c.bbox[2] / scaleX,
      c.bbox[3] / scaleY,
    ] as [number, number, number, number],
  }));
}

// ---------------------------------------------------------------------------
// Preprocessing: resize to fixed input size, BGR, no normalization (raw 0-255)
// ---------------------------------------------------------------------------

interface PreprocessResult {
  tensor: ort.Tensor;
  scaleX: number;
  scaleY: number;
}

function preprocess(image: ImageData, targetW: number, targetH: number): PreprocessResult {
  const { width: srcW, height: srcH, data: srcData } = image;
  const scaleX = targetW / srcW;
  const scaleY = targetH / srcH;

  const out = new Float32Array(3 * targetW * targetH);

  for (let y = 0; y < targetH; y++) {
    const srcY = Math.min(srcH - 1, Math.floor(y / scaleY));
    for (let x = 0; x < targetW; x++) {
      const srcX = Math.min(srcW - 1, Math.floor(x / scaleX));
      const srcIdx = (srcY * srcW + srcX) * 4;

      const r = srcData[srcIdx];
      const g = srcData[srcIdx + 1];
      const b = srcData[srcIdx + 2];

      const chwBase = y * targetW + x;
      // BGR order to match OpenCV-trained YuNet
      out[0 * targetW * targetH + chwBase] = b;
      out[1 * targetW * targetH + chwBase] = g;
      out[2 * targetW * targetH + chwBase] = r;
    }
  }

  const tensor = new ort.Tensor("float32", out, [1, 3, targetH, targetW]);
  return { tensor, scaleX, scaleY };
}

// ---------------------------------------------------------------------------
// Prior box generation (one prior per (grid cell, anchor size) per stride)
// ---------------------------------------------------------------------------

interface Prior {
  cx: number;
  cy: number;
  size: number;
}

function generatePriors(
  inputW: number,
  inputH: number,
  strides: number[],
  minSizes: Record<number, number[]>
): Prior[] {
  const priors: Prior[] = [];

  for (const stride of strides) {
    const gridW = Math.ceil(inputW / stride);
    const gridH = Math.ceil(inputH / stride);
    const sizes = minSizes[stride];

    for (let gy = 0; gy < gridH; gy++) {
      for (let gx = 0; gx < gridW; gx++) {
        for (const size of sizes) {
          priors.push({
            cx: (gx + 0.5) * stride,
            cy: (gy + 0.5) * stride,
            size,
          });
        }
      }
    }
  }

  return priors;
}

// ---------------------------------------------------------------------------
// Decode: sigmoid(cls) * sigmoid(obj) for score, apply box regression to prior
// ---------------------------------------------------------------------------

interface Candidate {
  bbox: [number, number, number, number]; // x, y, w, h in INPUT_W/H pixel space
  confidence: number;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function decode(
  output: ort.InferenceSession.OnnxValueMapType,
  priors: Prior[],
  confidenceThreshold: number
): Candidate[] {
  const candidates: Candidate[] = [];
  let priorOffset = 0;

  for (const stride of STRIDES) {
    const cls = output[`cls_${stride}`];
    const obj = output[`obj_${stride}`];
    const bbox = output[`bbox_${stride}`];

    if (!cls || !obj || !bbox) {
      throw new Error(
        `Missing YuNet output tensors for stride ${stride}. Got: ${Object.keys(output).join(", ")}. ` +
          `Check your model's actual tensor names with Netron and update faceDetector.ts.`
      );
    }

    const clsData = cls.data as Float32Array;
    const objData = obj.data as Float32Array;
    const bboxData = bbox.data as Float32Array;
    const n = cls.dims[1]; // number of priors for this stride

    for (let i = 0; i < n; i++) {
      const prior = priors[priorOffset + i];
      const score = Math.sqrt(sigmoid(clsData[i]) * sigmoid(objData[i]));
      if (score < confidenceThreshold) continue;

      // Box regression: offsets are relative to the prior's center/size
      const dx = bboxData[i * 4 + 0];
      const dy = bboxData[i * 4 + 1];
      const dw = bboxData[i * 4 + 2];
      const dh = bboxData[i * 4 + 3];

      const cx = prior.cx + dx * prior.size;
      const cy = prior.cy + dy * prior.size;
      const w = Math.exp(dw) * prior.size;
      const h = Math.exp(dh) * prior.size;

      candidates.push({
        bbox: [cx - w / 2, cy - h / 2, w, h],
        confidence: score,
      });
    }

    priorOffset += n;
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// NMS (single class: face)
// ---------------------------------------------------------------------------

function toXyxy(box: [number, number, number, number]): [number, number, number, number] {
  const [x, y, w, h] = box;
  return [x, y, x + w, y + h];
}

function iouXyxy(a: [number, number, number, number], b: [number, number, number, number]): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);

  const interArea = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  const unionArea = areaA + areaB - interArea;

  return unionArea <= 0 ? 0 : interArea / unionArea;
}

function nonMaxSuppression(candidates: Candidate[], iouThreshold: number): Candidate[] {
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const xyxyBoxes = sorted.map((c) => toXyxy(c.bbox));
  const suppressed = new Array(sorted.length).fill(false);
  const kept: Candidate[] = [];

  for (let i = 0; i < sorted.length; i++) {
    if (suppressed[i]) continue;
    kept.push(sorted[i]);
    for (let j = i + 1; j < sorted.length; j++) {
      if (suppressed[j]) continue;
      if (iouXyxy(xyxyBoxes[i], xyxyBoxes[j]) > iouThreshold) {
        suppressed[j] = true;
      }
    }
  }

  return kept;
}
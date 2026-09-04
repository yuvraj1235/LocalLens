/**
 * Phase 4 — UI Element Detection
 *
 * Wraps a fine-tuned Ultralytics YOLOv8/YOLO11-style detector trained on
 * web-UI classes. Assumes the model was exported the standard way:
 *
 *   model.export(format="onnx")
 *
 * which produces:
 *   input:  "images"  -> float32 [1, 3, inputSize, inputSize], values in [0,1]
 *   output: "output0" -> float32 [1, 4 + numClasses, numAnchors]
 *           (box in cx,cy,w,h relative to the (letterboxed) input image,
 *            followed by one row of class scores per class, NOT yet
 *            passed through softmax — Ultralytics exports raw sigmoid
 *            logits already applied, so scores are in [0,1])
 *
 * If your export uses different input/output tensor names, update
 * INPUT_NAME / OUTPUT_NAME below to match (check with Netron on the
 * .onnx file if unsure).
 *
 * Model placement: /models/ui-detector.onnx
 */
import * as ort from "onnxruntime-web";
import { getSession } from "../runtime/onnxRuntime.js";
const UI_DETECTOR_MODEL_PATH = "/models/ui-detector.onnx";
const INPUT_NAME = "images";
const OUTPUT_NAME = "output0";
const INPUT_SIZE = 640; // must match the imgsz used during training/export
// Must match the class order the model was trained with (dataset/README.md).
// Ultralytics assigns class indices by the order they appear in data.yaml —
// keep this array in sync with that file.
const CLASS_NAMES = [
    "button",
    "input",
    "text",
    "checkbox",
    "radio",
    "dropdown",
    "link",
    "icon",
    "image",
    "table",
    "card",
    "modal",
    "navigation",
    "tab",
    "avatar",
];
export async function runUiDetection(image, options = {}) {
    const confidenceThreshold = options.confidenceThreshold ?? 0.4;
    const iouThreshold = options.iouThreshold ?? 0.45;
    const session = await getSession("ui-detector", UI_DETECTOR_MODEL_PATH);
    const { tensor, scale, padX, padY } = preprocess(image, INPUT_SIZE);
    const feeds = { [INPUT_NAME]: tensor };
    const output = await session.run(feeds);
    const raw = output[OUTPUT_NAME];
    if (!raw) {
        throw new Error(`Expected output tensor named "${OUTPUT_NAME}" but got: ${Object.keys(output).join(", ")}. ` +
            `Update OUTPUT_NAME in uiDetector.ts to match your model's actual export.`);
    }
    const candidates = decode(raw, CLASS_NAMES.length, confidenceThreshold);
    const kept = nonMaxSuppression(candidates, iouThreshold);
    // Undo letterbox padding/scaling to map boxes back to original image space
    return kept.map((d) => ({
        type: d.type,
        confidence: d.confidence,
        bbox: unletterbox(d.bbox, scale, padX, padY, image.width, image.height),
    }));
}
function preprocess(image, inputSize) {
    const { width: srcW, height: srcH, data: srcData } = image;
    // Letterbox: scale to fit within inputSize x inputSize, preserving aspect ratio
    const scale = Math.min(inputSize / srcW, inputSize / srcH);
    const resizedW = Math.round(srcW * scale);
    const resizedH = Math.round(srcH * scale);
    const padX = Math.floor((inputSize - resizedW) / 2);
    const padY = Math.floor((inputSize - resizedH) / 2);
    // Resize via nearest-neighbor sampling (fast, adequate for detection input).
    // Swap for bilinear if you need to match training-time preprocessing exactly.
    const resized = new Float32Array(inputSize * inputSize * 3).fill(0.5); // grey padding (114/255 is YOLO's default, using 0.5 as a close approximation)
    for (let y = 0; y < resizedH; y++) {
        const srcY = Math.min(srcH - 1, Math.floor(y / scale));
        for (let x = 0; x < resizedW; x++) {
            const srcX = Math.min(srcW - 1, Math.floor(x / scale));
            const srcIdx = (srcY * srcW + srcX) * 4;
            const dstX = x + padX;
            const dstY = y + padY;
            const r = srcData[srcIdx] / 255;
            const g = srcData[srcIdx + 1] / 255;
            const b = srcData[srcIdx + 2] / 255;
            // CHW layout: channel-major
            const chwBase = dstY * inputSize + dstX;
            resized[0 * inputSize * inputSize + chwBase] = r;
            resized[1 * inputSize * inputSize + chwBase] = g;
            resized[2 * inputSize * inputSize + chwBase] = b;
        }
    }
    const tensor = new ort.Tensor("float32", resized, [1, 3, inputSize, inputSize]);
    return { tensor, scale, padX, padY };
}
function decode(output, numClasses, confidenceThreshold) {
    const dims = output.dims; // [1, 4+numClasses, numAnchors]
    if (dims.length !== 3) {
        throw new Error(`Unexpected output shape [${dims.join(",")}], expected rank 3`);
    }
    const numAttrs = dims[1]; // 4 + numClasses
    const numAnchors = dims[2];
    const data = output.data;
    const candidates = [];
    for (let a = 0; a < numAnchors; a++) {
        // data is laid out attr-major: value(attr, anchor) = data[attr * numAnchors + a]
        const cx = data[0 * numAnchors + a];
        const cy = data[1 * numAnchors + a];
        const w = data[2 * numAnchors + a];
        const h = data[3 * numAnchors + a];
        let bestClassIdx = -1;
        let bestScore = -Infinity;
        for (let c = 0; c < numClasses; c++) {
            const score = data[(4 + c) * numAnchors + a];
            if (score > bestScore) {
                bestScore = score;
                bestClassIdx = c;
            }
        }
        if (bestScore < confidenceThreshold)
            continue;
        candidates.push({
            type: CLASS_NAMES[bestClassIdx] ?? "unknown",
            bbox: [cx, cy, w, h],
            confidence: bestScore,
        });
    }
    return candidates;
}
// ---------------------------------------------------------------------------
// Non-max suppression (class-aware, greedy, standard IoU-based)
// ---------------------------------------------------------------------------
function toXyxy(box) {
    const [cx, cy, w, h] = box;
    return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
}
function iouXyxy(a, b) {
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
function nonMaxSuppression(candidates, iouThreshold) {
    const byClass = new Map();
    for (const c of candidates) {
        const list = byClass.get(c.type) ?? [];
        list.push(c);
        byClass.set(c.type, list);
    }
    const kept = [];
    for (const list of byClass.values()) {
        const sorted = [...list].sort((a, b) => b.confidence - a.confidence);
        const xyxyBoxes = sorted.map((c) => toXyxy(c.bbox));
        const suppressed = new Array(sorted.length).fill(false);
        for (let i = 0; i < sorted.length; i++) {
            if (suppressed[i])
                continue;
            kept.push(sorted[i]);
            for (let j = i + 1; j < sorted.length; j++) {
                if (suppressed[j])
                    continue;
                if (iouXyxy(xyxyBoxes[i], xyxyBoxes[j]) > iouThreshold) {
                    suppressed[j] = true;
                }
            }
        }
    }
    return kept;
}
// ---------------------------------------------------------------------------
// Map a box from letterboxed INPUT_SIZE space back to original image pixels
// ---------------------------------------------------------------------------
function unletterbox(box, scale, padX, padY, origWidth, origHeight) {
    const [cx, cy, w, h] = box;
    const x1 = (cx - w / 2 - padX) / scale;
    const y1 = (cy - h / 2 - padY) / scale;
    const boxW = w / scale;
    const boxH = h / scale;
    const clampedX = Math.max(0, Math.min(x1, origWidth));
    const clampedY = Math.max(0, Math.min(y1, origHeight));
    const clampedW = Math.min(boxW, origWidth - clampedX);
    const clampedH = Math.min(boxH, origHeight - clampedY);
    return [clampedX, clampedY, clampedW, clampedH];
}
export { CLASS_NAMES };

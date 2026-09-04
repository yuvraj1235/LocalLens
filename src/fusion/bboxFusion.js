/**
 * Phase 8 — Bounding-Box Fusion
 *
 * Merges boxes coming from OCR, the UI detector, and face detection into
 * one coherent set: dedupes near-duplicates, corrects for device pixel
 * ratio and scroll offset, and produces stable IDs.
 */
/** Converts a raw pixel-space bbox (from a captured bitmap) into page/document space */
export function toDocumentSpace(bbox, ctx) {
    const [x, y, w, h] = bbox;
    const scale = 1 / ctx.devicePixelRatio;
    return [
        x * scale + ctx.scrollX,
        y * scale + ctx.scrollY,
        w * scale,
        h * scale,
    ];
}
function iou(a, b) {
    const [ax, ay, aw, ah] = a;
    const [bx, by, bw, bh] = b;
    const x1 = Math.max(ax, bx);
    const y1 = Math.max(ay, by);
    const x2 = Math.min(ax + aw, bx + bw);
    const y2 = Math.min(ay + ah, by + bh);
    const interArea = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const unionArea = aw * ah + bw * bh - interArea;
    return unionArea === 0 ? 0 : interArea / unionArea;
}
/**
 * Removes near-duplicate boxes (e.g. the same button detected once by OCR
 * text and once by the UI detector). Keeps the higher-confidence box in
 * each overlapping cluster. Generic over payload type so it works for any
 * of OCR tokens / raw detections / faces.
 */
export function deduplicateBoxes(boxes, iouThreshold = 0.5) {
    const sorted = [...boxes].sort((a, b) => b.confidence - a.confidence);
    const kept = [];
    for (const candidate of sorted) {
        const overlapsKept = kept.some((k) => iou(k.bbox, candidate.bbox) >= iouThreshold);
        if (!overlapsKept)
            kept.push(candidate);
    }
    return kept;
}
let idCounter = 0;
export function nextElementId(prefix = "el") {
    idCounter += 1;
    return `${prefix}_${String(idCounter).padStart(3, "0")}`;
}
export function resetIdCounter() {
    idCounter = 0;
}

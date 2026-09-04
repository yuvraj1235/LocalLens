/**
 * src/bench/benchmark.ts
 *
 * Phase 13 — Evaluation Dashboard (data collection side)
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { analyzeScreen } from "../api/analyzeScreen.js";
// ---------------------------------------------------------------------------
// Bounding box IoU (shared helper)
// ---------------------------------------------------------------------------
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
export function evaluatePii(predicted, groundTruth, iouThreshold = 0.5) {
    const matchedGt = new Set();
    let truePositives = 0;
    for (const pred of predicted) {
        const matchIdx = groundTruth.findIndex((gt, idx) => !matchedGt.has(idx) && gt.type === pred.type && iou(gt.bbox, pred.bbox) >= iouThreshold);
        if (matchIdx !== -1) {
            matchedGt.add(matchIdx);
            truePositives += 1;
        }
    }
    const falsePositives = predicted.length - truePositives;
    const falseNegatives = groundTruth.length - truePositives;
    const precision = truePositives / (truePositives + falsePositives || 1);
    const recall = truePositives / (truePositives + falseNegatives || 1);
    const f1 = (2 * precision * recall) / (precision + recall || 1);
    return { precision, recall, f1, truePositives, falsePositives, falseNegatives };
}
export function evaluateDetections(predicted, groundTruth, iouThreshold = 0.5) {
    const classes = new Set([...predicted.map((p) => p.type), ...groundTruth.map((g) => g.type)]);
    const perClassAP = {};
    const matchedIoUs = [];
    for (const cls of classes) {
        const classPreds = predicted
            .filter((p) => p.type === cls)
            .sort((a, b) => b.confidence - a.confidence);
        const classGt = groundTruth.filter((g) => g.type === cls);
        const matchedGt = new Set();
        let truePositives = 0;
        const precisionAtRank = [];
        const recallAtRank = [];
        for (let i = 0; i < classPreds.length; i++) {
            const pred = classPreds[i];
            const candidates = classGt
                .map((gt, idx) => ({ gt, idx }))
                .filter(({ gt }) => gt.imageId === pred.imageId);
            let bestIoU = 0;
            let bestKey = null;
            for (const { gt, idx } of candidates) {
                const key = `${gt.imageId}:${idx}`;
                if (matchedGt.has(key))
                    continue;
                const overlap = iou(gt.bbox, pred.bbox);
                if (overlap > bestIoU) {
                    bestIoU = overlap;
                    bestKey = key;
                }
            }
            if (bestIoU >= iouThreshold && bestKey) {
                matchedGt.add(bestKey);
                truePositives += 1;
                matchedIoUs.push(bestIoU);
            }
            precisionAtRank.push(truePositives / (i + 1));
            recallAtRank.push(classGt.length === 0 ? 0 : truePositives / classGt.length);
        }
        let ap = 0;
        for (let t = 0; t <= 10; t++) {
            const recallLevel = t / 10;
            const precisionsAtOrAbove = precisionAtRank.filter((_, i) => recallAtRank[i] >= recallLevel);
            ap += (precisionsAtOrAbove.length > 0 ? Math.max(...precisionsAtOrAbove) : 0) / 11;
        }
        perClassAP[cls] = ap;
    }
    const apValues = Object.values(perClassAP);
    const meanAP = apValues.length === 0 ? 0 : apValues.reduce((s, v) => s + v, 0) / apValues.length;
    const meanIoU = matchedIoUs.length === 0 ? 0 : matchedIoUs.reduce((s, v) => s + v, 0) / matchedIoUs.length;
    return { perClassAP, meanAP, meanIoU };
}
export function summarizeLatency(runs) {
    const keys = Object.keys(runs[0]);
    const avg = {};
    for (const key of keys) {
        avg[key] = runs.reduce((sum, r) => sum + r[key], 0) / runs.length;
    }
    return avg;
}
async function loadDataset(imagesDir, annotationsDir) {
    const imageFiles = (await readdir(imagesDir)).filter((f) => /\.(png|jpg|jpeg)$/i.test(f));
    const samples = [];
    for (const file of imageFiles) {
        const imageId = path.basename(file, path.extname(file));
        const annotationPath = path.join(annotationsDir, `${imageId}.json`);
        try {
            const raw = await readFile(annotationPath, "utf-8");
            const annotation = JSON.parse(raw);
            samples.push({ imageId, imagePath: path.join(imagesDir, file), annotation });
        }
        catch {
            console.warn(`Skipping ${file}: no matching annotation at ${annotationPath}`);
        }
    }
    return samples;
}
async function loadImageData(_imagePath) {
    throw new Error("loadImageData not wired up — install the `canvas` package and implement " +
        "this to decode a file into ImageData before running the benchmark for real.");
}
const DUMMY_MODELS = {
    detModelUrl: "./models/det.onnx",
    recModelUrl: "./models/rec.onnx",
    charDictUrl: "./models/dict.txt",
    nerModelUrl: "./models/ner.onnx",
    nerVocabUrl: "./models/vocab.txt",
};
async function main() {
    const imagesDir = path.resolve("dataset/test/images");
    const annotationsDir = path.resolve("dataset/test/annotations");
    let samples;
    try {
        samples = await loadDataset(imagesDir, annotationsDir);
    }
    catch {
        console.log(`No dataset found at ${imagesDir}. Benchmark harness is wired and ready.`);
        return;
    }
    if (samples.length === 0) {
        console.log("Dataset folder found but empty — nothing to benchmark yet.");
        return;
    }
    const allPredictedPii = [];
    const allGtPii = [];
    const allPredictedDetections = [];
    const allGtDetections = [];
    const latencyRuns = [];
    for (const sample of samples) {
        const image = await loadImageData(sample.imagePath);
        const latency = { ocrMs: 0, detectionMs: 0, faceMs: 0, piiMs: 0, fusionMs: 0, totalMs: 0 };
        const graph = await analyzeScreen(image, { force: true, latencyOut: latency, models: DUMMY_MODELS });
        latencyRuns.push(latency);
        for (const el of graph.elements) {
            allPredictedDetections.push({
                type: el.type,
                bbox: el.bbox,
                confidence: el.confidence,
                imageId: sample.imageId,
            });
            if (el.sensitive && el.piiType && el.risk) {
                // Fixed interface signature alignment for FusedPiiResult
                allPredictedPii.push({
                    type: el.piiType,
                    bbox: el.bbox,
                    confidence: el.confidence,
                    risk: el.risk,
                    source: "vision",
                    sources: ["vision"],
                    corroborated: true
                });
            }
        }
        for (const el of sample.annotation.elements) {
            allGtDetections.push({ ...el, imageId: sample.imageId });
        }
        allGtPii.push(...sample.annotation.pii);
    }
    const piiResult = evaluatePii(allPredictedPii, allGtPii);
    const detectionResult = evaluateDetections(allPredictedDetections, allGtDetections);
    const latencySummary = summarizeLatency(latencyRuns);
    console.log("\n=== PII Detection ===");
    console.log(`Precision: ${piiResult.precision.toFixed(3)}  Recall: ${piiResult.recall.toFixed(3)}  F1: ${piiResult.f1.toFixed(3)}`);
    console.log("\n=== UI Detection ===");
    console.log(`mAP@0.5: ${detectionResult.meanAP.toFixed(3)}  Mean IoU (matched): ${detectionResult.meanIoU.toFixed(3)}`);
    for (const [cls, ap] of Object.entries(detectionResult.perClassAP)) {
        console.log(`  ${cls}: AP=${ap.toFixed(3)}`);
    }
    console.log("\n=== Latency (avg ms) ===");
    console.log(`OCR: ${latencySummary.ocrMs.toFixed(1)}  Detection: ${latencySummary.detectionMs.toFixed(1)}  ` +
        `Face: ${latencySummary.faceMs.toFixed(1)}  PII: ${latencySummary.piiMs.toFixed(1)}  ` +
        `Fusion: ${latencySummary.fusionMs.toFixed(1)}  Total: ${latencySummary.totalMs.toFixed(1)}`);
}
main();

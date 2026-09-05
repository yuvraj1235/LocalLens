/**
 * src/api/analyzeScreen.ts
 *
 * Phase 12 — Local Perception API
 */
import { OCREngine } from "../ocr/ocrEngine.js";
import { runUiDetection } from "../detection/uiDetector.js";
import { runFaceDetection } from "../face/faceDetector.js";
import { RegexRuleEngine } from "../pii/regexRules.js";
import { NEREngine } from "../pii/nerEngine.js";
import { fusePII } from "../pii/piiFusion.js";
import { buildUIGraph } from "../fusion/screenUnderstanding.js";
import { createChangeDetectorState, shouldRunFullPipeline, } from "../adaptive/adaptiveInference.js";
const defaultChangeState = createChangeDetectorState();
let lastGraph = null;
// Singleton engine instances to preserve loaded ONNX models in memory
let ocrEngine = null;
let regexEngine = null;
let nerEngine = null;
async function ensureEngines(models) {
    if (!regexEngine) {
        regexEngine = new RegexRuleEngine();
    }
    if (!ocrEngine && models) {
        ocrEngine = new OCREngine({
            detModelUrl: models.detModelUrl,
            recModelUrl: models.recModelUrl,
            charDictUrl: models.charDictUrl,
        });
    }
    if (!nerEngine && models) {
        nerEngine = new NEREngine({
            modelUrl: models.nerModelUrl,
            vocabUrl: models.nerVocabUrl,
        });
    }
    const initPromises = [];
    if (ocrEngine && !ocrEngine.isReady)
        initPromises.push(ocrEngine.initialize());
    if (nerEngine && !nerEngine.isReady)
        initPromises.push(nerEngine.initialize());
    await Promise.all(initPromises);
}
export async function analyzeScreen(image, options = {}) {
    const totalStart = performance.now();
    const state = options.changeState ?? defaultChangeState;
    if (!options.force && lastGraph) {
        const shouldRun = shouldRunFullPipeline(image, options.domMutationCount ?? 0, state);
        if (!shouldRun) {
            return lastGraph;
        }
    }
    await ensureEngines(options.models);
    if (!ocrEngine || !regexEngine || !nerEngine) {
        throw new Error("Local perception engines not properly initialized with model URLs.");
    }
    // Convert ImageData to OffscreenCanvas for the OCREngine
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    ctx.putImageData(image, 0, 0);
    const ocrStart = performance.now();
    const ocrTokens = await ocrEngine.run(canvas);
    const ocrMs = performance.now() - ocrStart;
    const detectionStart = performance.now();
    const detectionPromise = runUiDetection(image).then((result) => {
        return { result, detectionMs: performance.now() - detectionStart };
    });
    const faceStart = performance.now();
    const facePromise = runFaceDetection(image).then((result) => {
        return { result, faceMs: performance.now() - faceStart };
    });
    const [{ result: detections, detectionMs }, { result: faces, faceMs }] = await Promise.all([
        detectionPromise,
        facePromise,
    ]);
    const piiStart = performance.now();
    const regexSignals = regexEngine.detect(ocrTokens);
    const nerSignals = await nerEngine.detect(ocrTokens);
    const piiResults = fusePII(regexSignals, nerSignals);
    const piiMs = performance.now() - piiStart;
    const fusionStart = performance.now();
    const graph = buildUIGraph({
        ocrTokens,
        detections,
        faces,
        piiResults,
        screen: {
            width: image.width,
            height: image.height,
            devicePixelRatio: options.devicePixelRatio ?? 1,
            scrollX: options.scrollX ?? 0,
            scrollY: options.scrollY ?? 0,
        },
    });
    const fusionMs = performance.now() - fusionStart;
    const totalMs = performance.now() - totalStart;
    graph.latencyMs = totalMs;
    if (options.latencyOut) {
        options.latencyOut.ocrMs = ocrMs;
        options.latencyOut.detectionMs = detectionMs;
        options.latencyOut.faceMs = faceMs;
        options.latencyOut.piiMs = piiMs;
        options.latencyOut.fusionMs = fusionMs;
        options.latencyOut.totalMs = totalMs;
    }
    if (options.cachedFields && options.cachedFields.length > 0) {
        for (const el of graph.elements) {
            for (const cf of options.cachedFields) {
                const [ax, ay, aw, ah] = el.bbox;
                const [bx, by, bw, bh] = cf.bbox;
                // [x, y, w, h] overlap check
                if (!(ax + aw < bx || bx + bw < ax || ay + ah < by || by + bh < ay)) {
                    if (!el.sources.includes("cache")) {
                        el.sources.push("cache");
                    }
                    break;
                }
            }
        }
    }
    lastGraph = graph;
    return graph;
}

/**
 * Phase 9 — Screen Understanding / Element Fusion
 *
 * Takes the raw outputs of OCR, UI detection, and face detection (plus
 * fused PII results) and produces the final UIGraph defined in
 * src/schema/uiGraph.ts. This is this branch's actual deliverable.
 */

import type {
    DetectedElement,
    DetectedFace,
    OcrToken,
    RawDetection,
    UIGraph,
} from "../schema/uiGraph.js";
import type { FusedPII } from "../pii/piiFusion.js";
import { deduplicateBoxes, nextElementId, resetIdCounter, type Box } from "./bboxFusion.js";

function boxesOverlap(a: [number, number, number, number], b: [number, number, number, number]): boolean {
    const [ax, ay, aw, ah] = a;
    const [bx, by, bw, bh] = b;
    return !(ax + aw < bx || bx + bw < ax || ay + ah < by || by + bh < ay);
}

/**
 * pii/piiFusion.ts emits corner-format boxes ([x0, y0, x1, y1], matching
 * ocrEngine.ts) while everything else on this branch (RawDetection,
 * OcrToken, DetectedFace) follows the schema's [x, y, w, h] convention.
 * Convert at the boundary here rather than let the two silently disagree —
 * flagging this for a follow-up: either piiFusion should emit [x, y, w, h]
 * directly, or bboxFusion.ts should expose a shared `normalizeBBox` used by
 * every producer so this conversion doesn't need to live in fusion code.
 */
function piiBBoxToXYWH(corners: FusedPII["bbox"]): [number, number, number, number] {
    const [x0, y0, x1, y1] = corners;
    return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
}
function normalizePiiType(
    type: FusedPII["type"]
): DetectedElement["piiType"] {
    switch (type) {
        case "EMAIL":
            return "email";
        case "PHONE":
            return "phone";
        case "PERSON":
            return "person";
        case "ADDRESS":
            return "address";
        case "CREDIT_CARD":
            return "credit_card";
        case "PASSWORD":
            return "password";
        case "OTP":
            return "otp";
        case "ID_NUMBER":
            return "id_number";
        case "BANK_ACCOUNT":
            return "bank_account";
        case "LOCATION":
            return "location";
        case "ORGANIZATION":
            return "organization";
        default:
            return "none";
    }
}

export interface FuseInputs {
    ocrTokens: OcrToken[];
    detections: RawDetection[];
    faces: DetectedFace[];
    piiResults: FusedPII[];
    screen: UIGraph["screen"];
}

export function buildUIGraph(inputs: FuseInputs): UIGraph {
    resetIdCounter();

    // 0. Convert PII boxes to the schema's [x, y, w, h] convention once,
    //    up front, so every downstream overlap check below can treat all
    //    box types uniformly.
    const piiXYWH: Array<{ bbox: [number, number, number, number]; pii: FusedPII }> =
        inputs.piiResults.map((p) => ({ bbox: piiBBoxToXYWH(p.bbox), pii: p }));

    // 1. Dedupe UI detector boxes against themselves (NMS should have mostly
    //    handled this already, but overlapping model runs can still duplicate).
    const detectionBoxes: Box<RawDetection>[] = inputs.detections.map((d) => ({
        bbox: d.bbox,
        confidence: d.confidence,
        payload: d,
    }));
    const dedupedDetections = deduplicateBoxes(detectionBoxes, 0.5);

    // 2. Build one DetectedElement per surviving detection, attach OCR text
    //    and PII risk if the boxes overlap.
    const elements: DetectedElement[] = dedupedDetections.map(({ bbox, confidence, payload }) => {
        const overlappingText = inputs.ocrTokens
            .filter((t) => boxesOverlap(t.bbox, bbox))
            .map((t) => t.text)
            .join(" ")
            .trim();

        const matchedPii = piiXYWH.find((p) => boxesOverlap(p.bbox, bbox))?.pii;

        const sources: DetectedElement["sources"] = ["detector"];
        if (overlappingText) sources.push("ocr");
        if (matchedPii) sources.push("pii");

        // return {
        //     id: nextElementId("el"),
        //     type: payload.type,
        //     text: overlappingText || undefined,
        //     bbox,
        //     confidence,
        //     sensitive: false1,
        //     piiType: matchedPii?.type,
        //     risk: matchedPii?.risk,
        //     sources,
        // };
        return {
            id: nextElementId("el"),
            type: payload.type,
            text: overlappingText || undefined,
            bbox,
            confidence,
            sensitive: !!matchedPii,
            piiType: matchedPii ? normalizePiiType(matchedPii.type) : undefined,
            risk: matchedPii?.risk,
            sources,
        };
    });

    // 3. Any OCR tokens that didn't land inside a detected element still
    //    matter (e.g. loose text not wrapped in a recognized widget) — add
    //    them as "text" elements so nothing gets silently dropped.
    for (const token of inputs.ocrTokens) {
        const alreadyCovered = elements.some((el) => boxesOverlap(el.bbox, token.bbox));
        if (alreadyCovered) continue;

        const matchedPii = piiXYWH.find((p) => boxesOverlap(p.bbox, token.bbox))?.pii;
        elements.push({
            id: nextElementId("el"),
            type: "text",
            text: token.text,
            bbox: token.bbox,
            confidence: token.confidence,
            sensitive: Boolean(matchedPii),
            piiType: matchedPii
                ? normalizePiiType(matchedPii.type)
                : undefined,
            risk: matchedPii?.risk,
            sources: matchedPii ? ["ocr", "pii"] : ["ocr"],
        });
    }

    const faces: DetectedFace[] = inputs.faces.map((f) => ({
        ...f,
        id: nextElementId("face"),
    }));

    return {
        screen: inputs.screen,
        elements,
        faces,
        timestampMs: Date.now(),
    };
}

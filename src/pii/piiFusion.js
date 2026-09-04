/**
 * src/pii/piiFusion.ts
 *
 * Fuses PII candidates from the regex engine (pii/regexRules.ts) and the
 * NER engine (pii/nerEngine.ts) into a single risk-scored list.
 *
 * This module intentionally only fuses these two local-text-based sources.
 * Broader fusion across DOM semantics + vision/face detection happens one
 * level up, in src/fusion/bboxFusion.ts / screenUnderstanding.ts, which
 * treats this module's output as one input signal among several.
 *
 * Also owns the shared PII schema (`PIICandidate`, `PIIType`, `RiskLevel`)
 * so regexRules.ts and nerEngine.ts both import types from here rather than
 * each defining their own incompatible shape. These are type-only imports,
 * so there's no runtime circular-dependency concern.
 */
// ---------------------------------------------------------------------------
// Risk model
// ---------------------------------------------------------------------------
/** Baseline risk per type, used when a candidate isn't corroborated. */
const BASE_RISK = {
    PASSWORD: 'HIGH',
    CREDIT_CARD: 'HIGH',
    OTP: 'HIGH',
    ID_NUMBER: 'HIGH',
    EMAIL: 'MEDIUM',
    PHONE: 'MEDIUM',
    BANK_ACCOUNT: 'MEDIUM',
    PERSON: 'MEDIUM',
    ADDRESS: 'MEDIUM',
    LOCATION: 'LOW',
    ORGANIZATION: 'LOW',
};
const RISK_ORDER = ['LOW', 'MEDIUM', 'HIGH'];
function upgradeRisk(risk) {
    const idx = RISK_ORDER.indexOf(risk);
    return RISK_ORDER[Math.min(idx + 1, RISK_ORDER.length - 1)];
}
// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
function iou(a, b) {
    const [ax0, ay0, ax1, ay1] = a;
    const [bx0, by0, bx1, by1] = b;
    const ix0 = Math.max(ax0, bx0);
    const iy0 = Math.max(ay0, by0);
    const ix1 = Math.min(ax1, bx1);
    const iy1 = Math.min(ay1, by1);
    const iw = Math.max(0, ix1 - ix0);
    const ih = Math.max(0, iy1 - iy0);
    const interArea = iw * ih;
    if (interArea === 0)
        return 0;
    const areaA = Math.max(0, ax1 - ax0) * Math.max(0, ay1 - ay0);
    const areaB = Math.max(0, bx1 - bx0) * Math.max(0, by1 - by0);
    const unionArea = areaA + areaB - interArea;
    return unionArea === 0 ? 0 : interArea / unionArea;
}
function unionBBox(a, b) {
    return [
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.max(a[2], b[2]),
        Math.max(a[3], b[3]),
    ];
}
const DEFAULT_OVERLAP_THRESHOLD = 0.3;
/**
 * Combines regex-sourced and NER-sourced candidates into one risk-scored
 * list. Overlapping candidates on (roughly) the same region are merged and
 * their risk is upgraded one level, since agreement across independent
 * signal types is a strong corroboration signal (mirrors the DOM+OCR
 * corroboration example in the project spec, but for text-only signals).
 */
export function fusePII(regexCandidates, nerCandidates, options = {}) {
    const overlapThreshold = options.overlapThreshold ?? DEFAULT_OVERLAP_THRESHOLD;
    const all = [...regexCandidates, ...nerCandidates];
    if (all.length === 0)
        return [];
    const used = new Array(all.length).fill(false);
    const fused = [];
    for (let i = 0; i < all.length; i++) {
        if (used[i])
            continue;
        used[i] = true;
        let mergedBBox = all[i].bbox;
        let bestType = all[i].type;
        let bestConfidence = all[i].confidence;
        const sources = new Set([all[i].source]);
        let matchCount = 1;
        for (let j = i + 1; j < all.length; j++) {
            if (used[j])
                continue;
            if (iou(mergedBBox, all[j].bbox) < overlapThreshold)
                continue;
            used[j] = true;
            sources.add(all[j].source);
            matchCount++;
            mergedBBox = unionBBox(mergedBBox, all[j].bbox);
            // Prefer the higher-confidence type label when sources disagree on
            // exactly what the entity is (e.g. regex says PHONE, NER says PERSON
            // for a misread digit string) — keep whichever call is more confident.
            if (all[j].confidence > bestConfidence) {
                bestType = all[j].type;
                bestConfidence = all[j].confidence;
            }
            else {
                // Corroboration still bumps combined confidence even if we keep
                // the original label.
                bestConfidence = Math.min(0.99, bestConfidence + 0.1);
            }
        }
        const corroborated = matchCount > 1 && sources.size > 1;
        const baseRisk = BASE_RISK[bestType] ?? 'MEDIUM';
        const risk = corroborated ? upgradeRisk(baseRisk) : baseRisk;
        fused.push({
            type: bestType,
            bbox: mergedBBox,
            confidence: bestConfidence,
            risk,
            source: all[i].source,
            sources: Array.from(sources),
            corroborated,
        });
    }
    return fused.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
}
export default fusePII;

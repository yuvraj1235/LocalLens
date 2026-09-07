/**
 * Phase 1 â€” Output Contract
 *
 * This is the schema every other module (OCR, detection, face, PII, fusion)
 * must produce or consume. Lock this early and share it with the
 * server/reasoning branch so integration doesn't break later.
 */

export type ElementType =
  | "button"
  | "input"
  | "text"
  | "checkbox"
  | "radio"
  | "dropdown"
  | "link"
  | "image"
  | "table"
  | "card"
  | "modal"
  | "icon"
  | "avatar"
  | "navigation"
  | "tab"
  | "unknown";

export type PiiType =
  | "email"
  | "phone"
  | "person"
  | "address"
  | "credit_card"
  | "password"
  | "otp"
  | "id_number"
  | "bank_account"
  | "location"
  | "organization"
  | "face"
  | "none";
  

export type RiskLevel = "NONE" | "LOW" | "MEDIUM" | "HIGH";

/** [x, y, width, height] in pixel space of the captured screenshot */
export type BBox = [number, number, number, number];

export interface DetectedElement {
  id: string;
  type: ElementType;
  text?: string;
  bbox: BBox;
  confidence: number;
  sensitive: boolean;
  piiType?: PiiType;
  risk?: RiskLevel;
  /** which subsystems contributed to this element, useful for debugging fusion */
  sources: Array<"ocr" | "detector" | "face" | "dom" | "pii" | "cache">;
}

export interface DetectedFace {
  id: string;
  bbox: BBox;
  confidence: number;
}

export interface UIGraph {
  screen: {
    width: number;
    height: number;
    devicePixelRatio: number;
    scrollX: number;
    scrollY: number;
  };
  elements: DetectedElement[];
  faces: DetectedFace[];
  timestampMs: number;
  /** total pipeline latency for this frame, filled in by analyzeScreen */
  latencyMs?: number;
}

/** Raw OCR output before fusion */
export interface OcrToken {
  text: string;
  bbox: BBox;
  confidence: number;
}

/** Raw UI detector output before fusion */
export interface RawDetection {
  type: ElementType;
  bbox: BBox;
  confidence: number;
}

/** Raw PII signal before fusion, produced by regex/NER/visual layers */
export interface PiiSignal {
  type: PiiType;
  bbox: BBox;
  confidence: number;
  source: "regex" | "ner" | "visual" | "dom";
}
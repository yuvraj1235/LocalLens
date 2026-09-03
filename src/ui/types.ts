/**
 * types.ts — Shared TypeScript interfaces for the LocalLens UI
 *
 * These mirror the backend contract defined in:
 *   backend/app/schemas/context.py
 *
 * Keep in sync with Shreya's backend. Never add raw PII fields here.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type RedactionTag =
  | "PASSWORD_REDACTED"
  | "EMAIL_REDACTED"
  | "CARD_REDACTED"
  | "FACE_BLURRED"
  | "PII_REDACTED"
  | "NONE";

// ---------------------------------------------------------------------------
// UI Graph (built by Ankit's content script)
// ---------------------------------------------------------------------------

export interface UIElement {
  element_id: string;      // stable id, e.g. "btn_17"
  role: string;            // ARIA role, e.g. "button" | "textbox"
  label: string | null;    // visible/accessible text, already sanitised
  bbox: BoundingBox | null;
  redaction: RedactionTag;
  clickable: boolean;
  editable: boolean;
}

// ---------------------------------------------------------------------------
// SanitizedContext — the ONLY payload allowed to leave the device
// ---------------------------------------------------------------------------

export interface SanitizedContext {
  session_id: string;
  url_domain: string | null;      // domain only — no path/query
  screenshot_b64: string | null;  // already blurred/masked client-side
  ui_graph: UIElement[];
  viewport_width: number | null;
  viewport_height: number | null;
}

// ---------------------------------------------------------------------------
// TaskRequest — sent to Shreya's backend
// ---------------------------------------------------------------------------

export interface TaskRequest {
  session_id: string;
  task: string;              // natural language goal, e.g. "submit this form"
  context: SanitizedContext;
  history: string[];         // short log of prior actions for grounding
}

// ---------------------------------------------------------------------------
// StructuredAction — returned by Shreya's backend
// ---------------------------------------------------------------------------

export type ActionType =
  | "CLICK"
  | "TYPE"
  | "SCROLL"
  | "SELECT"
  | "NAVIGATE"
  | "WAIT"
  | "DONE"
  | "ASK_USER";

export interface StructuredAction {
  action: ActionType;
  element_id: string | null;  // required for CLICK / TYPE / SELECT
  value: string | null;       // text to type, option to select, URL, etc.
  reasoning: string | null;   // backend's rationale (for logging/eval)
  confidence: number;         // 0.0 – 1.0
  done: boolean;
}

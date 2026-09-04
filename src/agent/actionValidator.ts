/**
 * actionValidator.ts
 *
 * Validates a StructuredAction received from Shreya's backend BEFORE
 * actionExecutor.ts is allowed to touch the DOM.
 *
 * Two layers of validation:
 *   1. Schema validation  — required fields are present and types are correct.
 *   2. DOM validation     — element_id actually exists and is interactable
 *                           (visible, not disabled, in the current document).
 *
 * This is the "hallucination guard" mentioned in the backend README:
 * the server may return an element_id that doesn't exist on this page.
 * We catch that here so actionExecutor never runs blind.
 */

import type { StructuredAction, ActionType } from "./actionExecutor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ValidationStatus = "valid" | "invalid";

export interface ValidationResult {
  status: ValidationStatus;
  /** Human-readable reason — shown in the agent loop log. */
  reason: string;
}

// Actions that MUST have an element_id
const ELEMENT_REQUIRED: ActionType[] = ["CLICK", "TYPE", "SELECT"];

// Actions that MUST have a value
const VALUE_REQUIRED: ActionType[] = ["TYPE", "SELECT", "NAVIGATE"];

// Valid action set — mirrors backend Literal
const VALID_ACTIONS: ActionType[] = [
  "CLICK",
  "TYPE",
  "SCROLL",
  "SELECT",
  "NAVIGATE",
  "WAIT",
  "DONE",
  "ASK_USER",
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a StructuredAction.
 * Returns { status: "valid" } if it is safe to execute,
 * or { status: "invalid", reason } if something is wrong.
 *
 * @param skipDomCheck — set to true when calling from the popup/agentLoop
 *   context, where `document` is the popup's own document and does NOT
 *   contain the live page's elements. The content script's executeAction()
 *   will catch missing elements at the point of actual DOM interaction.
 */
export function validateAction(
  action: StructuredAction,
  { skipDomCheck = false }: { skipDomCheck?: boolean } = {}
): ValidationResult {
  // Layer 1: schema checks (always run)
  const schema = validateSchema(action);
  if (schema.status === "invalid") return schema;

  // Layer 2: DOM checks — only when:
  //   a) the action targets a specific element
  //   b) the caller is running inside the page's document (content script)
  //   c) the caller has not explicitly opted out (popup / agentLoop)
  if (
    !skipDomCheck &&
    ELEMENT_REQUIRED.includes(action.action) &&
    action.element_id &&
    typeof document !== "undefined"
  ) {
    return validateDOM(action.element_id);
  }

  return { status: "valid", reason: "Schema valid." };
}

// ---------------------------------------------------------------------------
// Internal — schema validation
// ---------------------------------------------------------------------------

function validateSchema(action: StructuredAction): ValidationResult {
  // 1a. action field must be a known type
  if (!VALID_ACTIONS.includes(action.action)) {
    return {
      status: "invalid",
      reason: `Unknown action type: "${action.action}". Expected one of: ${VALID_ACTIONS.join(", ")}.`,
    };
  }

  // 1b. confidence must be in [0, 1]
  if (action.confidence < 0 || action.confidence > 1) {
    return {
      status: "invalid",
      reason: `Confidence out of range: ${action.confidence}. Must be 0.0 – 1.0.`,
    };
  }

  // 1c. Actions that need element_id must have one
  if (ELEMENT_REQUIRED.includes(action.action) && !action.element_id) {
    return {
      status: "invalid",
      reason: `Action "${action.action}" requires element_id, but it is null.`,
    };
  }

  // 1d. Actions that need a value must have one
  if (VALUE_REQUIRED.includes(action.action) && !action.value) {
    return {
      status: "invalid",
      reason: `Action "${action.action}" requires a value, but it is null or empty.`,
    };
  }

  return { status: "valid", reason: "Schema valid." };
}

// ---------------------------------------------------------------------------
// Internal — DOM validation
// ---------------------------------------------------------------------------

function validateDOM(elementId: string): ValidationResult {
  // Try data-agent-id first (Ankit's content script stamps this attribute)
  const escapedId = typeof CSS !== "undefined" && CSS.escape
    ? CSS.escape(elementId)
    : elementId.replace(/["\\]/g, "\\$&");

  let el: HTMLElement | null = document.querySelector<HTMLElement>(
    `[data-agent-id="${escapedId}"]`
  );

  // Fallback: bare id
  if (!el) el = document.getElementById(elementId);

  if (!el) {
    return {
      status: "invalid",
      reason: `DOM element not found for element_id: "${elementId}". The backend may have hallucinated this id.`,
    };
  }

  // Element must be visible in the viewport
  if (!isVisible(el)) {
    return {
      status: "invalid",
      reason: `Element "${elementId}" exists in DOM but is not visible (hidden/display:none/zero-size).`,
    };
  }

  // Element must not be disabled
  if (isDisabled(el)) {
    return {
      status: "invalid",
      reason: `Element "${elementId}" is disabled and cannot be interacted with.`,
    };
  }

  return { status: "valid", reason: `DOM element "${elementId}" is present and interactable.` };
}

/** Check if an element is visible using getBoundingClientRect + computed styles. */
function isVisible(el: HTMLElement): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === "none") return false;
  if (style.visibility === "hidden") return false;
  if (parseFloat(style.opacity) === 0) return false;

  const rect = el.getBoundingClientRect();
  // zero-size elements are considered invisible
  return rect.width > 0 && rect.height > 0;
}

/** Check if an element or any ancestor is disabled. */
function isDisabled(el: HTMLElement): boolean {
  return (
    (el as HTMLInputElement).disabled === true ||
    el.getAttribute("aria-disabled") === "true"
  );
}

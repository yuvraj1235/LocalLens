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
// Actions that MUST have an element_id
const ELEMENT_REQUIRED = ["CLICK", "TYPE", "SELECT"];
// Actions that MUST have a value
const VALUE_REQUIRED = ["TYPE", "SELECT", "NAVIGATE"];
// Valid action set — mirrors backend Literal
const VALID_ACTIONS = [
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
 */
export function validateAction(action) {
    // --- 1. Schema checks ---
    const schemaResult = validateSchema(action);
    if (schemaResult.status === "invalid")
        return schemaResult;
    // --- 2. DOM checks (only for element-targeting actions) ---
    if (ELEMENT_REQUIRED.includes(action.action) && action.element_id) {
        const domResult = validateDOM(action.element_id);
        if (domResult.status === "invalid")
            return domResult;
    }
    return { status: "valid", reason: "All checks passed." };
}
// ---------------------------------------------------------------------------
// Internal — schema validation
// ---------------------------------------------------------------------------
function validateSchema(action) {
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
function validateDOM(elementId) {
    // Try data-agent-id first (Ankit's content script stamps this attribute)
    const escapedId = typeof CSS !== "undefined" && CSS.escape
        ? CSS.escape(elementId)
        : elementId.replace(/["\\]/g, "\\$&");
    let el = document.querySelector(`[data-agent-id="${escapedId}"]`);
    // Fallback: bare id
    if (!el)
        el = document.getElementById(elementId);
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
function isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === "none")
        return false;
    if (style.visibility === "hidden")
        return false;
    if (parseFloat(style.opacity) === 0)
        return false;
    const rect = el.getBoundingClientRect();
    // zero-size elements are considered invisible
    return rect.width > 0 && rect.height > 0;
}
/** Check if an element or any ancestor is disabled. */
function isDisabled(el) {
    return (el.disabled === true ||
        el.getAttribute("aria-disabled") === "true");
}

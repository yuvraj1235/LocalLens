/**
 * actionExecutor.ts
 *
 * Executes a StructuredAction (received from Shreya's backend) on the live DOM.
 * This module is the only place that physically touches the page —
 * keep all DOM side-effects here so they're easy to test and audit.
 *
 * ActionType contract (mirrors backend/app/schemas/context.py):
 *   CLICK | TYPE | SCROLL | SELECT | NAVIGATE | WAIT | DONE | ASK_USER
 */
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Execute one action returned by the backend planner.
 * Resolves with { status, message } — never throws, so the agent loop
 * can log failures without crashing.
 */
export async function executeAction(action) {
    try {
        switch (action.action) {
            case "CLICK":
                return await doClick(action.element_id);
            case "TYPE":
                return await doType(action.element_id, action.value);
            case "SCROLL":
                return doScroll(action.value);
            case "SELECT":
                return doSelect(action.element_id, action.value);
            case "NAVIGATE":
                return doNavigate(action.value);
            case "WAIT":
                return await doWait(action.value);
            case "DONE":
                return { status: "ok", message: "Task marked done by backend." };
            case "ASK_USER":
                return {
                    status: "ok",
                    message: `Backend needs user input: ${action.value ?? "(no prompt)"}`,
                };
            default:
                return { status: "error", message: `Unknown action: ${action.action}` };
        }
    }
    catch (err) {
        return {
            status: "error",
            message: err instanceof Error ? err.message : String(err),
        };
    }
}
// ---------------------------------------------------------------------------
// Internal helpers — one per action type
// ---------------------------------------------------------------------------
/** Resolve element_id → DOM node. element_id matches [data-agent-id="..."] or #id */
function resolveElement(elementId) {
    if (!elementId)
        throw new Error("element_id is required but was null.");
    // Safe escape: use CSS.escape when available (browsers), manual fallback for jsdom/tests
    const escapedId = typeof CSS !== "undefined" && CSS.escape
        ? CSS.escape(elementId)
        : elementId.replace(/["\\]/g, "\\$&");
    // Primary: data-agent-id attribute (Ankit's content script stamps this)
    let el = document.querySelector(`[data-agent-id="${escapedId}"]`);
    // Fallback: treat element_id as a bare CSS id
    if (!el)
        el = document.getElementById(elementId);
    if (!el)
        throw new Error(`Element not found in DOM: "${elementId}"`);
    return el;
}
async function doClick(elementId) {
    const el = resolveElement(elementId);
    el.focus();
    el.click();
    return { status: "ok", message: `Clicked: ${elementId}` };
}
async function doType(elementId, value) {
    if (value === null)
        throw new Error("TYPE requires a value.");
    const el = resolveElement(elementId);
    el.focus();
    // Set the value and fire both input + change so frameworks detect it
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { status: "ok", message: `Typed into ${elementId}: "${value}"` };
}
function doScroll(value) {
    // value format: "x,y"  e.g. "0,300"  — defaults to scrolling down 300 px
    const [x, y] = (value ?? "0,300").split(",").map(Number);
    window.scrollBy({ left: x || 0, top: y || 300, behavior: "smooth" });
    return { status: "ok", message: `Scrolled by (${x ?? 0}, ${y ?? 300})` };
}
function doSelect(elementId, value) {
    if (value === null)
        throw new Error("SELECT requires a value.");
    const el = resolveElement(elementId);
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { status: "ok", message: `Selected "${value}" in ${elementId}` };
}
function doNavigate(value) {
    if (!value)
        throw new Error("NAVIGATE requires a URL in value.");
    window.location.href = value;
    return { status: "ok", message: `Navigating to: ${value}` };
}
async function doWait(value) {
    const ms = parseInt(value ?? "1000", 10);
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { status: "ok", message: `Waited ${ms} ms` };
}

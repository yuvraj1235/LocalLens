/**
 * actionValidator.test.ts
 *
 * Unit tests for actionValidator.ts using Vitest + jsdom.
 * Tests cover:
 *   1. Schema validation (bad action type, missing element_id, missing value, confidence out of range)
 *   2. DOM validation (element not found, element hidden, element disabled)
 *   3. Happy paths (CLICK, TYPE, SELECT on valid elements)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { validateAction } from "../actionValidator";
// ---------------------------------------------------------------------------
// Helpers to build minimal valid actions
// ---------------------------------------------------------------------------
function makeAction(overrides = {}) {
    return {
        action: "CLICK",
        element_id: "btn_submit",
        value: null,
        reasoning: null,
        confidence: 0.9,
        done: false,
        ...overrides,
    };
}
/** Inject a real DOM element that actionValidator can find. */
function addElement(id, options = {}) {
    const el = document.createElement(options.tag ?? "button");
    el.setAttribute("data-agent-id", id);
    if (options.hidden)
        el.style.display = "none";
    if (options.disabled)
        el.disabled = true;
    // jsdom elements have zero-size by default; make them visible by default
    if (!options.zeroSize) {
        // Override getBoundingClientRect for jsdom
        el.getBoundingClientRect = () => ({
            x: 10, y: 10, width: 100, height: 40,
            top: 10, right: 110, bottom: 50, left: 10,
            toJSON: () => ({}),
        });
    }
    document.body.appendChild(el);
    return el;
}
// ---------------------------------------------------------------------------
// Reset the DOM between tests
// ---------------------------------------------------------------------------
beforeEach(() => {
    document.body.innerHTML = "";
});
// ---------------------------------------------------------------------------
// 1. Schema validation
// ---------------------------------------------------------------------------
describe("Schema validation", () => {
    it("rejects an unknown action type", () => {
        const result = validateAction(makeAction({ action: "HOVER" }));
        expect(result.status).toBe("invalid");
        expect(result.reason).toMatch(/Unknown action type/);
    });
    it("rejects confidence below 0", () => {
        const result = validateAction(makeAction({ confidence: -0.1 }));
        expect(result.status).toBe("invalid");
        expect(result.reason).toMatch(/Confidence out of range/);
    });
    it("rejects confidence above 1", () => {
        const result = validateAction(makeAction({ confidence: 1.5 }));
        expect(result.status).toBe("invalid");
        expect(result.reason).toMatch(/Confidence out of range/);
    });
    it("rejects CLICK with null element_id", () => {
        const result = validateAction(makeAction({ action: "CLICK", element_id: null }));
        expect(result.status).toBe("invalid");
        expect(result.reason).toMatch(/requires element_id/);
    });
    it("rejects TYPE with null element_id", () => {
        const result = validateAction(makeAction({ action: "TYPE", element_id: null, value: "hello" }));
        expect(result.status).toBe("invalid");
        expect(result.reason).toMatch(/requires element_id/);
    });
    it("rejects TYPE with null value", () => {
        addElement("inp_1");
        const result = validateAction(makeAction({ action: "TYPE", element_id: "inp_1", value: null }));
        expect(result.status).toBe("invalid");
        expect(result.reason).toMatch(/requires a value/);
    });
    it("rejects SELECT with null value", () => {
        addElement("sel_1", { tag: "select" });
        const result = validateAction(makeAction({ action: "SELECT", element_id: "sel_1", value: null }));
        expect(result.status).toBe("invalid");
        expect(result.reason).toMatch(/requires a value/);
    });
    it("rejects NAVIGATE with null value", () => {
        const result = validateAction(makeAction({ action: "NAVIGATE", element_id: null, value: null }));
        expect(result.status).toBe("invalid");
        expect(result.reason).toMatch(/requires a value/);
    });
    it("accepts confidence exactly 0 and 1 (boundary)", () => {
        addElement("btn_submit");
        expect(validateAction(makeAction({ confidence: 0 })).status).toBe("valid");
        expect(validateAction(makeAction({ confidence: 1 })).status).toBe("valid");
    });
});
// ---------------------------------------------------------------------------
// 2. DOM validation
// ---------------------------------------------------------------------------
describe("DOM validation", () => {
    it("rejects CLICK when element_id is not in the DOM (hallucination)", () => {
        // No element added — simulates hallucinated id
        const result = validateAction(makeAction({ element_id: "btn_ghost" }));
        expect(result.status).toBe("invalid");
        expect(result.reason).toMatch(/not found for element_id/);
    });
    it("rejects CLICK when element has display:none (invisible)", () => {
        addElement("btn_hidden", { hidden: true });
        const result = validateAction(makeAction({ element_id: "btn_hidden" }));
        expect(result.status).toBe("invalid");
        expect(result.reason).toMatch(/not visible/);
    });
    it("rejects CLICK when element is disabled", () => {
        addElement("btn_disabled", { disabled: true });
        const result = validateAction(makeAction({ element_id: "btn_disabled" }));
        expect(result.status).toBe("invalid");
        expect(result.reason).toMatch(/disabled/);
    });
    it("accepts CLICK when element exists, is visible and not disabled", () => {
        addElement("btn_submit");
        const result = validateAction(makeAction({ element_id: "btn_submit" }));
        expect(result.status).toBe("valid");
    });
    it("finds element by data-agent-id attribute", () => {
        addElement("btn_by_attr");
        const result = validateAction(makeAction({ element_id: "btn_by_attr" }));
        expect(result.status).toBe("valid");
    });
});
// ---------------------------------------------------------------------------
// 3. Actions that don't need DOM checks
// ---------------------------------------------------------------------------
describe("Non-DOM actions", () => {
    it("accepts SCROLL without element_id", () => {
        const result = validateAction(makeAction({ action: "SCROLL", element_id: null, value: "0,300" }));
        expect(result.status).toBe("valid");
    });
    it("accepts WAIT without element_id", () => {
        const result = validateAction(makeAction({ action: "WAIT", element_id: null }));
        expect(result.status).toBe("valid");
    });
    it("accepts DONE without element_id", () => {
        const result = validateAction(makeAction({ action: "DONE", element_id: null, done: true }));
        expect(result.status).toBe("valid");
    });
    it("accepts ASK_USER without element_id", () => {
        const result = validateAction(makeAction({ action: "ASK_USER", element_id: null, value: "Which option?" }));
        expect(result.status).toBe("valid");
    });
    it("accepts NAVIGATE with a URL value", () => {
        const result = validateAction(makeAction({ action: "NAVIGATE", element_id: null, value: "https://example.com" }));
        expect(result.status).toBe("valid");
    });
});

/**
 * actionExecutor.test.ts
 *
 * Unit tests for actionExecutor.ts using Vitest + jsdom.
 * Tests verify that each ActionType correctly interacts with the DOM.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { executeAction } from "../actionExecutor";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeAction(overrides = {}) {
    return {
        action: "CLICK",
        element_id: null,
        value: null,
        reasoning: null,
        confidence: 0.9,
        done: false,
        ...overrides,
    };
}
/** Add a real DOM element with data-agent-id so actionExecutor can find it. */
function addElement(id, tag = "button") {
    const el = document.createElement(tag);
    el.setAttribute("data-agent-id", id);
    el.getBoundingClientRect = () => ({
        x: 0, y: 0, width: 100, height: 40,
        top: 0, right: 100, bottom: 40, left: 0,
        toJSON: () => ({}),
    });
    document.body.appendChild(el);
    return el;
}
beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
});
// ---------------------------------------------------------------------------
// CLICK
// ---------------------------------------------------------------------------
describe("CLICK", () => {
    it("calls .click() on the resolved element", async () => {
        const el = addElement("btn_1");
        const clickSpy = vi.spyOn(el, "click");
        const result = await executeAction(makeAction({ action: "CLICK", element_id: "btn_1" }));
        expect(result.status).toBe("ok");
        expect(clickSpy).toHaveBeenCalledOnce();
    });
    it("returns error when element_id is null", async () => {
        const result = await executeAction(makeAction({ action: "CLICK", element_id: null }));
        expect(result.status).toBe("error");
        expect(result.message).toMatch(/element_id is required/);
    });
    it("returns error when element is not in DOM", async () => {
        const result = await executeAction(makeAction({ action: "CLICK", element_id: "ghost_btn" }));
        expect(result.status).toBe("error");
        expect(result.message).toMatch(/not found/);
    });
});
// ---------------------------------------------------------------------------
// TYPE
// ---------------------------------------------------------------------------
describe("TYPE", () => {
    it("sets element value and fires input + change events", async () => {
        const el = addElement("inp_email", "input");
        const inputFired = vi.fn();
        const changeFired = vi.fn();
        el.addEventListener("input", inputFired);
        el.addEventListener("change", changeFired);
        const result = await executeAction(makeAction({ action: "TYPE", element_id: "inp_email", value: "hello@test.com" }));
        expect(result.status).toBe("ok");
        expect(el.value).toBe("hello@test.com");
        expect(inputFired).toHaveBeenCalledOnce();
        expect(changeFired).toHaveBeenCalledOnce();
    });
    it("returns error when value is null", async () => {
        addElement("inp_1", "input");
        const result = await executeAction(makeAction({ action: "TYPE", element_id: "inp_1", value: null }));
        expect(result.status).toBe("error");
        expect(result.message).toMatch(/requires a value/);
    });
});
// ---------------------------------------------------------------------------
// SCROLL
// ---------------------------------------------------------------------------
describe("SCROLL", () => {
    it("calls window.scrollBy with parsed x,y values", async () => {
        const scrollSpy = vi.spyOn(window, "scrollBy").mockImplementation(() => { });
        const result = await executeAction(makeAction({ action: "SCROLL", element_id: null, value: "0,500" }));
        expect(result.status).toBe("ok");
        expect(scrollSpy).toHaveBeenCalledWith({ left: 0, top: 500, behavior: "smooth" });
    });
    it("uses default scroll of 300px when value is null", async () => {
        const scrollSpy = vi.spyOn(window, "scrollBy").mockImplementation(() => { });
        const result = await executeAction(makeAction({ action: "SCROLL", element_id: null, value: null }));
        expect(result.status).toBe("ok");
        expect(scrollSpy).toHaveBeenCalledWith({ left: 0, top: 300, behavior: "smooth" });
    });
});
// ---------------------------------------------------------------------------
// SELECT
// ---------------------------------------------------------------------------
describe("SELECT", () => {
    it("sets select value and fires change event", async () => {
        const el = addElement("sel_1", "select");
        // Add options so the value can be set
        ["red", "blue", "green"].forEach((v) => {
            const opt = document.createElement("option");
            opt.value = v;
            el.appendChild(opt);
        });
        const changeFired = vi.fn();
        el.addEventListener("change", changeFired);
        const result = await executeAction(makeAction({ action: "SELECT", element_id: "sel_1", value: "blue" }));
        expect(result.status).toBe("ok");
        expect(el.value).toBe("blue");
        expect(changeFired).toHaveBeenCalledOnce();
    });
    it("returns error when value is null", async () => {
        addElement("sel_2", "select");
        const result = await executeAction(makeAction({ action: "SELECT", element_id: "sel_2", value: null }));
        expect(result.status).toBe("error");
        expect(result.message).toMatch(/requires a value/);
    });
});
// ---------------------------------------------------------------------------
// NAVIGATE
// ---------------------------------------------------------------------------
describe("NAVIGATE", () => {
    it("sets window.location.href to the given URL", async () => {
        // jsdom allows assignment to location.href
        const result = await executeAction(makeAction({ action: "NAVIGATE", element_id: null, value: "https://example.com" }));
        expect(result.status).toBe("ok");
        expect(result.message).toMatch(/example.com/);
    });
    it("returns error when value is null", async () => {
        const result = await executeAction(makeAction({ action: "NAVIGATE", element_id: null, value: null }));
        expect(result.status).toBe("error");
        expect(result.message).toMatch(/requires a URL/);
    });
});
// ---------------------------------------------------------------------------
// WAIT
// ---------------------------------------------------------------------------
describe("WAIT", () => {
    it("waits for the specified number of ms", async () => {
        vi.useFakeTimers();
        const waitPromise = executeAction(makeAction({ action: "WAIT", element_id: null, value: "500" }));
        vi.advanceTimersByTime(500);
        const result = await waitPromise;
        expect(result.status).toBe("ok");
        expect(result.message).toMatch(/500 ms/);
        vi.useRealTimers();
    });
    it("defaults to 1000ms when value is null", async () => {
        vi.useFakeTimers();
        const waitPromise = executeAction(makeAction({ action: "WAIT", element_id: null, value: null }));
        vi.advanceTimersByTime(1000);
        const result = await waitPromise;
        expect(result.status).toBe("ok");
        expect(result.message).toMatch(/1000 ms/);
        vi.useRealTimers();
    });
});
// ---------------------------------------------------------------------------
// DONE / ASK_USER
// ---------------------------------------------------------------------------
describe("Terminal actions", () => {
    it("DONE returns ok status", async () => {
        const result = await executeAction(makeAction({ action: "DONE", element_id: null, done: true }));
        expect(result.status).toBe("ok");
        expect(result.message).toMatch(/done/i);
    });
    it("ASK_USER returns ok status with the value in message", async () => {
        const result = await executeAction(makeAction({ action: "ASK_USER", element_id: null, value: "Which option?" }));
        expect(result.status).toBe("ok");
        expect(result.message).toMatch(/Which option\?/);
    });
});

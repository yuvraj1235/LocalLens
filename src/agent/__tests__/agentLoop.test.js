/**
 * agentLoop.test.ts
 *
 * Unit tests for agentLoop.ts using Vitest + jsdom.
 * The AgentClient is injected via the `client` option so no real WebSocket
 * or module mocking is needed.
 *
 * Covers:
 *  - Loop stops when backend returns action.done = true
 *  - Loop stops when DONE action type is returned
 *  - Loop stops when maxSteps is reached
 *  - Loop stops when confidence is below threshold
 *  - Loop stops when validation fails (hallucinated element_id)
 *  - ASK_USER breaks the loop
 *  - onLog callback receives correct step, level, action fields
 *  - stop() halts the loop
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentLoop } from "../agentLoop";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeContext() {
    return {
        session_id: "test-session",
        url_domain: "localhost",
        screenshot_b64: null,
        ui_graph: [],
        viewport_width: 1280,
        viewport_height: 800,
    };
}
const SCROLL_ACTION = {
    action: "SCROLL",
    element_id: null,
    value: "0,100",
    reasoning: null,
    confidence: 0.9,
    done: false,
};
const DONE_ACTION = {
    action: "DONE",
    element_id: null,
    value: null,
    reasoning: null,
    confidence: 0.95,
    done: true,
};
/** Build an AgentLoop with a fake backend that always returns the given action. */
function makeLoop(backendResponse, options = {}, onLog) {
    const logs = [];
    const mockSend = vi.fn().mockResolvedValue(backendResponse);
    const loop = new AgentLoop({
        task: "test task",
        onLog: (entry) => { logs.push(entry); onLog?.(entry); },
        maxSteps: options.maxSteps ?? 5,
        minConfidence: options.minConfidence ?? 0.4,
        client: { send: mockSend },
    });
    return { loop, logs, mockSend };
}
beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
});
// ---------------------------------------------------------------------------
// Termination conditions
// ---------------------------------------------------------------------------
describe("Termination conditions", () => {
    it("stops when backend returns done: true", async () => {
        const { loop, logs } = makeLoop(DONE_ACTION);
        await loop.start(makeContext());
        expect(logs.find((l) => l.message.includes("Task completed"))).toBeDefined();
        expect(logs.find((l) => l.message.includes("max steps"))).toBeUndefined();
    });
    it("stops when DONE action type is returned (done: false)", async () => {
        const { loop, logs } = makeLoop({ ...DONE_ACTION, done: false });
        await loop.start(makeContext());
        expect(logs.find((l) => l.message.includes("Task completed"))).toBeDefined();
    });
    it("stops after maxSteps SCROLL actions", async () => {
        const { loop, logs } = makeLoop(SCROLL_ACTION, { maxSteps: 3 });
        await loop.start(makeContext());
        expect(logs.find((l) => l.message.includes("max steps (3)"))).toBeDefined();
    });
    it("stops when confidence is below minConfidence threshold", async () => {
        const { loop, logs } = makeLoop({ ...SCROLL_ACTION, confidence: 0.2 }, { minConfidence: 0.5 });
        await loop.start(makeContext());
        expect(logs.find((l) => l.level === "warn" && l.message.includes("confidence"))).toBeDefined();
    });
    it("stops when validation fails (hallucinated element_id)", async () => {
        const { loop, logs } = makeLoop({
            action: "CLICK",
            element_id: "phantom_btn", // doesn't exist in DOM
            value: null,
            reasoning: null,
            confidence: 0.9,
            done: false,
        });
        await loop.start(makeContext());
        expect(logs.find((l) => l.level === "error" && l.message.includes("Validation failed"))).toBeDefined();
    });
    it("breaks loop when ASK_USER is returned", async () => {
        const { loop, logs } = makeLoop({
            action: "ASK_USER",
            element_id: null,
            value: "Please confirm",
            reasoning: null,
            confidence: 0.9,
            done: false,
        });
        await loop.start(makeContext());
        expect(logs.find((l) => l.action === "ASK_USER")).toBeDefined();
        // Loop should have called backend exactly once before stopping
        const backendLogs = logs.filter((l) => l.action === "ASK_USER");
        expect(backendLogs.length).toBeGreaterThanOrEqual(1);
        expect(backendLogs.length).toBeLessThanOrEqual(2);
    });
    it("stop() halts the loop before maxSteps", async () => {
        const { loop, logs } = makeLoop(SCROLL_ACTION, { maxSteps: 20 });
        setTimeout(() => loop.stop(), 150); // stop after ~1-2 steps
        await loop.start(makeContext());
        expect(logs.find((l) => l.message.includes("stopped by caller"))).toBeDefined();
        // Must not reach 20 steps
        const maxStep = Math.max(...logs.map((l) => l.step));
        expect(maxStep).toBeLessThan(20);
    });
});
// ---------------------------------------------------------------------------
// Logging behaviour
// ---------------------------------------------------------------------------
describe("Logging behaviour", () => {
    it("emits an info log at start containing the task name", async () => {
        const { loop, logs } = makeLoop(DONE_ACTION);
        await loop.start(makeContext());
        expect(logs.find((l) => l.level === "info" && l.message.includes("test task"))).toBeDefined();
    });
    it("emits an info log at the very end", async () => {
        const { loop, logs } = makeLoop(DONE_ACTION);
        await loop.start(makeContext());
        expect(logs[logs.length - 1].message).toBe("Agent loop ended.");
    });
    it("step counter increments for each backend call", async () => {
        const { loop, logs } = makeLoop(SCROLL_ACTION, { maxSteps: 3 });
        await loop.start(makeContext());
        const stepNumbers = logs.map((l) => l.step);
        expect(stepNumbers).toContain(1);
        expect(stepNumbers).toContain(2);
        expect(stepNumbers).toContain(3);
    });
    it("backend send() is called once per step", async () => {
        const { loop, mockSend } = makeLoop(SCROLL_ACTION, { maxSteps: 3 });
        await loop.start(makeContext());
        expect(mockSend).toHaveBeenCalledTimes(3);
    });
    it("history is accumulated and passed in subsequent requests", async () => {
        // Return SCROLL twice then DONE
        let callCount = 0;
        const mockSend = vi.fn().mockImplementation(() => {
            callCount++;
            return Promise.resolve(callCount >= 3 ? DONE_ACTION : SCROLL_ACTION);
        });
        const logs = [];
        const loop = new AgentLoop({
            task: "test history",
            onLog: (e) => logs.push(e),
            maxSteps: 5,
            client: { send: mockSend },
        });
        await loop.start(makeContext());
        // 3rd call's history should contain 2 prior actions
        const thirdCall = mockSend.mock.calls[2]?.[0];
        expect(thirdCall?.history?.length).toBe(2);
    });
});

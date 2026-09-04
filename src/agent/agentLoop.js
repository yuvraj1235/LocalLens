/**
 * agentLoop.ts
 *
 * The main agent loop for LocalLens.
 *
 * Orchestration order per tick:
 *   1. Receive SanitizedContext from the content script (via message).
 *   2. Build a TaskRequest and send it to the backend (via wsClient).
 *   3. Validate the returned StructuredAction (via actionValidator).
 *   4. Execute the action on the live DOM (via actionExecutor).
 *   5. Emit a log event so the popup UI can display progress.
 *   6. If action.done === true or max steps reached → stop.
 */
import { AgentClient } from "../ui/wsClient";
import { validateAction } from "./actionValidator";
// ---------------------------------------------------------------------------
// AgentLoop class
// ---------------------------------------------------------------------------
export class AgentLoop {
    constructor(options) {
        this.running = false;
        this.stepCount = 0;
        this.history = [];
        this.task = options.task;
        this.onLog = options.onLog;
        this.maxSteps = options.maxSteps ?? 20;
        this.minConfidence = options.minConfidence ?? 0.4;
        this.client = options.client ?? new AgentClient("ws://localhost:8000/ws/agent");
    }
    async start(initialContext) {
        this.running = true;
        this.stepCount = 0;
        this.history = [];
        this.log("info", null, null, `Agent started. Task: "${this.task}"`);
        let currentContext = initialContext;
        while (this.running && this.stepCount < this.maxSteps) {
            this.stepCount++;
            // Step 1: On every step after the first, fetch fresh context from the
            // content script so element IDs reflect the current DOM state.
            if (this.stepCount > 1) {
                let fresh = null;
                let retries = 5;
                while (retries > 0) {
                    fresh = await this.sendMessage({ type: "GET_CONTEXT" });
                    if (fresh && !fresh.error) {
                        break;
                    }
                    // If we failed to get context, the page might be navigating/loading.
                    // Wait and retry.
                    this.log("info", null, null, "Waiting for page to load...");
                    await sleep(1000);
                    retries--;
                }
                if (fresh && !fresh.error) {
                    currentContext = fresh;
                }
                else {
                    this.log("warn", null, null, "Failed to get fresh context, continuing with old context.");
                }
            }
            // Step 2: Build request
            const request = {
                session_id: currentContext.session_id,
                task: this.task,
                context: currentContext,
                history: [...this.history],
            };
            // Send to backend
            let rawResponse;
            try {
                rawResponse = await this.client.send(request);
            }
            catch (err) {
                this.log("error", null, null, `Backend request failed: ${err}`);
                break;
            }
            const action = rawResponse;
            this.log("info", action.action, action.element_id, `Backend: ${action.action} → ${action.element_id ?? "—"} (confidence: ${action.confidence.toFixed(2)})`);
            // Step 3: Confidence gate
            if (action.confidence < this.minConfidence) {
                this.log("warn", action.action, action.element_id, `Skipping — confidence ${action.confidence.toFixed(2)} below threshold ${this.minConfidence}.`);
                break;
            }
            // Step 4: Validate
            const validation = validateAction(action);
            if (validation.status === "invalid") {
                this.log("error", action.action, action.element_id, `Validation failed: ${validation.reason}`);
                this.history.push(`Step ${this.stepCount}: FAILED — ${validation.reason}`);
                await sleep(300);
                continue;
            }
            // Step 5: Terminal conditions
            if (action.done || action.action === "DONE") {
                this.log("success", null, null, "Task completed by backend signal.");
                break;
            }
            if (action.action === "ASK_USER") {
                this.log("warn", null, null, `Agent paused — backend needs user input: ${action.value ?? ""}`);
                break;
            }
            // Step 6: Execute via Content Script Message
            const result = await this.sendMessage({ type: "EXECUTE_ACTION", action });
            if (!result || result.error) {
                const errStr = result?.error ?? "No response from content script";
                // If the page is navigating away, the message port will close early.
                // We shouldn't crash the agent loop for this; assume it was a successful click/submit.
                if (errStr.includes("message port closed") || errStr.includes("receiving end does not exist")) {
                    this.log("info", action.action, action.element_id, "Page navigation detected after action.");
                }
                else {
                    this.log("error", action.action, action.element_id, `Relay error: ${errStr}`);
                    break;
                }
            }
            else if (result.status === "error") {
                this.log("error", action.action, action.element_id, `Execution failed: ${result.message}`);
                this.history.push(`Step ${this.stepCount}: ${action.action} on ${action.element_id} failed — ${result.message}`);
                await sleep(500);
                continue;
            }
            else {
                this.log("success", action.action, action.element_id, result.message);
            }
            // Record this action for the history grounding context
            this.history.push(`Step ${this.stepCount}: ${action.action} ${action.element_id ?? ""} ${action.value ?? ""}`.trim());
            // Small delay between steps to avoid hammering the DOM
            await sleep(600);
        }
        if (this.stepCount >= this.maxSteps) {
            this.log("warn", null, null, `Stopped — reached max steps (${this.maxSteps}).`);
        }
        this.running = false;
        this.log("info", null, null, "Agent loop ended.");
    }
    /** Stop the loop gracefully after the current step finishes. */
    stop() {
        this.running = false;
        this.log("info", null, null, "Agent loop stopped by caller.");
    }
    // ---------------------------------------------------------------------------
    // Send a message via chrome.runtime → background → content script
    // ---------------------------------------------------------------------------
    sendMessage(msg) {
        return new Promise((resolve) => {
            if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
                chrome.runtime.sendMessage(msg, (response) => {
                    if (chrome.runtime.lastError) {
                        resolve({ error: chrome.runtime.lastError.message });
                    }
                    else {
                        resolve(response);
                    }
                });
            }
            else {
                // Dev mode fallback — no real content script available
                resolve({ error: "chrome.runtime not available (dev mode)" });
            }
        });
    }
    // ── Private helpers ─────────────────────────────────────────────────────
    log(level, action, elementId, message) {
        const entry = {
            step: this.stepCount,
            level,
            action,
            element_id: elementId,
            message,
            timestamp: Date.now(),
        };
        this.onLog(entry);
    }
}
// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

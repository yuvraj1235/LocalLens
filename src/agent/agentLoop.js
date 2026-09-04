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
import { executeAction } from "./actionExecutor";
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
    /** Begin the agent loop with an initial SanitizedContext from the content script. */
    async start(context) {
        this.running = true;
        this.stepCount = 0;
        this.history = [];
        this.log("info", null, null, `Agent started. Task: "${this.task}"`);
        while (this.running && this.stepCount < this.maxSteps) {
            this.stepCount++;
            // ── Step 1: Build request ──────────────────────────────────────────
            const request = {
                session_id: context.session_id,
                task: this.task,
                context,
                history: [...this.history],
            };
            // ── Step 2: Send to backend ────────────────────────────────────────
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
            // ── Step 3: Confidence gate ────────────────────────────────────────
            if (action.confidence < this.minConfidence) {
                this.log("warn", action.action, action.element_id, `Skipping — confidence ${action.confidence.toFixed(2)} below threshold ${this.minConfidence}.`);
                break;
            }
            // ── Step 4: Validate ───────────────────────────────────────────────
            const validation = validateAction(action);
            if (validation.status === "invalid") {
                this.log("error", action.action, action.element_id, `Validation failed: ${validation.reason}`);
                break;
            }
            // ── Step 5: Execute ────────────────────────────────────────────────
            const result = await executeAction(action);
            if (result.status === "error") {
                this.log("error", action.action, action.element_id, `Execution failed: ${result.message}`);
                break;
            }
            this.log("success", action.action, action.element_id, result.message);
            // Record this action for the history grounding context
            this.history.push(`Step ${this.stepCount}: ${action.action} ${action.element_id ?? ""} ${action.value ?? ""}`.trim());
            // ── Step 6: Terminal conditions ────────────────────────────────────
            if (action.done || action.action === "DONE") {
                this.log("success", null, null, "Task completed by backend signal.");
                break;
            }
            if (action.action === "ASK_USER") {
                this.log("warn", null, null, `Agent paused — backend needs user input: ${action.value ?? ""}`);
                break;
            }
            // Small delay between steps to avoid hammering the DOM
            await sleep(300);
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

/**
 * agentLoop.ts (JS compiled counterpart — keep in sync with agentLoop.ts)
 *
 * Orchestration order per tick:
 *   1. Receive SanitizedContext from the content script (via message).
 *   2. Build a TaskRequest and send it to the backend (via wsClient).
 *   3. Confidence gate — always bypassed for DONE / ASK_USER.
 *   4. Schema-validate the returned StructuredAction.
 *   5. Handle ASK_USER (break). Execute action. Then check done (break).
 *   6. Execute with up to MAX_EXEC_RETRIES retries.
 *   7. Check action.done AFTER execution so the final DOM action always fires.
 */
import { AgentClient } from "../ui/wsClient";
import { validateAction } from "./actionValidator";

const MAX_EXEC_RETRIES = 3;
const TERMINAL_ACTIONS = new Set(["DONE", "ASK_USER"]);

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
            if (this.stepCount > 1) {
                let fresh = null;
                let retries = 5;
                while (retries > 0) {
                    fresh = await this.sendMessage({ type: "GET_CONTEXT" });
                    if (fresh && !fresh.error) break;
                    const errStr = fresh?.error ?? "";
                    // Dev/test mode: no content script — skip retries immediately.
                    if (errStr.includes("chrome.runtime not available")) break;
                    // Real navigation: wait for the page to settle.
                    this.log("info", null, null, "Waiting for page to load...");
                    await sleep(1000);
                    retries--;
                }
                if (fresh && !fresh.error) {
                    currentContext = fresh;
                } else {
                    this.log("warn", null, null, "Failed to get fresh context, continuing with old context.");
                }
            }
            const request = {
                session_id: currentContext.session_id,
                task: this.task,
                context: currentContext,
                history: [...this.history],
            };
            let rawResponse;
            try {
                rawResponse = await this.client.send(request);
            } catch (err) {
                this.log("error", null, null, `Backend request failed: ${err}`);
                break;
            }
            const action = rawResponse;
            this.log("info", action.action, action.element_id,
                `Backend: ${action.action} → ${action.element_id ?? "—"} (confidence: ${action.confidence.toFixed(2)})`);

            // Step 3: Confidence gate — terminal actions bypass it.
            if (!TERMINAL_ACTIONS.has(action.action) && action.confidence < this.minConfidence) {
                this.log("warn", action.action, action.element_id,
                    `Skipping — confidence ${action.confidence.toFixed(2)} below threshold ${this.minConfidence}.`);
                break;
            }

            // Step 4: Schema validation.
            const validation = validateAction(action);
            if (validation.status === "invalid") {
                this.log("error", action.action, action.element_id, `Validation failed: ${validation.reason}`);
                this.history.push(`Step ${this.stepCount}: FAILED — ${validation.reason}`);
                await sleep(300);
                continue;
            }

            // Step 5: ASK_USER — pause immediately, no DOM action.
            if (action.action === "ASK_USER") {
                this.log("warn", null, null, `Agent paused — backend needs user input: ${action.value ?? ""}`);
                break;
            }

            // Step 6: Execute (with retries).
            // Execute BEFORE checking done so the final action always fires.
            if (action.action !== "DONE") {
                const execResult = await this.executeWithRetry(action);
                if (execResult.navigated) {
                    // Page is navigating — action succeeded, still record it for history.
                    this.log("info", action.action, action.element_id, "Page navigation detected after action.");
                    this.history.push(`Step ${this.stepCount}: ${action.action} ${action.element_id ?? ""} ${action.value ?? ""}`.trim());
                } else if (execResult.status === "error") {
                    this.log("error", action.action, action.element_id, `Execution failed: ${execResult.message}`);
                    this.history.push(`Step ${this.stepCount}: ${action.action} on ${action.element_id} failed — ${execResult.message}`);
                    await sleep(500);
                    continue;
                } else {
                    this.log("success", action.action, action.element_id, execResult.message);
                    this.history.push(`Step ${this.stepCount}: ${action.action} ${action.element_id ?? ""} ${action.value ?? ""}`.trim());
                }
            }

            // Step 7: Check done AFTER execution.
            if (action.done || action.action === "DONE") {
                this.log("success", null, null, "Task completed by backend signal.");
                break;
            }

            await sleep(600);
        }
        if (this.stepCount >= this.maxSteps) {
            this.log("warn", null, null, `Stopped — reached max steps (${this.maxSteps}).`);
        }
        this.running = false;
        this.log("info", null, null, "Agent loop ended.");
    }
    stop() {
        this.running = false;
        this.log("info", null, null, "Agent loop stopped by caller.");
    }
    async executeWithRetry(action) {
        let lastErr = "Unknown error";
        for (let attempt = 1; attempt <= MAX_EXEC_RETRIES; attempt++) {
            const raw = await this.sendMessage({ type: "EXECUTE_ACTION", action });
            if (!raw || raw.error) {
                const errStr = raw?.error ?? "No response from content script";
                if (errStr.includes("message port closed") ||
                    errStr.includes("receiving end does not exist") ||
                    errStr.includes("chrome.runtime not available")) {
                    return { status: "ok", message: "Page navigation detected.", navigated: true };
                }
                lastErr = errStr;
                if (attempt < MAX_EXEC_RETRIES) {
                    this.log("warn", action.action, action.element_id,
                        `Relay error (attempt ${attempt}/${MAX_EXEC_RETRIES}): ${errStr} — retrying…`);
                    await sleep(400 * attempt);
                    continue;
                }
                return { status: "error", message: `Relay failed after ${MAX_EXEC_RETRIES} attempts: ${lastErr}` };
            }
            if (raw.status === "error") {
                lastErr = raw.message ?? "Execution error";
                if (attempt < MAX_EXEC_RETRIES) {
                    this.log("warn", action.action, action.element_id,
                        `Execution error (attempt ${attempt}/${MAX_EXEC_RETRIES}): ${lastErr} — retrying…`);
                    await sleep(400 * attempt);
                    continue;
                }
                return { status: "error", message: lastErr };
            }
            return { status: "ok", message: raw.message ?? "Action executed." };
        }
        return { status: "error", message: `Execution failed after ${MAX_EXEC_RETRIES} attempts: ${lastErr}` };
    }
    sendMessage(msg) {
        return new Promise((resolve) => {
            if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
                chrome.runtime.sendMessage(msg, (response) => {
                    if (chrome.runtime.lastError) {
                        resolve({ error: chrome.runtime.lastError.message });
                    } else {
                        resolve(response);
                    }
                });
            } else {
                resolve({ error: "chrome.runtime not available (dev mode)" });
            }
        });
    }
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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

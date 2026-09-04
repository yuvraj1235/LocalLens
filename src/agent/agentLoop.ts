/**
 * agentLoop.ts
 *
 * The main agent loop for LocalLens.
 *
 * Orchestration order per tick:
 *   1. Receive SanitizedContext from the content script (via message).
 *   2. Build a TaskRequest and send it to the backend (via wsClient).
 *   3. Confidence gate — always bypassed for DONE / ASK_USER so terminal
 *      signals are never silently swallowed by a low-confidence score.
 *   4. Schema-validate the returned StructuredAction.
 *   5. Handle terminal actions: ASK_USER breaks; DONE executes its paired
 *      DOM action first (if any), THEN breaks — so the final step is always
 *      carried out before the loop exits.
 *   6. Execute the action with up to MAX_EXEC_RETRIES retries.
 *   7. Check action.done after execution and break if true.
 *   8. Emit a log event so the popup UI can display progress.
 */

// Re-export shared types from the canonical source so other modules
// can import from either place without duplication.
export type {
  BoundingBox,
  UIElement,
  SanitizedContext,
  TaskRequest,
} from "../ui/types";

import type { SanitizedContext, TaskRequest } from "../ui/types";
import { AgentClient } from "../ui/wsClient";
import { validateAction } from "./actionValidator";
import { executeAction } from "./actionExecutor";
import type { StructuredAction } from "./actionExecutor";

// ---------------------------------------------------------------------------
// Log entry — emitted after every step so the popup UI can render progress
// ---------------------------------------------------------------------------

export type LogLevel = "info" | "warn" | "error" | "success";

export interface LogEntry {
  step: number;
  level: LogLevel;
  action: string | null;       // e.g. "CLICK"
  element_id: string | null;   // e.g. "btn_submit"
  message: string;
  timestamp: number;           // Date.now()
}

// ---------------------------------------------------------------------------
// AgentLoop options
// ---------------------------------------------------------------------------

export interface AgentLoopOptions {
  /** The high-level natural-language goal, e.g. "Submit the login form". */
  task: string;
  /** Called after every step with a structured log entry. */
  onLog: (entry: LogEntry) => void;
  /** Stop after this many steps even if the task isn't marked done. Default: 20 */
  maxSteps?: number;
  /**
   * Minimum confidence the backend must return for an action to execute.
   * Actions below this threshold are skipped and logged as warnings.
   * Default: 0.4
   */
  minConfidence?: number;
  /**
   * Optional pre-built client — used in tests to inject a mock.
   * If omitted, a real AgentClient is created automatically.
   */
  client?: { send: (request: TaskRequest) => Promise<unknown> };
}

// ---------------------------------------------------------------------------
// AgentLoop class
// ---------------------------------------------------------------------------

/** Maximum execution retries for a single action before giving up. */
const MAX_EXEC_RETRIES = 3;

/** Actions that must never be stopped by the confidence gate. */
const TERMINAL_ACTIONS = new Set(["DONE", "ASK_USER"]);

export class AgentLoop {
  private task: string;
  private onLog: (entry: LogEntry) => void;
  private maxSteps: number;
  private minConfidence: number;

  private running = false;
  private stepCount = 0;
  private history: string[] = [];
  private client: { send: (request: TaskRequest) => Promise<unknown> };

  constructor(options: AgentLoopOptions) {
    this.task = options.task;
    this.onLog = options.onLog;
    this.maxSteps = options.maxSteps ?? 20;
    this.minConfidence = options.minConfidence ?? 0.4;
    this.client = options.client ?? new AgentClient("ws://localhost:8000/ws/agent");
  }

  async start(initialContext: SanitizedContext): Promise<void> {
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
        let fresh: any = null;
        let retries = 5;
        while (retries > 0) {
          fresh = await this.sendMessage({ type: "GET_CONTEXT" });
          if (fresh && !fresh.error) {
            break;
          }
          const errStr: string = fresh?.error ?? "";
          // Dev/test mode: no content script will ever appear — skip retries.
          if (errStr.includes("chrome.runtime not available")) {
            break;
          }
          // Real navigation: wait for the page to settle before retrying.
          this.log("info", null, null, "Waiting for page to load...");
          await sleep(1000);
          retries--;
        }
        
        if (fresh && !fresh.error) {
          currentContext = fresh as SanitizedContext;
        } else {
          this.log("warn", null, null, "Failed to get fresh context, continuing with old context.");
        }
      }

      // Step 2: Build request
      const request: TaskRequest = {
        session_id: currentContext.session_id,
        task: this.task,
        context: currentContext,
        history: [...this.history],
      };

      // Send to backend
      let rawResponse: unknown;
      try {
        rawResponse = await this.client.send(request);
      } catch (err) {
        this.log("error", null, null, `Backend request failed: ${err}`);
        break;
      }

      const action = rawResponse as StructuredAction;
      this.log(
        "info",
        action.action,
        action.element_id,
        `Backend: ${action.action} → ${action.element_id ?? "—"} (confidence: ${action.confidence.toFixed(2)})`
      );

      // Step 3: Confidence gate.
      // DONE and ASK_USER are terminal signals — they must NEVER be swallowed
      // by a low confidence score (e.g. when the hallucination guard resets
      // confidence to 0.0). Skip the gate for those two actions.
      if (!TERMINAL_ACTIONS.has(action.action) && action.confidence < this.minConfidence) {
        this.log(
          "warn",
          action.action,
          action.element_id,
          `Skipping — confidence ${action.confidence.toFixed(2)} below threshold ${this.minConfidence}.`
        );
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

      // Step 5: Handle ASK_USER immediately — no DOM action to take.
      if (action.action === "ASK_USER") {
        this.log("warn", null, null, `Agent paused — backend needs user input: ${action.value ?? ""}`);
        break;
      }

      // Step 6: Execute the action (with retries for reliability).
      // NOTE: We execute BEFORE checking action.done so that the backend can
      // signal completion as part of the same step as the final DOM action
      // (e.g. {action:"CLICK", element_id:"btn_submit", done:true}). Without
      // this ordering the final action would be silently skipped.
      if (action.action !== "DONE") {
        const execResult = await this.executeWithRetry(action);

        if (execResult.navigated) {
          // Page is navigating — action succeeded, still record it for history.
          this.log("info", action.action, action.element_id, "Page navigation detected after action.");
          this.history.push(
            `Step ${this.stepCount}: ${action.action} ${action.element_id ?? ""} ${action.value ?? ""}`.trim()
          );
        } else if (execResult.status === "error") {
          this.log("error", action.action, action.element_id, `Execution failed: ${execResult.message}`);
          this.history.push(
            `Step ${this.stepCount}: ${action.action} on ${action.element_id} failed — ${execResult.message}`
          );
          await sleep(500);
          continue;
        } else {
          this.log("success", action.action, action.element_id, execResult.message);
          this.history.push(
            `Step ${this.stepCount}: ${action.action} ${action.element_id ?? ""} ${action.value ?? ""}`.trim()
          );
        }
      }

      // Step 7: Stop if the backend signalled task completion.
      // Checked AFTER execution so the final DOM action always fires.
      if (action.done || action.action === "DONE") {
        this.log("success", null, null, "Task completed by backend signal.");
        break;
      }

      // Small delay between steps to avoid hammering the DOM.
      await sleep(600);
    }

    if (this.stepCount >= this.maxSteps) {
      this.log("warn", null, null, `Stopped — reached max steps (${this.maxSteps}).`);
    }

    this.running = false;
    this.log("info", null, null, "Agent loop ended.");
  }

  /** Stop the loop gracefully after the current step finishes. */
  stop(): void {
    this.running = false;
    this.log("info", null, null, "Agent loop stopped by caller.");
  }

  // ---------------------------------------------------------------------------
  // Execute with retries — ensures actions that CAN run DO run
  // ---------------------------------------------------------------------------

  /**
   * Sends EXECUTE_ACTION to the content script, retrying up to MAX_EXEC_RETRIES
   * times on transient relay errors. Returns a normalised result object:
   *   { status: "ok"|"error", message, navigated? }
   */
  private async executeWithRetry(
    action: StructuredAction
  ): Promise<{ status: "ok" | "error"; message: string; navigated?: boolean }> {
    let lastErr = "Unknown error";

    for (let attempt = 1; attempt <= MAX_EXEC_RETRIES; attempt++) {
      const raw: any = await this.sendMessage({ type: "EXECUTE_ACTION", action });

      // Navigation causes the message port to close — not a real failure.
      // Dev/test environments have no content script at all — treat that
      // identically so the loop advances normally without real retries.
      if (!raw || raw.error) {
        const errStr: string = raw?.error ?? "No response from content script";
        if (
          errStr.includes("message port closed") ||
          errStr.includes("receiving end does not exist") ||
          errStr.includes("chrome.runtime not available")
        ) {
          return { status: "ok", message: "Page navigation detected.", navigated: true };
        }
        lastErr = errStr;
        if (attempt < MAX_EXEC_RETRIES) {
          this.log(
            "warn",
            action.action,
            action.element_id,
            `Relay error (attempt ${attempt}/${MAX_EXEC_RETRIES}): ${errStr} — retrying…`
          );
          await sleep(400 * attempt);
          continue;
        }
        return { status: "error", message: `Relay failed after ${MAX_EXEC_RETRIES} attempts: ${lastErr}` };
      }

      // Content script returned a structured result.
      if (raw.status === "error") {
        lastErr = raw.message ?? "Execution error";
        if (attempt < MAX_EXEC_RETRIES) {
          this.log(
            "warn",
            action.action,
            action.element_id,
            `Execution error (attempt ${attempt}/${MAX_EXEC_RETRIES}): ${lastErr} — retrying…`
          );
          await sleep(400 * attempt);
          continue;
        }
        return { status: "error", message: lastErr };
      }

      // Success.
      return { status: "ok", message: raw.message ?? "Action executed." };
    }

    return { status: "error", message: `Execution failed after ${MAX_EXEC_RETRIES} attempts: ${lastErr}` };
  }

  // ---------------------------------------------------------------------------
  // Send a message via chrome.runtime → background → content script
  // ---------------------------------------------------------------------------
  private sendMessage(msg: any): Promise<unknown> {
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
        // Dev mode fallback — no real content script available
        resolve({ error: "chrome.runtime not available (dev mode)" });
      }
    });
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private log(
    level: LogLevel,
    action: string | null,
    elementId: string | null,
    message: string
  ): void {
    const entry: LogEntry = {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

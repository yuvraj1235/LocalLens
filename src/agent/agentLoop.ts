/**
 * agentLoop.ts
 *
 * The main agent loop for LocalLens.
 *
 * Orchestration order per tick:
 *   1. Receive SanitizedContext from Ankit's content script (via message).
 *   2. Build a TaskRequest and send it to Shreya's backend (via wsClient).
 *   3. Validate the returned StructuredAction (via actionValidator).
 *   4. Execute the action on the live DOM (via actionExecutor).
 *   5. Emit a log event so the popup UI can display progress.
 *   6. If action.done === true or max steps reached → stop.
 *
 * Usage (called from the extension popup or content script):
 *
 *   import { AgentLoop } from "./agentLoop";
 *
 *   const loop = new AgentLoop({
 *     task: "Submit the login form",
 *     onLog: (entry) => console.log(entry),
 *   });
 *   loop.start(sanitizedContext);
 *   // later:
 *   loop.stop();
 */

import { AgentClient } from "../ui/wsClient";
import { validateAction } from "./actionValidator";
import { executeAction } from "./actionExecutor";
import type { StructuredAction } from "./actionExecutor";

// ---------------------------------------------------------------------------
// Types  (mirrors backend/app/schemas/context.py)
// ---------------------------------------------------------------------------

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UIElement {
  element_id: string;
  role: string;
  label: string | null;
  bbox: BoundingBox | null;
  redaction: string;
  clickable: boolean;
  editable: boolean;
}

export interface SanitizedContext {
  session_id: string;
  url_domain: string | null;
  screenshot_b64: string | null;
  ui_graph: UIElement[];
  viewport_width: number | null;
  viewport_height: number | null;
}

export interface TaskRequest {
  session_id: string;
  task: string;
  context: SanitizedContext;
  history: string[];
}

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

export class AgentLoop {
  private task: string;
  private onLog: (entry: LogEntry) => void;
  private maxSteps: number;
  private minConfidence: number;

  private running = false;
  private stepCount = 0;
  private history: string[] = [];
  private client: AgentClient;

  constructor(options: AgentLoopOptions) {
    this.task = options.task;
    this.onLog = options.onLog;
    this.maxSteps = options.maxSteps ?? 20;
    this.minConfidence = options.minConfidence ?? 0.4;
    this.client = options.client ?? new AgentClient("ws://localhost:8000/ws/agent");
  }

  /** Begin the agent loop with an initial SanitizedContext from Ankit. */
  async start(context: SanitizedContext): Promise<void> {
    this.running = true;
    this.stepCount = 0;
    this.history = [];

    this.log("info", null, null, `Agent started. Task: "${this.task}"`);

    while (this.running && this.stepCount < this.maxSteps) {
      this.stepCount++;

      // ── Step 1: Build request ──────────────────────────────────────────
      const request: TaskRequest = {
        session_id: context.session_id,
        task: this.task,
        context,
        history: [...this.history],
      };

      // ── Step 2: Send to backend ────────────────────────────────────────
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

      // ── Step 3: Confidence gate ────────────────────────────────────────
      if (action.confidence < this.minConfidence) {
        this.log(
          "warn",
          action.action,
          action.element_id,
          `Skipping — confidence ${action.confidence.toFixed(2)} below threshold ${this.minConfidence}.`
        );
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
        // The popup UI should handle this (show a prompt) and call start() again
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
  stop(): void {
    this.running = false;
    this.log("info", null, null, "Agent loop stopped by caller.");
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

import { StructuredAction, SanitizedContext, LogEntry } from "../types";
import { validateAction } from "./actionValidator";
import { executeAction } from "./actionExecutor";

export class AgentLoop {
  private running = false;
  private stepCount = 0;
  private history: string[] = [];
  private task: string;
  private onLog: (entry: LogEntry) => void;
  private maxSteps: number;
  private minConfidence: number;

  constructor(opts: {
    task: string;
    onLog: (entry: LogEntry) => void;
    maxSteps?: number;
    minConfidence?: number;
  }) {
    this.task = opts.task;
    this.onLog = opts.onLog;
    this.maxSteps = opts.maxSteps ?? 20;
    this.minConfidence = opts.minConfidence ?? 0.4;
  }

  async start(initialContext: SanitizedContext) {
    this.running = true;
    this.stepCount = 0;
    this.history = [];
    this.log("info", null, null, `Agent started. Task: "${this.task}"`);

    let currentContext = initialContext;

    while (this.running && this.stepCount < this.maxSteps) {
      this.stepCount++;

      // 1. ALWAYS get fresh context from the live DOM for every loop step
      if (this.stepCount > 1) {
        currentContext = await this.fetchFreshContext();
      }

      const payload = {
        session_id: currentContext.session_id,
        task: this.task,
        context: currentContext,
        history: [...this.history],
      };

      let action: StructuredAction;
      try {
        action = await this.sendToBackend(payload);
      } catch (err) {
        this.log("error", null, null, `Backend request failed: ${err}`);
        break;
      }

      this.log(
        "info",
        action.action,
        action.element_id,
        `Backend: ${action.action} → ${action.element_id ?? "—"} (conf: ${action.confidence.toFixed(2)})`
      );

      if (action.confidence < this.minConfidence) {
        this.log(
          "warn",
          action.action,
          action.element_id,
          `Skipping — confidence ${action.confidence.toFixed(2)} below threshold ${this.minConfidence}.`
        );
        break;
      }

      // 2. Client-side DOM Validation
      const validation = validateAction(action);
      if (validation.status === "invalid") {
        this.log("error", action.action, action.element_id, `Validation failed: ${validation.reason}`);
        
        // CRITICAL: Feed validation error into history so backend learns in the next step
        this.history.push(
          `Step ${this.stepCount}: ${action.action} on ${action.element_id} failed — ${validation.reason}`
        );

        // DO NOT BREAK: Wait, refresh context, and retry the loop step!
        await new Promise((r) => setTimeout(r, 500));
        continue; 
      }

      // 3. Execute action on live DOM
      const res = await executeAction(action);
      if (res.status === "error") {
        this.log("error", action.action, action.element_id, `Execution failed: ${res.message}`);
        this.history.push(`Step ${this.stepCount}: ${action.action} failed — ${res.message}`);
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      this.log("success", action.action, action.element_id, res.message);
      this.history.push(`Step ${this.stepCount}: ${action.action} ${action.element_id ?? ""} ${action.value ?? ""}`.trim());

      if (action.done || action.action === "DONE") {
        this.log("success", null, null, "Task completed by backend signal.");
        break;
      }

      if (action.action === "ASK_USER") {
        this.log("warn", null, null, `Agent paused — backend needs user input: ${action.value ?? ""}`);
        break;
      }

      // Give the DOM 500ms to settle/render after click or input before the next step
      await new Promise((r) => setTimeout(r, 500));
    }

    this.running = false;
    this.log("info", null, null, "Agent loop ended.");
  }

  stop() {
    this.running = false;
  }

  private async fetchFreshContext(): Promise<SanitizedContext> {
    return new Promise((resolve) => {
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: "GET_CONTEXT" }, (res) => resolve(res));
      } else {
        resolve({
          session_id: `dev-${Date.now()}`,
          url_domain: window.location.hostname,
          screenshot_b64: null,
          viewport_width: window.innerWidth,
          viewport_height: window.innerHeight,
          ui_graph: [],
        });
      }
    });
  }

  private async sendToBackend(payload: any): Promise<StructuredAction> {
    const res = await fetch("http://localhost:8000/plan-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await res.json();
  }

  private log(level: any, action: any, element_id: any, message: string) {
    this.onLog({
      step: this.stepCount,
      level,
      action,
      element_id,
      message,
      timestamp: Date.now(),
    });
  }
}
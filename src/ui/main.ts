// main.ts – UI glue for the minimal LocalLens demo

import { agentClient } from "./wsClient";
import type { TaskRequest, StructuredAction, UIGraph } from "./types";
import { renderDebugOverlay } from "./debugOverlay";

// Grab DOM elements
const promptEl = document.getElementById("prompt") as HTMLTextAreaElement;
const runBtn = document.getElementById("runBtn") as HTMLButtonElement;
const logEl = document.getElementById("log") as HTMLElement;
const debugToggle = document.getElementById("debugToggle") as HTMLInputElement;

/**
 * Append a line to the log area, keeping it scrolled to bottom.
 */
function appendLog(message: string) {
  const line = document.createElement("div");
  line.textContent = message;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

/**
 * Format a JSON object with pretty printing for the log.
 */
function prettyPrint(json: any): string {
  return JSON.stringify(json, null, 2);
}

runBtn.addEventListener("click", async () => {
  const prompt = promptEl.value.trim();
  if (!prompt) {
    appendLog("[⚠️] Prompt is empty");
    return;
  }

  const request: TaskRequest = { prompt };
  appendLog(`> Sending task: ${prompt}`);

  try {
    const response = await agentClient.sendTask(request);
    const { action, graph } = response as { action: StructuredAction; graph?: UIGraph };

    // Log the structured action
    appendLog("[✅] Received StructuredAction:");
    appendLog(prettyPrint(action));

    // If debug overlay is enabled and we have a graph, render it
    if (debugToggle.checked && graph) {
      renderDebugOverlay(graph);
      appendLog("[🔍] Debug overlay rendered");
    }
  } catch (err) {
    console.error(err);
    appendLog(`[❌] Error: ${(err as Error).message}`);
  }
});

// Optional: clear log on page reload
window.addEventListener("load", () => {
  logEl.innerHTML = "";
});

// Expose for debugging in console
(window as any).agentClient = agentClient;

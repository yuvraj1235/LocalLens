// main.ts – UI glue for the minimal LocalLens demo
import { agentClient } from "./wsClient";
import { renderDebugOverlay } from "./debugOverlay";
// Grab DOM elements
const promptEl = document.getElementById("prompt");
const runBtn = document.getElementById("runBtn");
const logEl = document.getElementById("log");
const debugToggle = document.getElementById("debugToggle");
/**
 * Append a line to the log area, keeping it scrolled to bottom.
 */
function appendLog(message) {
    const line = document.createElement("div");
    line.textContent = message;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
}
/**
 * Format a JSON object with pretty printing for the log.
 */
function prettyPrint(json) {
    return JSON.stringify(json, null, 2);
}
runBtn.addEventListener("click", async () => {
    const prompt = promptEl.value.trim();
    if (!prompt) {
        appendLog("[⚠️] Prompt is empty");
        return;
    }
    const request = { prompt };
    appendLog(`> Sending task: ${prompt}`);
    try {
        const response = await agentClient.sendTask(request);
        const { action, graph } = response;
        // Log the structured action
        appendLog("[✅] Received StructuredAction:");
        appendLog(prettyPrint(action));
        // If debug overlay is enabled and we have a graph, render it
        if (debugToggle.checked && graph) {
            renderDebugOverlay(graph);
            appendLog("[🔍] Debug overlay rendered");
        }
    }
    catch (err) {
        console.error(err);
        appendLog(`[❌] Error: ${err.message}`);
    }
});
// Optional: clear log on page reload
window.addEventListener("load", () => {
    logEl.innerHTML = "";
});
// Expose for debugging in console
window.agentClient = agentClient;

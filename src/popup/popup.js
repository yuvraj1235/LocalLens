/**
 * popup.ts
 *
 * Wires the extension popup UI (popup.html) to the AgentLoop.
 *
 * Responsibilities:
 *  - Start / stop the AgentLoop when buttons are clicked.
 *  - Render each LogEntry from the loop into the live log list.
 *  - Update the status badge based on loop state.
 *  - Show the privacy strip with redaction tags from the SanitizedContext.
 *  - Handle the ASK_USER overlay interaction.
 *
 * In the final extension, `buildMockContext()` is replaced by a real
 * `chrome.runtime.sendMessage({ type: "GET_CONTEXT" })` call to Ankit's
 * content script. Everything else stays the same.
 */
import { AgentLoop } from "../agent/agentLoop";
import { getAutofillSettings, updateAutofillSettings, listCachedKeys, clearAllCachedValues, clearCachedValue } from "../cache/fieldCache.js";
// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const taskInput = document.getElementById("task-input");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const clearBtn = document.getElementById("clear-btn");
const statusBadge = document.getElementById("status-badge");
const logList = document.getElementById("log-list");
const privacyStrip = document.getElementById("privacy-strip");
const redactionTags = document.getElementById("redaction-tags");
const askOverlay = document.getElementById("ask-user-overlay");
const askMessage = document.getElementById("ask-user-message");
const askInput = document.getElementById("ask-user-input");
const askSubmit = document.getElementById("ask-user-submit");
// Autofill settings
const autofillEnableCb = document.getElementById("autofill-enable-cb");
const autofillConfirmCb = document.getElementById("autofill-confirm-cb");
const clearCacheBtn = document.getElementById("clear-cache-btn");
const cacheList = document.getElementById("cache-list");
// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let loop = null;
// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------
startBtn.addEventListener("click", handleStart);
stopBtn.addEventListener("click", handleStop);
clearBtn.addEventListener("click", clearLog);
taskInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter")
        handleStart();
});
askSubmit.addEventListener("click", () => {
    // User answered the ASK_USER prompt — hide overlay.
    // The actual answer handling can be extended here (e.g. re-start the loop
    // with the answer prepended to the task string).
    askOverlay.classList.add("hidden");
    appendLog({
        step: 0,
        level: "info",
        action: "ASK_USER",
        element_id: null,
        message: `User replied: "${askInput.value}"`,
        timestamp: Date.now(),
    });
    askInput.value = "";
});
// ---------------------------------------------------------------------------
// Autofill Settings Handlers
// ---------------------------------------------------------------------------
async function initSettings() {
    const settings = await getAutofillSettings();
    if (autofillEnableCb)
        autofillEnableCb.checked = settings.enabled;
    if (autofillConfirmCb)
        autofillConfirmCb.checked = settings.confirmRequired;
    autofillEnableCb?.addEventListener("change", async () => {
        await updateAutofillSettings({ enabled: autofillEnableCb.checked });
    });
    autofillConfirmCb?.addEventListener("change", async () => {
        await updateAutofillSettings({ confirmRequired: autofillConfirmCb.checked });
    });
    clearCacheBtn?.addEventListener("click", async () => {
        await clearAllCachedValues();
        renderCacheList();
    });
    // NEW: Dynamically create the trigger button for testing
    const applyBtn = document.createElement("button");
    applyBtn.textContent = "Inject Pending Autofills";
    applyBtn.style.marginTop = "10px";
    applyBtn.style.width = "100%";
    applyBtn.style.padding = "6px";
    applyBtn.style.backgroundColor = "#6366f1"; // matching your primary purple
    applyBtn.style.color = "white";
    applyBtn.style.border = "none";
    applyBtn.style.borderRadius = "4px";
    applyBtn.style.cursor = "pointer";
    applyBtn.onclick = triggerAutofill;
    cacheList?.parentElement?.appendChild(applyBtn);
    renderCacheList();
}
async function renderCacheList() {
    if (!cacheList)
        return;
    const keys = await listCachedKeys();
    cacheList.innerHTML = "";
    if (keys.length === 0) {
        cacheList.innerHTML = '<li style="color: #666; font-size: 12px; padding: 4px;">Cache is empty</li>';
        return;
    }
    for (const { key, updatedAt } of keys) {
        const li = document.createElement("li");
        li.style.display = "flex";
        li.style.justifyContent = "space-between";
        li.style.marginBottom = "4px";
        const timeStr = new Date(updatedAt).toLocaleTimeString();
        li.innerHTML = `
      <span style="color: #fff; font-size: 12px;">${escapeHtml(key)} <span style="color:#666">(${timeStr})</span></span>
      <button class="btn btn--ghost btn--sm" data-key="${escapeHtml(key)}">Del</button>
    `;
        cacheList.appendChild(li);
    }
    cacheList.querySelectorAll("button").forEach(btn => {
        btn.addEventListener("click", async (e) => {
            const target = e.target;
            const k = target.getAttribute("data-key");
            if (k) {
                await clearCachedValue(k);
                renderCacheList();
            }
        });
    });
}
initSettings();
// ---------------------------------------------------------------------------
// Core handlers
// ---------------------------------------------------------------------------
async function triggerAutofill() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "APPLY_AUTOFILL" }, (response) => {
            if (response?.success) {
                appendLog({
                    step: 0,
                    level: "success",
                    action: "AUTOFILL",
                    element_id: null,
                    message: `Successfully injected ${response.count} cached fields.`,
                    timestamp: Date.now(),
                });
            }
        });
    }
}
async function handleStart() {
    const task = taskInput.value.trim();
    if (!task) {
        taskInput.focus();
        return;
    }
    clearLog();
    setStatus("running");
    setButtons(true);
    // In the final extension this context comes from Ankit's content script.
    // For now we build a mock so the popup can be developed independently.
    const context = await getContext();
    renderPrivacyStrip(context);
    loop = new AgentLoop({
        task,
        onLog: (entry) => {
            appendLog(entry);
            // If backend asks the user something, surface the overlay
            if (entry.action === "ASK_USER") {
                askMessage.textContent = entry.message;
                askOverlay.classList.remove("hidden");
            }
            // Detect terminal log messages to reset buttons
            if (entry.message === "Agent loop ended.") {
                const wasSuccessful = logList.querySelector(".log-entry--success") !== null;
                setStatus(wasSuccessful ? "done" : "idle");
                setButtons(false);
            }
        },
    });
    await loop.start(context);
}
function handleStop() {
    loop?.stop();
    setStatus("idle");
    setButtons(false);
}
function setStatus(state) {
    const labels = {
        idle: "Idle",
        running: "Running…",
        done: "Done ✓",
        error: "Error",
    };
    statusBadge.textContent = labels[state];
    statusBadge.className = `badge badge--${state}`;
}
function setButtons(running) {
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    taskInput.disabled = running;
}
function clearLog() {
    logList.innerHTML =
        '<li class="log-entry log-entry--info log-entry--placeholder">Agent output will appear here…</li>';
}
/** Map log level → minimal symbol */
const ICONS = {
    info: "·",
    success: "✓",
    warn: "⚠",
    error: "✕",
};
function appendLog(entry) {
    // Remove placeholder if present
    const placeholder = logList.querySelector(".log-entry--placeholder");
    if (placeholder)
        placeholder.remove();
    const li = document.createElement("li");
    li.className = `log-entry log-entry--${entry.level}`;
    const time = new Date(entry.timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
    li.innerHTML = `
    <span class="log-step">#${entry.step}</span>
    <span class="log-icon">${ICONS[entry.level] ?? "•"}</span>
    <span class="log-msg">${escapeHtml(entry.message)}</span>
    <span class="log-time">${time}</span>
  `;
    logList.appendChild(li);
    // Auto-scroll to the latest entry
    logList.scrollTop = logList.scrollHeight;
}
/** Show which fields were redacted before the context left the device. */
function renderPrivacyStrip(context) {
    const tags = context.ui_graph
        .map((el) => el.redaction)
        .filter((r) => r !== "NONE");
    if (tags.length === 0) {
        privacyStrip.classList.add("hidden");
        return;
    }
    // Deduplicate
    const unique = [...new Set(tags)];
    redactionTags.innerHTML = unique
        .map((t) => `<span class="redaction-tag">🔒 ${escapeHtml(t)}</span>`)
        .join("");
    privacyStrip.classList.remove("hidden");
}
function escapeHtml(str) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
// ---------------------------------------------------------------------------
// Context source
// ---------------------------------------------------------------------------
/**
 * Get the SanitizedContext for the current tab.
 *
 * Production: replace with chrome.runtime.sendMessage({ type: "GET_CONTEXT" })
 * and await the response from Ankit's content script.
 *
 * Development (current): returns a mock context so the popup UI can be
 * developed and tested without the extension infrastructure.
 */
async function getContext() {
    // Try to get real context from the extension runtime
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: "GET_CONTEXT" }, (response) => {
                resolve(response);
            });
        });
    }
    // Fallback: mock context for standalone development
    return buildMockContext();
}
function buildMockContext() {
    return {
        session_id: `dev-${Date.now()}`,
        url_domain: window.location.hostname || "localhost",
        screenshot_b64: null,
        viewport_width: window.innerWidth,
        viewport_height: window.innerHeight,
        ui_graph: [
            {
                element_id: "btn_submit",
                role: "button",
                label: "Submit",
                bbox: { x: 100, y: 400, width: 120, height: 40 },
                redaction: "NONE",
                clickable: true,
                editable: false,
            },
            {
                element_id: "input_email",
                role: "textbox",
                label: null,
                bbox: { x: 100, y: 200, width: 280, height: 36 },
                redaction: "EMAIL_REDACTED",
                clickable: false,
                editable: true,
            },
        ],
    };
}

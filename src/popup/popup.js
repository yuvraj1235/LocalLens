/**
 * popup.ts
 *
 * Wires the extension popup UI (popup.html) to the AgentLoop.
 */
import { AgentLoop } from "../agent/agentLoop";
import { getAutofillSettings, updateAutofillSettings, listCachedKeys, clearAllCachedValues, clearCachedValue, } from "../cache/fieldCache.js";
// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const taskInput = document.getElementById("task-input");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const clearBtn = document.getElementById("clear-btn");
const closeBtn = document.getElementById("close-btn");
const uploadBtn = document.getElementById("upload-btn");
const voiceBtn = document.getElementById("voice-btn");
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
// Close button
closeBtn?.addEventListener("click", () => {
    // If we are in an iframe (floating widget), tell the content script to destroy us
    if (window.self !== window.top) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.id) {
                chrome.tabs.sendMessage(tabs[0].id, { type: "TOGGLE_WIDGET" });
            }
        });
    }
    else {
        // Fallback if opened as a standard popup
        window.close();
    }
});
// Placeholder handlers for upcoming features
uploadBtn?.addEventListener("click", () => {
    appendLog({
        step: 0,
        level: "info",
        action: "UPLOAD",
        element_id: null,
        message: "Image upload feature coming soon.",
        timestamp: Date.now(),
    });
});
voiceBtn?.addEventListener("click", () => {
    appendLog({
        step: 0,
        level: "info",
        action: "VOICE",
        element_id: null,
        message: "Voice input feature coming soon.",
        timestamp: Date.now(),
    });
});
taskInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter")
        handleStart();
});
askSubmit.addEventListener("click", () => {
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
        await updateAutofillSettings({
            confirmRequired: autofillConfirmCb.checked,
        });
    });
    clearCacheBtn?.addEventListener("click", async () => {
        await clearAllCachedValues();
        renderCacheList();
    });
    const applyBtn = document.createElement("button");
    applyBtn.textContent = "Inject Pending Autofills";
    applyBtn.style.marginTop = "10px";
    applyBtn.style.width = "100%";
    applyBtn.style.padding = "6px";
    applyBtn.style.backgroundColor = "#6366f1";
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
        cacheList.innerHTML =
            '<li style="color: #666; font-size: 12px; padding: 4px;">Cache is empty</li>';
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
    cacheList.querySelectorAll("button").forEach((btn) => {
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
    // Add user message bubble to chat log
    appendLog({
        step: 0,
        level: "info",
        action: "USER",
        element_id: null,
        message: task,
        timestamp: Date.now(),
    });
    const context = await getContext();
    renderPrivacyStrip(context);
    loop = new AgentLoop({
        task,
        onLog: (entry) => {
            appendLog(entry);
            if (entry.action === "ASK_USER") {
                askMessage.textContent = entry.message;
                askOverlay.classList.remove("hidden");
            }
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
const ICONS = {
    info: "·",
    success: "✓",
    warn: "⚠",
    error: "✕",
};
function appendLog(entry) {
    const placeholder = logList.querySelector(".log-entry--placeholder");
    if (placeholder)
        placeholder.remove();
    const isUser = entry.action === "USER";
    const isAgentAnswer = entry.message.startsWith("Agent Answer:") ||
        entry.message.startsWith("Task completed: No,") ||
        entry.message.startsWith("Task completed: Yes,");
    const time = new Date(entry.timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
    const li = document.createElement("li");
    if (isUser) {
        // Render as user query bubble
        li.className = "log-entry log-entry--user-bubble";
        li.innerHTML = `
      <div class="bubble-header"><span>You</span><span>${time}</span></div>
      <div class="bubble-content">${escapeHtml(entry.message)}</div>
    `;
    }
    else if (isAgentAnswer) {
        // Render as chatbot response bubble
        const cleanAnswer = entry.message.replace(/^Agent Answer:\s*/, "");
        li.className = "log-entry log-entry--agent-bubble";
        li.innerHTML = `
      <div class="bubble-header"><span>LocalLens Agent</span><span>${time}</span></div>
      <div class="bubble-content">${escapeHtml(cleanAnswer)}</div>
    `;
    }
    else {
        // Standard system step log
        li.className = `log-entry log-entry--${entry.level}`;
        li.innerHTML = `
      <span class="log-step">#${entry.step}</span>
      <span class="log-icon">${ICONS[entry.level] ?? "•"}</span>
      <span class="log-msg">${escapeHtml(entry.message)}</span>
      <span class="log-time">${time}</span>
    `;
    }
    logList.appendChild(li);
    logList.scrollTop = logList.scrollHeight;
}
function renderPrivacyStrip(context) {
    const tags = context.ui_graph
        .map((el) => el.redaction)
        .filter((r) => r !== "NONE");
    if (tags.length === 0) {
        privacyStrip.classList.add("hidden");
        return;
    }
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
async function getContext() {
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: "GET_CONTEXT" }, (response) => {
                resolve(response);
            });
        });
    }
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

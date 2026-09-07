/**
 * popup.ts
 *
 * Wires the extension popup UI (popup.html) to the AgentLoop.
 */

import { AgentLoop, SanitizedContext, LogEntry } from "../agent/agentLoop";
import {
  getAutofillSettings,
  updateAutofillSettings,
  listCachedKeys,
  clearAllCachedValues,
  clearCachedValue,
} from "../cache/fieldCache.js";

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const taskInput = document.getElementById("task-input") as HTMLInputElement;
const startBtn = document.getElementById("start-btn") as HTMLButtonElement;
const stopBtn = document.getElementById("stop-btn") as HTMLButtonElement;
const clearBtn = document.getElementById("clear-btn") as HTMLButtonElement;
const closeBtn = document.getElementById(
  "close-btn",
) as HTMLButtonElement | null;
const uploadBtn = document.getElementById(
  "upload-btn",
) as HTMLButtonElement | null;
const voiceBtn = document.getElementById(
  "voice-btn",
) as HTMLButtonElement | null;
const statusBadge = document.getElementById("status-badge") as HTMLElement;
const logList = document.getElementById("log-list") as HTMLUListElement;
const privacyStrip = document.getElementById("privacy-strip") as HTMLElement;
const redactionTags = document.getElementById("redaction-tags") as HTMLElement;
const askOverlay = document.getElementById("ask-user-overlay") as HTMLElement;
const askMessage = document.getElementById(
  "ask-user-message",
) as HTMLParagraphElement;
const askInput = document.getElementById("ask-user-input") as HTMLInputElement;
const askSubmit = document.getElementById(
  "ask-user-submit",
) as HTMLButtonElement;

// Autofill settings
const autofillEnableCb = document.getElementById(
  "autofill-enable-cb",
) as HTMLInputElement;
const autofillConfirmCb = document.getElementById(
  "autofill-confirm-cb",
) as HTMLInputElement;
const clearCacheBtn = document.getElementById(
  "clear-cache-btn",
) as HTMLButtonElement;
const cacheList = document.getElementById("cache-list") as HTMLUListElement;

// Privacy controls
const privacyKeyInput = document.getElementById(
  "privacy-key-input",
) as HTMLInputElement | null;
const privacyAddBtn = document.getElementById(
  "privacy-add-btn",
) as HTMLButtonElement | null;
const privacyKeysList = document.getElementById(
  "privacy-keys-list",
) as HTMLUListElement | null;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let loop: AgentLoop | null = null;

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
  } else {
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
// ---------------------------------------------------------------------------
// Deepgram Voice Input via FastAPI Backend (Bypasses Brave / Browser blocks)
// ---------------------------------------------------------------------------

let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let isRecording = false;
let originalPlaceholder = "";

voiceBtn?.addEventListener("click", async () => {
  if (!voiceBtn || !taskInput) return;

  if (!isRecording) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      audioChunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        if (taskInput) {
          taskInput.placeholder = originalPlaceholder;
          taskInput.disabled = false;
        }

        const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
        const formData = new FormData();
        formData.append("file", audioBlob, "voice-input.webm");

        appendLog({
          step: 0,
          level: "info",
          action: "VOICE",
          element_id: null,
          message: "Transcribing audio via Deepgram...",
          timestamp: Date.now(),
        });

        try {
          const response = await fetch("http://localhost:8000/transcribe", {
            method: "POST",
            body: formData,
          });

          if (!response.ok) {
            const errDetail = await response.text();
            throw new Error(`Server error: ${errDetail}`);
          }

          const data = await response.json();
          if (data.transcript) {
            taskInput.value = data.transcript;
            handleStart(); // Automatically trigger execution with transcribed text
          } else {
            appendLog({
              step: 0,
              level: "warn",
              action: "VOICE",
              element_id: null,
              message: "No speech detected. Please try again.",
              timestamp: Date.now(),
            });
          }
        } catch (err: any) {
          appendLog({
            step: 0,
            level: "error",
            action: "VOICE",
            element_id: null,
            message: `Transcription failed: ${err.message}`,
            timestamp: Date.now(),
          });
        }
      };

      mediaRecorder.start();
      isRecording = true;

      // UI state update
      voiceBtn.style.backgroundColor = "#ef4444";
      voiceBtn.style.boxShadow = "0 0 10px #ef4444";
      originalPlaceholder = taskInput.placeholder;
      taskInput.placeholder = "🔴 Listening... Speak now";
      taskInput.style.borderColor = "#ef4444";

    } catch (err: any) {
      console.error("Microphone access denied:", err);
      appendLog({
        step: 0,
        level: "error",
        action: "VOICE",
        element_id: null,
        message: "Microphone permission denied. Allow mic access in Brave settings.",
        timestamp: Date.now(),
      });
    }
  } else {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
      mediaRecorder.stream.getTracks().forEach((track) => track.stop());
    }
    isRecording = false;
    
    if (voiceBtn) {
      voiceBtn.style.backgroundColor = "";
      voiceBtn.style.boxShadow = "";
    }
    if (taskInput) {
      taskInput.style.borderColor = "";
      if (originalPlaceholder) taskInput.placeholder = originalPlaceholder;
    }
  }
});

taskInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleStart();
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
  if (autofillEnableCb) autofillEnableCb.checked = settings.enabled;
  if (autofillConfirmCb) autofillConfirmCb.checked = settings.confirmRequired;

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
  if (!cacheList) return;
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
      const target = e.target as HTMLButtonElement;
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
// Privacy Controls handlers
// ---------------------------------------------------------------------------

async function renderPrivacyKeysList(): Promise<void> {
  if (!privacyKeysList) return;
  const settings = await getAutofillSettings();
  const keys = settings.userRedactedKeys;

  privacyKeysList.innerHTML = "";
  if (keys.length === 0) {
    privacyKeysList.innerHTML =
      '<li style="color: #666; font-size: 12px; padding: 4px;">No custom fields added yet.</li>';
    return;
  }

  for (const key of keys) {
    const li = document.createElement("li");
    li.className = "privacy-key-item";
    li.innerHTML = `
      <span class="privacy-chip privacy-chip--user">🔒 ${escapeHtml(key)}</span>
      <button class="btn btn--ghost btn--sm" data-key="${escapeHtml(key)}" title="Remove">✕</button>
    `;
    privacyKeysList.appendChild(li);
  }

  privacyKeysList.querySelectorAll("button[data-key]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const target = e.target as HTMLButtonElement;
      const k = target.getAttribute("data-key");
      if (!k) return;
      const current = await getAutofillSettings();
      await updateAutofillSettings({
        userRedactedKeys: current.userRedactedKeys.filter((x) => x !== k),
      });
      renderPrivacyKeysList();
    });
  });
}

async function addPrivacyKey(): Promise<void> {
  if (!privacyKeyInput) return;
  // Normalize: lowercase, replace spaces with underscores
  const raw = privacyKeyInput.value.trim().toLowerCase().replace(/\s+/g, "_");
  if (!raw) return;

  const current = await getAutofillSettings();
  if (!current.userRedactedKeys.includes(raw)) {
    await updateAutofillSettings({
      userRedactedKeys: [...current.userRedactedKeys, raw],
    });
  }
  privacyKeyInput.value = "";
  renderPrivacyKeysList();
}

function initPrivacyControls(): void {
  privacyAddBtn?.addEventListener("click", addPrivacyKey);
  privacyKeyInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addPrivacyKey();
  });
  renderPrivacyKeysList();
}

initPrivacyControls();

// ---------------------------------------------------------------------------
// Core handlers
// ---------------------------------------------------------------------------

async function triggerAutofill() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]?.id) {
    chrome.tabs.sendMessage(
      tabs[0].id,
      { type: "APPLY_AUTOFILL" },
      (response) => {
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
      },
    );
  }
}

async function handleStart(): Promise<void> {
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
        const wasSuccessful =
          logList.querySelector(".log-entry--success") !== null;
        setStatus(wasSuccessful ? "done" : "idle");
        setButtons(false);
      }
    },
  });

  await loop.start(context);
}

function handleStop(): void {
  loop?.stop();
  setStatus("idle");
  setButtons(false);
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

type BadgeState = "idle" | "running" | "done" | "error";

function setStatus(state: BadgeState): void {
  const labels: Record<BadgeState, string> = {
    idle: "Idle",
    running: "Running…",
    done: "Done ✓",
    error: "Error",
  };
  statusBadge.textContent = labels[state];
  statusBadge.className = `badge badge--${state}`;
}

function setButtons(running: boolean): void {
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  taskInput.disabled = running;
}

function clearLog(): void {
  logList.innerHTML =
    '<li class="log-entry log-entry--info log-entry--placeholder">Agent output will appear here…</li>';
}

const ICONS: Record<string, string> = {
  info: "·",
  success: "✓",
  warn: "⚠",
  error: "✕",
};

function appendLog(entry: LogEntry): void {
  const placeholder = logList.querySelector(".log-entry--placeholder");
  if (placeholder) placeholder.remove();

  const isUser = entry.action === "USER";
  const isAgentAnswer =
    entry.message.startsWith("Agent Answer:") ||
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
  } else if (isAgentAnswer) {
    // Render as chatbot response bubble
    const cleanAnswer = entry.message.replace(/^Agent Answer:\s*/, "");
    li.className = "log-entry log-entry--agent-bubble";
    li.innerHTML = `
      <div class="bubble-header"><span>LocalLens Agent</span><span>${time}</span></div>
      <div class="bubble-content">${escapeHtml(cleanAnswer)}</div>
    `;
  } else {
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

function renderPrivacyStrip(context: SanitizedContext): void {
  const redactedElements = context.ui_graph.filter((el) => el.redaction !== "NONE");

  if (redactedElements.length === 0) {
    privacyStrip.classList.add("hidden");
    return;
  }

  // Build a deduplicated list of label+tag chips for display
  const seen = new Set<string>();
  const chips: string[] = [];
  for (const el of redactedElements) {
    const label = (el as any).redacted_label as string | null | undefined;
    const display = label ? `${label} (${el.redaction})` : el.redaction;
    if (!seen.has(display)) {
      seen.add(display);
      chips.push(display);
    }
  }

  redactionTags.innerHTML = chips
    .map((t) => `<span class="redaction-tag">🔒 ${escapeHtml(t)}</span>`)
    .join("");
  privacyStrip.classList.remove("hidden");
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function getContext(): Promise<SanitizedContext> {
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_CONTEXT" }, (response) => {
        resolve(response as SanitizedContext);
      });
    });
  }
  return buildMockContext();
}

function buildMockContext(): SanitizedContext {
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
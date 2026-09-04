/**
 * popup.ts — LocalLens Popup Script
 */
import { AgentLoop } from "../agent/agentLoop";

const taskInput = document.getElementById("task-input") as HTMLInputElement;
const startBtn = document.getElementById("start-btn") as HTMLButtonElement;
const stopBtn = document.getElementById("stop-btn") as HTMLButtonElement;
const clearBtn = document.getElementById("clear-btn") as HTMLButtonElement;
const statusBadge = document.getElementById("status-badge") as HTMLElement;
const logList = document.getElementById("log-list") as HTMLElement;
const privacyStrip = document.getElementById("privacy-strip") as HTMLElement;
const redactionTags = document.getElementById("redaction-tags") as HTMLElement;
const askOverlay = document.getElementById("ask-user-overlay") as HTMLElement;
const askMessage = document.getElementById("ask-user-message") as HTMLElement;
const askInput = document.getElementById("ask-user-input") as HTMLInputElement;
const askSubmit = document.getElementById("ask-user-submit") as HTMLButtonElement;

let loop: AgentLoop | null = null;

startBtn.addEventListener("click", handleStart);
stopBtn.addEventListener("click", handleStop);
clearBtn.addEventListener("click", clearLog);
taskInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") handleStart();
});

askSubmit.addEventListener("click", () => {
    const userReply = askInput.value.trim();
    askOverlay.classList.add("hidden");

    appendLog({
        step: 0,
        level: "info",
        action: "ASK_USER",
        element_id: null,
        message: `User replied: "${userReply}"`,
        timestamp: Date.now(),
    });

    if (userReply && taskInput) {
        taskInput.value = `${taskInput.value} (User Input: ${userReply})`;
    }
    askInput.value = "";
});

async function handleStart() {
    const task = taskInput.value.trim();
    if (!task) {
        taskInput.focus();
        return;
    }
    clearLog();
    setStatus("running");
    setButtons(true);

    const context = await getContext();

    if (!context || (context as any).error) {
        appendLog({
            step: 0,
            level: "error",
            action: null,
            element_id: null,
            message: `Context error: ${(context as any)?.error || "Failed to fetch tab context."}`,
            timestamp: Date.now(),
        });
        setStatus("error");
        setButtons(false);
        return;
    }

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

function setStatus(state: "idle" | "running" | "done" | "error") {
    const labels = {
        idle: "Idle",
        running: "Running…",
        done: "Done ✓",
        error: "Error",
    };
    statusBadge.textContent = labels[state];
    statusBadge.className = `badge badge--${state}`;
}

function setButtons(running: boolean) {
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    taskInput.disabled = running;
}

function clearLog() {
    logList.innerHTML =
        '<li class="log-entry log-entry--info log-entry--placeholder">Agent output will appear here…</li>';
}

const ICONS: Record<string, string> = {
    info: "·",
    success: "✓",
    warn: "⚠",
    error: "✕",
};

function appendLog(entry: any) {
    const placeholder = logList.querySelector(".log-entry--placeholder");
    if (placeholder) placeholder.remove();

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
    logList.scrollTop = logList.scrollHeight;
}

function renderPrivacyStrip(context: any) {
    if (!context || !Array.isArray(context.ui_graph)) {
        privacyStrip.classList.add("hidden");
        return;
    }

    const tags = context.ui_graph
        .map((el: any) => el.redaction)
        .filter((r: string) => r && r !== "NONE");

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

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

async function getContext(): Promise<any> {
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: "GET_CONTEXT" }, (response) => {
                if (chrome.runtime.lastError) {
                    resolve({ error: chrome.runtime.lastError.message });
                } else {
                    resolve(response);
                }
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
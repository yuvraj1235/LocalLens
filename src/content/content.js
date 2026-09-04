/**
 * content.ts — LocalLens Content Script (MV3)
 */
import { executeAction } from "../agent/actionExecutor";

const PII_PATTERNS = [
    { label: "EMAIL_REDACTED", re: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
    { label: "PII_REDACTED", re: /(\+?\d[\d\s\-().]{7,}\d)/g },
    { label: "CARD_REDACTED", re: /\b(?:\d[ -]?){13,16}\b/g },
    { label: "PII_REDACTED", re: /\b\d{3}-\d{2}-\d{4}\b/g },
    { label: "PASSWORD_REDACTED", re: /password|passwd|secret|token/i },
];

function detectPii(text: string): string {
    for (const { label, re } of PII_PATTERNS) {
        if (re.test(text)) return label;
    }
    return "NONE";
}

function getLabel(el: Element): string | null {
    return (
        el.getAttribute("aria-label") ||
        (el as HTMLInputElement).placeholder ||
        (() => {
            const id = el.id;
            if (!id) return null;
            const lbl = document.querySelector(`label[for="${id}"]`);
            return lbl?.textContent?.trim() ?? null;
        })() ||
        el.getAttribute("title") ||
        el.textContent?.trim().slice(0, 60) ||
        null
    );
}

function getBbox(el: Element) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
    };
}

const ROLE_MAP: Record<string, string> = {
    A: "link",
    BUTTON: "button",
    INPUT: "textbox",
    SELECT: "listbox",
    TEXTAREA: "textbox",
    DETAILS: "group",
    SUMMARY: "button",
    H1: "heading",
    H2: "heading",
    H3: "heading",
    IMG: "img",
    FORM: "form",
};

function getRole(el: Element): string {
    return el.getAttribute("role") || ROLE_MAP[el.tagName] || "generic";
}

const SELECTOR = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "[role=button]",
    "[role=link]",
    "[role=checkbox]",
    "[role=menuitem]",
    "[role=tab]",
    "[role=option]",
    "[tabindex]",
].join(",");

let agentIdCounter = 0;

function ensureStampedAndBuildGraph() {
    const elements: any[] = [];

    document.querySelectorAll(SELECTOR).forEach((el) => {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
            return;
        }

        const bbox = getBbox(el);
        if (!bbox) return;

        // PRESERVE EXISTING STAMPED ID: Do not overwrite if element already has data-agent-id
        let agentId = el.getAttribute("data-agent-id");
        if (!agentId) {
            agentId = `agent_${agentIdCounter++}`;
            el.setAttribute("data-agent-id", agentId);
        }

        const rawLabel = getLabel(el) ?? "";
        const redaction = detectPii(rawLabel);
        const isEditable =
            el.tagName === "INPUT" ||
            el.tagName === "TEXTAREA" ||
            el.getAttribute("contenteditable") === "true";

        elements.push({
            element_id: agentId,
            role: getRole(el),
            label: redaction === "NONE" ? rawLabel || null : null,
            bbox,
            redaction,
            clickable:
                el.tagName === "BUTTON" ||
                el.tagName === "A" ||
                !!(el as HTMLElement).onclick ||
                el.getAttribute("role") === "button",
            editable: isEditable,
        });
    });

    return elements;
}

function buildContext() {
    return {
        session_id: `tab-${Date.now()}`,
        url_domain: window.location.hostname,
        screenshot_b64: null,
        viewport_width: window.innerWidth,
        viewport_height: window.innerHeight,
        ui_graph: ensureStampedAndBuildGraph(),
    };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "GET_CONTEXT") {
        sendResponse(buildContext());
        return true;
    }

    if (msg.type === "EXECUTE_ACTION") {
        const action = msg.action;

        // If target element is missing, trigger DOM re-stamping check
        if (action.element_id && !document.querySelector(`[data-agent-id="${action.element_id}"]`)) {
            ensureStampedAndBuildGraph();
        }

        executeAction(action)
            .then(sendResponse)
            .catch((err) => sendResponse({ status: "error", message: String(err) }));
        return true;
    }
});

console.log("[LocalLens] Content script loaded on", window.location.hostname);
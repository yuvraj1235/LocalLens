/**
 * content.ts — LocalLens Content Script (MV3)
 *
 * Runs in the context of every page. Responsibilities:
 *  1. Walk the DOM and build a SanitizedContext (UIGraph + metadata).
 *  2. Stamp every interactive element with [data-agent-id] so the
 *     actionExecutor can resolve element_id → DOM node later.
 *  3. Listen for GET_CONTEXT messages from the popup/background and reply.
 *  4. Listen for EXECUTE_ACTION messages and run them on the live DOM.
 */

import type { SanitizedContext, UIElement, BoundingBox, RedactionTag } from "../ui/types";
import { executeAction } from "../agent/actionExecutor";
import type { StructuredAction } from "../agent/actionExecutor";

// ---------------------------------------------------------------------------
// PII patterns — redact sensitive text before it ever leaves the device
// ---------------------------------------------------------------------------

const PII_PATTERNS: { label: RedactionTag; re: RegExp }[] = [
  { label: "EMAIL_REDACTED",   re: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
  { label: "PII_REDACTED",     re: /(\+?\d[\d\s\-().]{7,}\d)/g },
  { label: "CARD_REDACTED",    re: /\b(?:\d[ -]?){13,16}\b/g },
  { label: "PII_REDACTED",     re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { label: "PASSWORD_REDACTED",re: /password|passwd|secret|token/i },
];

function detectPii(text: string): RedactionTag {
  for (const { label, re } of PII_PATTERNS) {
    if (re.test(text)) return label;
  }
  return "NONE";
}

function getLabel(el: Element): string | null {
  // aria-label → placeholder → associated <label> → title → null
  return (
    el.getAttribute("aria-label") ||
    (el as HTMLInputElement).placeholder ||
    (() => {
      const id = el.id;
      if (!id) return null;
      const lbl = document.querySelector<HTMLLabelElement>(`label[for="${id}"]`);
      return lbl?.textContent?.trim() ?? null;
    })() ||
    el.getAttribute("title") ||
    el.textContent?.trim().slice(0, 60) ||
    null
  );
}

function getBbox(el: Element): BoundingBox | null {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
}

// Roles that map to ARIA / semantic roles
const ROLE_MAP: Record<string, string> = {
  A: "link", BUTTON: "button", INPUT: "textbox", SELECT: "listbox",
  TEXTAREA: "textbox", DETAILS: "group", SUMMARY: "button",
  H1: "heading", H2: "heading", H3: "heading",
  IMG: "img", FORM: "form",
};

function getRole(el: Element): string {
  return el.getAttribute("role") || ROLE_MAP[el.tagName] || "generic";
}

// ---------------------------------------------------------------------------
// DOM walker — builds the UIGraph
// ---------------------------------------------------------------------------

// Counter never resets — IDs are permanent for the lifetime of the content script.
// New elements that appear after the first stamp get the next available number.
let agentIdCounter = 0;

function buildUIGraph(): UIElement[] {
  const elements: UIElement[] = [];

  const SELECTOR = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=menuitem]",
    "[role=tab]", "[role=option]", "[tabindex]",
  ].join(",");

  document.querySelectorAll<HTMLElement>(SELECTOR).forEach((el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return;

    const bbox = getBbox(el);
    if (!bbox) return;

    // PRESERVE existing stamp — only assign a new ID if the element doesn't have one yet.
    // This keeps IDs stable across repeated GET_CONTEXT calls.
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
      clickable: el.tagName === "BUTTON" || el.tagName === "A" || !!el.onclick || el.getAttribute("role") === "button",
      editable: isEditable,
    });
  });

  return elements;
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

function buildContext(): SanitizedContext {
  return {
    session_id: `tab-${Date.now()}`,
    url_domain: window.location.hostname,
    screenshot_b64: null, // screenshot handled by background via chrome.tabs.captureVisibleTab
    viewport_width: window.innerWidth,
    viewport_height: window.innerHeight,
    ui_graph: buildUIGraph(),
  };
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_CONTEXT") {
    sendResponse(buildContext());
    return true; // keep channel open for async
  }

  if (msg.type === "EXECUTE_ACTION") {
    const action = msg.action as StructuredAction;
    executeAction(action).then(sendResponse);
    return true; // async response
  }
});

console.log("[LocalLens] Content script loaded on", window.location.hostname);

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
import { setupCacheListeners, getSemanticKey } from "./cacheIntegration";
import { getCachedValue, getAutofillSettings } from "../cache/fieldCache";

/**
 * In-memory map of agentId → plaintext cached value.
 * Values are NEVER written to the DOM until the user explicitly confirms.
 * Cleared on each full buildUIGraph() call so stale suggestions don't linger.
 */
const pendingAutofillSuggestions = new Map<string, string>();

/**
 * Called by the popup confirm handler when the user accepts an autofill suggestion.
 * Only then does the plaintext value touch the live DOM.
 */
export function applyAutofillSuggestion(agentId: string): boolean {
  const value = pendingAutofillSuggestions.get(agentId);
  if (!value) return false;
  
  const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[data-agent-id="${agentId}"]`
  );
  
  if (el) {
    // 1. Get the native property descriptor
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    
    const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;

    // 2. Call the native setter bypassing React's wrapper
    if (el.tagName === "INPUT" && nativeInputValueSetter) {
      nativeInputValueSetter.call(el, value);
    } else if (el.tagName === "TEXTAREA" && nativeTextAreaValueSetter) {
      nativeTextAreaValueSetter.call(el, value);
    } else {
      el.value = value; // Fallback for standard HTML
    }

    // 3. Dispatch events that frameworks listen to
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  
  pendingAutofillSuggestions.delete(agentId);
  return !!el;
}

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
    re.lastIndex = 0; // Reset stateful /g regex before each test() call.
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

const SESSION_ID = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let agentIdCounter = 0;

async function buildUIGraph(): Promise<UIElement[]> {
  const elements: UIElement[] = [];
  const settings = await getAutofillSettings();

  const SELECTOR = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=menuitem]",
    "[role=tab]", "[role=option]", "[tabindex]",
  ].join(",");

  pendingAutofillSuggestions.clear();

  const nodes = document.querySelectorAll<HTMLElement>(SELECTOR);
  for (const el of Array.from(nodes)) {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;

    const bbox = getBbox(el);
    if (!bbox) continue;

    let agentId = el.getAttribute("data-agent-id");
    if (!agentId) {
      agentId = `agent_${agentIdCounter++}`;
      el.setAttribute("data-agent-id", agentId);
    }

    let rawLabel = getLabel(el) ?? "";
    let redaction = detectPii(rawLabel);

    // Bulletproof redaction overrides based on HTML attributes
    if (el.tagName === "INPUT") {
      const inputEl = el as HTMLInputElement;
      const inputType = (inputEl.type || "").toLowerCase();
      const inputName = (inputEl.name || "").toLowerCase();
      
      if (inputType === "password" || inputName.includes("password")) {
        redaction = "PASSWORD_REDACTED";
      } else if (inputType === "email" || inputName.includes("email")) {
        redaction = "EMAIL_REDACTED";
      } else if (inputType === "tel" || inputName.includes("phone")) {
        redaction = "PII_REDACTED";
      }
    }

    const isEditable =
      el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.getAttribute("contenteditable") === "true";

    let hasCacheSuggestion = false;
    if (isEditable && settings.enabled) {
      const key = getSemanticKey(el);
      if (key) {
        const cached = await getCachedValue(key);
        if (cached) {
          hasCacheSuggestion = true;
          pendingAutofillSuggestions.set(agentId, cached);
          el.setAttribute("data-autofill-pending", "1");
        }
      }
    }

    elements.push({
      element_id: agentId,
      role: getRole(el),
      label: redaction === "NONE" ? rawLabel || null : null,
      bbox,
      redaction,
      clickable:
        el.tagName === "BUTTON" ||
        el.tagName === "A" ||
        !!el.onclick ||
        el.getAttribute("role") === "button" ||
        el.getAttribute("role") === "link" ||
        (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1"),
      editable: isEditable,
    });
  }

  return elements;
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

async function buildContext(): Promise<SanitizedContext> {
  return {
    session_id: SESSION_ID,
    url_domain: window.location.hostname,
    screenshot_b64: null,
    viewport_width: window.innerWidth,
    viewport_height: window.innerHeight,
    ui_graph: await buildUIGraph(),
  };
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_CONTEXT") {
    buildContext().then(sendResponse);
    return true; 
  }

  if (msg.type === "EXECUTE_ACTION") {
    const action = msg.action as StructuredAction;
    executeAction(action).then(sendResponse);
    return true; 
  }

  // Listen for manual autofill confirmation from the popup
  if (msg.type === "APPLY_AUTOFILL") {
    buildUIGraph().then(() => {
      let appliedCount = 0;
      for (const agentId of pendingAutofillSuggestions.keys()) {
        if (applyAutofillSuggestion(agentId)) {
          appliedCount++;
        }
      }
      sendResponse({ success: true, count: appliedCount });
    }).catch(err => {
      console.error("[LocalLens] Autofill scan failed:", err);
      sendResponse({ success: false, count: 0 });
    });
    
    return true; 
  }
});

setupCacheListeners();
console.log("[LocalLens] Content script loaded on", window.location.hostname);
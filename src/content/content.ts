"use strict";
/**
 * background.ts — LocalLens Service Worker (MV3)
 *
 * Relay messages between the popup/side panel/floating widget and the
 * active tab's content script. Cross-context communication in MV3 must
 * go through the service worker.
 */

interface RelayMessage {
  type: string;
  [key: string]: unknown;
}

type SendResponse = (response?: unknown) => void;

chrome.runtime.onInstalled.addListener(() => {
  console.log("[LocalLens] Extension installed / updated.");
});

// ---------------------------------------------------------------------------
// Toggle the floating widget on icon click
// ---------------------------------------------------------------------------
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_WIDGET" }).catch(() => {
      console.log("Could not toggle widget. Is the content script loaded?");
    });
  }
});

// ---------------------------------------------------------------------------
// Relay: popup / side panel / floating-widget iframe → background → content script
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener(
  (msg: RelayMessage, sender: chrome.runtime.MessageSender, sendResponse: SendResponse) => {
    // Only relay messages that come from our OWN extension UI surfaces
    // (popup, side panel, or the floating widget's injected iframe).
    // NOTE: sender.tab is set for the floating widget too, since it's an
    // extension-origin iframe embedded inside the page — so checking
    // sender.tab alone incorrectly filters it out. Check sender.url instead.
    const fromOwnExtensionUI = sender.url?.startsWith(chrome.runtime.getURL(""));

    // PAGE_CHANGED / DOM_CHANGED originate from content.ts itself (not our
    // UI), so they must be allowed through even though sender.tab is set
    // and sender.url is the page's own URL, not an extension URL.
    if (msg.type === "PAGE_CHANGED" || msg.type === "DOM_CHANGED") {
      // Just forward straight through — no relay target needed, this is
      // a broadcast-style notification for whichever UI is listening.
      chrome.runtime.sendMessage(msg).catch(() => {
        // No UI currently listening (side panel/widget closed) — fine.
      });
      return; // not expecting a sendResponse for this message type
    }

    if (!fromOwnExtensionUI) {
      return; // ignore anything not from our own popup/side panel/widget
    }

    if (msg.type === "GET_CONTEXT" || msg.type === "EXECUTE_ACTION") {
      // If the message came from the floating widget iframe, sender.tab
      // already tells us exactly which tab it's embedded in — use that
      // directly instead of re-querying "active tab", which can resolve
      // to the wrong tab if focus has moved elsewhere.
      if (sender.tab?.id) {
        relayToTab(sender.tab.id, msg, sendResponse);
      } else {
        // Came from popup/side panel (no sender.tab) — fall back to
        // querying the active tab in the currently focused window.
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs: chrome.tabs.Tab[]) => {
          const tab = tabs[0];
          if (!tab?.id) {
            sendResponse({ error: "No active tab found." });
            return;
          }
          relayToTab(tab.id, msg, sendResponse);
        });
      }
      return true; // keep message channel open for async response
    }
  }
);

function relayToTab(
  tabId: number,
  msg: RelayMessage,
  sendResponse: SendResponse,
  attempt = 0
): void {
  chrome.tabs.sendMessage(tabId, msg, (response: unknown) => {
    if (chrome.runtime.lastError) {
      const isConnectionError = chrome.runtime.lastError.message?.includes(
        "Receiving end does not exist"
      );
      if (isConnectionError && attempt < 3) {
        // Content script probably still injecting after a fresh
        // navigation — retry shortly instead of failing immediately.
        setTimeout(() => relayToTab(tabId, msg, sendResponse, attempt + 1), 200);
        return;
      }
      console.error("[LocalLens BG] Relay error:", chrome.runtime.lastError.message);
      sendResponse({ error: chrome.runtime.lastError.message });
    } else {
      sendResponse(response);
    }
  });
}
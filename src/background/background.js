"use strict";
/**
 * background.ts — LocalLens Service Worker (MV3)
 *
 * Relay messages between the popup and the active tab's content script.
 * The popup cannot talk to content scripts directly in MV3 — all cross-context
 * communication goes through the service worker.
 */
chrome.runtime.onInstalled.addListener(() => {
    console.log("[LocalLens] Extension installed / updated.");
});
// ---------------------------------------------------------------------------
// Relay: popup → background → content script (and back)
// ---------------------------------------------------------------------------
chrome.action.onClicked.addListener((tab) => {
    if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_WIDGET" }).catch(() => {
            console.log("Could not toggle widget. Is the content script loaded?");
        });
    }
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // ---------------------------------------------------------------------------
    // CAPTURE_SCREENSHOT — callable from content scripts.
    // Only the service worker can call captureVisibleTab; content scripts delegate
    // here so they don't need the "tabs" host permission themselves.
    // ---------------------------------------------------------------------------
    if (msg.type === "CAPTURE_SCREENSHOT") {
        // Use the sender tab's windowId when available (content script origin),
        // otherwise fall back to the current window.
        const windowId = sender.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
        chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 70 }, // JPEG 70% — good VLM input, ~60 KB
        (dataUrl) => {
            if (chrome.runtime.lastError) {
                console.warn("[LocalLens BG] captureVisibleTab failed:", chrome.runtime.lastError.message);
                sendResponse({ error: chrome.runtime.lastError.message, screenshot_b64: null });
            }
            else {
                // Strip the data-URL prefix — send only the raw base64 payload.
                const b64 = dataUrl?.replace(/^data:image\/jpeg;base64,/, "") ?? null;
                sendResponse({ screenshot_b64: b64 });
            }
        });
        return true; // async — keep channel open
    }
    // Only relay non-screenshot messages that didn't originate from a content script
    if (sender.tab)
        return;
    if (msg.type === "GET_CONTEXT" || msg.type === "EXECUTE_ACTION") {
        // Forward to the active tab
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tab = tabs[0];
            if (!tab?.id) {
                sendResponse({ error: "No active tab found." });
                return;
            }
            chrome.tabs.sendMessage(tab.id, msg, (response) => {
                if (chrome.runtime.lastError) {
                    console.error("[LocalLens BG] Relay error:", chrome.runtime.lastError.message);
                    sendResponse({ error: chrome.runtime.lastError.message });
                }
                else {
                    sendResponse(response);
                }
            });
        });
        return true; // keep message channel open for async response
    }
});

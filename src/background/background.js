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
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only relay messages that didn't originate from a content script
    if (sender.tab)
        return; // came from content script — ignore
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

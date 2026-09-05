/**
 * src/content/cacheIntegration.ts
 *
 * Implements DOM listeners for caching field values on blur/submit,
 * and querying the cache during context generation.
 */

import { classifyField } from "../cache/fieldClassifier.js";
import { setCachedValue, getAutofillSettings } from "../cache/fieldCache.js";

// Helper to extract a semantic key from a DOM element
export function getSemanticKey(el: HTMLElement): string | null {
    const labelText = (() => {
        const id = el.id;
        if (id) {
            const lbl = document.querySelector<HTMLLabelElement>(`label[for="${id}"]`);
            if (lbl) return lbl.textContent?.trim();
        }
        return el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || "";
    })();

    // In a full integration, we might also have the PII type from the vision pass,
    // but here in the content script we rely primarily on DOM signals.
    return classifyField({
        id: el.id,
        name: (el as HTMLInputElement).name,
        autocomplete: (el as HTMLInputElement).autocomplete,
        type: (el as HTMLInputElement).type,
        label: labelText
    });
}

// Called when a field loses focus
export async function handleFieldBlur(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
    const settings = await getAutofillSettings();
    if (!settings.enabled) return;

    const val = el.value.trim();
    if (!val) return;

    const key = getSemanticKey(el);
    if (key) {
        await setCachedValue(key, val);
    }
}

// Installs listeners on the current page
export function setupCacheListeners() {
    document.addEventListener("blur", (e) => {
        const target = e.target as HTMLElement;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) {
            handleFieldBlur(target as any);
        }
    }, true); // use capture phase for blur

    document.addEventListener("submit", (e) => {
        const form = e.target as HTMLFormElement;
        if (form && form.elements) {
            for (let i = 0; i < form.elements.length; i++) {
                const el = form.elements[i] as HTMLElement;
                if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
                    handleFieldBlur(el as any);
                }
            }
        }
    }, true);
}

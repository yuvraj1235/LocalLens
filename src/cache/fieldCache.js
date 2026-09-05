/**
 * src/cache/fieldCache.ts
 *
 * Provides an encrypted local storage interface for caching field values.
 * Hard-excludes PASSWORD and OTP from ever being cached.
 */
const CACHE_PREFIX = "field_cache_";
const KEY_STORAGE_ID = "_autofill_master_key";
// Pure Uint8Array ↔ base64 helpers — no window.atob/btoa, works in service workers and Node.
const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function ab2b64(buf) {
    const bytes = new Uint8Array(buf);
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i], b1 = bytes[i + 1] ?? 0, b2 = bytes[i + 2] ?? 0;
        out += BASE64_CHARS[b0 >> 2];
        out += BASE64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
        out += i + 1 < bytes.length ? BASE64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : "=";
        out += i + 2 < bytes.length ? BASE64_CHARS[b2 & 63] : "=";
    }
    return out;
}
function b642ab(b64) {
    const table = {};
    for (let i = 0; i < BASE64_CHARS.length; i++)
        table[BASE64_CHARS[i]] = i;
    const clean = b64.replace(/=/g, "");
    const bytes = new Uint8Array(Math.floor(clean.length * 3 / 4));
    let bi = 0;
    for (let i = 0; i < clean.length; i += 4) {
        const v0 = table[clean[i]] ?? 0;
        const v1 = table[clean[i + 1]] ?? 0;
        const v2 = table[clean[i + 2]] ?? 0;
        const v3 = table[clean[i + 3]] ?? 0;
        bytes[bi++] = (v0 << 2) | (v1 >> 4);
        if (clean[i + 2])
            bytes[bi++] = ((v1 & 15) << 4) | (v2 >> 2);
        if (clean[i + 3])
            bytes[bi++] = ((v2 & 3) << 6) | v3;
    }
    return bytes.buffer;
}
// Use globalThis.crypto so this module works in content scripts, service workers, and Node tests.
const webcrypto = globalThis.crypto;
// Helper to wrap chrome.storage.local.get
function storageGet(keys) {
    return new Promise((resolve) => {
        chrome.storage.local.get(keys, resolve);
    });
}
// Helper to wrap chrome.storage.local.set
function storageSet(items) {
    return new Promise((resolve) => {
        chrome.storage.local.set(items, () => resolve());
    });
}
// Helper to wrap chrome.storage.local.remove
function storageRemove(keys) {
    return new Promise((resolve) => {
        chrome.storage.local.remove(keys, () => resolve());
    });
}
let masterKeyCache = null;
/** Exposed only for unit tests — resets the in-memory key so each test starts fresh. */
export function _resetMasterKeyForTest() {
    masterKeyCache = null;
}
async function getMasterKey() {
    if (masterKeyCache)
        return masterKeyCache;
    const storage = await storageGet(KEY_STORAGE_ID);
    if (storage[KEY_STORAGE_ID]) {
        // Import existing key
        masterKeyCache = await webcrypto.subtle.importKey("jwk", storage[KEY_STORAGE_ID], { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
    }
    else {
        // Generate and store new key
        masterKeyCache = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
        const jwk = await webcrypto.subtle.exportKey("jwk", masterKeyCache);
        await storageSet({ [KEY_STORAGE_ID]: jwk });
    }
    return masterKeyCache;
}
async function encryptData(text) {
    const key = await getMasterKey();
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(text);
    const ciphertextBuf = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, encoded);
    return {
        ciphertext: ab2b64(ciphertextBuf),
        iv: ab2b64(iv.buffer)
    };
}
async function decryptData(ciphertextB64, ivB64) {
    const key = await getMasterKey();
    const iv = b642ab(ivB64);
    const ciphertext = b642ab(ciphertextB64);
    const decryptedBuf = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(iv) }, key, ciphertext);
    return new TextDecoder().decode(decryptedBuf);
}
export async function getCachedValue(key) {
    const storageKey = CACHE_PREFIX + key;
    const result = await storageGet(storageKey);
    const entry = result[storageKey];
    if (!entry)
        return null;
    try {
        return await decryptData(entry.ciphertext, entry.iv);
    }
    catch (err) {
        console.error("Failed to decrypt cached value for key:", key, err);
        return null;
    }
}
export async function setCachedValue(key, value) {
    // HARD EXCLUSION GUARD
    if (key === "password" || key === "otp") {
        console.warn(`[LocalLens Cache] Refusing to cache highly sensitive type: ${key}`);
        return;
    }
    const { ciphertext, iv } = await encryptData(value);
    const storageKey = CACHE_PREFIX + key;
    await storageSet({
        [storageKey]: {
            key,
            ciphertext,
            iv,
            updatedAt: Date.now()
        }
    });
}
export async function clearCachedValue(key) {
    await storageRemove(CACHE_PREFIX + key);
}
export async function listCachedKeys() {
    const allData = await storageGet(null);
    const entries = [];
    for (const [k, v] of Object.entries(allData)) {
        if (k.startsWith(CACHE_PREFIX)) {
            // Cast 'v' to let TypeScript know the structure of your stored cache object
            const cacheData = v;
            entries.push({
                key: cacheData.key,
                updatedAt: cacheData.updatedAt
            });
        }
    }
    return entries.sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function clearAllCachedValues() {
    const allData = await storageGet(null);
    const keysToRemove = [];
    for (const k of Object.keys(allData)) {
        if (k.startsWith(CACHE_PREFIX)) {
            keysToRemove.push(k);
        }
    }
    if (keysToRemove.length > 0) {
        await storageRemove(keysToRemove);
    }
}
// -- Settings wrappers --
const SETTINGS_KEY = "_autofill_settings";
export async function getAutofillSettings() {
    const result = await storageGet(SETTINGS_KEY);
    const settings = result[SETTINGS_KEY];
    return {
        enabled: settings?.enabled ?? true,
        confirmRequired: settings?.confirmRequired ?? true
    };
}
export async function updateAutofillSettings(updates) {
    const current = await getAutofillSettings();
    await storageSet({
        [SETTINGS_KEY]: { ...current, ...updates }
    });
}

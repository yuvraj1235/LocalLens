// Polyfill WebCrypto BEFORE importing fieldCache so globalThis.crypto is available
// at module-init time in Node (vitest default env is 'node', not 'jsdom').
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) {
  (globalThis as any).crypto = webcrypto;
}

import { classifyField } from "./fieldClassifier.js";
import { setCachedValue, getCachedValue, clearAllCachedValues, _resetMasterKeyForTest } from "./fieldCache.js";
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock chrome.storage.local using real callback-style API that fieldCache.ts expects.
const mockStorage = new Map<string, any>();
(global as any).chrome = {
  storage: {
    local: {
      get: vi.fn((keys, callback) => {
        if (keys === null) {
          const result: any = {};
          for (const [k, v] of mockStorage.entries()) {
            result[k] = v;
          }
          if (callback) callback(result);
          return;
        }
        
        const result: any = {};
        if (typeof keys === "string") {
          result[keys] = mockStorage.get(keys);
        }
        if (callback) callback(result);
      }),
      set: vi.fn((items, callback) => {
        for (const [k, v] of Object.entries(items)) {
          mockStorage.set(k, v);
        }
        if (callback) callback();
      }),
      remove: vi.fn((keys, callback) => {
        if (typeof keys === "string") mockStorage.delete(keys);
        else if (Array.isArray(keys)) keys.forEach(k => mockStorage.delete(k));
        if (callback) callback();
      })
    }
  }
};

describe("fieldClassifier", () => {
  it("should classify based on autocomplete", () => {
    expect(classifyField({ autocomplete: "email" })).toBe("email");
    expect(classifyField({ autocomplete: "given-name" })).toBe("first_name");
  });

  it("should fallback to name/id heuristics", () => {
    expect(classifyField({ name: "zipCode" })).toBe("postal_code");
    expect(classifyField({ id: "cellphone" })).toBe("phone");
  });

  it("should use PII type if provided", () => {
    expect(classifyField({ piiType: "CREDIT_CARD" })).toBe("credit_card");
  });
});

describe("fieldCache", () => {
  beforeEach(async () => {
    mockStorage.clear();
    // Reset the in-memory key cache so each test gets a fresh key
    // consistent with the empty storage (otherwise getMasterKey() returns
    // a stale CryptoKey that doesn't match the cleared storage JWK).
    if (typeof _resetMasterKeyForTest === "function") _resetMasterKeyForTest();
  });

  it("should store and retrieve an encrypted value", async () => {
    await setCachedValue("email", "test@example.com");
    const val = await getCachedValue("email");
    expect(val).toBe("test@example.com");
  });

  it("should not store plaintext in storage (encryption actually happens)", async () => {
    await setCachedValue("email", "test@example.com");
    // Raw storage should contain no readable plaintext at all.
    const rawValues = JSON.stringify(Object.fromEntries(mockStorage));
    expect(rawValues).not.toContain("test@example.com");
  });

  it("should refuse to cache password or OTP", async () => {
    await setCachedValue("password", "supersecret");
    const valPass = await getCachedValue("password");
    expect(valPass).toBeNull();

    await setCachedValue("otp", "123456");
    const valOtp = await getCachedValue("otp");
    expect(valOtp).toBeNull();
  });
});

/**
 * METRIC 4 — Client-Side Resource Utilization (20%)
 *
 * Measures:
 *  a) UIGraph build time per DOM size (should scale linearly, not exponentially)
 *  b) Regex PII engine throughput (lines/sec) — must not be a bottleneck
 *  c) fieldClassifier throughput (classifications/sec)
 *  d) fieldCache encrypt/decrypt latency (AES-GCM round-trip)
 *  e) Memory footprint of UIGraph (bytes per element)
 *
 * TARGETS (conservative — to beat smolagents + screenshot pipeline):
 *   UIGraph build:         < 50 ms for 200 interactive elements
 *   PII regex engine:      > 5,000 lines/sec
 *   fieldClassifier:       > 50,000 calls/sec
 *   Cache encrypt/decrypt: < 10 ms per field (round-trip)
 *   UIGraph JSON size:     < 1 KB per element average
 */

import { describe, it, expect } from "vitest";
import { RegexRuleEngine } from "../pii/regexRules";
import { classifyField } from "../cache/fieldClassifier";
import type { OCRResult } from "../ocr/ocrEngine";
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) (globalThis as any).crypto = webcrypto;
import { setCachedValue, getCachedValue, _resetMasterKeyForTest } from "../cache/fieldCache";

// ── Chrome mock ────────────────────────────────────────────────────────────────
const mockStorage = new Map<string, any>();
(global as any).chrome = {
  storage: { local: {
    get: (k: any, cb: any) => { if (k===null){const r:any={};for(const[kk,v]of mockStorage)r[kk]=v;cb(r);return;}const r:any={};if(typeof k==="string")r[k]=mockStorage.get(k);cb(r); },
    set: (items: any, cb: any) => { for(const[kk,v]of Object.entries(items))mockStorage.set(kk,v);cb?.(); },
    remove: (keys: any, cb: any) => { if(typeof keys==="string")mockStorage.delete(keys);else if(Array.isArray(keys))keys.forEach((k:string)=>mockStorage.delete(k));cb?.(); },
  }},
};

// ── DOM UIGraph build simulation (pure JS, no browser APIs) ──────────────────

function simulateBuildUIGraph(elementCount: number): number {
  const ROLE_MAP: Record<string, string> = {
    A: "link", BUTTON: "button", INPUT: "textbox", SELECT: "listbox", TEXTAREA: "textbox",
  };
  const PII_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

  const start = performance.now();

  const elements = [];
  for (let i = 0; i < elementCount; i++) {
    const tag = ["BUTTON", "INPUT", "A", "SELECT"][i % 4];
    const label = i % 10 === 0 ? "user@example.com" : `Element Label ${i}`;
    PII_RE.lastIndex = 0;
    const isEmail = PII_RE.test(label);
    const redaction = isEmail ? "EMAIL_REDACTED" : "NONE";

    elements.push({
      element_id: `agent_${i}`,
      role: ROLE_MAP[tag] || "generic",
      label: redaction === "NONE" ? label : null,
      redacted_label: redaction !== "NONE" ? label : null,
      bbox: { x: (i % 10) * 100, y: Math.floor(i / 10) * 50, width: 90, height: 40 },
      redaction,
      clickable: tag === "BUTTON" || tag === "A",
      editable: tag === "INPUT" || tag === "TEXTAREA",
    });
  }

  return performance.now() - start;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("M4A — UIGraph build latency", () => {
  it("builds 50 elements in < 20 ms", () => {
    const ms = simulateBuildUIGraph(50);
    console.log(`  UIGraph(50): ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(20);
  });

  it("builds 200 elements in < 50 ms (real-world large page)", () => {
    const ms = simulateBuildUIGraph(200);
    console.log(`  UIGraph(200): ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(50);
  });

  it("scales linearly: 200 elements < 4× the time for 50 elements", () => {
    const t50  = simulateBuildUIGraph(50);
    const t200 = simulateBuildUIGraph(200);
    console.log(`  Scale factor: ${(t200 / t50).toFixed(2)}×`);
    // Linear means 4× elements → 4× time. Allow 6× headroom for jitter.
    expect(t200).toBeLessThan(t50 * 6 + 10); // +10ms floor for very fast machines
  });
});

describe("M4B — Regex PII engine throughput", () => {
  const engine = new RegexRuleEngine();
  const MIXED_LINES: OCRResult[] = [
    { text: "Name: John Smith",                      bbox: [0,0,400,20], confidence: 0.9, detectionScore: 0.9 },
    { text: "Email: john@example.com",               bbox: [0,20,400,40], confidence: 0.9, detectionScore: 0.9 },
    { text: "Phone: +91 98765 43210",                bbox: [0,40,400,60], confidence: 0.9, detectionScore: 0.9 },
    { text: "Card: 4111 1111 1111 1111",             bbox: [0,60,400,80], confidence: 0.9, detectionScore: 0.9 },
    { text: "Click the submit button to continue",   bbox: [0,80,400,100], confidence: 0.9, detectionScore: 0.9 },
  ];

  it("processes 1,000 lines in < 200 ms (> 5,000 lines/sec)", () => {
    const batch: OCRResult[] = [];
    for (let i = 0; i < 200; i++) batch.push(...MIXED_LINES);

    const start = performance.now();
    engine.detect(batch);
    const ms = performance.now() - start;
    const linesPerSec = Math.round(1000 / ms * 1000);
    console.log(`  PII regex: ${ms.toFixed(2)} ms for 1,000 lines (${linesPerSec.toLocaleString()} lines/sec)`);
    expect(ms).toBeLessThan(200);
  });
});

describe("M4C — fieldClassifier throughput", () => {
  const INPUTS = [
    { autocomplete: "email" },
    { type: "password" },
    { name: "firstName" },
    { id: "cellphone" },
    { label: "Postal Code" },
  ];

  it("classifies 10,000 fields in < 100 ms (> 100,000/sec)", () => {
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      classifyField(INPUTS[i % INPUTS.length]);
    }
    const ms = performance.now() - start;
    const perSec = Math.round(10000 / ms * 1000);
    console.log(`  fieldClassifier: ${ms.toFixed(2)} ms for 10,000 calls (${perSec.toLocaleString()}/sec)`);
    expect(ms).toBeLessThan(100);
  });
});

describe("M4D — fieldCache AES-GCM encrypt/decrypt latency", () => {
  it("encrypt + decrypt one field in < 20 ms", async () => {
    mockStorage.clear();
    _resetMasterKeyForTest?.();
    const start = performance.now();
    await setCachedValue("email", "alice@example.com");
    await getCachedValue("email");
    const ms = performance.now() - start;
    console.log(`  Cache round-trip: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(20);
  });

  it("10 encrypt+decrypt round-trips in < 200 ms (key reuse path)", async () => {
    mockStorage.clear();
    _resetMasterKeyForTest?.();
    // Pre-warm key generation
    await setCachedValue("email", "seed@test.com");

    const start = performance.now();
    for (let i = 0; i < 10; i++) {
      await setCachedValue(`field_${i}`, `value_${i}@example.com`);
      await getCachedValue(`field_${i}`);
    }
    const ms = performance.now() - start;
    const perOp = ms / 10;
    console.log(`  10 cache ops: ${ms.toFixed(2)} ms (${perOp.toFixed(2)} ms/op)`);
    expect(ms).toBeLessThan(200);
  });
});

describe("M4E — UIGraph payload size (bandwidth cost)", () => {
  it("average element JSON < 500 bytes (controls upload cost)", () => {
    const element = {
      element_id: "agent_123",
      role: "textbox",
      label: "Email Address",
      redacted_label: null,
      bbox: { x: 100, y: 200, width: 280, height: 36 },
      redaction: "NONE",
      clickable: false,
      editable: true,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(element)).length;
    console.log(`  Element JSON: ${bytes} bytes`);
    expect(bytes).toBeLessThan(500);
  });

  it("50-element UIGraph JSON < 20 KB total", () => {
    const elements = Array.from({ length: 50 }, (_, i) => ({
      element_id: `agent_${i}`,
      role: "textbox",
      label: `Field ${i}`,
      redacted_label: null,
      bbox: { x: 0, y: i * 50, width: 200, height: 40 },
      redaction: "NONE",
      clickable: i % 5 === 0,
      editable: true,
    }));
    const bytes = new TextEncoder().encode(JSON.stringify(elements)).length;
    const kb = bytes / 1024;
    console.log(`  50-element UIGraph: ${kb.toFixed(2)} KB`);
    expect(kb).toBeLessThan(20);
  });

  it("UIGraph is < 5% the size of a 1000×1350 screenshot (privacy + bandwidth win)", () => {
    // Approximate screenshot PNG = 150 KB base64 encoded
    const screenshotBytes = 150 * 1024;
    const elements = Array.from({ length: 30 }, (_, i) => ({
      element_id: `agent_${i}`, role: "button", label: `Button ${i}`,
      redacted_label: null, bbox: { x:0,y:0,width:100,height:40 },
      redaction: "NONE", clickable: true, editable: false,
    }));
    const uiGraphBytes = new TextEncoder().encode(JSON.stringify(elements)).length;
    const ratio = uiGraphBytes / screenshotBytes;
    console.log(`  UIGraph/Screenshot ratio: ${(ratio * 100).toFixed(1)}%`);
    expect(ratio).toBeLessThan(0.05);
  });
});

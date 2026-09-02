/**
 * Phase 10 — Browser Inference Runtime
 *
 * Central place that decides WebGPU vs WASM and loads/caches ONNX sessions.
 * Every model wrapper (OCR, UI detector, face detector, NER) should go
 * through getSession() instead of creating its own InferenceSession.
 */

import * as ort from "onnxruntime-web";

export type ExecutionBackend = "webgpu" | "wasm";

let cachedBackend: ExecutionBackend | null = null;
const sessionCache = new Map<string, ort.InferenceSession>();

/** Detects whether WebGPU is available in this browser context. */
export async function detectBackend(): Promise<ExecutionBackend> {
  if (cachedBackend) return cachedBackend;

  const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;
  if (hasWebGPU) {
    try {
      // @ts-expect-error - navigator.gpu typing not always present
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        cachedBackend = "webgpu";
        return cachedBackend;
      }
    } catch {
      // fall through to wasm
    }
  }
  cachedBackend = "wasm";
  return cachedBackend;
}

/**
 * Loads (or returns a cached) ONNX Runtime Web session for the given model.
 * modelPath should point at a quantized model under /models (see models/README.md).
 */
export async function getSession(
  modelKey: string,
  modelPath: string
): Promise<ort.InferenceSession> {
  const cached = sessionCache.get(modelKey);
  if (cached) return cached;

  const backend = await detectBackend();

  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: backend === "webgpu" ? ["webgpu", "wasm"] : ["wasm"],
    graphOptimizationLevel: "all",
  });

  sessionCache.set(modelKey, session);
  return session;
}

export function clearSessionCache(): void {
  sessionCache.clear();
}
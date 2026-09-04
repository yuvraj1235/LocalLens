/**
 * latencyTest.ts
 *
 * Measures round-trip latency for each backend call made by the AgentLoop.
 *
 * Tracks:
 *  - Per-request latency (ms)
 *  - Rolling stats: min / max / average / p95
 *  - Transport type: WebSocket vs REST fallback
 *
 * Usage:
 *   import { LatencyTracker } from "./latencyTest";
 *
 *   const tracker = new LatencyTracker();
 *
 *   const t = tracker.start("CLICK");
 *   const response = await agentClient.send(request);
 *   tracker.end(t, "ws");
 *
 *   console.table(tracker.summary());
 *
 * You can also run a standalone benchmark against the backend by calling:
 *   runLatencyBenchmark("http://localhost:8000", 20);
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Transport = "ws" | "rest";

export interface LatencySample {
  /** Sequential index (1-based) */
  index: number;
  /** Action type that triggered this request, e.g. "CLICK" */
  action: string;
  /** Round-trip time in milliseconds */
  durationMs: number;
  /** Which transport was used */
  transport: Transport;
  /** Unix timestamp when the request was sent */
  timestamp: number;
}

export interface LatencySummary {
  count: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p95Ms: number;
  wsCalls: number;
  restCalls: number;
}

// ---------------------------------------------------------------------------
// LatencyTracker class
// ---------------------------------------------------------------------------

export class LatencyTracker {
  private samples: LatencySample[] = [];

  /**
   * Call immediately before sending a request.
   * Returns an opaque token to pass to `end()`.
   */
  start(action: string): { action: string; startedAt: number } {
    return { action, startedAt: performance.now() };
  }

  /**
   * Call immediately after the response is received.
   * Records the sample and returns the measured duration.
   */
  end(token: { action: string; startedAt: number }, transport: Transport): number {
    const durationMs = Math.round(performance.now() - token.startedAt);
    this.samples.push({
      index: this.samples.length + 1,
      action: token.action,
      durationMs,
      transport,
      timestamp: Date.now(),
    });
    return durationMs;
  }

  /** All recorded samples (read-only copy). */
  getSamples(): Readonly<LatencySample[]> {
    return [...this.samples];
  }

  /** Computed statistics over all recorded samples. */
  summary(): LatencySummary {
    if (this.samples.length === 0) {
      return { count: 0, minMs: 0, maxMs: 0, avgMs: 0, p95Ms: 0, wsCalls: 0, restCalls: 0 };
    }

    const durations = this.samples.map((s) => s.durationMs).sort((a, b) => a - b);
    const count     = durations.length;
    const minMs     = durations[0];
    const maxMs     = durations[count - 1];
    const avgMs     = Math.round(durations.reduce((a, b) => a + b, 0) / count);
    const p95Ms     = durations[Math.floor(count * 0.95)] ?? maxMs;
    const wsCalls   = this.samples.filter((s) => s.transport === "ws").length;
    const restCalls = this.samples.filter((s) => s.transport === "rest").length;

    return { count, minMs, maxMs, avgMs, p95Ms, wsCalls, restCalls };
  }

  /** Print a formatted summary to the console (handy for manual testing). */
  printSummary(): void {
    const s = this.summary();
    console.group("📊 LocalLens Latency Report");
    console.log(`Requests : ${s.count}  (WS: ${s.wsCalls} | REST: ${s.restCalls})`);
    console.log(`Min      : ${s.minMs} ms`);
    console.log(`Avg      : ${s.avgMs} ms`);
    console.log(`p95      : ${s.p95Ms} ms`);
    console.log(`Max      : ${s.maxMs} ms`);
    console.groupEnd();
  }

  /** Reset all recorded samples. */
  reset(): void {
    this.samples = [];
  }
}

// ---------------------------------------------------------------------------
// Standalone benchmark
// ---------------------------------------------------------------------------

/**
 * Fire `n` POST requests to the backend and report latency stats.
 * Useful for latency testing without running the full agent loop.
 *
 * @param baseUrl  e.g. "http://localhost:8000"
 * @param n        Number of requests to send (default: 10)
 */
export async function runLatencyBenchmark(
  baseUrl: string = "http://localhost:8000",
  n: number = 10
): Promise<LatencySummary> {
  const tracker = new LatencyTracker();

  const mockRequest = {
    session_id: `bench-${Date.now()}`,
    task: "latency benchmark ping",
    context: {
      session_id: `bench-${Date.now()}`,
      url_domain: "localhost",
      screenshot_b64: null,
      ui_graph: [],
      viewport_width: 1280,
      viewport_height: 800,
    },
    history: [],
  };

  console.log(`🚀 Running latency benchmark: ${n} requests → ${baseUrl}/plan-action`);

  for (let i = 0; i < n; i++) {
    const token = tracker.start("BENCHMARK");
    try {
      const res = await fetch(`${baseUrl}/plan-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mockRequest),
      });
      await res.json(); // consume body so the connection closes cleanly
      const ms = tracker.end(token, "rest");
      console.log(`  [${i + 1}/${n}] ${ms} ms`);
    } catch (err) {
      tracker.end(token, "rest");
      console.warn(`  [${i + 1}/${n}] request failed: ${err}`);
    }

    // Small pause between requests to avoid flooding
    await sleep(100);
  }

  tracker.printSummary();
  return tracker.summary();
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Auto-run when executed directly via ts-node / node
// (vite strips this block in browser builds via dead-code elimination)
// ---------------------------------------------------------------------------
if (
  typeof process !== "undefined" &&
  process.argv[1]?.includes("latencyTest")
) {
  const baseUrl = process.argv[2] ?? "http://localhost:8000";
  const n       = parseInt(process.argv[3] ?? "10", 10);
  runLatencyBenchmark(baseUrl, n).catch(console.error);
}

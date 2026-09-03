// Minimal WebSocket client with REST fallback for LocalLens UI
// This module abstracts the communication with the FastAPI backend.
// It tries to open a WS connection to `/ws/agent` and, if unavailable,
// falls back to a simple POST request to `/plan-action`.

import type { TaskRequest, StructuredAction, UIGraph } from "./types";

// Configurable endpoint – default to local dev server.
const BASE_URL = "http://localhost:8000";

/**
 * Represents a live WebSocket connection. Handles auto‑reconnect and
 * exposes a simple `sendTask` method that resolves with the server's
 * response (either via WS or REST).
 */
export class AgentClient {
  private ws: WebSocket | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private maxReconnect = 5;
  private pendingResolve: ((msg: any) => void) | null = null;

  constructor() {
    this.initWebSocket();
  }

  private initWebSocket() {
    const wsUrl = BASE_URL.replace(/^http/, "ws") + "/ws/agent";
    try {
      this.ws = new WebSocket(wsUrl);
      this.ws.onopen = () => {
        console.log("[AgentClient] WS connected");
        this.isConnected = true;
        this.reconnectAttempts = 0;
      };
      this.ws.onmessage = (ev) => {
        const data = JSON.parse(ev.data);
        if (this.pendingResolve) {
          this.pendingResolve(data);
          this.pendingResolve = null;
        }
      };
      this.ws.onclose = () => {
        console.warn("[AgentClient] WS closed, attempting reconnect");
        this.isConnected = false;
        this.scheduleReconnect();
      };
      this.ws.onerror = (e) => {
        console.error("[AgentClient] WS error", e);
        this.ws?.close();
      };
    } catch (e) {
      console.error("[AgentClient] Failed to create WS", e);
      this.isConnected = false;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnect) return;
    const delay = 1000 * Math.pow(2, this.reconnectAttempts); // exponential back‑off
    setTimeout(() => {
      this.reconnectAttempts++;
      this.initWebSocket();
    }, delay);
  }

  /**
   * Send a task request to the backend.
   * Resolves with the server response (StructuredAction & optional UIGraph).
   * If WS is not ready after a short timeout, falls back to REST.
   */
  async sendTask(request: TaskRequest): Promise<{ action: StructuredAction; graph?: UIGraph }>
  {
    // Try WS first if we think we are connected
    if (this.isConnected && this.ws) {
      return new Promise((resolve, reject) => {
        this.pendingResolve = resolve;
        this.ws?.send(JSON.stringify(request));
        // If no response within 2 seconds, fallback to REST
        setTimeout(() => {
          if (this.pendingResolve) {
            this.pendingResolve = null; // cancel WS promise
            this.fallbackRest(request).then(resolve).catch(reject);
          }
        }, 2000);
      });
    }
    // WS not ready – immediate fallback
    return this.fallbackRest(request);
  }

  private async fallbackRest(request: TaskRequest) {
    const resp = await fetch(`${BASE_URL}/plan-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!resp.ok) throw new Error(`REST fallback failed: ${resp.status}`);
    return resp.json();
  }
}

// Export a singleton for convenience
export const agentClient = new AgentClient();

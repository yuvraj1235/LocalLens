/**
 * wsClient.ts — LocalLens WebSocket / REST client
 *
 * Sends a TaskRequest to Shreya's FastAPI backend and resolves with a
 * StructuredAction. Tries WebSocket first; falls back to REST after 2 s.
 *
 * Schema contract: backend/app/schemas/context.py
 */

import type { TaskRequest, StructuredAction } from "./types";

const BASE_URL = "http://localhost:8000";

export class AgentClient {
  private ws: WebSocket | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private readonly maxReconnect = 5;
  private pendingResolve: ((msg: StructuredAction) => void) | null = null;
  private wsUrl: string;

  constructor(wsUrl = BASE_URL.replace(/^http/, "ws") + "/ws/agent") {
    this.wsUrl = wsUrl;
    this.initWebSocket();
  }

  private initWebSocket() {
    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        console.log("[AgentClient] WS connected");
        this.isConnected = true;
        this.reconnectAttempts = 0;
      };

      this.ws.onmessage = (ev) => {
        const data: StructuredAction = JSON.parse(ev.data);
        if (this.pendingResolve) {
          this.pendingResolve(data);
          this.pendingResolve = null;
        }
      };

      this.ws.onclose = () => {
        console.warn("[AgentClient] WS closed — scheduling reconnect");
        this.isConnected = false;
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch (e) {
      console.error("[AgentClient] Failed to open WS", e);
      this.isConnected = false;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnect) return;
    const delay = 1000 * Math.pow(2, this.reconnectAttempts); // exponential back-off
    setTimeout(() => {
      this.reconnectAttempts++;
      this.initWebSocket();
    }, delay);
  }

  /**
   * Send a TaskRequest and resolve with the backend's StructuredAction.
   * Uses WebSocket if connected; falls back to POST /plan-action after 2 s.
   */
  async send(request: TaskRequest): Promise<StructuredAction> {
    if (this.isConnected && this.ws) {
      return new Promise<StructuredAction>((resolve, reject) => {
        this.pendingResolve = resolve;
        this.ws!.send(JSON.stringify(request));

        // 2-second timeout → fall back to REST
        setTimeout(() => {
          if (this.pendingResolve) {
            this.pendingResolve = null;
            this.fallbackRest(request).then(resolve).catch(reject);
          }
        }, 2000);
      });
    }
    return this.fallbackRest(request);
  }

  private async fallbackRest(request: TaskRequest): Promise<StructuredAction> {
    const resp = await fetch(`${BASE_URL}/plan-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!resp.ok) throw new Error(`REST request failed: ${resp.status} ${resp.statusText}`);
    return resp.json() as Promise<StructuredAction>;
  }
}

// Singleton for the debug UI
export const agentClient = new AgentClient();

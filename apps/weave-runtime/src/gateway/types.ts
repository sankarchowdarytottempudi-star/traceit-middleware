import type { Flow, FlowDeployment, HttpRequestSample, InvokeResponse } from "@traceit/weave-flow";

export interface GatewayPublished { apiId: string; name: string; context: string; version: string; url: string; }
export type GatewayCheck = "ok" | "republished" | "failed" | "skipped";
export interface Gateway {
  readonly enabled: boolean;
  /** Contexts owned by APIs the runtime did not create (never touched, never reused). */
  reservedContexts(): string[];
  reachable(): Promise<boolean>;
  /** Creates or updates the API for this flow, deploys a revision, publishes it, subscribes the test application. Idempotent. */
  publish(flow: Flow): Promise<GatewayPublished>;
  /** Removes the API this runtime created for the flow (no-op when it is not there). */
  remove(flow: Flow): Promise<void>;
  /** Calls the published API through the public gateway with a token of the test application. */
  invoke(flow: Flow, dep: FlowDeployment, request: HttpRequestSample): Promise<InvokeResponse>;
  /** Names of the runtime's APIs currently present on the gateway, for a cheap reconcile. */
  present(): Promise<Map<string, { id: string; context: string; version: string; lifeCycleStatus: string }>>;
  apiName(flow: Flow): string;
}

export class NullGateway implements Gateway {
  readonly enabled = false;
  reservedContexts() { return []; }
  async reachable() { return false; }
  async publish(): Promise<GatewayPublished> { throw new Error("The API gateway is not configured for this runtime (APIM_BASE_URL is not set)"); }
  async remove() { /* nothing to remove */ }
  async invoke(): Promise<InvokeResponse> { throw new Error("The API gateway is not configured for this runtime (APIM_BASE_URL is not set)"); }
  async present() { return new Map(); }
  apiName(flow: Flow) { return flow.slug; }
}

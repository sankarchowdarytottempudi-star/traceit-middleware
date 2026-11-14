// REST contract of the Weave runtime (apps/weave-runtime), prefix /v1. The Factory BFF exposes
// exactly the same paths to the browser under /api/studio (e.g. GET /api/studio/flows), after
// checking the user session, adding the internal key header. Errors are application/problem+json:
// { type: "about:blank", title: string, status: number, detail?: string, issues?: ValidationIssue[] }.
import type {
  CompiledInstruction, Connection, ConnectionTypeDef, ConnectorDef, Execution, ExecutionSummary, Flow, FlowDeployment,
  FlowSummary, FlowVersion, FunctionDoc, HttpRequestSample, Json, MappingRule, MappingSpec, NodeTypeDef, StepTrace, ValidationIssue,
} from "./types.js";

export const RUNTIME_API_PREFIX = "/v1";
export const STUDIO_API_PREFIX = "/api/studio";
export const INTERNAL_KEY_HEADER = "x-weave-key";
export const USER_HEADER = "x-weave-user";

// GET /catalog
export interface CatalogResponse {
  nodeTypes: NodeTypeDef[];               // built-ins + one per custom connector operation
  connectionTypes: ConnectionTypeDef[];
  functions: FunctionDoc[];               // JSONata helpers available in expressions
  instructionExamples: string[];          // phrasings the plain-words interpreter understands
  templates: { id: string; name: string; description: string }[]; // starter flows (POST /flows { templateId })
}

// Flows
// GET    /flows                         -> { flows: FlowSummary[] }
// POST   /flows                         <- CreateFlowRequest            -> Flow
// GET    /flows/:id                     -> Flow
// PUT    /flows/:id                     <- Flow (revision = the one edited) -> Flow (revision + 1); 409 if stale
// DELETE /flows/:id                     -> { ok: true }   (undeploys first)
// POST   /flows/:id/duplicate           <- { name?: string }            -> Flow
// GET    /flows/:id/versions            -> { versions: FlowVersion[] }
// GET    /flows/:id/versions/:revision  -> Flow
// POST   /flows/:id/versions/:revision/restore -> Flow (a new revision with that version's content)
// POST   /flows/validate                <- { flow: Flow }               -> { issues: ValidationIssue[] }
// GET    /flows/:id/export              -> Flow (portable JSON; connection ids kept, no secrets)
// POST   /flows/import                  <- { flow: Flow, name?: string } -> Flow
export interface CreateFlowRequest { name: string; description?: string; templateId?: string; flow?: Partial<Flow>; origin?: Flow["origin"]; }
export interface FlowListResponse { flows: FlowSummary[]; }

// Run & debug
// POST /flows/:id/test                  <- TestFlowRequest              -> Execution (full trace)
// POST /flows/:id/nodes/:nodeId/test    <- TestNodeRequest              -> TestNodeResponse
export interface TestFlowRequest {
  draft?: Flow;                           // run this unsaved graph instead of the stored one
  triggerNodeId?: string;                 // which trigger to start from (default: first)
  request?: HttpRequestSample;            // for trigger.http
  payload?: Json;                         // for trigger.manual / trigger.schedule
}
export interface TestNodeRequest {
  draft?: Flow;
  context: { payload?: Json; vars?: Record<string, Json>; request?: HttpRequestSample; item?: Json; index?: number };
}
export interface TestNodeResponse { step: StepTrace; context: { payload: Json; vars: Record<string, Json> }; }

// Deploy
// POST /flows/:id/deploy                <- { publishToGateway?: boolean } -> { flow: Flow; deployment: FlowDeployment; issues: ValidationIssue[] }
// POST /flows/:id/undeploy              -> { flow: Flow }
// POST /flows/:id/invoke                <- InvokeRequest                 -> InvokeResponse
//   via "gateway": the runtime gets a token for its own test application and calls the public
//   WSO2 gateway URL, proving the published path end to end. via "direct": calls the live listener.
// POST /gateway/resync                  -> { results: { flowId: string; status: string; error?: string }[] }
//   re-publishes every deployed flow (the gateway can lose state on restart).
export interface InvokeRequest { via: "gateway" | "direct"; request: HttpRequestSample; }
export interface InvokeResponse {
  status: number; headers: Record<string, string>; body: Json; ms: number; url: string;
  executionId?: string;                   // the live execution this call produced, when it reached the runtime
  curl?: string;                          // equivalent curl (token masked)
}

// Executions & logs
// GET    /executions?flowId=&status=&mode=&limit=&before=   -> { executions: ExecutionSummary[] }
// GET    /executions/:id                                    -> Execution
// DELETE /flows/:id/executions                              -> { ok: true }
// GET    /flows/:id/logs?limit=&level=                      -> { lines: LogLine[] }
// GET    /stats?hours=                                      -> StatsResponse
export interface ExecutionListResponse { executions: ExecutionSummary[]; }
export interface LogLine { at: string; level: string; message: string; flowId: string; executionId?: string; nodeName?: string; }
export interface StatsResponse {
  flows: { flowId: string; name: string; slug: string; deployed: boolean; total: number; errors: number; p50Ms: number; p95Ms: number; lastAt?: string }[];
  series: { at: string; total: number; errors: number }[]; // per-minute or per-hour buckets
}

// Connections (secrets are write-only: send them in `secrets`, they are never returned)
// GET    /connections                   -> { connections: Connection[] }
// POST   /connections                   <- SaveConnectionRequest -> Connection
// PUT    /connections/:id               <- SaveConnectionRequest -> Connection   (omitted secrets keep their stored value)
// DELETE /connections/:id               -> { ok: true }  (409 with the flows that use it)
// POST   /connections/:id/test          -> { ok: boolean; ms: number; detail: string }
// POST   /connections/test              <- SaveConnectionRequest -> same (test before saving)
export interface SaveConnectionRequest { name: string; type: string; config: Record<string, unknown>; secrets?: Record<string, string>; }

// Custom connectors
// GET    /connectors                    -> { connectors: ConnectorDef[] }
// POST   /connectors                    <- Omit<ConnectorDef, "id"|"createdAt"|"updatedAt"> -> ConnectorDef
// PUT    /connectors/:id                -> ConnectorDef
// DELETE /connectors/:id                -> { ok: true }
// POST   /connectors/import-openapi     <- { name?: string; spec: Json | string } -> ConnectorDef (not saved until POSTed)

// Mapping & expressions (all evaluated locally in the runtime; nothing is sent to any external service)
// POST /mapping/preview                 <- { spec: MappingSpec; source: Json }      -> MappingPreviewResponse
// POST /mapping/infer                   <- { sampleSource: Json; desiredOutput: Json } -> { rules: MappingRule[]; engine: "rules" }
// POST /mapping/compile-instruction     <- CompileInstructionRequest                -> CompileInstructionResponse
// POST /expr/eval                       <- { expr: string; context: TestNodeRequest["context"]; template?: boolean } -> { ok: boolean; result?: Json; error?: string }
export interface MappingPreviewResponse {
  output: Json;
  rules: {
    id: string; ok: boolean; value?: Json; error?: string;
    warning?: string;                     // the rule ran but deserves a look (e.g. the source path is missing in this sample)
    compiled?: CompiledInstruction;       // instruction rules: what the words were compiled to for this preview
    suggestions?: string[];               // instruction rules that were not understood: phrasings that are
  }[];
  diff?: { path: string; got: Json | undefined; want: Json | undefined }[]; // against spec.sampleTarget when present
}
export interface CompileInstructionRequest {
  instruction: string;                    // the user's own words
  target?: string;
  sampleSource?: Json;                    // lets the interpreter resolve field names and show a preview
  desiredValue?: Json;                    // if known, the interpreter checks its result against it
}
export interface CompileInstructionResponse {
  compiled: CompiledInstruction | null;   // null = not understood (the UI must say so)
  preview?: Json;                         // result on sampleSource
  matchesDesired?: boolean;
  suggestions: string[];                  // nearest supported phrasings
  ok?: boolean;                           // same as compiled !== null
  reason?: string;                        // not understood: what could not be worked out, in plain words
  understood?: string[];                  // the parts that were understood (fields found, partial readings, typo fixes)
  fields?: string[];                      // input paths the expression reads
  previewError?: string;                  // compiled, but evaluating it on sampleSource failed
}
/** A rule proposed by POST /mapping/infer. `confidence` is 0..1; `comment` says why it was proposed. */
export type InferredMappingRule = MappingRule & { confidence?: number };

// Health
// GET /healthz -> { status: "UP", flowsDeployed: number, gateway: "reachable" | "unreachable" }

export type { Flow, FlowDeployment, FlowVersion, Connection, ConnectorDef, Execution, ExecutionSummary, MappingRule, MappingSpec, ValidationIssue };

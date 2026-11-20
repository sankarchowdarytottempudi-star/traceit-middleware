// Weave Studio flow model. Shared by the canvas (apps/weave-factory) and the runtime
// (apps/weave-runtime). See ../CONTRACT.md for execution semantics.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

// ---------------------------------------------------------------- flow graph
export interface FlowNode {
  id: string;                       // stable, unique inside the flow (e.g. "n_ab12cd")
  type: string;                     // NodeTypeDef.type, e.g. "http.request" or "connector:<connectorId>:<opId>"
  name: string;                     // unique inside the flow; referenced by $nodes."<name>"
  position: { x: number; y: number };
  config: Record<string, unknown>;  // shaped by NodeTypeDef.fields
  disabled?: boolean;               // disabled nodes pass payload through unchanged on port "out"
  notes?: string;                   // free text shown on the canvas
}
export interface FlowEdge {
  id: string;
  from: string;                     // source node id
  fromPort: string;                 // output port id: "out" | "error" | "case:<id>" | "otherwise" | "each" | "done" | "branch:<id>" | "try" | "catch"
  to: string;                       // target node id (every node has at most one input port)
}
export interface FlowSettings {
  basePath: string;                 // "/<slug>/v1" - HTTP listeners are served under /run<basePath><listener path>
  timeoutMs?: number;               // whole-execution timeout (default 60000)
  logPayloads?: boolean;            // store step input/output in execution traces (default true)
  gateway: {
    publish: boolean;               // publish on the WSO2 API gateway when deployed
    context?: string;               // gateway context, defaults to "/" + slug
    version?: string;               // defaults to "v1"
    security: "oauth2" | "none";    // default oauth2
    throttlingPolicy?: string;      // API-level policy name, default "Unlimited"
  };
}
export interface FlowDeployment {
  status: "deployed" | "failed" | "stopped";
  revision: number;                 // the flow revision that is live
  deployedAt: string;
  deployedBy?: string;
  runtimeUrl: string;               // direct runtime URL (server-internal)
  error?: string;
  gateway?: {
    status: "published" | "failed" | "skipped";
    apiId?: string; context?: string; version?: string;
    url?: string;                   // public gateway URL
    error?: string;
  };
}
export interface Flow {
  id: string;
  name: string;
  slug: string;                     // url-safe, unique
  description?: string;
  tags?: string[];
  nodes: FlowNode[];
  edges: FlowEdge[];
  settings: FlowSettings;
  origin?: { kind: "blank" | "template" | "migrated" | "clone"; ref?: string };
  revision: number;                 // +1 on every save; PUT must send the revision it edited (409 on mismatch)
  createdAt: string; updatedAt: string; updatedBy?: string;
  deployment?: FlowDeployment | null;
  readOnly?: boolean;               // true for derived views (e.g. a migrated service rendered as a flow)
}
export type FlowSummary = Pick<Flow, "id" | "name" | "slug" | "description" | "tags" | "origin" | "revision" | "updatedAt" | "deployment"> & {
  nodeCount: number; triggers: string[]; lastExecution?: { status: ExecutionStatus; at: string } | null;
};
export interface FlowVersion { revision: number; savedAt: string; savedBy?: string; note?: string; deployed?: boolean; }

export interface ValidationIssue { level: "error" | "warning"; nodeId?: string; field?: string; message: string; /** production lesson check id (lessons.json), e.g. "L4.no-timeout" */ lesson?: string; }

// ---------------------------------------------------------------- mapping
/** One target field of a Transform (Map) node.
 *  kind "instruction": the user wrote plain words. `instruction` keeps their words verbatim;
 *  `compiled` holds what the LOCAL deterministic interpreter understood. The runtime executes
 *  compiled.expr. A rule whose instruction could not be compiled is a validation ERROR, never
 *  silently dropped. */
export interface MappingRule {
  id: string;
  target: string;                   // dot path in the output: "customer.first", "items[0].sku"
  kind: "direct" | "expr" | "const" | "instruction";
  source?: string;                  // direct: dot path in the input
  expr?: string;                    // expr: JSONata
  value?: Json;                     // const
  instruction?: string;             // instruction: the user's own words
  compiled?: CompiledInstruction | null;
  comment?: string;                 // free-text note, kept with the rule, never executed
  enabled?: boolean;                // default true
}
export interface CompiledInstruction {
  expr: string;                     // JSONata
  explanation: string;              // plain-English restatement shown as "Understood as"
  confidence: "exact" | "guessed";
  engine: "rules" | "in-estate-model";
}
/** What the mapping produces. Older mappings have no shape and produce an object. */
export interface MappingShape {
  kind: "object" | "each" | "values" | "value";
  // object: one object, one field per rule (default)
  // each:   a list of objects, one per item of the input list at `each`; rules read `item.…`, `parent.…`, `index`
  // values: a list of values (with `each`: the first rule's value per item; without: every rule's value in order)
  // value:  the first rule's value on its own
  each?: string;                    // input path of the list, for "each" (and "values" per item)
  wrap?: string;                    // put the result under this key: { <wrap>: result }
}
export interface MappingSpec {
  rules: MappingRule[];
  shape?: MappingShape;
  passthrough?: boolean;            // true: start from the input object and apply rules on top
  sampleSource?: Json;              // design-time samples; stored with the flow, never sent anywhere else
  sampleTarget?: Json;
}

// ---------------------------------------------------------------- catalog
export type FieldKind =
  | "text"        // plain string
  | "template"    // string with {{ jsonata }} interpolation
  | "expr"        // a JSONata expression
  | "textarea" | "number" | "boolean"
  | "select"      // options[]
  | "multiselect" // options[]
  | "json"        // JSON value; strings inside may use {{ }} interpolation
  | "keyvalue"    // Array<{ key: string; value: string }> - values are templates
  | "code"        // large JSONata editor
  | "graphql" | "sql"
  | "connection"  // id of a Connection of connectionType
  | "flow"        // id of another flow
  | "mapping"     // MappingSpec
  | "conditions"  // Array<{ id: string; label: string; expr: string }> - each becomes port "case:<id>"
  | "branches"    // Array<{ id: string; label: string }> - each becomes port "branch:<id>"
  | "stringlist"; // string[]
export interface FieldDef {
  key: string; label: string; kind: FieldKind;
  help?: string; placeholder?: string; required?: boolean;
  options?: { value: string; label: string }[];
  connectionType?: string;
  default?: unknown;
  showIf?: { key: string; equals?: unknown; in?: unknown[] };
  group?: string;                   // "Advanced" etc. - UI collapses non-default groups
  secret?: boolean;                 // write-only (connections)
}
export interface PortDef { id: string; label: string; kind?: "default" | "error" | "branch"; }
export type NodeCategory = "trigger" | "connector" | "transform" | "logic" | "utility" | "custom";
export interface NodeTypeDef {
  type: string; label: string; category: NodeCategory;
  description: string;
  icon: string;                     // lucide-react icon name
  color?: string;                   // accent token name: "trigger" | "http" | "data" | "logic" | "util" | "custom"
  hasInput: boolean;                // false for triggers and notes
  outputs: PortDef[];               // static ports
  dynamicPorts?: "conditions" | "branches"; // extra ports generated from the field of that kind
  fields: FieldDef[];
  defaults: Record<string, unknown>;
  docs?: string;                    // short markdown shown in the node panel
  keywords?: string[];              // extra words the palette search matches (e.g. "mssql")
}
export interface ConnectionTypeDef {
  type: string; label: string; description: string; icon: string;
  fields: FieldDef[];               // fields with secret:true are write-only
}
export interface FunctionDoc { name: string; signature: string; description: string; example?: string; }

// ---------------------------------------------------------------- connections & custom connectors
export interface Connection {
  id: string; name: string; type: string;
  config: Record<string, unknown>;  // NON-secret values only
  secretsSet: string[];             // which secret fields have a stored value (values never leave the runtime)
  createdAt: string; updatedAt: string;
}
export interface ConnectorOperation {
  id: string; name: string; description?: string;
  method: string; path: string;     // path may contain {param} placeholders
  params: FieldDef[];               // become node fields
  query?: { key: string; value: string }[];
  headers?: { key: string; value: string }[];
  bodyTemplate?: string;            // template; default: payload
}
/** A user-defined connector. Each operation appears in the palette as node type
 *  "connector:<connectorId>:<operationId>" (category "custom"). */
export interface ConnectorDef {
  id: string; name: string; description?: string; icon?: string;
  connectionType: "http" | "graphql";
  defaultConnectionId?: string;
  operations: ConnectorOperation[];
  source?: "manual" | "openapi";
  createdAt: string; updatedAt: string;
}

// ---------------------------------------------------------------- executions
export type ExecutionStatus = "running" | "success" | "error";
export interface HttpRequestSample {
  method: string; path: string;     // path relative to the flow basePath, e.g. "/voyages/123"
  query?: Record<string, string>; headers?: Record<string, string>; body?: Json;
}
export interface StepTrace {
  seq: number;
  nodeId: string; nodeName: string; nodeType: string;
  status: "success" | "error" | "skipped";
  startedAt: string; durationMs: number;
  port?: string;                    // output port taken
  input?: Json; output?: Json;      // truncated to ~64 KB each; secrets/headers redacted
  truncated?: boolean;
  error?: { message: string; status?: number; detail?: Json };
  iteration?: number;               // inside a for-each body
  branch?: string;                  // inside a parallel branch
  meta?: { http?: { method: string; url: string; status?: number }; cache?: { hit: boolean }; [k: string]: Json | undefined | object };
}
export interface Execution {
  id: string; flowId: string; flowName: string; revision: number;
  mode: "test" | "live" | "node-test";
  via?: "direct" | "gateway";
  trigger: { type: string; nodeId?: string; method?: string; path?: string };
  status: ExecutionStatus;
  startedAt: string; finishedAt?: string; durationMs?: number;
  request?: HttpRequestSample;
  response?: { status: number; headers?: Record<string, string>; body?: Json };
  error?: { message: string; nodeId?: string; nodeName?: string; status?: number };
  steps: StepTrace[];
  logs?: { at: string; level: string; message: string; nodeName?: string }[];
}
export type ExecutionSummary = Omit<Execution, "steps" | "logs" | "request" | "response"> & { stepCount: number; responseStatus?: number };

// The effective catalog (built-ins + custom connector operations) comes from the runtime.
// Until it answers, the built-in catalog bundled with the contract package is used, so the
// canvas, palette and forms always render.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BUILTIN_CONNECTION_TYPES, BUILTIN_NODE_TYPES,
  type CatalogResponse, type ConnectionTypeDef, type FieldDef, type FunctionDoc, type NodeCategory, type NodeTypeDef, type PortDef,
} from "@traceit/weave-flow";
import { studioApi } from "./api.ts";

export const FALLBACK_FUNCTIONS: FunctionDoc[] = [
  { name: "$string", signature: "$string(value)", description: "Turns a value into text.", example: '$string(42) = "42"' },
  { name: "$number", signature: "$number(value)", description: "Turns text into a number.", example: '$number("42") = 42' },
  { name: "$uppercase", signature: "$uppercase(text)", description: "UPPER CASE.", example: '$uppercase("abc") = "ABC"' },
  { name: "$lowercase", signature: "$lowercase(text)", description: "lower case.", example: '$lowercase("ABC") = "abc"' },
  { name: "$trim", signature: "$trim(text)", description: "Removes spaces at both ends and collapses repeated spaces." },
  { name: "$substring", signature: "$substring(text, start, length)", description: "Part of a text.", example: '$substring("hello", 0, 2) = "he"' },
  { name: "$replace", signature: "$replace(text, find, with)", description: "Replaces every occurrence.", example: '$replace("John Smith", " ", "_") = "John_Smith"' },
  { name: "$split", signature: "$split(text, separator)", description: "Splits text into a list.", example: '$split("a,b", ",") = ["a","b"]' },
  { name: "$join", signature: "$join(list, separator)", description: "Joins a list into text.", example: '$join(["a","b"], "-") = "a-b"' },
  { name: "$count", signature: "$count(list)", description: "Number of items in a list." },
  { name: "$sum", signature: "$sum(list)", description: "Adds up a list of numbers." },
  { name: "$map", signature: "$map(list, function($v, $i) { ... })", description: "Transforms every item of a list." },
  { name: "$filter", signature: "$filter(list, function($v) { ... })", description: "Keeps the items for which the function is true." },
  { name: "$exists", signature: "$exists(value)", description: "True when the value is present." },
  { name: "$now", signature: "$now()", description: "Current date and time (ISO 8601)." },
  { name: "$millis", signature: "$millis()", description: "Current time in milliseconds." },
  { name: "$merge", signature: "$merge([object, object])", description: "Merges objects into one." },
  { name: "$keys", signature: "$keys(object)", description: "The field names of an object." },
  { name: "$round", signature: "$round(number, decimals)", description: "Rounds a number." },
  { name: "$boolean", signature: "$boolean(value)", description: "Turns a value into true/false." },
];
export const FALLBACK_INSTRUCTION_EXAMPLES = [
  "add the _ inbetween if name came as two words(customer.name)",
  "copy customer.email",
  "upper case of customer.country",
  "join firstName and lastName with a space",
  "first 3 letters of voyage.code",
  "use 0 if amount is missing",
];

export interface Catalog {
  nodeTypes: NodeTypeDef[];
  connectionTypes: ConnectionTypeDef[];
  functions: FunctionDoc[];
  instructionExamples: string[];
  templates: { id: string; name: string; description: string }[];
  byType: Map<string, NodeTypeDef>;
  /** true when the catalog came from the runtime, false when the bundled fallback is shown */
  live: boolean;
  loading: boolean;
}

export function buildCatalog(res: Partial<CatalogResponse> | undefined, live: boolean, loading = false): Catalog {
  const nodeTypes = Array.isArray(res?.nodeTypes) && res!.nodeTypes!.length ? res!.nodeTypes! : BUILTIN_NODE_TYPES;
  const connectionTypes = Array.isArray(res?.connectionTypes) && res!.connectionTypes!.length ? res!.connectionTypes! : BUILTIN_CONNECTION_TYPES;
  return {
    nodeTypes, connectionTypes,
    functions: Array.isArray(res?.functions) && res!.functions!.length ? res!.functions! : FALLBACK_FUNCTIONS,
    instructionExamples: Array.isArray(res?.instructionExamples) && res!.instructionExamples!.length ? res!.instructionExamples! : FALLBACK_INSTRUCTION_EXAMPLES,
    templates: Array.isArray(res?.templates) ? res!.templates! : [],
    byType: new Map(nodeTypes.map((t) => [t.type, t])),
    live, loading,
  };
}

export function useCatalog(): Catalog {
  const q = useQuery({ queryKey: ["studio", "catalog"], queryFn: studioApi.catalog, staleTime: 30_000, retry: 0 });
  return useMemo(() => buildCatalog(q.data, q.isSuccess, q.isLoading), [q.data, q.isSuccess, q.isLoading]);
}

export const CATEGORY_LABEL: Record<NodeCategory | string, string> = {
  trigger: "Triggers", connector: "Connectors", transform: "Transform", logic: "Logic", utility: "Utility", custom: "Custom connectors",
};
export const CATEGORY_ORDER: string[] = ["trigger", "connector", "custom", "transform", "logic", "utility"];

/** Accent colour (CSS variable) for a node type. */
export function accentOf(def: Pick<NodeTypeDef, "color" | "category"> | undefined): string {
  const c = def?.color ?? (def?.category === "trigger" ? "trigger" : def?.category === "custom" ? "custom" : "util");
  return ["trigger", "http", "data", "logic", "util", "custom"].includes(c) ? `var(--ws-${c})` : "var(--ws-util)";
}

/** Definition used for a node whose type is not in the catalog (a removed custom connector,
 *  or a step of a migrated service that has no Weave equivalent). Never crashes the canvas. */
export function unknownType(type: string, portsInUse: string[] = []): NodeTypeDef {
  const ports = Array.from(new Set(["out", ...portsInUse]));
  const short = type.startsWith("connector:") ? "Custom connector step" : type;
  return {
    type, label: short, category: "custom", description: "This step type is not in the catalog on this server.", icon: "Puzzle", color: "custom",
    hasInput: !type.startsWith("trigger."), outputs: ports.map((p) => ({ id: p, label: portLabel(p), kind: p === "error" ? "error" : "default" } as PortDef)),
    fields: [], defaults: {},
  };
}
export function portLabel(id: string): string {
  if (id === "out") return "Next";
  if (id === "error") return "On error";
  if (id === "otherwise") return "Otherwise";
  if (id === "each") return "Each item";
  if (id === "done") return "Done";
  if (id === "try") return "Try";
  if (id === "catch") return "Catch";
  if (id.startsWith("case:")) return `When ${id.slice(5)}`;
  if (id.startsWith("branch:")) return `Branch ${id.slice(7)}`;
  return id;
}

/** All output ports of a node: dynamic ones (choice cases, parallel branches) first, then static. */
export function portsFor(def: NodeTypeDef, config: Record<string, unknown> | undefined): PortDef[] {
  const dyn: PortDef[] = [];
  if (def.dynamicPorts) {
    const field = def.fields.find((f) => f.kind === def.dynamicPorts);
    const list = field ? (config?.[field.key] ?? def.defaults?.[field.key]) : undefined;
    if (Array.isArray(list)) {
      for (const it of list as { id?: unknown; label?: unknown }[]) {
        if (!it || typeof it.id !== "string" || !it.id) continue;
        const prefix = def.dynamicPorts === "conditions" ? "case:" : "branch:";
        dyn.push({ id: prefix + it.id, label: typeof it.label === "string" && it.label ? it.label : it.id, kind: "branch" });
      }
    }
  }
  return [...dyn, ...def.outputs];
}

export function fieldVisible(f: FieldDef, config: Record<string, unknown>): boolean {
  if (!f.showIf) return true;
  const v = config[f.showIf.key];
  if (f.showIf.in) return f.showIf.in.includes(v as never);
  if ("equals" in f.showIf) return v === f.showIf.equals;
  return true;
}
export function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

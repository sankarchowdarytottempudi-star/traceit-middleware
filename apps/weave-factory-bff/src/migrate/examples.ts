// "Test data": examples a person gives for each operation of a migrated API (the request and the
// answer they expect) and, optionally, for one TODO step (its input and the output it should give).
// Only these fields travel on to the migration tool, which keeps them, turns them into tests and
// works out suggested answers for TODO steps. Nothing is applied, deployed or enabled from here.

/** Largest JSON "Save examples" request (bytes). */
export const EXAMPLES_MAX = 2 * 1024 * 1024;
/** Largest filled examples workbook (bytes). */
export const EXAMPLES_XLSX_MAX = 10 * 1024 * 1024;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const oneLine = (s: string) => !/[\r\n\0]/.test(s);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export interface ExampleInput {
  kind: "operation" | "step"; id?: string; delete?: true; operation?: string; step?: string; name?: string; note?: string;
  request?: Record<string, unknown>; response?: Record<string, unknown>; input?: unknown; output?: unknown;
}

/** "Save examples": each example checked for its shape; the tool checks whether it fits the API. */
export function examplesOf(body: unknown): { ok: true; examples: ExampleInput[] } | { ok: false; error: string } {
  const b = isObj(body) ? body : {};
  if (!Array.isArray(b.examples) || b.examples.length === 0) return { ok: false, error: "No examples were sent." };
  if (b.examples.length > 500) return { ok: false, error: "Send at most 500 examples at a time." };
  const out: ExampleInput[] = [];
  for (const raw of b.examples) {
    const r = isObj(raw) ? raw : {};
    const kind = r.kind === "step" ? "step" : r.kind === "operation" ? "operation" : "";
    const id = str(r.id, 60).trim();
    if (id && !oneLine(id)) return { ok: false, error: "An example has an odd id." };
    if (r.delete === true) {
      if (!id) return { ok: false, error: "Say which example to remove." };
      out.push({ kind: kind || "operation", id, delete: true });
      continue;
    }
    if (!kind) return { ok: false, error: "Say whether each example is for an operation or a TODO step." };
    const e: ExampleInput = { kind, ...(id ? { id } : {}) };
    if (kind === "operation") {
      const operation = str(r.operation, 300).trim();
      if (!operation || !oneLine(operation)) return { ok: false, error: "Choose the operation of each example." };
      if (!isObj(r.request)) return { ok: false, error: "Give the request of each example." };
      if (!isObj(r.response)) return { ok: false, error: "Give the answer you expect for each example." };
      Object.assign(e, { operation, request: r.request, response: r.response });
    } else {
      const step = str(r.step, 60).trim();
      if (!step || !oneLine(step)) return { ok: false, error: "Choose the TODO step of each step example." };
      if (r.input === undefined || r.output === undefined) return { ok: false, error: "Give the input and the output of each step example." };
      Object.assign(e, { step, input: r.input, output: r.output });
    }
    const name = str(r.name, 200).trim(), note = str(r.note, 2000).trim();
    if (name) e.name = name;
    if (note) e.note = note;
    out.push(e);
  }
  return { ok: true, examples: out };
}

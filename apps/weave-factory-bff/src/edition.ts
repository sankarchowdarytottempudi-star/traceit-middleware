// The edition this server runs as. Unset (or "traceit"): every source technology and every target the
// migration tool knows. WEAVE_EDITION=cruise-saudi: MuleSoft (Mule 4) to WSO2 (Ballerina) only. Anything
// else is refused here with a plain message, so the restriction does not depend on the screen.
import { sniffAll } from "./migrate/paste.js";

export type Edition = "traceit" | "cruise-saudi";
export function editionOf(env: NodeJS.ProcessEnv = process.env): Edition {
  return (env.WEAVE_EDITION ?? "").trim().toLowerCase() === "cruise-saudi" ? "cruise-saudi" : "traceit";
}
export const muleOnly = (e: Edition): boolean => e === "cruise-saudi";

export const ONLY_SOURCE = "mule4";
export const ONLY_TARGETS = ["wso2", "ballerina"] as const;
/** Single files a Mule project is made of (flows, DataWeave, settings, schemas). */
export const MULE_SINGLE_FILES = [".xml", ".dwl", ".properties", ".yaml", ".yml", ".wsdl", ".xsd"];

export const MSG = {
  source: "This installation migrates MuleSoft (Mule 4) projects only. Upload a Mule 4 project (.zip or .jar), or paste Mule flow XML or DataWeave.",
  target: "This installation migrates to WSO2 only.",
  requirements: "This installation migrates MuleSoft (Mule 4) projects to WSO2 only. A service cannot be made from a requirement document here.",
  spec: "This installation migrates MuleSoft (Mule 4) projects to WSO2 only. A written specification is not accepted here.",
  platforms: "This installation migrates to WSO2 only. There are no Boomi or Workato accounts or imports here.",
  file: "This installation migrates MuleSoft (Mule 4) projects only. Upload the Mule project as a .zip or .jar, or one Mule flow XML or DataWeave file.",
  notMule: "This does not look like Mule 4 code (Mule flow XML or DataWeave). This installation migrates MuleSoft (Mule 4) projects only.",
} as const;

type Check = { ok: true } | { ok: false; error: string };
const OK: Check = { ok: true };
const no = (error: string): Check => ({ ok: false, error });

export function targetOk(e: Edition, target: string | undefined): Check {
  if (!muleOnly(e)) return OK;
  return (ONLY_TARGETS as readonly string[]).includes((target || "wso2").toLowerCase()) ? OK : no(MSG.target);
}

/** An upload (query of POST /api/factory/migrations). "auto" or no sourceType is read as Mule. */
export function uploadOk(e: Edition, q: { sourceType?: string; target?: string; filename?: string }): Check {
  if (!muleOnly(e)) return OK;
  const st = (q.sourceType || "").toLowerCase();
  if (st === "requirements") return no(MSG.requirements);
  if (st === "spec") return no(MSG.spec);
  if (st && st !== "auto" && st !== ONLY_SOURCE) return no(MSG.source);
  const t = targetOk(e, q.target);
  if (!t.ok) return t;
  const ext = (/\.[a-z0-9]+$/i.exec((q.filename || "").replace(/^.*[\\/]/, ""))?.[0] || "").toLowerCase();
  if (ext && ext !== ".zip" && ext !== ".jar" && !MULE_SINGLE_FILES.includes(ext)) return no(MSG.file);
  return OK;
}

/** One uploaded source file (wrapped into a project here): it must read as Mule, or say nothing about its technology. */
export function singleFileOk(e: Edition, name: string, text: string): Check {
  if (!muleOnly(e)) return OK;
  const t = sniffAll([{ name, text }]);
  return t === ONLY_SOURCE || t === "unknown" ? OK : no(MSG.notMule);
}

/** Pasted code: the technology chosen must be Mule (or "detect"), and the pieces must read as Mule. */
export function pasteOk(e: Edition, body: unknown): Check {
  if (!muleOnly(e)) return OK;
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const tech = typeof b.technology === "string" && b.technology ? b.technology.toLowerCase() : "auto";
  if (tech !== "auto" && tech !== ONLY_SOURCE) return no(MSG.source);
  const t = targetOk(e, typeof b.target === "string" ? b.target : undefined);
  if (!t.ok) return t;
  const snippets = (Array.isArray(b.snippets) ? b.snippets : [])
    .filter((s): s is { name?: unknown; text?: unknown } => !!s && typeof s === "object")
    .map((s) => ({ name: typeof s.name === "string" ? s.name : "", text: typeof s.text === "string" ? s.text : "" }))
    .filter((s) => s.text.trim());
  if (!snippets.length) return OK; // the form check says what is missing
  const found = sniffAll(snippets);
  if (found === ONLY_SOURCE) return OK;
  // nothing in the pieces says what they are: accepted only when the person said "Mule"
  if (found === "unknown" && tech === ONLY_SOURCE) return OK;
  return no(MSG.notMule);
}

/** What the "New migration" screen is told it may choose from. */
export function editionOptions<T extends {
  technologies: { id: string }[]; targets: { id: string }[]; extensions: string[];
  singleFileExtensions: string[]; integrationFileExtensions: string[]; paste: { technologies: readonly { id: string }[] };
  requirements?: unknown;
}>(e: Edition, o: T): T & { edition: Edition } {
  if (!muleOnly(e)) return { ...o, edition: e };
  const only = {
    ...o,
    edition: e,
    technologies: o.technologies.filter((t) => t.id === ONLY_SOURCE),
    targets: o.targets.filter((t) => (ONLY_TARGETS as readonly string[]).includes(t.id)),
    extensions: o.extensions.filter((x) => x === ".zip" || x === ".jar" || MULE_SINGLE_FILES.includes(x)),
    singleFileExtensions: o.singleFileExtensions.filter((x) => MULE_SINGLE_FILES.includes(x)),
    integrationFileExtensions: [],
    requirements: undefined,
    paste: { ...o.paste, technologies: o.paste.technologies.filter((t) => t.id === ONLY_SOURCE) },
  };
  return only as unknown as T & { edition: Edition };
}

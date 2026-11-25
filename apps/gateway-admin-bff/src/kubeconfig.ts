// Access to the cluster the migrated APIs run on (the "target" cluster). By default that is the
// cluster this server reads with K8S_API_URL / K8S_TOKEN_FILE / K8S_CA_FILE; when the APIs are
// installed on another cluster, TARGET_KUBECONFIG (a kubeconfig file, + TARGET_KUBE_CONTEXT) or
// TARGET_K8S_API_URL + TARGET_K8S_TOKEN_FILE (+ TARGET_K8S_CA_FILE) point at it, and
// TARGET_K8S_NAMESPACE names the namespace the APIs are in.
// Only the kubeconfig shapes a service account or a client certificate gives are understood
// (token, token file, client certificate/key, CA data or file, insecure-skip-tls-verify);
// exec plugins and auth providers are refused with a clear reason.
// Same file in apps/weave-factory-bff/src/estate and apps/gateway-admin-bff/src: keep them equal.
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export interface KubeAccess {
  apiUrl: string;
  token?: string; tokenFile?: string;
  ca?: string; cert?: string; key?: string;
  insecure?: boolean;
  namespace?: string;   // the context's namespace, when the kubeconfig names one
  context?: string;
}
export interface TargetEnv {
  TARGET_KUBECONFIG?: string; TARGET_KUBE_CONTEXT?: string;
  TARGET_K8S_API_URL?: string; TARGET_K8S_TOKEN_FILE?: string; TARGET_K8S_CA_FILE?: string; TARGET_K8S_NAMESPACE?: string;
}
/** null: no target configured (use the local cluster). error: configured but not usable. */
export type Target = null | { access?: KubeAccess; namespace?: string; error?: string; source: string };

// ------------------------------------------------------------------ a small YAML reader
// Block mappings, block sequences ("- " items), plain/quoted scalars, comments, {} and [].
// Enough for kubeconfig files written by kubectl; JSON (also YAML) is read with JSON.parse.
type Y = string | boolean | number | null | Y[] | { [k: string]: Y };
interface Line { indent: number; text: string; }

function scalar(raw: string): Y {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "{}") return {};
  if (s === "[]") return [];
  if (s === "true") return true;
  if (s === "false") return false;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) { try { return JSON.parse(s) as string; } catch { return s.slice(1, -1); } }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}
function stripComment(t: string): string {
  let q: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(t[i - 1]))) return t.slice(0, i);
  }
  return t;
}
const KEY = /^("[^"]*"|'[^']*'|[^:]+?):(?:\s+(.*)|\s*)$/;

function parseBlock(lines: Line[], start: number, indent: number): [Y, number] {
  if (start >= lines.length) return [null, start];
  const first = lines[start];
  if (first.text.startsWith("- ") || first.text === "-") {
    const arr: Y[] = []; let i = start;
    while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith("- ") || lines[i].text === "-")) {
      const rest = lines[i].text === "-" ? "" : lines[i].text.slice(2);
      if (!rest.trim()) { const [v, n] = parseBlock(lines, i + 1, lines[i + 1]?.indent ?? indent + 2); arr.push(v); i = n; continue; }
      // "- key: value" opens a mapping whose further keys are indented to the key's column
      const col = indent + 2 + (rest.length - rest.trimStart().length);
      const sub: Line[] = [{ indent: col, text: rest.trimStart() }];
      let j = i + 1;
      while (j < lines.length && lines[j].indent > indent) { sub.push(lines[j]); j++; }
      const [v] = KEY.test(rest.trim()) ? parseBlock(sub, 0, col) : [scalar(rest)];
      arr.push(v); i = j;
    }
    return [arr, i];
  }
  const obj: { [k: string]: Y } = {}; let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const m = KEY.exec(lines[i].text);
    if (!m) throw new Error(`line ${i + 1}: not a "key: value" line`);
    const key = String(scalar(m[1]));
    if (m[2] !== undefined && m[2].trim() !== "") { obj[key] = scalar(m[2]); i++; continue; }
    const next = lines[i + 1];
    if (next && (next.indent > indent || (next.indent === indent && next.text.startsWith("- ")))) {
      const [v, n] = parseBlock(lines, i + 1, next.indent); obj[key] = v; i = n;
    } else { obj[key] = null; i++; }
  }
  return [obj, i];
}
export function parseYaml(text: string): Y {
  const t = text.replace(/^﻿/, "");
  if (/^\s*[{[]/.test(t)) return JSON.parse(t) as Y;
  const lines: Line[] = [];
  for (const raw of t.split(/\r?\n/)) {
    if (/^\s*(---|\.\.\.)\s*$/.test(raw)) continue;
    const s = stripComment(raw).replace(/\s+$/, "");
    if (!s.trim()) continue;
    if (/^\s*\t/.test(s)) throw new Error("tabs are not allowed for indentation");
    lines.push({ indent: s.length - s.trimStart().length, text: s.trimStart() });
  }
  if (!lines.length) return null;
  const [v, n] = parseBlock(lines, 0, lines[0].indent);
  if (n < lines.length) throw new Error(`line ${n + 1}: unexpected indentation`);
  return v;
}

// ------------------------------------------------------------------ kubeconfig
const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const named = (list: unknown, name: string, what: string) => {
  const hit = (Array.isArray(list) ? list : []).find((x) => obj(x).name === name);
  if (!hit) throw new Error(`the kubeconfig has no ${what} "${name}"`);
  return obj(obj(hit)[what]);
};
const b64 = (s: unknown) => Buffer.from(String(s), "base64").toString("utf8");

/** Server, credentials and namespace of one context of a kubeconfig (its current context by default). */
export function parseKubeconfig(text: string, context?: string, baseDir = "."): KubeAccess {
  const doc = obj(parseYaml(text));
  const ctxName = context || String(doc["current-context"] || "");
  if (!ctxName) throw new Error("the kubeconfig has no current-context; set TARGET_KUBE_CONTEXT");
  const ctx = named(doc.contexts, ctxName, "context");
  const cluster = named(doc.clusters, String(ctx.cluster || ""), "cluster");
  const user = ctx.user ? named(doc.users, String(ctx.user), "user") : {};
  const file = (p: unknown) => readFileSync(isAbsolute(String(p)) ? String(p) : resolve(baseDir, String(p)), "utf8");
  if (user.exec || user["auth-provider"]) throw new Error("the kubeconfig user signs in with a plugin (exec/auth-provider); give a service-account token instead");
  if (!cluster.server) throw new Error(`cluster of context "${ctxName}" has no server`);
  const a: KubeAccess = { apiUrl: String(cluster.server).replace(/\/+$/, ""), context: ctxName };
  if (cluster["certificate-authority-data"]) a.ca = b64(cluster["certificate-authority-data"]);
  else if (cluster["certificate-authority"]) a.ca = file(cluster["certificate-authority"]);
  if (cluster["insecure-skip-tls-verify"] === true) a.insecure = true;
  if (user.token) a.token = String(user.token);
  else if (user.tokenFile || user["token-file"]) { const p = String(user.tokenFile || user["token-file"]); a.tokenFile = isAbsolute(p) ? p : resolve(baseDir, p); }
  if (user["client-certificate-data"]) a.cert = b64(user["client-certificate-data"]);
  else if (user["client-certificate"]) a.cert = file(user["client-certificate"]);
  if (user["client-key-data"]) a.key = b64(user["client-key-data"]);
  else if (user["client-key"]) a.key = file(user["client-key"]);
  if (!a.token && !a.tokenFile && !(a.cert && a.key)) throw new Error(`user of context "${ctxName}" has no token or client certificate`);
  if (ctx.namespace) a.namespace = String(ctx.namespace);
  return a;
}

/** The target cluster from the environment; null when none is set (the local cluster is used). */
export function targetFromEnv(env: TargetEnv): Target {
  const ns = env.TARGET_K8S_NAMESPACE || undefined;
  if (env.TARGET_KUBECONFIG) {
    try {
      const access = parseKubeconfig(readFileSync(env.TARGET_KUBECONFIG, "utf8"), env.TARGET_KUBE_CONTEXT || undefined, dirname(env.TARGET_KUBECONFIG));
      return { access, namespace: ns || access.namespace, source: "kubeconfig" };
    } catch (e) {
      // never fall back to the local cluster: it would show the wrong services as if they were the target's
      const why = (e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "EACCES" ? "the kubeconfig file is not readable" : (e as Error).message;
      return { error: `Target cluster: ${why}`, namespace: ns, source: "kubeconfig" };
    }
  }
  if (env.TARGET_K8S_API_URL) {
    if (!env.TARGET_K8S_TOKEN_FILE) return { error: "Target cluster: TARGET_K8S_TOKEN_FILE is not set", namespace: ns, source: "env" };
    let ca: string | undefined;
    if (env.TARGET_K8S_CA_FILE) { try { ca = readFileSync(env.TARGET_K8S_CA_FILE, "utf8"); } catch { return { error: "Target cluster: TARGET_K8S_CA_FILE is not readable", namespace: ns, source: "env" }; } }
    return { access: { apiUrl: env.TARGET_K8S_API_URL.replace(/\/+$/, ""), tokenFile: env.TARGET_K8S_TOKEN_FILE, ca }, namespace: ns, source: "env" };
  }
  return null;
}

/** Authorization header and TLS options of one request (a token file is read on every call: tokens rotate). */
export function authOf(a: KubeAccess): { headers: Record<string, string>; tls: { ca?: string; cert?: string; key?: string; rejectUnauthorized?: boolean } } {
  const headers: Record<string, string> = {};
  const token = a.token ?? (a.tokenFile ? readFileSync(a.tokenFile, "utf8").trim() : undefined);
  if (token) headers.Authorization = `Bearer ${token}`;
  const tls: { ca?: string; cert?: string; key?: string; rejectUnauthorized?: boolean } = {};
  if (a.ca) tls.ca = a.ca;
  if (a.cert && a.key) { tls.cert = a.cert; tls.key = a.key; }
  if (a.insecure) tls.rejectUnauthorized = false;
  return { headers, tls };
}

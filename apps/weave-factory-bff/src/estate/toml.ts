// Small TOML reader for Ballerina Config.toml files (tables, dotted and quoted keys, strings,
// numbers, booleans, arrays, inline tables, multi-line strings). Read-only and forgiving: a line it
// cannot understand is skipped rather than failing the whole file.

export type TomlValue = string | number | boolean | TomlValue[] | { [k: string]: TomlValue };
export type TomlTable = { [k: string]: TomlValue };

function parseKey(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    while (i < n && /\s/.test(src[i])) i++;
    if (i >= n) break;
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i];
      let j = i + 1, s = "";
      while (j < n && src[j] !== q) { if (q === '"' && src[j] === "\\") { j++; s += src[j] ?? ""; } else s += src[j]; j++; }
      out.push(s); i = j + 1;
    } else {
      let j = i;
      while (j < n && src[j] !== "." && !/\s/.test(src[j])) j++;
      out.push(src.slice(i, j)); i = j;
    }
    while (i < n && /\s/.test(src[i])) i++;
    if (src[i] === ".") i++;
  }
  return out;
}

class Reader {
  i = 0;
  constructor(readonly s: string) {}
  ws(newlines = false) {
    for (;;) {
      const c = this.s[this.i];
      if (c === " " || c === "\t" || c === "\r" || (newlines && c === "\n")) this.i++;
      else if (c === "#") { while (this.i < this.s.length && this.s[this.i] !== "\n") this.i++; }
      else break;
    }
  }
  value(): TomlValue {
    this.ws();
    const s = this.s;
    const c = s[this.i];
    if (s.startsWith('"""', this.i) || s.startsWith("'''", this.i)) {
      const q = s.substr(this.i, 3);
      let end = s.indexOf(q, this.i + 3);
      if (end < 0) end = s.length;
      let body = s.slice(this.i + 3, end);
      if (body.startsWith("\n")) body = body.slice(1);
      this.i = end + 3;
      return q === '"""' ? body.replace(/\\\n\s*/g, "").replace(/\\(["\\nrt])/g, (_m, x) => ({ n: "\n", r: "\r", t: "\t" } as Record<string, string>)[x] ?? x) : body;
    }
    if (c === '"') {
      let j = this.i + 1, out = "";
      while (j < s.length && s[j] !== '"' && s[j] !== "\n") {
        if (s[j] === "\\") {
          j++;
          const e = s[j];
          if (e === "n") out += "\n"; else if (e === "t") out += "\t"; else if (e === "r") out += "\r";
          else if (e === "u") { out += String.fromCharCode(parseInt(s.substr(j + 1, 4), 16) || 32); j += 4; }
          else out += e ?? "";
        } else out += s[j];
        j++;
      }
      this.i = j + 1;
      return out;
    }
    if (c === "'") {
      let j = s.indexOf("'", this.i + 1);
      if (j < 0) j = s.length;
      const out = s.slice(this.i + 1, j);
      this.i = j + 1;
      return out;
    }
    if (c === "[") {
      this.i++;
      const out: TomlValue[] = [];
      for (;;) {
        this.ws(true);
        if (this.i >= s.length) break;
        if (s[this.i] === "]") { this.i++; break; }
        out.push(this.value());
        this.ws(true);
        if (s[this.i] === ",") this.i++;
      }
      return out;
    }
    if (c === "{") {
      this.i++;
      const out: TomlTable = {};
      for (;;) {
        this.ws(true);
        if (this.i >= s.length) break;
        if (s[this.i] === "}") { this.i++; break; }
        let j = this.i, inQ = "";
        while (j < s.length && (inQ || s[j] !== "=")) { if (!inQ && (s[j] === '"' || s[j] === "'")) inQ = s[j]; else if (inQ && s[j] === inQ) inQ = ""; j++; }
        const key = parseKey(s.slice(this.i, j));
        this.i = j + 1;
        put(out, key, this.value());
        this.ws(true);
        if (s[this.i] === ",") this.i++;
      }
      return out;
    }
    let j = this.i;
    while (j < s.length && !/[\n,#\]}]/.test(s[j])) j++;
    const raw = s.slice(this.i, j).trim();
    this.i = j;
    if (raw === "true") return true;
    if (raw === "false") return false;
    const num = Number(raw.replace(/_/g, ""));
    if (raw !== "" && !Number.isNaN(num)) return num;
    return raw;
  }
}

function put(root: TomlTable, key: string[], value: TomlValue) {
  let t = root;
  for (let k = 0; k < key.length - 1; k++) {
    const cur = t[key[k]];
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) t[key[k]] = {};
    t = t[key[k]] as TomlTable;
  }
  if (key.length) t[key[key.length - 1]] = value;
}

export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable = root;
  const r = new Reader(text);
  const s = text;
  while (r.i < s.length) {
    r.ws(true);
    if (r.i >= s.length) break;
    if (s[r.i] === "[") {
      const arrayTable = s[r.i + 1] === "[";
      const close = s.indexOf(arrayTable ? "]]" : "]", r.i);
      const nl = s.indexOf("\n", r.i);
      if (close < 0 || (nl >= 0 && close > nl)) { r.i = nl < 0 ? s.length : nl + 1; continue; }
      const key = parseKey(s.slice(r.i + (arrayTable ? 2 : 1), close));
      r.i = close + (arrayTable ? 2 : 1);
      let t = root;
      for (let k = 0; k < key.length; k++) {
        const last = k === key.length - 1;
        const cur = t[key[k]];
        if (last && arrayTable) {
          const arr = Array.isArray(cur) ? cur : [];
          const item: TomlTable = {};
          arr.push(item);
          t[key[k]] = arr;
          t = item;
        } else if (Array.isArray(cur) && cur.length && typeof cur[cur.length - 1] === "object") {
          t = cur[cur.length - 1] as TomlTable;
        } else {
          if (!cur || typeof cur !== "object" || Array.isArray(cur)) t[key[k]] = {};
          t = t[key[k]] as TomlTable;
        }
      }
      current = t;
      continue;
    }
    // key = value
    let j = r.i, inQ = "";
    while (j < s.length && s[j] !== "\n" && (inQ || s[j] !== "=")) { if (!inQ && (s[j] === '"' || s[j] === "'")) inQ = s[j]; else if (inQ && s[j] === inQ) inQ = ""; j++; }
    if (s[j] !== "=") { r.i = j + 1; continue; }
    const key = parseKey(s.slice(r.i, j));
    r.i = j + 1;
    const value = r.value();
    if (key.length) put(current, key, value);
    // rest of the line
    while (r.i < s.length && s[r.i] !== "\n") r.i++;
  }
  return root;
}

// ------------------------------------------------------------------ flattening and masking

/** Keys whose values must never be shown. */
export const SECRET_KEY = /(pass(word|wd|phrase)|(^|[._-])pass$|secret|token|credential|authorization|api[-_]?key|private[-_]?key|access[-_]?key|client[-_]?id|^key$|[a-z]Key$|_key$|signature|salt)/i;
// `client_id`-style identifiers are treated as sensitive too: they identify a tenant at a backend.
const NOT_SECRET = /^(keyPrefix|keyspace|cacheKey|keyTtl\w*|keysPerBatch|primaryKey|tokenUrl|tokenTtl\w*|tokenPath)$/i;

export function isSecretKey(key: string): boolean {
  const last = key.split(".").pop() || key;
  if (NOT_SECRET.test(last)) return false;
  return SECRET_KEY.test(last) || /[a-z0-9](Pass|Pwd)$/.test(last);
}

/** Remove user:password@ from URLs and mask query-string credentials. */
export function scrubUrl(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s"']+@/gi, "$1")
    .replace(/([?&](?:[\w.-]*(?:token|secret|password|passwd|key|signature|sig)[\w.-]*)=)[^&\s"']+/gi, "$1***");
}

export function showValue(key: string, value: unknown): string {
  if (isSecretKey(key)) {
    const empty = value === "" || value === null || value === undefined;
    return empty ? "not set" : "set";
  }
  if (typeof value === "string") return scrubUrl(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return scrubUrl(JSON.stringify(maskDeep(value)));
}

/** Copy of a value with every secret-like key replaced by "set" / "not set". */
export function maskDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = isSecretKey(k) ? showValue(k, v) : maskDeep(v);
    return out;
  }
  return typeof value === "string" ? scrubUrl(value) : value;
}

const IDENT = /^[A-Za-z_][\w-]*$/;
export function joinKey(prefix: string, k: string): string {
  const part = IDENT.test(k) ? k : JSON.stringify(k);
  return prefix ? `${prefix}.${part}` : part;
}

/** Flatten nested tables into dotted keys. Arrays stay as one value. */
export function flatten(value: unknown, prefix = "", out: { key: string; value: unknown }[] = []): { key: string; value: unknown }[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length && prefix) out.push({ key: prefix, value: {} });
    for (const [k, v] of entries) flatten(v, joinKey(prefix, k), out);
  } else if (prefix) out.push({ key: prefix, value });
  return out;
}

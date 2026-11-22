// What the screens may send for the agent's open decisions, a person's version of a document, the
// target platform accounts and the import options. Only these fields travel on to the migration tool.

/** Largest "Save answers" request (bytes). */
export const DECISIONS_MAX = 1024 * 1024;
/** Largest edited document (bytes of text). */
export const DOCUMENT_MAX = 2 * 1024 * 1024;
export const TARGETS = ["boomi", "workato"] as const;
export type Target = (typeof TARGETS)[number];

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const ANSWER_TYPES = new Set(["connector", "expression", "code", "call", "drop", "manual"]);

export type Answer =
  | { type: "connector"; connector: string; operation: string }
  | { type: "expression"; text: string }
  | { type: "code"; language: string; text: string }
  | { type: "call"; services: string[] }
  | { type: "drop" }
  | { type: "manual" };
export interface AnswerInput { id: string; answer: Answer; scope: "api" | "workspace"; note?: string }

/** "Save answers": every answer checked for its shape; the tool checks whether it fits the decision. */
export function answersOf(body: unknown): { ok: true; answers: AnswerInput[] } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (!Array.isArray(b.answers) || b.answers.length === 0) return { ok: false, error: "No answers were sent." };
  if (b.answers.length > 500) return { ok: false, error: "Save at most 500 answers at a time." };
  const out: AnswerInput[] = [];
  for (const raw of b.answers) {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const id = str(r.id, 300).trim();
    if (!id || /[\r\n\0]/.test(id)) return { ok: false, error: "An answer has no decision." };
    const a = (r.answer && typeof r.answer === "object" ? r.answer : {}) as Record<string, unknown>;
    const type = str(a.type, 20);
    if (!ANSWER_TYPES.has(type)) return { ok: false, error: "Choose how each step should be done." };
    let answer: Answer;
    if (type === "connector") {
      const connector = str(a.connector, 200).trim(), operation = str(a.operation, 200).trim();
      if (!connector) return { ok: false, error: "Choose the connector to use." };
      answer = { type, connector, operation };
    } else if (type === "expression") {
      const text = str(a.text, 20000);
      if (!text.trim()) return { ok: false, error: "Write the expression." };
      answer = { type, text };
    } else if (type === "code") {
      const language = str(a.language, 30).trim().toLowerCase(), text = str(a.text, 200000);
      if (!/^[a-z0-9+#-]{1,30}$/.test(language)) return { ok: false, error: "Choose the language of the code." };
      if (!text.trim()) return { ok: false, error: "Write the code." };
      answer = { type, language, text };
    } else if (type === "call") {
      const services = (Array.isArray(a.services) ? a.services : []).map((x) => str(x, 200).trim()).filter(Boolean).slice(0, 50);
      if (!services.length) return { ok: false, error: "Name at least one service to call." };
      answer = { type, services };
    } else answer = { type } as Answer;
    const scope = r.scope === "workspace" ? "workspace" : "api";
    const note = str(r.note, 2000).trim();
    out.push({ id, answer, scope, ...(note ? { note } : {}) });
  }
  return { ok: true, answers: out };
}

/** A document name as the tool lists it ("MAPPING.md"): no folders, nothing hidden. */
export const docNameOk = (name: string) => name.length <= 120 && /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.md$/.test(name) && !name.includes("..");

export function docEditOf(body: unknown): { ok: true; edit: { text: string; note?: string } } | { ok: false; status: number; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof b.text !== "string") return { ok: false, status: 400, error: "No document text was sent." };
  if (Buffer.byteLength(b.text) > DOCUMENT_MAX) return { ok: false, status: 413, error: "The document is larger than 2 MB." };
  if (!b.text.trim()) return { ok: false, status: 400, error: "The document is empty. Use \"Revert to the generated version\" to drop your version." };
  const note = str(b.note, 500).trim();
  return { ok: true, edit: { text: b.text, ...(note ? { note } : {}) } };
}

const FOLDER = /^[A-Za-z0-9._:-]{1,120}$/;
const tokenOk = (t: string) => t.length <= 4000 && !/[\r\n\0]/.test(t);
const httpsOk = (u: string) => /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[\w./-]*)?$/.test(u);

/** One target platform account. An empty token keeps the saved one (the tool decides). */
export function targetAccountOf(target: string, body: unknown): { ok: true; account: Record<string, string> } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const token = typeof b.token === "string" ? b.token.trim() : "";
  if (!tokenOk(token)) return { ok: false, error: "The token is not in a form the platform accepts." };
  if (target === "boomi") {
    const accountId = str(b.accountId, 200).trim(), user = str(b.user, 200).trim();
    const apiBase = str(b.apiBase, 300).trim(), folder = str(b.folderParentId, 200).trim();
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(accountId)) return { ok: false, error: "Type the Boomi account ID (letters, digits, - _ and . only)." };
    if (!/^[^\s@]{1,100}@[^\s@]{1,100}$/.test(user)) return { ok: false, error: "Type the login e-mail of the Boomi user." };
    if (apiBase && !httpsOk(apiBase)) return { ok: false, error: "The Boomi address must start with https://." };
    if (folder && !FOLDER.test(folder)) return { ok: false, error: "A folder id has letters, digits and - _ . : only." };
    return { ok: true, account: { accountId, user, token, ...(apiBase ? { apiBase } : {}), ...(folder ? { folderParentId: folder } : {}) } };
  }
  if (target === "workato") {
    const apiBase = str(b.apiBase, 300).trim(), folder = str(b.parentFolderId, 200).trim();
    if (!httpsOk(apiBase) || !/(^|\.)workato\.com(:\d+)?(\/|$)/i.test(apiBase.replace(/^https:\/\//, ""))) return { ok: false, error: "Choose the Workato data center." };
    if (folder && !/^\d{1,20}$/.test(folder)) return { ok: false, error: "A Workato folder id is a number." };
    return { ok: true, account: { apiBase, token, ...(folder ? { parentFolderId: folder } : {}) } };
  }
  return { ok: false, error: "Unknown target platform." };
}

/** Options of one migration a person can switch from the screen. */
export function migrationOptionsOf(body: unknown): { ok: true; options: { autoImport: boolean } } | { ok: false; error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof b.autoImport !== "boolean") return { ok: false, error: "Say whether to import automatically." };
  return { ok: true, options: { autoImport: b.autoImport } };
}

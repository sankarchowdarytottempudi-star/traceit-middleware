// Users, their roles and the directory-group mapping, in one JSON file shared by the Gateway and
// the Factory (WEAVE_USERS_FILE). Every change takes a lock file next to it, reads the file fresh,
// writes a temporary copy, flushes it and renames it over the old one, so two processes never
// lose each other's changes and a reader never sees half a file.
import crypto from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { cleanRoles, type GroupRole, type Role } from "./roles.js";

export type Provider = "local" | "oidc" | "wso2";

export interface UserRecord {
  id: string;
  /** Sign-in name: e-mail for local and Microsoft accounts, the API Manager user name for wso2. */
  email: string;
  name: string;
  provider: Provider;
  /** Directory object id (Entra "oid") once the person has signed in; empty for an invitation. */
  subject?: string;
  roles: Role[];
  disabled: boolean;
  passwordHash?: string;
  /** "invited" (added by an admin), "groups" (created at first sign-in from a group mapping), "bootstrap". */
  source?: string;
  createdAt: string;
  createdBy?: string;
  updatedAt: string;
  lastSignInAt?: string;
}

export interface UsersFile { version: 1; users: UserRecord[]; groupRoles: GroupRole[]; updatedAt?: string }

/** A user as shown to the admin screen: never the password hash. */
export type PublicUser = Omit<UserRecord, "passwordHash"> & { hasPassword: boolean };
export function publicUser(u: UserRecord): PublicUser {
  const { passwordHash, ...rest } = u;
  return { ...rest, hasPassword: !!passwordHash };
}

const EMPTY: UsersFile = { version: 1, users: [], groupRoles: [] };
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30_000;

function sleepSync(ms: number) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

export function normEmail(v: string): string { return v.trim().toLowerCase(); }

function sanitize(raw: unknown): UsersFile {
  const j = (raw && typeof raw === "object" ? raw : {}) as Partial<UsersFile>;
  const users = Array.isArray(j.users) ? j.users.filter((u) => u && typeof u.id === "string" && typeof u.email === "string")
    .map((u) => ({ ...u, roles: cleanRoles(u.roles), disabled: !!u.disabled })) : [];
  const groupRoles = Array.isArray(j.groupRoles) ? j.groupRoles.filter((g) => g && typeof g.group === "string" && g.group.trim())
    .map((g) => ({ group: g.group.trim(), ...(g.label ? { label: String(g.label) } : {}), roles: cleanRoles(g.roles) })) : [];
  return { version: 1, users, groupRoles, updatedAt: j.updatedAt };
}

export class UserStore {
  private cache: { key: string; data: UsersFile } | null = null;
  constructor(readonly file: string) {}

  /** Current contents; re-read only when the file changed on disk. */
  read(): UsersFile {
    let st;
    try { st = statSync(this.file); } catch { return structuredClone(EMPTY); }
    const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
    if (this.cache?.key === key) return this.cache.data;
    const data = sanitize(JSON.parse(readFileSync(this.file, "utf8")));
    this.cache = { key, data };
    return data;
  }

  /** Runs `fn` on a fresh copy under the lock and saves what it returns. */
  update<T>(fn: (d: UsersFile) => T): T {
    mkdirSync(dirname(this.file), { recursive: true });
    const lock = `${this.file}.lock`;
    const started = Date.now();
    let fd = -1;
    for (;;) {
      try { fd = openSync(lock, "wx", 0o600); break; } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { unlinkSync(lock); continue; } } catch { continue; }
        if (Date.now() - started > LOCK_WAIT_MS) throw Object.assign(new Error("The user list is busy; try again."), { statusCode: 503 });
        sleepSync(20);
      }
    }
    try {
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      let data: UsersFile;
      try { data = sanitize(JSON.parse(readFileSync(this.file, "utf8"))); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        data = structuredClone(EMPTY);
      }
      const out = fn(data);
      data.updatedAt = new Date().toISOString();
      const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      const t = openSync(tmp, "w", 0o600);
      try { writeSync(t, JSON.stringify(data, null, 2) + "\n"); fsyncSync(t); } finally { closeSync(t); }
      renameSync(tmp, this.file);
      try { const d = openSync(dirname(this.file), "r"); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* not all systems allow it */ }
      this.cache = null;
      return out;
    } finally {
      closeSync(fd);
      try { unlinkSync(lock); } catch { /* already gone */ }
    }
  }

  findById(id: string): UserRecord | undefined { return this.read().users.find((u) => u.id === id); }

  /** The record a signed-in identity belongs to. */
  match(provider: Provider, email: string, subject?: string): UserRecord | undefined {
    const users = this.read().users.filter((u) => u.provider === provider);
    if (subject) { const bySub = users.find((u) => u.subject === subject); if (bySub) return bySub; }
    const e = normEmail(email);
    // A Microsoft account is matched by e-mail only while its invitation is not yet bound to a directory id.
    return users.find((u) => normEmail(u.email) === e && (provider !== "oidc" || !u.subject));
  }

  groupRoles(): GroupRole[] { return this.read().groupRoles; }

  static newId(): string { return `u_${crypto.randomBytes(9).toString("base64url")}`; }
}

// Users and access: who may use which part of Weave (Migration, Gateway console, Admin), how they
// sign in, directory groups that grant access, and the audit log. Admins only (the server checks).
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, Search, Trash2, UserPlus } from "lucide-react";
import { apiClient, type AccessRole, type AccessUser, type GroupRole } from "../api.ts";
import { Drawer, SegTabs, Skeleton, ErrorState } from "../components/ui.tsx";
import { Section, Chip, Banner, DataTable, useDebounced, copyText, type Col } from "../components/gw.tsx";
import { ago } from "../lib/text.ts";
import { PageHeader } from "./PageHeader.tsx";

export const ROLE_INFO: { id: AccessRole; label: string; hint: string }[] = [
  { id: "migration", label: "Migration (Factory)", hint: "Migrations and the integration studio" },
  { id: "gateway", label: "Gateway console", hint: "APIs, analytics, logs, rate limits, approvals" },
  { id: "admin", label: "Admin", hint: "Users and access, group mapping, audit log" },
];
const PROVIDER_WORDS: Record<string, string> = { oidc: "Microsoft account", local: "Weave account", wso2: "API Manager account" };
type Tab = "people" | "groups" | "audit";

function errText(e: unknown): string { return e instanceof Error ? e.message : "Something went wrong"; }

function RoleChecks({ value, onChange, idPrefix }: { value: AccessRole[]; onChange: (v: AccessRole[]) => void; idPrefix: string }) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 2 }}>
      <legend style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Access</legend>
      {ROLE_INFO.map((r) => (
        <label key={r.id} className="gw-check" htmlFor={`${idPrefix}-${r.id}`} style={{ alignItems: "flex-start" }}>
          <input id={`${idPrefix}-${r.id}`} type="checkbox" checked={value.includes(r.id)} style={{ marginTop: 3 }}
            onChange={(e) => onChange(e.target.checked ? [...value, r.id] : value.filter((x) => x !== r.id))} />
          <span style={{ display: "flex", flexDirection: "column" }}><span style={{ fontWeight: 600 }}>{r.label}</span><span className="gw-faint" style={{ fontSize: 12 }}>{r.hint}</span></span>
        </label>
      ))}
    </fieldset>
  );
}

function newPassword(): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const a = new Uint32Array(18); crypto.getRandomValues(a);
  return Array.from(a, (n) => abc[n % abc.length]).join("").replace(/(.{6})(?=.)/g, "$1-");
}

function PasswordField({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <label className="gw-field" htmlFor={id} style={{ display: "flex" }}>Password (at least 12 characters)
      <span style={{ display: "flex", gap: 8 }}>
        <input id={id} className="gw-input" style={{ flex: 1 }} type="text" autoComplete="new-password" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="gw-btn" onClick={() => { onChange(newPassword()); setCopied(false); }}>Generate</button>
        <button type="button" className="gw-btn" disabled={!value} onClick={async () => setCopied(await copyText(value))}>{copied ? "Copied" : "Copy"}</button>
      </span>
      <span className="gw-faint" style={{ fontWeight: 400, letterSpacing: 0 }}>Give it to the person over a safe channel. It is stored only as a hash.</span>
    </label>
  );
}

function AddPerson({ providers, onDone }: { providers: string[]; onDone: () => void }) {
  const qc = useQueryClient();
  const kinds = (["oidc", "local", "wso2"] as const).filter((k) => providers.includes(k) || k === "oidc" || k === "local");
  const [kind, setKind] = useState<"oidc" | "local" | "wso2">(providers.includes("oidc") || !providers.includes("local") ? "oidc" : "local");
  const [email, setEmail] = useState(""); const [name, setName] = useState("");
  const [roles, setRoles] = useState<AccessRole[]>(["migration"]); const [password, setPassword] = useState("");
  const add = useMutation({
    mutationFn: () => apiClient.accessCreate({ provider: kind, email, name, roles, ...(kind === "local" ? { password } : {}) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["access-users"] }); qc.invalidateQueries({ queryKey: ["access-audit"] }); onDone(); },
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); add.mutate(); }} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <label className="gw-field" htmlFor="add-kind" style={{ display: "flex" }}>Signs in with
        <select id="add-kind" className="gw-select" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          {kinds.map((k) => <option key={k} value={k}>{PROVIDER_WORDS[k]}{!providers.includes(k) ? " (sign-in not switched on yet)" : ""}</option>)}
        </select>
      </label>
      {kind === "oidc" && <p className="gw-note" style={{ margin: 0 }}>Invite by company e-mail. The person signs in with Microsoft; the first sign-in links this entry to their directory account.</p>}
      <label className="gw-field" htmlFor="add-email" style={{ display: "flex" }}>{kind === "wso2" ? "API Manager user name" : "E-mail"}
        <input id="add-email" className="gw-input" type={kind === "wso2" ? "text" : "email"} required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
      </label>
      <label className="gw-field" htmlFor="add-name" style={{ display: "flex" }}>Name (optional)
        <input id="add-name" className="gw-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </label>
      {kind === "local" && <PasswordField id="add-password" value={password} onChange={setPassword} />}
      <RoleChecks idPrefix="add" value={roles} onChange={setRoles} />
      {add.isError && <ErrorState message={errText(add.error)} />}
      <button type="submit" className="gw-btn gw-btn-pri" style={{ height: 42, justifyContent: "center" }} disabled={add.isPending}>{add.isPending ? "Saving…" : kind === "oidc" ? "Invite" : "Add person"}</button>
    </form>
  );
}

function EditPerson({ user, me, onDone }: { user: AccessUser; me: string | null; onDone: () => void }) {
  const qc = useQueryClient();
  const [roles, setRoles] = useState<AccessRole[]>(user.roles);
  const [password, setPassword] = useState("");
  const [confirmRemove, setConfirmRemove] = useState("");
  const self = user.id === me;
  const refresh = () => { qc.invalidateQueries({ queryKey: ["access-users"] }); qc.invalidateQueries({ queryKey: ["access-audit"] }); };
  const save = useMutation({ mutationFn: (p: { roles?: AccessRole[]; disabled?: boolean }) => apiClient.accessUpdate(user.id, p), onSuccess: () => { refresh(); onDone(); } });
  const reset = useMutation({ mutationFn: () => apiClient.accessResetPassword(user.id, password), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => apiClient.accessRemove(user.id), onSuccess: () => { refresh(); onDone(); } });
  const err = save.error ?? reset.error ?? remove.error;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <strong style={{ fontSize: 15, overflowWrap: "anywhere" }}>{user.name}</strong>
        <span className="gw-muted" style={{ fontSize: 13, overflowWrap: "anywhere" }}>{user.email}</span>
        <span style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
          <Chip>{PROVIDER_WORDS[user.provider] ?? user.provider}</Chip>
          {user.disabled ? <Chip tone="bad">Switched off</Chip> : <Chip tone="ok">Active</Chip>}
          {user.provider === "oidc" && !user.subject && <Chip tone="warn">Invited, not signed in yet</Chip>}
        </span>
      </div>
      <RoleChecks idPrefix="edit" value={roles} onChange={setRoles} />
      {self && !roles.includes("admin") && <Banner tone="warn">You cannot take away your own admin access.</Banner>}
      <button type="button" className="gw-btn gw-btn-pri" style={{ justifyContent: "center", height: 40 }} disabled={save.isPending || (self && !roles.includes("admin"))} onClick={() => save.mutate({ roles })}>Save access</button>

      {user.provider === "local" && (
        <Section title="Reset password" note="The old password stops working at once.">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <PasswordField id="reset-password" value={password} onChange={setPassword} />
            <button type="button" className="gw-btn" style={{ alignSelf: "flex-start" }} disabled={reset.isPending || password.length < 12} onClick={() => reset.mutate()}><KeyRound size={15} aria-hidden="true" />{reset.isSuccess ? "Password changed" : "Set new password"}</button>
          </div>
        </Section>
      )}

      {!self && (
        <Section title={user.disabled ? "Switched off" : "Switch off"} note={user.disabled ? "This person cannot sign in. Their entry and history are kept." : "Ends their sessions at once. Their entry and history are kept."}>
          <button type="button" className="gw-btn" disabled={save.isPending} onClick={() => save.mutate({ disabled: !user.disabled })}>{user.disabled ? "Switch on again" : "Switch off"}</button>
        </Section>
      )}

      {!self && (
        <Section title="Remove" note="Removes the entry. The audit log keeps what they did.">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input className="gw-input" aria-label={`Type ${user.email} to confirm`} placeholder={`Type ${user.email}`} value={confirmRemove} onChange={(e) => setConfirmRemove(e.target.value)} style={{ flex: "1 1 200px" }} />
            <button type="button" className="gw-btn" style={{ color: "var(--bad)" }} disabled={confirmRemove.trim().toLowerCase() !== user.email.toLowerCase() || remove.isPending} onClick={() => remove.mutate()}><Trash2 size={15} aria-hidden="true" />Remove</button>
          </div>
        </Section>
      )}
      {err && <ErrorState message={errText(err)} />}
    </div>
  );
}

function People({ users, me, providers }: { users: AccessUser[]; me: string | null; providers: string[] }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AccessUser | null>(null);
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return [...users].filter((u) => !n || `${u.name} ${u.email}`.toLowerCase().includes(n)).sort((a, b) => a.name.localeCompare(b.name));
  }, [users, q]);
  const cols: Col<AccessUser>[] = [
    { key: "who", label: "Person", lead: true, render: (u) => (
      <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <strong style={{ overflowWrap: "anywhere" }}>{u.name}{u.id === me ? <span className="gw-faint" style={{ fontWeight: 400 }}> (you)</span> : null}</strong>
        <span className="gw-faint" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{u.email}</span>
      </span>) },
    { key: "how", label: "Signs in with", render: (u) => <span className="gw-muted">{PROVIDER_WORDS[u.provider] ?? u.provider}</span> },
    { key: "roles", label: "Access", render: (u) => (
      <span style={{ display: "inline-flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" }}>
        {u.roles.length ? ROLE_INFO.filter((r) => u.roles.includes(r.id)).map((r) => <Chip key={r.id} tone={r.id === "admin" ? "accent" : "plain"}>{r.id === "migration" ? "Migration" : r.id === "gateway" ? "Gateway" : "Admin"}</Chip>)
          : <span className="gw-faint">{u.source === "groups" ? "Through groups" : "None"}</span>}
      </span>) },
    { key: "state", label: "Status", render: (u) => u.disabled ? <Chip tone="bad">Switched off</Chip> : u.provider === "oidc" && !u.subject ? <Chip tone="warn">Invited</Chip> : <Chip tone="ok">Active</Chip> },
    { key: "last", label: "Last sign-in", render: (u) => <span className="gw-faint">{u.lastSignInAt ? ago(Date.parse(u.lastSignInAt), Date.now()) : "Never"}</span> },
  ];
  return (
    <Section title={`People (${users.length})`} note="Choose a person to change their access, switch them off or reset a Weave password."
      actions={<button type="button" className="gw-btn gw-btn-pri" onClick={() => setAdding(true)}><UserPlus size={15} aria-hidden="true" />Add person</button>}>
      <div className="gw-toolbar" style={{ marginBottom: 12 }}>
        <label style={{ position: "relative", flex: "1 1 240px", maxWidth: 360 }}>
          <Search size={15} aria-hidden="true" style={{ position: "absolute", left: 10, top: 10, color: "var(--faint)" }} />
          <input className="gw-input" aria-label="Find a person" placeholder="Find by name or e-mail" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "100%", paddingLeft: 32 }} />
        </label>
      </div>
      <DataTable label="People" cols={cols} rows={shown} rowKey={(u) => u.id} onRow={setEditing} empty={q ? "Nobody matches." : "Nobody yet. Add the first person."} />
      <Drawer open={adding} title="Add person" onClose={() => setAdding(false)}><AddPerson providers={providers} onDone={() => setAdding(false)} /></Drawer>
      <Drawer open={!!editing} title="Access" onClose={() => setEditing(null)}>{editing && <EditPerson key={editing.id} user={editing} me={me} onDone={() => setEditing(null)} />}</Drawer>
    </Section>
  );
}

function Groups({ initial, claim }: { initial: GroupRole[]; claim: string | null }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<GroupRole[]>(initial);
  useEffect(() => { setRows(initial); }, [initial]);
  const dirty = JSON.stringify(rows) !== JSON.stringify(initial);
  const save = useMutation({ mutationFn: () => apiClient.accessGroups(rows), onSuccess: () => { qc.invalidateQueries({ queryKey: ["access-users"] }); qc.invalidateQueries({ queryKey: ["access-audit"] }); } });
  const set = (i: number, p: Partial<GroupRole>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <Section title="Directory groups" note={<>Members of a group get its access when they sign in with Microsoft, on top of what is set per person. Use the group's <strong>Object ID</strong> from Entra ID{claim ? <> (read from the <code className="gw-mono">{claim}</code> claim)</> : null}. Changes apply on each person's next request.</>}
      actions={<button type="button" className="gw-btn" onClick={() => setRows([...rows, { group: "", label: "", roles: [] }])}><Plus size={15} aria-hidden="true" />Add group</button>}>
      {!rows.length ? <p className="gw-note" style={{ margin: 0 }}>No groups mapped. Access is given per person only.</p> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end", padding: 12, borderRadius: 12, border: "1px solid var(--border)", background: "var(--surface2)" }}>
              <label className="gw-field" style={{ flex: "2 1 260px" }}>Group object ID or name
                <input className="gw-input gw-mono" value={r.group} onChange={(e) => set(i, { group: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" />
              </label>
              <label className="gw-field" style={{ flex: "1 1 160px" }}>Label (for you)
                <input className="gw-input" value={r.label ?? ""} onChange={(e) => set(i, { label: e.target.value })} placeholder="Weave Gateway users" />
              </label>
              <span style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: "1 1 300px" }} role="group" aria-label={`Access for ${r.label || r.group || "this group"}`}>
                {ROLE_INFO.map((ro) => (
                  <label key={ro.id} className="gw-check">
                    <input type="checkbox" checked={r.roles.includes(ro.id)} onChange={(e) => set(i, { roles: e.target.checked ? [...r.roles, ro.id] : r.roles.filter((x) => x !== ro.id) })} />{ro.id === "migration" ? "Migration" : ro.id === "gateway" ? "Gateway" : "Admin"}
                  </label>
                ))}
              </span>
              <button type="button" className="gw-iconbtn" style={{ width: 36, height: 36 }} aria-label="Remove this group" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 size={15} aria-hidden="true" /></button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 10, marginTop: 14, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className="gw-btn gw-btn-pri" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving…" : "Save groups"}</button>
        {dirty && <button type="button" className="gw-btn" onClick={() => setRows(initial)}>Undo changes</button>}
        {save.isSuccess && !dirty && <span className="gw-faint">Saved.</span>}
      </div>
      {save.isError && <div style={{ marginTop: 10 }}><ErrorState message={errText(save.error)} /></div>}
    </Section>
  );
}

function Audit() {
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 300);
  const log = useQuery({ queryKey: ["access-audit", dq], queryFn: () => apiClient.accessAudit(dq), refetchInterval: 30_000 });
  const fmt = (t: string) => { const d = new Date(t); return Number.isNaN(d.getTime()) ? t : d.toLocaleString(); };
  return (
    <Section title="Audit log" note="Every sign-in, every change to users and access, and every change made through the Gateway or the Factory, with the person who made it. Calls made with the server's own API Manager account for Microsoft and Weave accounts are marked.">
      <div className="gw-toolbar" style={{ marginBottom: 12 }}>
        <label style={{ position: "relative", flex: "1 1 240px", maxWidth: 360 }}>
          <Search size={15} aria-hidden="true" style={{ position: "absolute", left: 10, top: 10, color: "var(--faint)" }} />
          <input className="gw-input" aria-label="Search the audit log" placeholder="Search: person, action, address" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "100%", paddingLeft: 32 }} />
        </label>
      </div>
      {log.isLoading ? <Skeleton h={160} /> : log.isError ? <ErrorState message={errText(log.error)} onRetry={() => log.refetch()} /> : !log.data?.enabled ? (
        <Banner tone="warn">The audit log is off: set WEAVE_USERS_FILE or WEAVE_AUDIT_FILE on the server.</Banner>
      ) : (
        <DataTable label="Audit log" rows={log.data.entries} rowKey={(e, i) => `${e.time}-${i}`} empty={q ? "Nothing matches." : "Nothing recorded yet."} cols={[
          { key: "time", label: "When", render: (e) => <span className="gw-faint" style={{ whiteSpace: "nowrap" }}>{fmt(e.time)}</span> },
          { key: "user", label: "Who", lead: true, render: (e) => <strong style={{ overflowWrap: "anywhere" }}>{e.user}</strong> },
          { key: "action", label: "What", render: (e) => <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end" }}><span className="gw-mono" style={{ fontSize: 12.5 }}>{e.action}</span>{e.status && e.status >= 400 ? <Chip tone="bad">{e.status}</Chip> : null}{e.via === "service-account" ? <Chip tone="accent" title="API Manager was called with the server's service account for this person">service account</Chip> : null}</span> },
          { key: "target", label: "On", render: (e) => <span className="gw-muted" style={{ overflowWrap: "anywhere", fontSize: 12.5 }}>{e.target ?? ""}{e.detail ? <span className="gw-faint" style={{ display: "block" }}>{e.detail}</span> : null}</span> },
          { key: "app", label: "Where", render: (e) => <span className="gw-faint">{e.app === "factory" ? "Factory" : e.app === "gateway" ? "Gateway" : e.app ?? ""}</span> },
        ]} />
      )}
    </Section>
  );
}

export function Users() {
  const [tab, setTab] = useState<Tab>("people");
  const q = useQuery({ queryKey: ["access-users"], queryFn: apiClient.accessUsers });
  return (
    <>
      <PageHeader area="Users and access" title="Users and access"
        subtitle="Give each person access per area: Migration (Factory), Gateway console and Admin. Microsoft accounts can also get access through directory groups." />
      {q.isLoading ? <Skeleton h={240} /> : q.isError ? <ErrorState message={errText(q.error)} onRetry={() => q.refetch()} /> : !q.data!.configured ? (
        <Banner tone="warn">User management is off on this server. Set <code className="gw-mono">WEAVE_USERS_FILE</code> (and the sign-in providers) as described in docs/CRUISE-SAUDI-SSO.md. Until then everyone who signs in through API Manager has full access.</Banner>
      ) : (
        <>
          <SegTabs label="Users and access" value={tab} onChange={setTab} tabs={[
            { id: "people", label: "People", count: q.data!.users.length },
            { id: "groups", label: "Directory groups", count: q.data!.groupRoles.length },
            { id: "audit", label: "Audit log" },
          ]} />
          {!q.data!.providers.includes("oidc") && tab !== "audit" && <Banner>Microsoft sign-in is not switched on yet. You can already invite Microsoft accounts and map groups; they take effect once it is.</Banner>}
          {tab === "people" && <People users={q.data!.users} me={q.data!.me} providers={q.data!.providers} />}
          {tab === "groups" && <Groups initial={q.data!.groupRoles} claim={q.data!.groupsClaim} />}
          {tab === "audit" && <Audit />}
        </>
      )}
    </>
  );
}

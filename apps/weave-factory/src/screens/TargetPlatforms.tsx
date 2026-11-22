// "Target platforms": the Boomi and Workato accounts a finished migration is imported into.
// Tokens are write-only: they go to the migration tool with the request that sets them and never
// come back; the account id and the login come back masked by the tool and are shown as they are.
import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlugZap, Save, Trash2 } from "lucide-react";
import { api, type ApiError, type TargetAccount } from "../api.ts";
import { txt } from "../lib/text.ts";
import { ago, dateTime } from "../lib/migrate.ts";
import { Btn, Confirm, Failed, Field, Loading, Notice, Panel, Pill, errText } from "../migrate/ui.tsx";

export const TARGET_PLATFORMS_ANCHOR = "target-platforms";
export const WORKATO_CENTERS: [string, string][] = [
  ["https://www.workato.com", "US (www.workato.com)"],
  ["https://app.eu.workato.com", "EU (app.eu.workato.com)"],
  ["https://app.jp.workato.com", "JP (app.jp.workato.com)"],
  ["https://app.sg.workato.com", "SG (app.sg.workato.com)"],
  ["https://app.au.workato.com", "AU (app.au.workato.com)"],
  ["https://app.trial.workato.com", "Trial (app.trial.workato.com)"],
];
/** The data center of a stored address ("https://app.eu.workato.com/api" is the EU one). */
export function centerOf(apiBase: unknown): string {
  const host = txt(apiBase).replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  return WORKATO_CENTERS.find(([u]) => u.replace(/^https:\/\//, "") === host)?.[0] ?? WORKATO_CENTERS[0][0];
}
const LABEL: Record<string, string> = { boomi: "Boomi", workato: "Workato" };
const FOLDER_ID = /^[A-Za-z0-9._:-]{0,120}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function Saved({ a }: { a: TargetAccount | undefined }) {
  if (!a?.configured) return null;
  const rows: [string, string][] = [];
  if (a.target === "boomi") { rows.push(["Account ID", txt(a.accountId)], ["Login e-mail", txt(a.user)]); }
  else rows.push(["Data center", WORKATO_CENTERS.find(([u]) => u === centerOf(a.apiBase))?.[1] ?? txt(a.apiBase)]);
  rows.push(["API token", a.hasToken === false ? "not set" : "set (not shown)"]);
  const folder = txt(a.folderParentId) || txt(a.parentFolderId);
  if (folder) rows.push(["Parent folder id", folder]);
  return (
    <dl className="mf-mg-kv" data-testid={`target-${a.target}-saved`}>
      {rows.filter(([, v]) => v).map(([k, v]) => <div key={k} style={{ display: "contents" }}><dt>{k}</dt><dd className="mf-mg-wrap">{v}</dd></div>)}
      {a.updated ? <div style={{ display: "contents" }}><dt>Last change</dt><dd className="mf-mg-wrap" title={dateTime(a.updated)}>{ago(a.updated)}{txt(a.updatedBy) ? ` by ${txt(a.updatedBy)}` : ""}</dd></div> : null}
    </dl>
  );
}

function AccountCard({ target, account }: { target: "boomi" | "workato"; account?: TargetAccount }) {
  const qc = useQueryClient();
  const configured = !!account?.configured;
  const label = LABEL[target];
  const [accountId, setAccountId] = useState("");
  const [user, setUser] = useState("");
  const [token, setToken] = useState("");
  const [folder, setFolder] = useState("");
  const [center, setCenter] = useState(centerOf(account?.apiBase));
  const [tried, setTried] = useState(false);
  const [saved, setSaved] = useState(false);
  const [askRemove, setAskRemove] = useState(false);
  useEffect(() => { if (account?.apiBase) setCenter(centerOf(account.apiBase)); }, [account?.apiBase]);

  const problem = (() => {
    if (target === "boomi") {
      if (!accountId.trim()) return "Type the Boomi account ID.";
      if (!EMAIL.test(user.trim())) return "Type the login e-mail of the Boomi user.";
    }
    if (!configured && !token.trim()) return "Paste the API token.";
    if (target === "workato" && folder.trim() && !/^\d{1,20}$/.test(folder.trim())) return "A Workato folder id is a number (open the folder in Workato: it is the number in the address).";
    if (!FOLDER_ID.test(folder.trim())) return "A folder id has letters, digits and - _ . : only.";
    return "";
  })();
  const after = () => qc.invalidateQueries({ queryKey: ["target-accounts"] });
  const save = useMutation<TargetAccount, ApiError>({
    mutationFn: () => api.saveTargetAccount(target, target === "boomi"
      ? { accountId: accountId.trim(), user: user.trim(), token: token.trim(), ...(folder.trim() ? { folderParentId: folder.trim() } : {}) }
      : { apiBase: center, token: token.trim(), ...(folder.trim() ? { parentFolderId: folder.trim() } : {}) }),
    onSuccess: () => { setToken(""); setAccountId(""); setUser(""); setTried(false); setSaved(true); test.reset(); after(); },
  });
  const test = useMutation<{ ok: boolean; message?: string }, ApiError>({ mutationFn: () => api.testTargetAccount(target) });
  const remove = useMutation<{ ok?: boolean }, ApiError>({ mutationFn: () => api.removeTargetAccount(target), onSuccess: () => { setAskRemove(false); setSaved(false); test.reset(); after(); } });
  const submit = (e: FormEvent) => { e.preventDefault(); setTried(true); setSaved(false); if (!problem) save.mutate(); };

  return (
    <section className="mf-mg-card" aria-label={`${label} account`} data-testid={`target-${target}`}>
      <div className="mf-mg-row" style={{ gap: 8 }}>
        <h3 className="mf-mg-grow" style={{ margin: 0, fontSize: 15 }}>{label}</h3>
        <Pill tone={configured ? "ok" : undefined}>{configured ? "Set up" : "Not set up"}</Pill>
      </div>
      <Saved a={account} />
      <form className="mf-mg-stack" style={{ gap: 10 }} onSubmit={submit} noValidate>
        {target === "boomi" ? (
          <>
            <Field label="Account ID" hint="Boomi: Settings > Account Information and Setup > Account Information.">
              <input className="mf-mg-input mf-mono" value={accountId} onChange={(e) => setAccountId(e.target.value)} autoCapitalize="none" spellCheck={false} maxLength={120}
                placeholder={configured ? "Type it again to change the account" : "for example acme-AB12CD"} data-testid="boomi-accountId" />
            </Field>
            <Field label="Login e-mail" hint="The Boomi user the import runs as. Its role needs the API Access privilege.">
              <input className="mf-mg-input" type="email" value={user} onChange={(e) => setUser(e.target.value)} autoCapitalize="none" spellCheck={false} maxLength={200} data-testid="boomi-user" />
            </Field>
            <Field label="API token" hint={<>Boomi: Settings &gt; Account Information and Setup &gt; Platform API Tokens. {configured ? "Leave empty to keep the saved token." : ""} It is never shown again.</>}>
              <input className="mf-mg-input" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" maxLength={4000}
                placeholder={configured ? "Saved. Leave empty to keep it" : ""} data-testid="boomi-token" />
            </Field>
            <Field label="Parent folder id (optional)" hint="The Boomi folder the imported components go under. Empty: the account's top folder.">
              <input className="mf-mg-input mf-mono" value={folder} onChange={(e) => setFolder(e.target.value)} autoCapitalize="none" spellCheck={false} maxLength={120} data-testid="boomi-folder" />
            </Field>
          </>
        ) : (
          <>
            <Field label="Data center" hint="The address you sign in to Workato at.">
              <select className="mf-mg-input" value={center} onChange={(e) => setCenter(e.target.value)} data-testid="workato-center">
                {WORKATO_CENTERS.map(([u, l]) => <option key={u} value={u}>{l}</option>)}
              </select>
            </Field>
            <Field label="API client token" hint={<>Workato: Workspace admin &gt; API clients. The client's role needs Recipe lifecycle management (import) and access to folders. {configured ? "Leave empty to keep the saved token." : ""} It is never shown again.</>}>
              <input className="mf-mg-input" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" maxLength={4000}
                placeholder={configured ? "Saved. Leave empty to keep it" : ""} data-testid="workato-token" />
            </Field>
            <Field label="Parent folder id (optional)" hint="A number: the Workato folder the imported recipes go under. Empty: the workspace's top folder.">
              <input className="mf-mg-input mf-mono" value={folder} onChange={(e) => setFolder(e.target.value)} inputMode="numeric" autoCapitalize="none" spellCheck={false} maxLength={20} data-testid="workato-folder" />
            </Field>
          </>
        )}
        {tried && problem && <Notice tone="bad"><span data-testid={`target-${target}-problem`}>{problem}</span></Notice>}
        {save.isError && <Notice tone="bad"><span data-testid={`target-${target}-error`}>{errText(save.error)}</span></Notice>}
        {saved && !save.isError && <Notice tone="ok"><span data-testid={`target-${target}-saved-note`}>Saved. Use "Test connection" to check it.</span></Notice>}
        {test.data && <Notice tone={test.data.ok ? "ok" : "bad"}><span className="mf-mg-wrap" data-testid={`target-${target}-test`}>{txt(test.data.message) || (test.data.ok ? `${label} answered: the account works.` : `${label} did not accept the account.`)}</span></Notice>}
        {test.isError && <Notice tone="bad"><span className="mf-mg-wrap" data-testid={`target-${target}-test`}>{errText(test.error)}</span></Notice>}
        <div className="mf-mg-actions">
          <Btn kind="primary" type="submit" icon={<Save size={15} aria-hidden="true" />} busy={save.isPending} data-testid={`target-${target}-save`}>Save</Btn>
          <Btn icon={<PlugZap size={15} aria-hidden="true" />} disabled={!configured} busy={test.isPending} onClick={() => test.mutate()} data-testid={`target-${target}-testbtn`}>Test connection</Btn>
          {configured && <Btn kind="danger" icon={<Trash2 size={15} aria-hidden="true" />} onClick={() => { remove.reset(); setAskRemove(true); }} data-testid={`target-${target}-remove`}>Remove</Btn>}
        </div>
      </form>
      {askRemove && (
        <Confirm danger title={`Remove the ${label} account?`} confirmLabel="Remove" busy={remove.isPending} error={remove.isError ? errText(remove.error) : undefined} onConfirm={() => remove.mutate()} onClose={() => setAskRemove(false)}>
          <span>The saved {label} account and its token are removed from this server. Nothing changes in {label}; migrations can no longer be imported there until an account is set up again.</span>
        </Confirm>
      )}
    </section>
  );
}

export function TargetPlatforms() {
  const q = useQuery({ queryKey: ["target-accounts"], queryFn: api.targetAccounts, retry: false });
  const by = (t: string) => (q.data ?? []).find((a) => a.target === t);
  // opened from a link ("set up the account"): bring the section into view once it is there
  useEffect(() => {
    if (q.isSuccess && typeof location !== "undefined" && location.hash === `#${TARGET_PLATFORMS_ANCHOR}`) document.getElementById(TARGET_PLATFORMS_ANCHOR)?.scrollIntoView?.({ block: "start" });
  }, [q.isSuccess]);
  return (
    <Panel id={TARGET_PLATFORMS_ANCHOR} title="Target platforms">
      <div className="mf-mg-stack" style={{ gap: 12 }} data-testid="target-platforms">
        <p className="mf-mg-sub mf-mg-wrap" style={{ fontSize: 13.5, margin: 0 }}>
          The Boomi and Workato accounts finished migrations are imported into. Importing only creates the components or recipes there: nothing is deployed or switched on. Tokens are kept on this server and are never shown again.
        </p>
        {q.isLoading ? <Loading rows={1} h={160} /> : q.isError && (q.error as ApiError).status !== 404 ? <Failed what="The target platform accounts are not available right now." error={q.error} onRetry={() => q.refetch()} /> : (
          <div className="mf-mg-grid-2">
            <AccountCard target="boomi" account={by("boomi")} />
            <AccountCard target="workato" account={by("workato")} />
          </div>
        )}
      </div>
    </Panel>
  );
}

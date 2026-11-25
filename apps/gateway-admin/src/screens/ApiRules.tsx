// One page per live API: traffic limits, access, consumers, live status and change history.
// Every save previews the exact change, then updates the API, creates a revision and deploys it.
import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, RotateCcw, KeyRound } from "lucide-react";
import { rulesClient, type ApiRules as TApiRules, type ChangePlan, type Security, type AccessBody, type TrafficBody } from "../api.ts";
import { ErrorState, SegTabs } from "../components/ui.tsx";
import { Banner, Chip, Loading, Section, Tile, useParam, DataTable, type Col } from "../components/gw.tsx";
import { ConfirmChange, ErrorLine, ListInput, NewLimit, Radio, policyLabel, splitList } from "../components/rules.tsx";
import { PageHeader } from "./PageHeader.tsx";
import { PoliciesTab } from "./ApiPolicies.tsx";
import { ago, fmtDateTime, fmtInt, txt } from "../lib/text.ts";

type Tab = "traffic" | "access" | "policies" | "consumers" | "live" | "history";
const TABS: { id: Tab; label: string }[] = [
  { id: "traffic", label: "Traffic limits" }, { id: "access", label: "Access" }, { id: "policies", label: "Policies" }, { id: "consumers", label: "Consumers" },
  { id: "live", label: "Live status" }, { id: "history", label: "Change history" },
];

/** Preview -> confirm -> apply, shared by every tab that changes the live API. */
function useLiveChange<B>(run: (body: B, preview: boolean) => Promise<ChangePlan>, onDone: (p: ChangePlan) => void) {
  const [plan, setPlan] = useState<ChangePlan | null>(null);
  const [body, setBody] = useState<B | null>(null);
  const preview = useMutation({ mutationFn: (b: B) => run(b, true), onSuccess: (p, b) => { setPlan(p); setBody(b); } });
  const apply = useMutation({ mutationFn: () => run(body as B, false), onSuccess: (p) => { setPlan(null); onDone(p); } });
  return { plan, preview, apply, close: () => { setPlan(null); apply.reset(); } };
}

function Done({ result }: { result: ChangePlan | null }) {
  if (!result) return null;
  return <div data-testid="change-done"><Banner tone="info"><strong>{result.environments.length ? "Live now." : "Saved."}</strong> {result.revision ? `${result.revision.displayName} is deployed to ${result.environments.map((e) => e.name).join(", ")}.` : result.environments.length ? `Deployed to ${result.environments.map((e) => e.name).join(", ")}.` : "The API is not deployed to any gateway."} {result.changes.join(" ")}</Banner></div>;
}

function EnvPicker({ data, value, onChange }: { data: TApiRules; value: string[]; onChange: (v: string[]) => void }) {
  if (data.deployments.length || !data.environments.length) return null;
  return (
    <Section title="Not deployed yet" note="This API is not on any gateway. Choose where the saved rules should go live, or leave all unticked to only save them.">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {data.environments.map((e) => (
          <label key={e.name} className="gw-check"><input type="checkbox" checked={value.includes(e.name)} onChange={(ev) => onChange(ev.target.checked ? [...value, e.name] : value.filter((x) => x !== e.name))} /><span>{e.displayName} ({e.vhost})</span></label>
        ))}
      </div>
    </Section>
  );
}

// ---------------- Traffic limits ----------------
function TrafficTab({ data, done }: { data: TApiRules; done: (p: ChangePlan) => void }) {
  const [sp] = useSearchParams();
  const t = data.traffic;
  const [tiers, setTiers] = useState<string[]>(t.tiers);
  const [mode, setMode] = useState<"none" | "api" | "operation">(t.apiPolicy ? "api" : t.operations.some((o) => o.policy && o.policy !== "Unlimited") ? "operation" : "none");
  const [apiPolicy, setApiPolicy] = useState(t.apiPolicy ?? "");
  const [ops, setOps] = useState<Record<string, string>>(() => Object.fromEntries(t.operations.map((o) => [`${o.verb} ${o.target}`, o.policy ?? "Unlimited"])));
  const [envs, setEnvs] = useState<string[]>([]);
  const qc = useQueryClient();
  const suggest = sp.get("suggest"); const kind = sp.get("kind");
  useEffect(() => {
    if (!suggest) return;
    if (kind === "subscription") setTiers((x) => (x.includes(suggest) ? x : [...x, suggest]));
    if (kind === "advanced") { setMode("api"); setApiPolicy(suggest); }
  }, [suggest, kind]);
  const sub = data.policies.subscription; const adv = data.policies.advanced;
  const body = (): TrafficBody => ({
    tiers, apiPolicy: mode === "api" ? apiPolicy || null : null,
    operations: t.operations.map((o) => ({ verb: o.verb, target: o.target, policy: mode === "operation" ? ops[`${o.verb} ${o.target}`] || "Unlimited" : "Unlimited" })),
    environments: envs.length ? envs : undefined,
  });
  const lc = useLiveChange((b: TrafficBody, p) => rulesClient.traffic(data.api.id, b, p), (p) => { qc.invalidateQueries({ queryKey: ["usage"] }); done(p); });
  const created = () => qc.invalidateQueries({ queryKey: ["rules", data.api.id] });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {suggest && <Banner tone="info">Assigning <strong className="gw-mono">{suggest}</strong>. It is selected below; review the change and save to make it live.</Banner>}
      <Section title="Plans consumers can pick" note="A plan is a limit per consumer application. When an application subscribes to this API it picks one of these plans, and its calls are counted against that plan. Plans for event and AI APIs are not listed.">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }} role="group" aria-label="Plans consumers can pick">
          {sub.filter((p) => !p.quotaType || p.quotaType === "REQUESTCOUNTLIMIT" || p.quotaType === "BANDWIDTHLIMIT" || tiers.includes(p.name)).map((p) => (
            <label key={p.name} className="gw-check"><input type="checkbox" checked={tiers.includes(p.name)} onChange={(e) => setTiers(e.target.checked ? [...tiers, p.name] : tiers.filter((x) => x !== p.name))} />
              <span>{policyLabel(p, p.name, "plan")}</span></label>
          ))}
        </div>
        <div style={{ marginTop: 10 }}><NewLimit kind="subscription" label="New plan" onCreated={(n) => { setTiers((x) => [...x, n]); created(); }} /></div>
      </Section>

      <Section title="Limit on the API itself" note="These limits count every call to the API (or to one operation), whoever makes it. Use them to protect the backend. Callers over the limit get HTTP 429. API Manager counts in the background, so a few calls past the limit can still pass before throttling starts.">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }} role="radiogroup" aria-label="Limit on the API itself">
          <Radio name="mode" value="none" current={mode} onChange={(v) => setMode(v as any)} title="No shared limit">Only the consumers' plans apply.</Radio>
          <Radio name="mode" value="api" current={mode} onChange={(v) => setMode(v as any)} title="One limit for the whole API">All operations share one counter.</Radio>
          {mode === "api" && (
            <div style={{ paddingLeft: 30, display: "flex", flexDirection: "column", gap: 8 }}>
              <select className="gw-select" aria-label="Limit for the whole API" value={apiPolicy} onChange={(e) => setApiPolicy(e.target.value)} style={{ maxWidth: 520 }}>
                <option value="">Choose a limit…</option>
                {adv.map((p) => <option key={p.name} value={p.name}>{policyLabel(p, p.name, "api")}</option>)}
              </select>
              <NewLimit kind="advanced" label="New limit" onCreated={(n) => { setApiPolicy(n); created(); }} />
            </div>
          )}
          <Radio name="mode" value="operation" current={mode} onChange={(v) => setMode(v as any)} title="Limits per operation">Each operation has its own counter, e.g. stricter on writes.</Radio>
          {mode === "operation" && (
            <div style={{ paddingLeft: 30, display: "flex", flexDirection: "column", gap: 8 }}>
              {t.operations.map((o) => {
                const k = `${o.verb} ${o.target}`;
                return (
                  <div key={k} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <span className="gw-mono" style={{ minWidth: 200, fontSize: 13 }}><strong style={{ color: "var(--accentText)" }}>{o.verb}</strong> {o.target}</span>
                    <select className="gw-select" aria-label={`Limit for ${k}`} value={ops[k] ?? "Unlimited"} onChange={(e) => setOps({ ...ops, [k]: e.target.value })} style={{ flex: "1 1 240px", maxWidth: 480 }}>
                      <option value="Unlimited">No limit</option>
                      {adv.map((p) => <option key={p.name} value={p.name}>{policyLabel(p, p.name, "operation")}</option>)}
                    </select>
                  </div>
                );
              })}
              <NewLimit kind="advanced" label="New limit" onCreated={() => created()} />
            </div>
          )}
        </div>
      </Section>
      <EnvPicker data={data} value={envs} onChange={setEnvs} />
      <ErrorLine error={lc.preview.error} />
      <div><button type="button" className="gw-btn gw-btn-pri" disabled={lc.preview.isPending || (mode === "api" && !apiPolicy)} onClick={() => lc.preview.mutate(body())}>{lc.preview.isPending ? "Checking…" : "Review change"}</button></div>
      <ConfirmChange open={!!lc.plan} plan={lc.plan} busy={lc.apply.isPending} error={lc.apply.error} onConfirm={() => lc.apply.mutate()} onClose={lc.close} />
    </div>
  );
}

// ---------------- Access ----------------
const SEC: { id: Security; title: string; hint: string }[] = [
  { id: "oauth2", title: "OAuth2 token", hint: "Callers send a bearer token issued for a subscribed application." },
  { id: "apikey", title: "API key", hint: "Callers send an API key of a subscribed application in the ApiKey header." },
  { id: "both", title: "OAuth2 token or API key", hint: "Either is accepted." },
  { id: "basic", title: "User name and password (basic)", hint: "Checked against the key manager's users. Use only over HTTPS." },
  { id: "none", title: "None (open)", hint: "No sign-in. Anyone who can reach the gateway can call every operation." },
];
const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"];
function AccessTab({ data, done }: { data: TApiRules; done: (p: ChangePlan) => void }) {
  const a = data.access;
  const [security, setSecurity] = useState<Security>(a.security);
  const [corsOn, setCorsOn] = useState(a.cors.enabled);
  const [origins, setOrigins] = useState(a.cors.origins.join("\n"));
  const [headers, setHeaders] = useState(a.cors.headers.join("\n"));
  const [methods, setMethods] = useState<string[]>(a.cors.methods.length ? a.cors.methods : ["GET", "POST", "PUT", "DELETE", "OPTIONS"]);
  const [creds, setCreds] = useState(a.cors.credentials);
  const [allow, setAllow] = useState(a.ipAllow.join("\n"));
  const [deny, setDeny] = useState(a.ipDeny.join("\n"));
  const [envs, setEnvs] = useState<string[]>([]);
  const [typedName, setTypedName] = useState("");
  const prod = data.stage === "production";
  const body = (confirm?: string): AccessBody => ({ security, cors: { enabled: corsOn, origins: splitList(origins), headers: splitList(headers), methods, credentials: creds },
    ipAllow: splitList(allow), ipDeny: splitList(deny), confirmNoSecurity: confirm, environments: envs.length ? envs : undefined });
  const lc = useLiveChange((b: AccessBody, p) => rulesClient.access(data.api.id, b, p), (p) => done(p));
  const goingOpen = security === "none" && a.security !== "none";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Section title="Sign-in" note={`Now: ${a.securityWords}.`}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }} role="radiogroup" aria-label="Sign-in">
          {SEC.map((s) => <Radio key={s.id} name="security" value={s.id} current={security} onChange={(v) => setSecurity(v as Security)} title={s.title}>{s.hint}</Radio>)}
        </div>
        {security === "none" && <div style={{ marginTop: 10 }}><Banner tone={prod ? "bad" : "warn"}>{prod
          ? <><strong>This is a production gateway.</strong> With no sign-in, anyone on the internet who knows the address can call {data.api.name}, and you cannot tell callers apart or limit them per consumer. You will have to type the API name to confirm.</>
          : <>Anyone who can reach this UAT gateway can call {data.api.name} without signing in.</>}</Banner></div>}
      </Section>

      <Section title="Browser access (CORS)" note="Which web pages may call this API from a browser. Server-to-server callers are not affected.">
        <label className="gw-check"><input type="checkbox" checked={corsOn} onChange={(e) => setCorsOn(e.target.checked)} /><span>Set CORS for this API (otherwise the gateway default applies)</span></label>
        {corsOn && (
          <div className="gw-grid2" style={{ marginTop: 10 }}>
            <ListInput id="cors-origins" label="Allowed origins" value={origins} onChange={setOrigins} placeholder={"https://app.example.com\nhttps://admin.example.com"} hint="One per line, scheme and host only. * allows any page." />
            <ListInput id="cors-headers" label="Allowed request headers" value={headers} onChange={setHeaders} placeholder={"Authorization\nContent-Type\nApiKey"} hint="One per line." />
            <div className="gw-field" role="group" aria-label="Allowed methods"><span>Allowed methods</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>{METHODS.map((m) => <label key={m} className="gw-check"><input type="checkbox" checked={methods.includes(m)} onChange={(e) => setMethods(e.target.checked ? [...methods, m] : methods.filter((x) => x !== m))} /><span>{m}</span></label>)}</div>
            </div>
            <label className="gw-check" style={{ alignSelf: "flex-start" }}><input type="checkbox" checked={creds} onChange={(e) => setCreds(e.target.checked)} /><span>Allow credentials (cookies, Authorization) from those pages</span></label>
          </div>
        )}
      </Section>

      <Section title="Caller addresses for this API" note={<>Only this API. To block an address on every API use <Link className="gw-link" to="/blocking">Blocking rules</Link>.</>}>
        <div className="gw-grid2">
          <ListInput id="ip-allow" label="Only allow these addresses" value={allow} onChange={setAllow} placeholder={"203.0.113.10\n10.20.0.0/16"} hint="Empty = any address may call. IPv4 addresses, IPv4 ranges (CIDR) or exact IPv6 addresses, one per line." />
          <ListInput id="ip-deny" label="Block these addresses" value={deny} onChange={setDeny} placeholder="198.51.100.7" hint="Blocked callers get HTTP 403." />
        </div>
        <p className="gw-note" style={{ margin: "10px 0 0" }}>{a.clientIpHeader
          ? <>The caller address is read from the <span className="gw-mono">{a.clientIpHeader}</span> header set by your proxy.</>
          : <>The gateway checks the address of the connection it receives. If a proxy or load balancer sits in front of the gateway, that is the proxy's address; ask your administrator to set <span className="gw-mono">GATEWAY_CLIENT_IP_HEADER</span> so the real caller address is used.</>}</p>
      </Section>
      <EnvPicker data={data} value={envs} onChange={setEnvs} />
      <ErrorLine error={lc.preview.error} />
      {goingOpen && prod && (
        <label className="gw-field" style={{ display: "flex", maxWidth: 420 }}><span>Type <strong className="gw-mono" style={{ color: "var(--text)" }}>{data.api.name}</strong> to allow calls without sign-in</span>
          <input className="gw-input" value={typedName} onChange={(e) => setTypedName(e.target.value)} aria-label="Type the API name to confirm" autoComplete="off" /></label>
      )}
      <div><button type="button" className="gw-btn gw-btn-pri" disabled={lc.preview.isPending || (goingOpen && prod && typedName !== data.api.name)} onClick={() => lc.preview.mutate(body(goingOpen ? typedName : undefined))}>{lc.preview.isPending ? "Checking…" : "Review change"}</button></div>
      <ConfirmChange open={!!lc.plan} plan={lc.plan} busy={lc.apply.isPending} error={lc.apply.error} onConfirm={() => lc.apply.mutate()} onClose={lc.close} danger={goingOpen} />
    </div>
  );
}

// ---------------- Consumers ----------------
const SUB_WORD: Record<string, { word: string; tone: "ok" | "warn" | "bad" | "plain" }> = {
  UNBLOCKED: { word: "Active", tone: "ok" }, BLOCKED: { word: "Blocked", tone: "bad" }, PROD_ONLY_BLOCKED: { word: "Production blocked", tone: "warn" },
  ON_HOLD: { word: "Waiting for approval", tone: "warn" }, REJECTED: { word: "Rejected", tone: "bad" },
};
function ConsumersTab({ data }: { data: TApiRules }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["consumers", data.api.id], queryFn: () => rulesClient.consumers(data.api.id) });
  const [ask, setAsk] = useState<{ subId: string; app: string; state: "BLOCKED" | "PROD_ONLY_BLOCKED" | "UNBLOCKED" } | null>(null);
  const m = useMutation({ mutationFn: (x: NonNullable<typeof ask>) => rulesClient.subscriptionState(x.subId, data.api.id, x.state),
    onSuccess: () => { setAsk(null); qc.invalidateQueries({ queryKey: ["consumers", data.api.id] }); } });
  const words = { BLOCKED: "stops every call this application makes to", PROD_ONLY_BLOCKED: "stops production calls (sandbox keys still work) from this application to", UNBLOCKED: "lets this application call" };
  const cols: Col<any>[] = [
    { key: "app", label: "Application", lead: true, render: (r) => <span className="gw-mono" style={{ fontWeight: 600 }}>{txt(r.application)}</span> },
    { key: "owner", label: "Owner", render: (r) => txt(r.owner) },
    { key: "plan", label: "Plan", render: (r) => txt(r.plan) },
    { key: "status", label: "Status", render: (r) => { const s = SUB_WORD[r.status] ?? { word: txt(r.status), tone: "plain" as const }; return <Chip tone={s.tone}>{s.word}</Chip>; } },
    { key: "act", label: "Actions", render: (r) => (
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {r.status !== "BLOCKED" && <button type="button" className="gw-btn gw-btn-sm" onClick={() => setAsk({ subId: r.subscriptionId, app: r.application, state: "BLOCKED" })}>Block</button>}
        {r.status === "UNBLOCKED" && <button type="button" className="gw-btn gw-btn-sm" onClick={() => setAsk({ subId: r.subscriptionId, app: r.application, state: "PROD_ONLY_BLOCKED" })}>Block production only</button>}
        {r.status !== "UNBLOCKED" && <button type="button" className="gw-btn gw-btn-sm" onClick={() => setAsk({ subId: r.subscriptionId, app: r.application, state: "UNBLOCKED" })}>Unblock</button>}
        <Link className="gw-btn gw-btn-sm" to={`/applications?app=${encodeURIComponent(r.applicationId)}`}><KeyRound size={13} aria-hidden="true" />Keys</Link>
      </div>) },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Section title="Applications subscribed" note="Each application calls this API with its own keys and plan. Blocking takes effect on the gateway at once; no revision is needed."
        actions={<Link className="gw-btn gw-btn-sm" to="/applications">Subscribe an application</Link>}>
        {q.isLoading ? <Loading tiles={0} blocks={1} /> : q.isError ? <ErrorState message={(q.error as Error).message} onRetry={() => q.refetch()} /> :
          <DataTable cols={cols} rows={q.data?.list ?? []} rowKey={(r) => r.subscriptionId} empty="No application is subscribed yet, so nobody can call this API with keys." label="Applications subscribed" />}
      </Section>
      {ask && (
        <ConfirmChange open plan={{ api: data.api, changes: [`${ask.app}: ${SUB_WORD[(q.data?.list ?? []).find((s) => s.subscriptionId === ask.subId)?.status ?? ""]?.word ?? "current"} → ${SUB_WORD[ask.state].word}.`], noChange: false, environments: data.deployments,
          sentence: `This ${words[ask.state]} ${data.api.name} on the live gateway in ${data.stageWord}, immediately.`, applied: false }}
          busy={m.isPending} error={m.error} onConfirm={() => m.mutate(ask)} onClose={() => { setAsk(null); m.reset(); }} confirmLabel={ask.state === "UNBLOCKED" ? "Unblock" : "Block now"} danger={ask.state !== "UNBLOCKED"} deploysRevision={false} />
      )}
    </div>
  );
}

// ---------------- Live status ----------------
function LiveTab({ data }: { data: TApiRules }) {
  const q = useQuery({ queryKey: ["live", data.api.id], queryFn: () => rulesClient.live(data.api.id), refetchInterval: 15000 });
  if (q.isLoading) return <Loading tiles={4} blocks={1} />;
  if (q.isError || !q.data) return <ErrorState message={(q.error as Error)?.message ?? "Could not load the live status"} onRetry={() => q.refetch()} />;
  const d = q.data;
  const n = (v: number | undefined | null) => (v == null ? "—" : fmtInt(v));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {!d.measured && <Banner tone="warn">Traffic is not measured right now{d.analytics?.detail ? ` (${txt(d.analytics.detail)})` : ""}. Gateway analytics reads the gateway's metrics log; until it is active the counts below are unknown, not zero.</Banner>}
      <div className="gw-tiles">
        <Tile label="Requests" value={n(d.last5m?.requests)} hint={`last 5 minutes · ${n(d.last1h?.requests)} in the last hour`} />
        <Tile label="Errors" value={n(d.last5m?.errors)} hint={`last 5 minutes · ${n(d.last1h?.errors)} in the last hour`} />
        <Tile label="Throttled (429)" value={n(d.last5m?.throttled)} hint={`last 5 minutes · ${n(d.last1h?.throttled)} in the last hour`} />
        <Tile label="Refused (401/403)" value={n(d.last5m?.refused)} hint={`last 5 minutes · ${n(d.last1h?.refused)} in the last hour`} />
      </div>
      <Section title="Deployed now" note="The revision each gateway is serving.">
        {d.deployments.length ? <dl className="gw-kv">{d.deployments.map((x) => <Fragment key={x.name}><dt>{x.name} ({x.vhost})</dt><dd><strong>{x.revision}</strong>{x.deployedTime ? ` · since ${fmtDateTime(x.deployedTime)}` : ""}</dd></Fragment>)}</dl>
          : <p className="gw-note" style={{ margin: 0 }}>Not deployed to any gateway. Callers cannot reach it.</p>}
      </Section>
      <Section title="Last change">
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55 }}>
          {d.lastChange.by ? <><strong>{d.lastChange.by}</strong> · {d.lastChange.action} · {d.lastChange.at ? ago(Date.parse(d.lastChange.at)) : ""} {d.lastChange.outcome === "failed" ? <Chip tone="bad">failed</Chip> : null}<br /><span className="gw-muted">{d.lastChange.what}</span></>
            : <>Last changed {d.lastChange.at ? txt(d.lastChange.at) : "at an unknown time"} outside this console (API Manager does not record who).</>}
        </p>
      </Section>
      <p className="gw-faint" style={{ margin: 0, fontSize: 12.5 }}>Refreshes every 15 seconds. <Link className="gw-link" to={`/gateway-analytics?api=${encodeURIComponent(data.api.name)}`}>Open gateway analytics</Link></p>
    </div>
  );
}

// ---------------- Change history ----------------
function HistoryTab({ data, done }: { data: TApiRules; done: (p: ChangePlan) => void }) {
  const q = useQuery({ queryKey: ["history", data.api.id], queryFn: () => rulesClient.history(data.api.id) });
  const lc = useLiveChange((rev: string, p) => rulesClient.rollback(data.api.id, rev, p), (p) => { q.refetch(); done(p); });
  if (q.isLoading) return <Loading tiles={0} blocks={2} />;
  if (q.isError || !q.data) return <ErrorState message={(q.error as Error)?.message ?? "Could not load the history"} onRetry={() => q.refetch()} />;
  const deployedAny = q.data.revisions.some((r) => r.deployedTo.length);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Section title="Revisions" note={`Each saved change becomes a revision. API Manager keeps at most ${q.data.maxRevisions}; the oldest undeployed one makes room for a new one.`}>
        <div style={{ display: "flex", flexDirection: "column" }} aria-label="Revisions">
          {q.data.revisions.map((r, i) => (
            <div key={r.id} className="gw-apirow" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "12px 4px", borderTop: i ? "1px solid var(--border)" : "none" }} data-revision={r.displayName}>
              <div style={{ flex: "1 1 260px", minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                <strong style={{ fontSize: 13.5 }}>{r.displayName} {r.deployedTo.map((d) => <Chip key={d.name} tone="ok">Live on {d.name}</Chip>)}</strong>
                <span className="gw-muted" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{r.description || "No description"}</span>
                <span className="gw-faint" style={{ fontSize: 12 }}>{r.createdTime ? fmtDateTime(Number(r.createdTime)) : ""}</span>
              </div>
              {!r.deployedTo.length && deployedAny && <button type="button" className="gw-btn gw-btn-sm" disabled={lc.preview.isPending} onClick={() => lc.preview.mutate(r.id)}><RotateCcw size={13} aria-hidden="true" />Roll back to this</button>}
            </div>
          ))}
          {!q.data.revisions.length && <p className="gw-note" style={{ margin: 0 }}>No revisions yet.</p>}
        </div>
        <ErrorLine error={lc.preview.error} />
      </Section>
      <Section title="Changes made from this console" note="Who changed what, from the audit log. Changes made directly in API Manager are only visible as revisions above.">
        {q.data.audit.length ? (
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }} aria-label="Audit">
            {q.data.audit.map((l, i) => (
              <li key={i} style={{ fontSize: 13, lineHeight: 1.5, borderTop: i ? "1px solid var(--border)" : "none", paddingTop: i ? 10 : 0 }}>
                <strong>{l.user}</strong> · {l.action} · {fmtDateTime(Date.parse(l.at))} {l.outcome === "failed" ? <Chip tone="bad">failed</Chip> : <Chip tone="ok">done</Chip>}{l.revision ? <> · {l.revision}</> : null}
                <div className="gw-muted" style={{ overflowWrap: "anywhere" }}>{l.before ? `${l.before} → ` : ""}{l.after}{l.detail ? ` (${l.detail})` : ""}</div>
              </li>
            ))}
          </ul>
        ) : <p className="gw-note" style={{ margin: 0 }}>No changes from this console yet.</p>}
      </Section>
      <ConfirmChange open={!!lc.plan} title="Confirm roll back" plan={lc.plan} busy={lc.apply.isPending} error={lc.apply.error} onConfirm={() => lc.apply.mutate()} onClose={lc.close} confirmLabel="Roll back the live gateway" danger deploysRevision={false} />
    </div>
  );
}

export function ApiRules() {
  const { id = "" } = useParams();
  const [tab, setTab] = useParam<Tab>("tab", "traffic", TABS.map((t) => t.id));
  const q = useQuery({ queryKey: ["rules", id], queryFn: () => rulesClient.api(id) });
  const d = q.data;
  const [result, setResult] = useState<ChangePlan | null>(null);
  useEffect(() => { setResult(null); }, [tab, id]);
  const done = (p: ChangePlan) => { setResult(p); q.refetch(); window.scrollTo?.({ top: 0, behavior: "smooth" }); };
  const live = useMemo(() => (d?.deployments ?? []).map((x) => `${x.name} (${x.vhost})`).join(", "), [d]);
  // Tabs keep their own form state; remount them when the API definition changes underneath.
  const key = `${d?.api.id}-${d?.api.lastUpdatedTime}-${(d?.deployments ?? []).map((x) => x.revisionUuid).join()}`;
  return (
    <>
      <div><Link className="gw-link" to="/apis" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}><ArrowLeft size={14} aria-hidden="true" />All APIs</Link></div>
      <PageHeader area="APIs" title={d ? d.api.name : "API"} subtitle={d ? <>
        <span className="gw-mono">{`${d.api.context}/${d.api.version}`.replace(/\/+/g, "/")}</span> · {d.api.lifeCycleStatus === "PUBLISHED" ? "Published" : txt(d.api.lifeCycleStatus).toLowerCase()} · {live ? `Live on ${live}` : "Not deployed"} · <strong style={{ color: d.stage === "production" ? "var(--bad)" : "var(--warn)" }}>{d.stageWord}</strong>
      </> : undefined} />
      {q.isLoading ? <Loading tiles={0} blocks={2} /> : q.isError || !d ? <ErrorState message={(q.error as Error)?.message ?? "Could not load this API"} onRetry={() => q.refetch()} /> : (
        <>
          {d.via === "service" && <Banner tone="info">Shown with the console's service account because your own sign-in sees no APIs. Changes are recorded under your name.</Banner>}
          <SegTabs<Tab> label="API sections" tabs={TABS} value={tab} onChange={setTab} />
          <Done result={result} />
          <div key={key}>
            {tab === "traffic" && <TrafficTab data={d} done={done} />}
            {tab === "access" && <AccessTab data={d} done={done} />}
            {tab === "policies" && <PoliciesTab data={d} done={done} />}
            {tab === "consumers" && <ConsumersTab data={d} />}
            {tab === "live" && <LiveTab data={d} />}
            {tab === "history" && <HistoryTab data={d} done={done} />}
          </div>
        </>
      )}
    </>
  );
}

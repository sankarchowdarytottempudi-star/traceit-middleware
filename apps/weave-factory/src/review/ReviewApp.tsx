// Manual Review Workbench (§15): the page a CRM Web Tab shows. Reviewers decide whether an incoming
// guest is a person the CRM already knows. Every read and decision goes through this server's
// /api/review/*, which calls the Integration Service review API only. Opening a case reads no CRM.
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMatch, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, LogOut, RefreshCw } from "lucide-react";
import { Btn, Empty, Failed, Field, KV, Loading, Notice, Panel, Pill } from "../migrate/ui.tsx";
import { ThemeSwitch } from "../components/ThemeSwitch.tsx";
import "../migrate/migrate.css";
import "./review.css";
import { hasToken, reviewApi, ReviewError, setToken, signIn, whenExpired, type Action, type CaseRow, type GuestView, type ReviewCase, type Role, type Session } from "./api.ts";
import {
  ACTION_HINT, ACTION_LABEL, ERROR_WORDS, FIELDS, KIND_LABEL, KIND_SHORT, ROLE_LABEL, STATUS_LABEL,
  age, caseChanges, distinctIdentities, fieldMark, identityOf, newIdempotencyKey, slaWords, versionsShown, type Change,
} from "./model.ts";

const words = (e: unknown) => (e instanceof ReviewError ? ERROR_WORDS[e.code] ?? e.message : e instanceof Error ? e.message : "Something went wrong. Try again.");

export function ReviewApp() {
  const qc = useQueryClient();
  const [signedIn, setSignedIn] = useState(hasToken());
  const [ended, setEnded] = useState<string | null>(null);
  // nothing one person saw may show for the next person who signs in here
  const forget = () => qc.removeQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("rv-") && q.queryKey[0] !== "rv-info" });
  useEffect(() => { document.title = "Identity review"; }, []);
  useEffect(() => { whenExpired(() => { forget(); setSignedIn(false); setEnded("Your session ended. Sign in again to carry on."); }); }, []);
  return (
    <div className="mf rv" data-testid="review-app">
      {signedIn
        ? <Workbench onSignOut={(why) => { setToken(null); forget(); setSignedIn(false); setEnded(why); }} />
        : <SignIn ended={ended} onSignedIn={(t) => { forget(); setToken(t); setEnded(null); setSignedIn(true); }} />}
    </div>
  );
}

function TopBar({ children }: { children?: ReactNode }) {
  return (
    <header className="rv-top">
      <h1>Identity review</h1>
      <div className="rv-who">{children}<ThemeSwitch /></div>
    </header>
  );
}

// ---- sign-in -----------------------------------------------------------------------------------
function SignIn({ ended, onSignedIn }: { ended: string | null; onSignedIn: (token: string) => void }) {
  const info = useQuery({ queryKey: ["rv-info"], queryFn: reviewApi.info, retry: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    const r = await signIn();
    setBusy(false);
    if (r.ok) onSignedIn(r.token); else setErr(ERROR_WORDS[r.error] ?? ERROR_WORDS.SIGN_IN_FAILED);
  };
  return (
    <>
      <TopBar />
      <main className="rv-signin">
        <div className="rv-card" data-testid="rv-signin">
          <h2>Sign in to review guests</h2>
          <p>Use your Zoho account. A small window opens for Zoho's sign-in, then closes by itself.</p>
          {ended && <Notice tone="warn">{ended}</Notice>}
          {info.data && !info.data.signIn && <Notice tone="warn">Sign-in is not set up yet. Your CRM administrator needs to finish the Zoho connection for this page.</Notice>}
          {err && <Notice tone="bad">{err}</Notice>}
          <Btn kind="primary" onClick={go} busy={busy} disabled={!info.data?.signIn} data-testid="rv-signin-btn">Sign in with Zoho</Btn>
          <p style={{ fontSize: 12.5 }}>Only people with a review role can open cases. Your session ends after a while without use.</p>
        </div>
      </main>
    </>
  );
}

// ---- workbench ---------------------------------------------------------------------------------
function Workbench({ onSignOut }: { onSignOut: (why: string | null) => void }) {
  const session = useQuery({ queryKey: ["rv-session"], queryFn: reviewApi.session, retry: false, staleTime: 60_000 });
  const s = session.data;
  // the session also has an absolute end; leave politely when it comes
  useEffect(() => {
    if (!s) return;
    const ms = Date.parse(s.expiresAt) - Date.now();
    if (!Number.isFinite(ms)) return;
    const t = setTimeout(() => onSignOut("Your session reached its time limit. Sign in again to carry on."), Math.max(0, Math.min(ms, 2 ** 31 - 1)));
    return () => clearTimeout(t);
  }, [s, onSignOut]);
  const logout = async () => { await reviewApi.logout().catch(() => undefined); onSignOut("You signed out."); };
  return (
    <>
      <TopBar>
        {s && <span data-testid="rv-user">{s.user.name || "Signed in"} · {s.roles.map((r) => ROLE_LABEL[r] ?? r).join(", ")}</span>}
        <Btn small icon={<LogOut size={14} aria-hidden="true" />} onClick={logout}>Sign out</Btn>
      </TopBar>
      <main className="rv-main">
        {session.isLoading && <Loading rows={2} />}
        {session.isError && <Failed what="Could not open your session." error={words(session.error)} onRetry={() => session.refetch()} />}
        {s && <Desk s={s} />}
      </main>
    </>
  );
}

const KIND_FILTERS = ["MULTIPLE_IDENTITY_CONFLICT", "FOUR_FIELD_REVIEW", "PAIR_REPAIR", "REEVALUATION_CONFLICT", "GUARDRAIL", "SHADOW_CANDIDATE"];
const STATUS_FILTERS = ["REVIEW_OPEN", "REVIEW_DATA_CHANGED", "REVIEW_CRM_UPDATE_PENDING", "REVIEW_FAILED", "REVIEW_COMMITTED"];

function Desk({ s }: { s: Session }) {
  const m = useMatch("/review/cases/:id");
  const id = m?.params.id ?? null;
  const nav = useNavigate();
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("REVIEW_OPEN");
  const [mine, setMine] = useState(false);
  const cases = useQuery({ queryKey: ["rv-cases", kind, status, mine], queryFn: () => reviewApi.cases({ kind, status, mine }), retry: false, refetchInterval: 60_000 });
  return (
    <>
      {!s.connected && <Notice tone="warn">The review service is not connected yet, so there are no cases to show. This page is ready for when it is.</Notice>}
      <div className={`rv-split${id ? " rv-has-case" : ""}`}>
        <section className="rv-queue" aria-labelledby="rv-queue-h" data-testid="rv-queue">
          <div className="rv-row" style={{ justifyContent: "space-between" }}>
            <h2 id="rv-queue-h" className="mf-mg-h2" style={{ margin: 0 }}>Cases{cases.data ? ` (${cases.data.cases.length})` : ""}</h2>
            <Btn small icon={<RefreshCw size={14} aria-hidden="true" />} onClick={() => cases.refetch()} aria-label="Refresh the cases">Refresh</Btn>
          </div>
          <div className="rv-filters">
            <label className="rv-sr" htmlFor="rv-kind">Kind of case</label>
            <select id="rv-kind" className="mf-mg-input" value={kind} onChange={(e) => setKind(e.target.value)} data-testid="rv-filter-kind">
              <option value="">All kinds</option>
              {KIND_FILTERS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
            <label className="rv-sr" htmlFor="rv-status">Status</label>
            <select id="rv-status" className="mf-mg-input" value={status} onChange={(e) => setStatus(e.target.value)} data-testid="rv-filter-status">
              <option value="">Any status</option>
              {STATUS_FILTERS.map((k) => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}
            </select>
            <label className="rv-row" style={{ gap: 6, fontSize: 13.5 }}>
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} data-testid="rv-filter-mine" style={{ width: 18, height: 18 }} /> Only mine
            </label>
          </div>
          {cases.isLoading && <Loading rows={4} h={70} />}
          {cases.isError && <Failed what="Could not load the cases." error={words(cases.error)} onRetry={() => cases.refetch()} />}
          {cases.data && !cases.data.cases.length && <Empty title="No cases here" hint="Nothing matches these filters right now." />}
          {cases.data && cases.data.cases.length > 0 && (
            <ul className="rv-list">
              {cases.data.cases.map((c) => <li key={c.caseId}><QueueItem c={c} current={c.caseId === id} onOpen={() => nav(`/review/cases/${encodeURIComponent(c.caseId)}`)} /></li>)}
            </ul>
          )}
        </section>
        <div className="rv-casecol">
          {id ? <CaseView key={id} id={id} s={s} onBack={() => nav("/review")} />
            : <Panel><Empty title="Choose a case" hint="Pick a case on the left to compare the guests and decide." /></Panel>}
        </div>
      </div>
    </>
  );
}

function SlaBadge({ sla }: { sla: CaseRow["sla"] }) {
  const w = slaWords(sla);
  if (!w) return null;
  return <span data-testid="rv-sla" data-state={sla?.state}><Pill tone={w.tone}>{w.text}</Pill></span>;
}

function QueueItem({ c, current, onOpen }: { c: CaseRow; current: boolean; onOpen: () => void }) {
  return (
    <button type="button" className="rv-item" aria-current={current} onClick={onOpen} data-testid="rv-case-item" data-case={c.caseId}>
      <span className="rv-item-top">
        <Pill tone={c.kind === "MULTIPLE_IDENTITY_CONFLICT" || c.kind === "REEVALUATION_CONFLICT" ? "bad" : c.kind === "SHADOW_CANDIDATE" ? "accent" : undefined}>{KIND_SHORT[c.kind] ?? c.kind}</Pill>
        {c.priority === "HIGH" && <Pill tone="warn">High priority</Pill>}
        <SlaBadge sla={c.sla} />
      </span>
      <span className="rv-item-title">{c.title ?? `Case ${c.caseId}`}</span>
      <span className="rv-meta">
        <span>{STATUS_LABEL[c.caseStatus] ?? c.caseStatus}</span>
        {c.createdAt && <span>Waiting {age(c.createdAt)}</span>}
        {c.candidateCount !== null && <span>{c.candidateCount} possible match{c.candidateCount === 1 ? "" : "es"}</span>}
        <span>{c.assignee ? "Taken" : "Not taken"}</span>
      </span>
    </button>
  );
}

// ---- one case ----------------------------------------------------------------------------------
const mayDecide = (r: Role[]) => r.includes("IDENTITY_REVIEWER") || r.includes("IDENTITY_SUPERVISOR");
const mayComment = (r: Role[]) => mayDecide(r) || r.includes("CRM_ADMINISTRATOR");

function CaseView({ id, s, onBack }: { id: string; s: Session; onBack: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["rv-case", id], queryFn: () => reviewApi.case(id), retry: false });
  const hist = useQuery({ queryKey: ["rv-hist", id], queryFn: () => reviewApi.history(id), retry: false });
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  const changedRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (changes && changedRef.current) { changedRef.current.scrollIntoView({ block: "center" }); changedRef.current.focus(); } }, [changes]);
  const refreshAll = async () => { await Promise.all([q.refetch(), hist.refetch(), qc.invalidateQueries({ queryKey: ["rv-cases"] })]); };
  const c = q.data;
  return (
    <>
      <div className="rv-row">
        <Btn small onClick={onBack} data-testid="rv-back">← All cases</Btn>
        <span className="mf-mg-grow" />
        <Btn small icon={<RefreshCw size={14} aria-hidden="true" />} onClick={refreshAll}>Refresh case</Btn>
      </div>
      {q.isLoading && <Loading rows={3} h={90} />}
      {q.isError && <Failed what="Could not open this case." error={words(q.error)} onRetry={() => q.refetch()} />}
      {c && (
        <div data-testid="rv-case" data-case={c.caseId} className="rv-casecol">
          <Panel title={<>{KIND_LABEL[c.kind] ?? c.kind}</>} actions={<span className="rv-badges"><Pill>{STATUS_LABEL[c.caseStatus] ?? c.caseStatus}</Pill><SlaBadge sla={c.sla} /></span>}>
            <KV rows={[
              ["Case", <span className="mf-mg-nowrap">{c.caseId}</span>],
              ["Priority", c.priority === "HIGH" ? "High" : c.priority ? "Normal" : ""],
              ["Waiting", c.createdAt ? age(c.createdAt) : ""],
              ["Taken by", c.assignee ? (c.assignee === s.user.zuid ? "You" : c.assignee) : "Nobody yet"],
              ["Rule version", c.ruleVersion ?? ""],
              ["Why it is here", c.reasonCodes?.length ? <span className="rv-codes">{c.reasonCodes.map((r) => <span key={r} className="rv-code">{r}</span>)}</span> : ""],
              ["Trial matcher", c.shadow ? <span data-testid="rv-shadow">{c.shadow.label ?? "—"}{typeof c.shadow.score === "number" ? ` · score ${c.shadow.score.toFixed(2)}` : ""}{c.shadow.modelVersion ? ` · ${c.shadow.modelVersion}` : ""}</span> : ""],
            ]} />
          </Panel>
          {!c.protectedShown && <Notice tone="info"><span data-testid="rv-masked">Personal details are hidden for your role. You can see how the details compare, not the details themselves.</span></Notice>}
          {changes && (
            <Notice tone="warn">
              <div data-testid="rv-changed" role="alert" tabIndex={-1} ref={changedRef} style={{ outline: "none" }}>
                <strong>The guest data changed while you were looking.</strong> Your decision was not saved. The case below now shows the latest data; look again and decide.
                {changes.length > 0 && <ul className="rv-changes">{changes.map((x, i) => <li key={i}>{x.record}: {x.what}{x.before !== undefined ? <> — was <strong>{x.before}</strong>, now <strong>{x.after}</strong></> : null}</li>)}</ul>}
              </div>
            </Notice>
          )}
          {saved && <Notice tone="ok"><span data-testid="rv-saved">{saved}</span></Notice>}
          <Compare c={c} />
          <Pairs c={c} />
          <Decide key={`${c.caseId}:${formKey}`} c={c} s={s}
            onSaved={async (msg) => { setChanges(null); setSaved(msg); await refreshAll(); }}
            onChanged={async () => {
              const before = c;
              const r = await q.refetch();
              setChanges(r.data ? caseChanges(before, r.data) : []);
              setSaved(null);
              setFormKey((k) => k + 1); // a new decision is needed
            }} />
          <div className="rv-grid2">
            <Assign c={c} s={s} onDone={refreshAll} />
            {mayComment(s.roles) && <Comment id={c.caseId} onDone={() => hist.refetch()} />}
          </div>
          <Panel title="History">
            {hist.isLoading && <Loading rows={2} h={40} />}
            {hist.isError && <Failed what="Could not load the history." error={words(hist.error)} onRetry={() => hist.refetch()} />}
            {hist.data && !hist.data.history.length && <p className="mf-mg-muted" style={{ margin: 0 }}>Nothing has happened on this case yet.</p>}
            {hist.data && hist.data.history.length > 0 && (
              <ol className="rv-hist" data-testid="rv-history">
                {hist.data.history.map((h, i) => (
                  <li key={i}>
                    <span>{h.what ?? (h.action ? ACTION_LABEL[h.action as Action] ?? h.action : h.kind ?? "Update")}{h.who || h.by ? ` · ${h.who ?? h.by}` : ""}</span>
                    {(h.text || h.comment) && <span className="mf-mg-muted">{h.text ?? h.comment}</span>}
                    {h.at && <time dateTime={h.at}>{new Date(h.at).toLocaleString()}</time>}
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
      )}
    </>
  );
}

function Compare({ c }: { c: ReviewCase }) {
  const [norm, setNorm] = useState(false);
  const cols: { g: GuestView; head: ReactNode; incoming?: boolean }[] = [];
  if (c.incoming) cols.push({ g: c.incoming, incoming: true, head: <><strong>Incoming guest</strong><span>{c.incoming.crmGuestRecordId}</span></> });
  const ids = distinctIdentities(c);
  c.candidates.forEach((g, i) => {
    const pid = identityOf(g);
    const n = pid ? ids.indexOf(pid) + 1 : 0;
    cols.push({ g, head: <><strong>Possible match {i + 1}</strong><span>{g.crmGuestRecordId}</span>{n > 0 && <span>Person {n} of {ids.length}</span>}</> });
  });
  const canNorm = c.protectedShown && cols.some(({ g }) => g.normalized && Object.keys(g.normalized).length);
  return (
    <Panel title="Compare the guests" actions={canNorm ? <label className="rv-row" style={{ gap: 6, fontSize: 13 }}><input type="checkbox" checked={norm} onChange={(e) => setNorm(e.target.checked)} data-testid="rv-show-norm" style={{ width: 18, height: 18 }} /> Show cleaned-up values</label> : undefined}>
      {ids.length > 1 && <p style={{ margin: "0 0 10px" }} data-testid="rv-distinct"><Pill tone="bad">{ids.length} different people</Pill> The possible matches belong to more than one person in CRM.</p>}
      <div className="rv-compare-wrap" tabIndex={0} role="region" aria-label="Guest comparison table">
        <table className="rv-compare" data-testid="rv-compare">
          <thead>
            <tr><th scope="col"><span className="rv-sr">Detail</span></th>{cols.map(({ g, head, incoming }) => <th key={g.crmGuestRecordId} scope="col" className={incoming ? "rv-incoming" : undefined}><span className="rv-colhead">{head}</span></th>)}</tr>
          </thead>
          <tbody>
            {FIELDS.map(([k, label]) => (
              <tr key={k}>
                <th scope="row">{label}</th>
                {cols.map(({ g, incoming }) => {
                  const v = g.display?.[k] ?? "";
                  const mk = incoming ? (v ? null : fieldMark("MISSING", false)) : fieldMark(g.fieldResults?.[k], !!v);
                  const nv = g.normalized ? Object.entries(g.normalized).find(([nk]) => nk.toLowerCase().startsWith(k.toLowerCase().replace("name", ""))) : undefined;
                  return (
                    <td key={g.crmGuestRecordId} className={incoming ? "rv-incoming" : undefined} data-field={k} data-result={g.fieldResults?.[k] ?? ""}>
                      <span className="rv-val">{v || <span className="mf-mg-faint">—</span>}</span>
                      {norm && nv && <span className="rv-norm">{String(nv[1])}</span>}
                      {mk && <><br /><span className={`rv-mark rv-mark-${mk.tone}`}><span aria-hidden="true">{mk.symbol}</span>{mk.label}</span></>}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <th scope="row">Reasons</th>
              {cols.map(({ g }) => <td key={g.crmGuestRecordId}>{g.reasonCodes?.length ? <span className="rv-codes">{g.reasonCodes.map((r) => <span key={r} className="rv-code">{r}</span>)}</span> : <span className="mf-mg-faint">—</span>}</td>)}
            </tr>
            <tr>
              <th scope="row">In CRM</th>
              {cols.map(({ g }) => <td key={g.crmGuestRecordId}>{g.crmLink ? <a className="rv-link" href={g.crmLink} target="_blank" rel="noopener noreferrer" data-testid="rv-crm-link">Open in CRM <ExternalLink size={12} aria-hidden="true" /><span className="rv-sr"> (opens a new tab)</span></a> : <span className="mf-mg-faint">—</span>}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Pairs({ c }: { c: ReviewCase }) {
  const prov = typeof c.provisionalIdentity === "string" ? c.provisionalIdentity : c.provisionalIdentity?.crmIdentityRecordId;
  const groups: [string, string, any[]][] = [
    ["current", "Linked now", c.pairs?.current ?? []],
    ["provisional", "Linked for now, until decided", c.pairs?.provisional ?? []],
    ["surviving", "Will stay linked after the decision", c.pairs?.surviving ?? []],
  ];
  const any = groups.some(([, , l]) => l.length) || prov;
  if (!any) return null;
  return (
    <Panel title="Links between guest and person">
      <div data-testid="rv-pairs" className="mf-mg-stack" style={{ gap: 10 }}>
        {prov && <p style={{ margin: 0 }}>For now the incoming guest is linked to person <span className="rv-code">{prov}</span>.</p>}
        {groups.filter(([, , l]) => l.length).map(([k, label, l]) => (
          <div key={k}>
            <h3 className="mf-mg-h3" style={{ margin: "0 0 4px" }}>{label}</h3>
            <ul className="rv-changes" style={{ marginTop: 0 }}>
              {l.map((p: any, i: number) => <li key={i}>Guest <span className="rv-code">{p.crmGuestRecordId ?? p.guestId ?? "?"}</span> → person <span className="rv-code">{p.crmIdentityRecordId ?? p.identityId ?? "?"}</span>{p.state ? ` · ${p.state}` : ""}</li>)}
            </ul>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function Decide({ c, s, onSaved, onChanged }: { c: ReviewCase; s: Session; onSaved: (msg: string) => void; onChanged: () => void }) {
  const acts = c.allowedActions ?? [];
  const ids = useMemo(() => distinctIdentities(c), [c]);
  const [action, setAction] = useState<Action | "">("");
  const [pick, setPick] = useState(ids.length === 1 ? ids[0] : "");
  const [comment, setComment] = useState("");
  const [follow, setFollow] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // one key per decision attempt, kept across retries of the same choice
  const keyRef = useRef<string>("");
  useEffect(() => { keyRef.current = ""; }, [action, pick, comment, follow]);
  if (!acts.length) {
    const why = c.caseStatus === "REVIEW_COMMITTED" ? "This case is decided. Only a supervisor can reverse it."
      : c.caseStatus === "REVIEW_CRM_UPDATE_PENDING" ? "CRM is being updated with the decision."
      : mayDecide(s.roles) ? "This case cannot take a decision in its current state." : "Your role can read cases but not decide them.";
    return <Panel title="Decision"><p className="mf-mg-muted" style={{ margin: 0 }} data-testid="rv-no-actions">{why}</p></Panel>;
  }
  const needPick = action === "CONFIRM_SAME_PERSON" || action === "REVERSE_DECISION";
  const today = new Date().toISOString().slice(0, 10);
  const problems: string[] = [];
  if (!action) problems.push("Choose a decision.");
  if (action === "CONFIRM_SAME_PERSON" && !pick) problems.push("Choose which person the guest is.");
  if (action === "DEFER" && !comment.trim()) problems.push("Say why you are leaving it for later.");
  if (action === "DEFER" && !follow) problems.push("Choose a date to look again.");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problems.length || !action) return;
    setBusy(true); setErr(null);
    if (!keyRef.current) keyRef.current = newIdempotencyKey(c.caseId, s.user.zuid);
    try {
      await reviewApi.decide(c.caseId, {
        action, versionsShown: versionsShown(c), idempotencyKey: keyRef.current,
        ...(needPick && pick ? { selectedIdentityId: pick } : {}),
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        ...(action === "DEFER" ? { followUpDate: follow } : {}),
      });
      onSaved(`Saved: ${ACTION_LABEL[action]}.${action === "DEFER" ? ` Look again on ${follow}.` : ""}`);
    } catch (x) {
      if (x instanceof ReviewError && x.code === "REVIEW_DATA_CHANGED") { onChanged(); return; }
      setErr(words(x));
    } finally { setBusy(false); }
  };
  return (
    <Panel title="Decision">
      <form className="rv-form" onSubmit={submit} data-testid="rv-decide">
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="rv-sr">What is your decision?</legend>
          <div className="rv-actions">
            {acts.map((a) => (
              <label key={a} className="rv-choice">
                <input type="radio" name="rv-action" value={a} checked={action === a} onChange={() => setAction(a)} data-testid={`rv-act-${a}`} />
                <span><strong>{ACTION_LABEL[a]}</strong><small>{ACTION_HINT[a]}</small></span>
              </label>
            ))}
          </div>
        </fieldset>
        {needPick && (
          <Field label={action === "REVERSE_DECISION" ? "Link the guest to (leave empty for nobody)" : "Which person is the incoming guest?"}>
            <select className="mf-mg-input" value={pick} onChange={(e) => setPick(e.target.value)} data-testid="rv-pick">
              <option value="">{action === "REVERSE_DECISION" ? "Nobody" : "Choose a person"}</option>
              {ids.map((p, i) => <option key={p} value={p}>Person {i + 1} ({p})</option>)}
            </select>
          </Field>
        )}
        {action === "DEFER" && (
          <Field label="Look again on">
            <input type="date" className="mf-mg-input" min={today} value={follow} onChange={(e) => setFollow(e.target.value)} data-testid="rv-follow" />
          </Field>
        )}
        <Field label={action === "DEFER" ? "Why leave it for later?" : "Comment (optional)"} hint="Up to 2000 characters. Kept with the case.">
          <textarea className="mf-mg-input" rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} data-testid="rv-comment" />
        </Field>
        {err && <Notice tone="bad"><span data-testid="rv-error">{err}</span></Notice>}
        <div className="rv-row">
          <Btn kind="primary" type="submit" busy={busy} disabled={problems.length > 0} data-testid="rv-submit">Save decision</Btn>
          {problems.length > 0 && action && <span className="mf-mg-muted" style={{ fontSize: 13 }}>{problems[0]}</span>}
        </div>
      </form>
    </Panel>
  );
}

function Assign({ c, s, onDone }: { c: ReviewCase; s: Session; onDone: () => void }) {
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const mine = c.assignee === s.user.zuid;
  const canTake = mayDecide(s.roles) && !mine;
  if (!canTake && !c.canAssign) return <Panel title="Who has it"><p style={{ margin: 0 }}>{c.assignee ? (mine ? "You have this case." : "Someone has taken this case.") : "Nobody has taken this case yet."}</p></Panel>;
  const give = async (who: string) => {
    setBusy(true); setMsg(null);
    try { await reviewApi.assign(c.caseId, who); setMsg({ tone: "ok", text: who === s.user.zuid ? "The case is yours." : "The case was handed over." }); setTo(""); onDone(); }
    catch (x) { setMsg({ tone: "bad", text: words(x) }); }
    finally { setBusy(false); }
  };
  return (
    <Panel title="Who has it">
      <div className="rv-form" data-testid="rv-assign">
        <p style={{ margin: 0 }}>{c.assignee ? (mine ? "You have this case." : `Taken by ${c.assignee}.`) : "Nobody has taken this case yet."}</p>
        {canTake && <Btn onClick={() => give(s.user.zuid)} busy={busy} data-testid="rv-take">Take this case</Btn>}
        {c.canAssign && (
          <form className="rv-row" onSubmit={(e) => { e.preventDefault(); if (to.trim()) give(to.trim()); }}>
            <label className="rv-sr" htmlFor="rv-to">Zoho user ID of the reviewer</label>
            <input id="rv-to" className="mf-mg-input" style={{ flex: "1 1 160px", width: "auto" }} placeholder="Reviewer's Zoho user ID" value={to} onChange={(e) => setTo(e.target.value)} data-testid="rv-assign-to" />
            <Btn type="submit" busy={busy} disabled={!to.trim()} data-testid="rv-assign-btn">Give to reviewer</Btn>
          </form>
        )}
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      </div>
    </Panel>
  );
}

function Comment({ id, onDone }: { id: string; onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true); setMsg(null);
    try { await reviewApi.comment(id, text.trim()); setText(""); setMsg({ tone: "ok", text: "Comment added." }); onDone(); }
    catch (x) { setMsg({ tone: "bad", text: words(x) }); }
    finally { setBusy(false); }
  };
  return (
    <Panel title="Add a comment">
      <form className="rv-form" onSubmit={send} data-testid="rv-comment-form">
        <label className="rv-sr" htmlFor="rv-note">Comment</label>
        <textarea id="rv-note" className="mf-mg-input" rows={2} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder="A note for other reviewers" />
        <div className="rv-row"><Btn type="submit" busy={busy} disabled={!text.trim()}>Add comment</Btn></div>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      </form>
    </Panel>
  );
}

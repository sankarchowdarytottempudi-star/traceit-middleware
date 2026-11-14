import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { ChevronDown, Copy, Download, Pause, Play, RefreshCw, X } from "lucide-react";
import { apiClient, type LogEntry, type LogResult, type LogSource } from "../api.ts";
import { ErrorState } from "../components/ui.tsx";
import { Banner, Section, useDebounced, copyText } from "../components/gw.tsx";
import { PageHeader } from "./PageHeader.tsx";
import { txt, num, list, fmtInt, fmtClockMs, fmtDay, plural } from "../lib/text.ts";

const GROUPS: { kind: LogSource["kind"]; title: string }[] = [
  { kind: "gateway", title: "Gateway" },
  { kind: "service", title: "Migrated services" },
  { kind: "flow", title: "Flows" },
  { kind: "component", title: "Supporting components" },
];
const SINCE: { v: string; label: string }[] = [
  { v: "300", label: "Last 5 minutes" }, { v: "900", label: "Last 15 minutes" }, { v: "3600", label: "Last hour" },
  { v: "21600", label: "Last 6 hours" }, { v: "86400", label: "Last 24 hours" }, { v: "604800", label: "Last 7 days" },
];
const TAILS = ["200", "500", "1000", "2000", "5000"];
const LEVELS: { v: string; label: string }[] = [
  { v: "", label: "All levels" }, { v: "ERROR", label: "Errors only" }, { v: "WARN", label: "Warnings and errors" }, { v: "INFO", label: "Information and above" },
];
const pick = (v: string | null, allowed: string[], fallback: string) => (v && allowed.includes(v) ? v : fallback);

/** Wraps every occurrence of the search term in <mark>. */
function highlight(text: string, term: string): ReactNode {
  if (!term) return text;
  const lower = text.toLowerCase(); const t = term.toLowerCase();
  const out: ReactNode[] = []; let from = 0; let at = lower.indexOf(t); let k = 0;
  while (at >= 0 && k < 40) {
    if (at > from) out.push(text.slice(from, at));
    out.push(<mark key={k++}>{text.slice(at, at + t.length)}</mark>);
    from = at + t.length; at = lower.indexOf(t, from);
  }
  out.push(text.slice(from));
  return out;
}

export function Logs() {
  const [sp, setSp] = useSearchParams();
  const set = (changes: Record<string, string | null>) => setSp((prev) => {
    const n = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(changes)) { if (v === null) n.delete(k); else n.set(k, v); }
    return n;
  }, { replace: true });

  const srcQ = useQuery({ queryKey: ["log-sources"], queryFn: apiClient.logSources, refetchInterval: 60000 });
  const all = useMemo(() => list<LogSource>(srcQ.data?.list).filter((s) => txt(s.id)), [srcQ.data]);
  const byId = useMemo(() => new Map(all.map((s) => [s.id, s])), [all]);

  // No "api" in the address means "every migrated service"; an empty one means the user cleared the choice.
  const apiParam = sp.get("api");
  const selected = useMemo(() => {
    if (apiParam === null) return all.filter((s) => s.kind === "service").map((s) => s.id);
    const want = apiParam.split(",").map((s) => s.trim()).filter(Boolean);
    return all.length ? want.filter((id) => byId.has(id)) : want;
  }, [apiParam, all, byId]);
  const selKey = selected.join(",");

  const cid = sp.get("cid") ?? "";
  const level = pick(sp.get("level"), LEVELS.map((l) => l.v), "");
  const since = pick(sp.get("since"), SINCE.map((s) => s.v), cid ? "86400" : "3600");
  const tail = pick(sp.get("tail"), TAILS, "500");
  const [search, setSearch] = useState(sp.get("q") ?? "");
  const term = useDebounced(search.trim(), 350);
  useEffect(() => { if ((sp.get("q") ?? "") !== term) set({ q: term || null }); /* keep the address shareable */ }, [term]);

  const [live, setLive] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [copied, setCopied] = useState("");

  const q = useQuery({
    queryKey: ["logs", selKey, tail, since, level, term, cid],
    queryFn: () => apiClient.logs({ sources: selected, tail: Number(tail), sinceSeconds: Number(since), level, q: term, cid }),
    enabled: selected.length > 0 && (all.length > 0 || apiParam !== null),
    refetchInterval: live ? 3000 : false, placeholderData: keepPreviousData, retry: false,
  });
  const data: LogResult | undefined = selected.length ? q.data : undefined;
  const lines = list<LogEntry>(data?.lines);
  const meta = list<LogResult["sources"][number]>(data?.sources);
  const failed = meta.filter((m) => txt(m.error));
  const manyReplicas = useMemo(() => new Set(meta.filter((m) => list(m.replicas).length > 1).map((m) => m.id)), [meta]);

  // Stay at the newest line while the reader is at the bottom; leave the view alone once they scroll up.
  const box = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const onScroll = () => { const el = box.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; };
  useLayoutEffect(() => { const el = box.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [lines.length, data?.generatedAt]);
  useEffect(() => { stick.current = true; }, [selKey, term, cid, level, since, tail]);

  const toggle = (id: string) => set({ api: (selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]).join(",") });
  const choose = (ids: string[]) => set({ api: ids.join(",") });
  const sourceLabel = (e: LogEntry) => {
    const label = txt(byId.get(e.source)?.label) || txt(e.source);
    return manyReplicas.has(e.source) && txt(e.pod) ? `${label} · ${txt(e.pod).slice(-5)}` : label;
  };
  const plain = () => lines.map((l) => `[${txt(byId.get(l.source)?.label) || txt(l.source)}] ${txt(l.text)}`).join("\n");
  const flash = (word: string) => { setCopied(word); setTimeout(() => setCopied(""), 1800); };
  const copyAll = async () => flash((await copyText(plain())) ? "Copied" : "Copy failed");
  const download = () => {
    const url = URL.createObjectURL(new Blob([plain() + "\n"], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url; a.download = `weave-logs-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.log`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const firstDay = lines.length ? fmtDay(num(lines[0].t)) : "";
  const lastDay = lines.length ? fmtDay(num(lines[lines.length - 1].t)) : "";
  const summary = !all.length ? "Choose APIs" : selected.length === 0 ? "No API chosen" : selected.length === 1 ? txt(byId.get(selected[0])?.label) || selected[0] : `${selected.length} of ${all.length} chosen`;

  return (
    <>
      <PageHeader area="Logs" title="Logs"
        subtitle="What the migrated APIs, the gateway and the flows are writing right now. Follow one request across every API with its correlation id." />
      {srcQ.isError && <ErrorState message="Could not load the list of APIs" onRetry={() => srcQ.refetch()} />}
      {list<string>(srcQ.data?.errors).length > 0 && <Banner tone="warn">Some sources could not be listed, so the choice below may be incomplete: {list<string>(srcQ.data?.errors).map(txt).join("; ")}</Banner>}

      <div className="gw-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="gw-toolbar" style={{ margin: 0 }}>
          <button type="button" className="gw-btn" aria-expanded={pickerOpen} aria-controls="gw-log-sources" onClick={() => setPickerOpen((o) => !o)}>
            APIs: {summary}<ChevronDown size={15} aria-hidden="true" style={{ transform: pickerOpen ? "rotate(180deg)" : undefined, transition: "transform .15s" }} />
          </button>
          <input className="gw-input" type="search" aria-label="Search log lines" placeholder="Search text in log lines" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: "1 1 220px" }} />
          <select className="gw-select" aria-label="Level" value={level} onChange={(e) => set({ level: e.target.value || null })}>
            {LEVELS.map((l) => <option key={l.v} value={l.v}>{l.label}</option>)}
          </select>
          <select className="gw-select" aria-label="Period" value={since} onChange={(e) => set({ since: e.target.value })}>
            {SINCE.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
          </select>
          <select className="gw-select" aria-label="Number of lines" value={tail} onChange={(e) => set({ tail: e.target.value })}>
            {TAILS.map((t) => <option key={t} value={t}>{fmtInt(Number(t))} lines</option>)}
          </select>
        </div>

        {pickerOpen && (
          <div id="gw-log-sources" style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="gw-btn gw-btn-sm" onClick={() => choose(all.filter((s) => s.kind === "service").map((s) => s.id))}>All migrated services</button>
              <button type="button" className="gw-btn gw-btn-sm" onClick={() => choose(all.map((s) => s.id))}>Everything</button>
              <button type="button" className="gw-btn gw-btn-sm" onClick={() => choose([])}>Clear</button>
            </div>
            {srcQ.isLoading && <p className="gw-note" aria-busy="true">Loading the list of APIs…</p>}
            {GROUPS.map((g) => {
              const items = all.filter((s) => s.kind === g.kind);
              if (!items.length) return null;
              return (
                <fieldset key={g.kind} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
                  <legend className="gw-navtitle" style={{ padding: 0, marginBottom: 4 }}>{g.title}</legend>
                  <div className="gw-sourcepick">
                    {items.map((s) => (
                      <label key={s.id} className="gw-check">
                        <input type="checkbox" checked={selected.includes(s.id)} onChange={() => toggle(s.id)} />
                        <span>{txt(s.label)}{num(s.replicas) === 0 ? <span className="gw-faint"> (not running)</span> : num(s.replicas) > 1 ? <span className="gw-faint"> ({num(s.replicas)} replicas)</span> : null}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              );
            })}
          </div>
        )}

        <div className="gw-toolbar" style={{ margin: 0 }}>
          <button type="button" className="gw-btn" aria-pressed={live} onClick={() => setLive((v) => !v)}>
            {live ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}{live ? "Live: on" : "Live: paused"}
          </button>
          <button type="button" className="gw-btn" onClick={() => q.refetch()} disabled={!selected.length}><RefreshCw size={15} aria-hidden="true" className={q.isFetching ? "mf-spin" : undefined} />Refresh</button>
          <button type="button" className="gw-btn" onClick={copyAll} disabled={!lines.length}><Copy size={15} aria-hidden="true" />{copied || "Copy"}</button>
          <button type="button" className="gw-btn" onClick={download} disabled={!lines.length}><Download size={15} aria-hidden="true" />Download</button>
          <span className="gw-spacer" />
          <span className="gw-faint" style={{ fontSize: 12.5 }} aria-live="polite">
            {!selected.length ? "" : q.isLoading ? "Reading logs…" : data ? `${plural(lines.length, "line")}${firstDay ? ` · ${firstDay === lastDay ? firstDay : `${firstDay} to ${lastDay}`}` : ""}` : ""}
          </span>
        </div>
      </div>

      {cid && (
        <Banner>
          <span style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>Following one request: <span className="gw-mono">{cid}</span></span>
            {all.length > 0 && selected.length < all.length && <button type="button" className="gw-btn gw-btn-sm" onClick={() => choose(all.map((s) => s.id))}>Search every API and the gateway</button>}
            <button type="button" className="gw-btn gw-btn-sm" onClick={() => set({ cid: null })}><X size={14} aria-hidden="true" />Stop following</button>
          </span>
        </Banner>
      )}
      {failed.length > 0 && (
        <Banner tone="warn">Logs could not be read from {failed.map((f) => `${txt(f.label) || txt(f.id)} (${txt(f.error)})`).join("; ")}. The other sources are shown.</Banner>
      )}

      {q.isError && selected.length > 0 && !data ? <ErrorState message="Could not load logs" onRetry={() => q.refetch()} /> : (
        <div className="gw-logbox" ref={box} onScroll={onScroll} tabIndex={0} role="log" aria-label="Log lines" aria-live="off">
          {!selected.length ? <div className="gw-logempty">Choose one or more APIs to see their logs.</div>
            : !data ? <div className="gw-logempty" aria-busy="true">Reading logs…</div>
            : !lines.length ? <div className="gw-logempty">{cid ? "No log line mentions this request in the chosen APIs and period. A request leaves a line only where the gateway or the service writes its id into the log, so it can be counted in analytics without one. Try every API or a longer period, or stop following to read what was logged around that time." : term || level ? "No log line matches these filters in the chosen period." : "Nothing was logged in the chosen period."}</div>
            : lines.map((l, i) => (
              <div key={`${l.t}-${l.source}-${l.pod}-${i}`} className={`gw-logline${l.level === "ERROR" || l.level === "WARN" ? ` gw-logline-${l.level}` : ""}`}>
                <span className="gw-logt" title={new Date(num(l.t)).toString()}>{num(l.t) > 0 ? fmtClockMs(num(l.t)) : ""}</span>
                <span className="gw-logsrc" title={`${txt(byId.get(l.source)?.label) || txt(l.source)} · ${txt(l.pod)}`}>{sourceLabel(l)}</span>
                <span className={`gw-loglvl${l.level ? ` gw-loglvl-${l.level}` : ""}`}>{txt(l.level) || "·"}</span>
                <span className="gw-logmsg">
                  {highlight(txt(l.msg), term)}
                  {txt(l.cid) && txt(l.cid) !== cid && <button type="button" className="gw-logcid" title="Follow this request across the chosen APIs" onClick={() => set({ cid: txt(l.cid) })}>follow {txt(l.cid).slice(0, 8)}</button>}
                </span>
              </div>
            ))}
        </div>
      )}

      {data && selected.length > 0 && (
        <Section title="What was read" note={`${fmtInt(data.matched)} of ${fmtInt(data.scanned)} lines read match the filters; the newest ${fmtInt(data.limit)} are shown at most. Times are in your local time zone.`}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {meta.map((m) => (
              <span key={m.id} className={`gw-chip${txt(m.error) ? " gw-chip-warn" : ""}`} title={list<string>(m.replicas).map(txt).join(", ")}>
                {txt(m.label) || txt(m.id)}: {txt(m.error) ? "not readable" : plural(num(m.lines), "line")}{list(m.replicas).length > 1 ? ` from ${list(m.replicas).length} replicas` : ""}
              </span>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

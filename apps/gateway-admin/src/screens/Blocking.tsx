// Global blocking rules (API Manager deny policies): block an address, range, application, user or
// a whole API on every gateway, switch rules on and off, remove them.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rulesClient, type BlockRule } from "../api.ts";
import { ErrorState } from "../components/ui.tsx";
import { Chip, DataTable, Loading, Section, type Col } from "../components/gw.tsx";
import { ConfirmChange } from "../components/rules.tsx";
import { PageHeader } from "./PageHeader.tsx";

const TYPES = [
  { id: "IP", label: "IP address", placeholder: "198.51.100.7", hint: "One IPv4 or IPv6 address." },
  { id: "IPRANGE", label: "IP range", placeholder: "10.20.0.0/16", hint: "A CIDR range, or a first address here and the last below." },
  { id: "APPLICATION", label: "Application", placeholder: "admin:mobile-app", hint: "Owner and application name, as owner:name." },
  { id: "USER", label: "User", placeholder: "jane@example.com", hint: "The user name the token was issued to." },
  { id: "API", label: "Whole API", placeholder: "/orders/v1", hint: "The API's path with its version. Every call to it is refused." },
] as const;
const TYPE_WORD: Record<string, string> = Object.fromEntries(TYPES.map((t) => [t.id, t.label]));

export function Blocking() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["blocking"], queryFn: rulesClient.blocking });
  const [type, setType] = useState<string>("IP");
  const [value, setValue] = useState("");
  const [endIp, setEndIp] = useState("");
  const [invert, setInvert] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [ask, setAsk] = useState<null | { kind: "add" } | { kind: "toggle" | "remove"; rule: BlockRule }>(null);
  const [done, setDone] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["blocking"] });
  const add = useMutation({ mutationFn: () => rulesClient.addBlock({ type, value: value.trim(), endIp: endIp.trim() || undefined, invert, enabled }),
    onSuccess: (r) => { setAsk(null); setValue(""); setEndIp(""); setInvert(false); setDone(`Added: ${r.words}.`); refresh(); } });
  const toggle = useMutation({ mutationFn: (r: BlockRule) => rulesClient.setBlock(r.id, !r.enabled), onSuccess: () => { setAsk(null); refresh(); } });
  const remove = useMutation({ mutationFn: (r: BlockRule) => rulesClient.removeBlock(r.id), onSuccess: () => { setAsk(null); refresh(); } });
  const t = TYPES.find((x) => x.id === type) ?? TYPES[0];
  const what = () => {
    const v = value.trim();
    if (type === "IP") return `${invert ? "every address except" : "calls from"} ${v}`;
    if (type === "IPRANGE") return `${invert ? "every address outside" : "calls from"} ${v}${endIp.trim() ? ` to ${endIp.trim()}` : ""}`;
    if (type === "APPLICATION") return `every call made with the keys of application ${v}`;
    if (type === "USER") return `every call made by user ${v}`;
    return `every call to ${v}`;
  };

  const cols: Col<BlockRule>[] = [
    { key: "rule", label: "Blocks", lead: true, render: (r) => <span style={{ fontWeight: 600 }}>{r.words}</span> },
    { key: "type", label: "Type", render: (r) => TYPE_WORD[r.type] ?? r.type },
    { key: "state", label: "State", render: (r) => (r.enabled ? <Chip tone="bad">Enforced</Chip> : <Chip>Off</Chip>) },
    { key: "act", label: "Actions", render: (r) => (
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button type="button" className="gw-btn gw-btn-sm" onClick={() => setAsk({ kind: "toggle", rule: r })}>{r.enabled ? "Turn off" : "Turn on"}</button>
        <button type="button" className="gw-btn gw-btn-sm" onClick={() => setAsk({ kind: "remove", rule: r })}>Remove</button>
      </div>) },
  ];
  const list = q.data?.list ?? [];
  const confirmPlan = ask && {
    api: { id: "", name: "", context: "", version: "", lifeCycleStatus: "" }, noChange: false, applied: false, environments: [{ name: "every gateway", vhost: "" }],
    changes: ask.kind === "add" ? [`Block ${what()}${enabled ? "" : " (saved switched off: nothing is blocked until you turn it on)"}.`]
      : ask.kind === "toggle" ? [`${ask.rule.words}: ${ask.rule.enabled ? "enforced → off. Those calls are allowed again." : "off → enforced. Those calls are refused."}`]
      : [`Remove the rule "${ask.rule.words}". ${ask.rule.enabled ? "Those calls are allowed again." : "It was off, so nothing changes for callers."}`],
    sentence: "Blocking rules apply to every API on every gateway, immediately. Blocked callers get HTTP 403.",
  };
  return (
    <>
      <PageHeader area="Blocking rules" title="Blocking rules" subtitle="Refuse calls from an address, a range, an application, a user, or to a whole API, on every gateway at once. For rules on a single API use the API's Access tab." />
      {done && <div data-testid="block-done"><p className="gw-note" style={{ margin: 0 }} role="status">{done}</p></div>}
      <Section title={`Rules (${list.length})`} note="Rules are checked before rate limits and sign-in. Turning a rule off keeps it for later.">
        {q.isLoading ? <Loading tiles={0} blocks={1} /> : q.isError ? <ErrorState message={(q.error as Error).message} onRetry={() => q.refetch()} /> :
          <DataTable cols={cols} rows={list} rowKey={(r) => r.id} empty="No blocking rules. Every caller with valid credentials gets through." label="Blocking rules" />}
      </Section>
      <Section title="Add a rule">
        <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 640 }}>
          <label className="gw-field">Block by<select className="gw-select" value={type} onChange={(e) => { setType(e.target.value); setInvert(false); }} aria-label="Block by">{TYPES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
          <label className="gw-field" style={{ display: "flex" }}>{type === "IPRANGE" ? "Range or first address" : t.label}<input className="gw-input" value={value} onChange={(e) => setValue(e.target.value)} placeholder={t.placeholder} aria-label="Value to block" />
            <span style={{ fontWeight: 400, letterSpacing: 0, fontSize: 12 }}>{t.hint}</span></label>
          {type === "IPRANGE" && !value.includes("/") && <label className="gw-field" style={{ display: "flex" }}>Last address<input className="gw-input" value={endIp} onChange={(e) => setEndIp(e.target.value)} placeholder="10.20.255.255" aria-label="Last address" /></label>}
          {(type === "IP" || type === "IPRANGE") && <label className="gw-check"><input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} /><span>Invert: block every address <strong>except</strong> this</span></label>}
          <label className="gw-check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /><span>Enforce now</span></label>
          <div><button type="button" className="gw-btn gw-btn-pri" disabled={!value.trim()} onClick={() => { add.reset(); setAsk({ kind: "add" }); }}>Review rule</button></div>
        </div>
      </Section>
      <ConfirmChange open={!!ask} plan={confirmPlan || null} title={ask?.kind === "add" ? "Confirm blocking rule" : ask?.kind === "remove" ? "Confirm removal" : "Confirm change"}
        busy={add.isPending || toggle.isPending || remove.isPending} error={add.error || toggle.error || remove.error}
        confirmLabel={ask?.kind === "add" ? (enabled ? "Block now" : "Save switched off") : ask?.kind === "remove" ? "Remove rule" : "Apply"}
        deploysRevision={false}
        danger={ask?.kind === "add" || (ask?.kind === "toggle" && !ask.rule.enabled)}
        onConfirm={() => { if (!ask) return; if (ask.kind === "add") add.mutate(); else if (ask.kind === "toggle") toggle.mutate(ask.rule); else remove.mutate(ask.rule); }}
        onClose={() => { setAsk(null); add.reset(); toggle.reset(); remove.reset(); }} />
    </>
  );
}

// On/off switch on the card of a running API (a migrated service or a live flow), so it can be
// stopped or started without opening it. State is read live from the server; only admins can switch.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorText, studioApi, type PowerAudit, type PowerView, type ServicePower, type FlowPower } from "../api.ts";
import { confirmDialog, cx, toast } from "../ui.tsx";

export const POWER_KEY = ["studio", "power"] as const;
const changing = (v?: PowerView) => !!v && v.services.some((s) => s.state === "starting" || s.state === "stopping");

/** Live on/off state of every running API; polled every 3 s while one is changing, else every 15 s. */
export function usePower() {
  return useQuery({ queryKey: POWER_KEY, queryFn: studioApi.power, retry: 0, refetchInterval: (q) => (changing(q.state.data) ? 3000 : 15000) });
}

/** "11:00" today, "17 Nov 11:00" on another day. */
export function clock(iso?: string, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${hm}`;
}

/** The line under the switch: who stopped or started it, and when. */
export function lastLine(p: { state: string; last?: PowerAudit; stoppedBy?: string; stoppedAt?: string; stoppedOutside?: boolean }, now = new Date()): string {
  const off = p.state === "off" || p.state === "stopping";
  if (off) {
    if (p.last?.action === "stop") return `Stopped by ${p.last.by} at ${clock(p.last.at, now)}`;
    if (p.stoppedBy) return `Stopped by ${p.stoppedBy}${p.stoppedAt ? ` at ${clock(p.stoppedAt, now)}` : ""}`;
    if (p.stoppedOutside) return "Stopped outside the Factory";
    return "";
  }
  return p.last?.action === "start" ? `Started by ${p.last.by} at ${clock(p.last.at, now)}` : "";
}

type Props =
  | { kind: "service"; target: string; label: string; view: ServicePower; canToggle: boolean }
  | { kind: "flow"; target: string; label: string; view: FlowPower; canToggle: boolean };

export function PowerSwitch({ kind, target, label, view, canToggle }: Props) {
  const qc = useQueryClient();
  const [asked, setAsked] = useState<"start" | "stop" | null>(null);
  const m = useMutation({
    mutationFn: (on: boolean): Promise<ServicePower | FlowPower> => (kind === "service" ? studioApi.powerService(target, on) : studioApi.powerFlow(target, on)),
    onSuccess: (_r, on) => {
      toast(on ? `${label} is starting.` : `${label} is stopped.`, on ? "ok" : "info");
      void qc.invalidateQueries({ queryKey: POWER_KEY });
      void qc.invalidateQueries({ queryKey: ["studio", kind === "service" ? "estate" : "flows"] });
    },
    onError: (e) => toast(errorText(e), "bad"),
    onSettled: () => setAsked(null),
  });
  const state = view.state;
  const on = state === "on" || state === "starting";
  const isProtected = kind === "service" && (view as ServicePower).protected;
  const busy = m.isPending ? (asked === "stop" ? "Stopping…" : "Starting…") : state === "starting" ? "Starting…" : state === "stopping" ? "Stopping…" : "";
  const counts = kind === "service" ? `${(view as ServicePower).ready}/${(view as ServicePower).wanted} running` : view.state === "on" ? "live" : "offline";
  const why = !canToggle ? "Only an admin can switch an API on or off" : isProtected ? "Shared infrastructure cannot be switched off here" : "";
  const flip = async () => {
    if (on) {
      if (!(await confirmDialog({ title: `Stop ${label}?`, body: "Callers will get errors until it is started again.", confirmLabel: "Stop", danger: true }))) return;
      setAsked("stop"); m.mutate(false);
    } else { setAsked("start"); m.mutate(true); }
  };
  const line = lastLine(view as Parameters<typeof lastLine>[0]);
  return (
    <div className="ws-power" data-power={target} data-power-kind={kind} data-power-state={m.isPending ? (asked === "stop" ? "stopping" : "starting") : state}>
      <button type="button" role="switch" aria-checked={on} aria-label={`${label}: ${on ? "on" : "off"}`} title={why || (on ? `Stop ${label}` : `Start ${label}`)}
        className={cx("ws-switch", on && "ws-switch-on")} disabled={!!why || m.isPending} onClick={() => void flip()} data-action="power">
        <span className="ws-switch-knob" aria-hidden />
      </button>
      <span className="ws-power-text">
        <strong>{on ? "On" : "Off"}</strong>
        <span className="mf-faint" data-power-counts>{counts}</span>
        {busy && <span className="ws-power-busy" data-power-busy role="status">{busy}</span>}
        {!canToggle && <span className="mf-faint">read-only</span>}
      </span>
      {line && <span className="ws-power-last mf-faint" data-power-last>{line}</span>}
    </div>
  );
}

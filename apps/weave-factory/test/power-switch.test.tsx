// The on/off switch on a running API's card (server calls are stand-ins).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PowerSwitch, clock, lastLine } from "../src/studio/pages/PowerSwitch.tsx";
import { StudioHost } from "../src/studio/ui.tsx";
import type { ServicePower } from "../src/studio/api.ts";

const svc = (over: Partial<ServicePower> = {}): ServicePower => ({ name: "cms-proc-api", state: "on", ready: 2, wanted: 2, current: 2, startsWith: 2, protected: false, ...over });

function mount(view: ServicePower, canToggle = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><StudioHost /><PowerSwitch kind="service" target={view.name} label={view.name} view={view} canToggle={canToggle} /></QueryClientProvider>);
}
function stubFetch(answer: () => Promise<Response>) {
  const f = vi.fn((_url: string, _init?: RequestInit) => answer());
  vi.stubGlobal("fetch", f);
  return f;
}
const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
// The first date formatting loads locale data, which can take seconds on a busy server.
vi.setConfig({ testTimeout: 20_000 });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("power switch on a card", () => {
  it("shows On with running / wanted copies", () => {
    mount(svc());
    const sw = screen.getByRole("switch", { name: "cms-proc-api: on" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("On")).toBeInTheDocument();
    expect(screen.getByText("2/2 running")).toBeInTheDocument();
  });

  it("asks before stopping and only stops after the confirmation", async () => {
    const f = stubFetch(() => ok(svc({ state: "off", wanted: 0, ready: 0 })));
    mount(svc());
    fireEvent.click(screen.getByRole("switch"));
    expect(await screen.findByText("Stop cms-proc-api?")).toBeInTheDocument();
    expect(screen.getByText("Callers will get errors until it is started again.")).toBeInTheDocument();
    expect(f).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(f).toHaveBeenCalled());
    const [url, init] = f.mock.calls[0];
    expect(url).toMatch(/\/api\/factory\/power\/services\/cms-proc-api$/);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ on: false });
  });

  it("does nothing when the confirmation is cancelled", async () => {
    const f = stubFetch(() => ok({}));
    mount(svc());
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await act(async () => { await Promise.resolve(); });
    expect(f).not.toHaveBeenCalled();
  });

  it("starts without asking and shows Starting… while it changes", async () => {
    let release!: () => void;
    const f = stubFetch(() => new Promise<Response>((r) => { release = () => r(new Response(JSON.stringify(svc({ state: "starting", wanted: 1, ready: 0 })), { status: 200 })); }));
    mount(svc({ state: "off", wanted: 0, ready: 0, current: 0, startsWith: 1, stoppedOutside: true }));
    expect(screen.getByText("Off")).toBeInTheDocument();
    expect(screen.getByText("Stopped outside the Factory")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch"));
    expect(await screen.findByText("Starting…")).toBeInTheDocument();
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ on: true });
    await act(async () => { release(); });
  });

  it("shows Starting… / Stopping… for a change in progress read from the cluster", () => {
    mount(svc({ state: "starting", ready: 0, wanted: 1 }));
    expect(screen.getByText("Starting…")).toBeInTheDocument();
    expect(screen.getByText("0/1 running")).toBeInTheDocument();
    cleanup();
    mount(svc({ state: "stopping", ready: 1, wanted: 0 }));
    expect(screen.getByText("Stopping…")).toBeInTheDocument();
  });

  it("is read-only for a user who is not an admin, and for shared infrastructure", () => {
    mount(svc(), false);
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.getByText("read-only")).toBeInTheDocument();
    cleanup();
    mount(svc({ name: "intg-redis", protected: true }));
    expect(screen.getByRole("switch")).toBeDisabled();
  });

  it("says who stopped it and when", () => {
    const at = new Date(); at.setHours(11, 0, 0, 0);
    mount(svc({ state: "off", wanted: 0, ready: 0, last: { at: at.toISOString(), by: "owner", kind: "service", target: "cms-proc-api", action: "stop", from: "2 copies", to: "0 copies", ok: true } }));
    expect(screen.getByText(`Stopped by owner at ${clock(at.toISOString())}`)).toBeInTheDocument();
  });
});

describe("wording", () => {
  it("prefers the audit record, then the annotation", () => {
    const now = new Date("2026-11-18T12:00:00");
    expect(lastLine({ state: "off", stoppedBy: "x", stoppedAt: "2026-11-18T11:00:00" }, now)).toBe(`Stopped by x at ${clock("2026-11-18T11:00:00", now)}`);
    expect(lastLine({ state: "on", last: { at: "2026-11-18T11:00:00", by: "y", kind: "service", target: "a", action: "start", from: "", to: "", ok: true } }, now)).toMatch(/^Started by y at /);
    expect(lastLine({ state: "on" }, now)).toBe("");
    expect(clock("2026-11-17T11:00:00", now)).toMatch(/17/);
  });
});

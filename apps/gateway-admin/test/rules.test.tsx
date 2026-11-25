import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ConfirmChange, policyLabel, rateWords, splitList } from "../src/components/rules";
import { ApiRules } from "../src/screens/ApiRules";
import { Blocking } from "../src/screens/Blocking";
import type { ApiRules as TApiRules, ChangePlan } from "../src/api";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const ID = "11111111-2222-3333-4444-555555555555";
const rules: TApiRules = {
  stage: "production", stageWord: "Production", via: "user",
  api: { id: ID, name: "cs-gw-test-orders", context: "/cs-gw-test-orders", version: "v1", lifeCycleStatus: "PUBLISHED", lastUpdatedTime: "1" },
  traffic: { tiers: ["Unlimited"], apiPolicy: null, operations: [{ verb: "GET", target: "/orders", policy: "Unlimited" }] },
  policies: { subscription: [{ name: "Unlimited", limit: 2147483647, timeUnit: "min", unitTime: 1 }, { name: "Gold", limit: 5000, timeUnit: "min", unitTime: 1, quotaType: "REQUESTCOUNTLIMIT" }],
    advanced: [{ name: "cs-gw-test-3", limit: 3, timeUnit: "min", unitTime: 1, quotaType: "REQUESTCOUNTLIMIT" }] },
  gatewayPolicies: { apiKeyHeader: "ApiKey", caching: { enabled: false, seconds: 300 }, maxTps: { production: null, sandbox: null }, endpoint: { timeoutMs: null, suspendMs: null },
    jsonThreat: null, xmlThreat: false, addHeaders: [], removeHeaders: [], httpsOnly: false, schemaValidation: false },
  lifecycle: { state: "PUBLISHED", version: "v1", isDefaultVersion: false },
  access: { security: "oauth2", securityWords: "OAuth2 token required", cors: { enabled: false, origins: [], headers: [], methods: [], credentials: false }, ipAllow: [], ipDeny: [], clientIpHeader: "" },
  deployments: [{ name: "Default", vhost: "localhost", revisionUuid: "r1", deployedTime: 1 }],
  environments: [{ name: "Default", displayName: "Default", vhost: "localhost" }],
};
const plan: ChangePlan = {
  api: rules.api, applied: false, noChange: false, environments: [{ name: "Default", vhost: "localhost" }],
  sentence: "This changes the live gateway for cs-gw-test-orders in Production (Default (localhost)). Gateways pick it up within about 15 seconds of saving.",
  changes: ["Limit for the whole API: no limit → cs-gw-test-3 (3 requests per minute, shared by every caller of this API)."], pruneRevision: { id: "r0", displayName: "Revision 1" },
};

function ok(body: unknown, status = 200) { return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })); }
function wrap(ui: React.ReactNode, path: string, route = "*") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}><Routes><Route path={route} element={ui} /></Routes></MemoryRouter></QueryClientProvider>);
}

describe("plain words on the client", () => {
  it("formats limits and lists", () => {
    expect(rateWords(100, "min")).toBe("100 requests per minute");
    expect(rateWords(2147483647, "min")).toBe("no limit");
    expect(policyLabel(rules.policies.subscription[1], "Gold", "plan")).toBe("Gold: 5,000 requests per minute per consumer");
    expect(policyLabel(undefined, "Unlimited", "api")).toBe("Unlimited: no limit");
    expect(splitList("a, b\n\nc ,")).toEqual(["a", "b", "c"]);
  });
});

describe("ConfirmChange", () => {
  it("says what changes on the live gateway and which revision makes room", () => {
    render(<ConfirmChange open plan={plan} busy={false} onConfirm={() => {}} onClose={() => {}} />);
    expect(screen.getByText(plan.sentence)).toBeInTheDocument();
    expect(within(screen.getByLabelText("What changes")).getByText(plan.changes[0])).toBeInTheDocument();
    expect(screen.getByText(/Revision 1\) is removed first/)).toBeInTheDocument();
  });
  it("keeps the button disabled until the name is typed", () => {
    const onConfirm = vi.fn();
    render(<ConfirmChange open plan={plan} busy={false} onConfirm={onConfirm} onClose={() => {}} typeToConfirm="cs-gw-test-orders" />);
    const btn = screen.getByRole("button", { name: "Apply to the live gateway" });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Type to confirm"), { target: { value: "cs-gw-test-orders" } });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

describe("API page: traffic limits", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/rules/apis/${ID}`) return ok(rules);
      if (url === `/api/rules/apis/${ID}/traffic?preview=1`) return ok(plan);
      if (url === `/api/rules/apis/${ID}/traffic`) return ok({ ...plan, applied: true, revision: { id: "r9", displayName: "Revision 9" } });
      return ok({ error: `unexpected ${url} ${init?.method}` }, 404);
    });
  });
  it("assigns a whole-API limit through preview, confirmation and apply", async () => {
    wrap(<ApiRules />, `/apis/${ID}`, "/apis/:id");
    await screen.findByRole("heading", { name: "cs-gw-test-orders" });
    expect(screen.getByText("Production")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/One limit for the whole API/));
    fireEvent.change(screen.getByLabelText("Limit for the whole API"), { target: { value: "cs-gw-test-3" } });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await screen.findByTestId("confirm-change");
    const call = (fetch as any).mock.calls.find((c: any[]) => String(c[0]).endsWith("traffic?preview=1"));
    expect(JSON.parse(call[1].body)).toEqual({ tiers: ["Unlimited"], apiPolicy: "cs-gw-test-3", operations: [{ verb: "GET", target: "/orders", policy: "Unlimited" }] });
    fireEvent.click(screen.getByRole("button", { name: "Apply to the live gateway" }));
    const done = await screen.findByTestId("change-done");
    expect(done).toHaveTextContent("Live now. Revision 9 is deployed to Default.");
  });
  it("preselects a policy sent from the Rate limiting screen", async () => {
    wrap(<ApiRules />, `/apis/${ID}?tab=traffic&suggest=Gold&kind=subscription`, "/apis/:id");
    await screen.findByText(/Assigning/);
    expect(screen.getByLabelText(/Gold: 5,000 requests per minute per consumer/)).toBeChecked();
  });
});

describe("API page: access", () => {
  it("asks for the API name before allowing an open API on production", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => (String(input) === `/api/rules/apis/${ID}` ? ok(rules) : ok({}, 404)));
    wrap(<ApiRules />, `/apis/${ID}?tab=access`, "/apis/:id");
    await screen.findByRole("heading", { name: "cs-gw-test-orders" });
    fireEvent.click(screen.getByLabelText(/None \(open\)/));
    expect(screen.getByText(/This is a production gateway\./)).toBeInTheDocument();
    const review = screen.getByRole("button", { name: "Review change" });
    expect(review).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Type the API name to confirm"), { target: { value: "cs-gw-test-orders" } });
    expect(review).toBeEnabled();
  });
});

describe("Blocking rules", () => {
  it("previews a rule in plain words before creating it", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (String(input) === "/api/rules/blocking" && (init?.method ?? "GET") === "GET") return ok({ list: [] });
      return ok({ id: "x", words: "Address 198.51.100.7" }, 201);
    });
    wrap(<Blocking />, "/blocking");
    await screen.findByText(/No blocking rules/);
    fireEvent.change(screen.getByLabelText("Value to block"), { target: { value: "198.51.100.7" } });
    fireEvent.click(screen.getByRole("button", { name: "Review rule" }));
    expect(await screen.findByText("Block calls from 198.51.100.7.")).toBeInTheDocument();
    expect(calls.filter((c) => c.startsWith("POST"))).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Block now" }));
    await waitFor(() => expect(calls).toContain("POST /api/rules/blocking"));
    expect(await screen.findByText("Added: Address 198.51.100.7.")).toBeInTheDocument();
  });
});

describe("API page: policies", () => {
  it("lists every policy family with where it is handled and previews a JSON limit", async () => {
    const bodies: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/rules/apis/${ID}`) return ok(rules);
      if (url === `/api/rules/apis/${ID}/policies?preview=1`) { bodies.push(String(init?.body)); return ok({ ...plan, changes: ["JSON threat protection: off → on (depth ≤ 10, …)."] }); }
      return ok({}, 404);
    });
    wrap(<ApiRules />, `/apis/${ID}?tab=policies`, "/apis/:id");
    await screen.findByText("1. Authentication");
    expect(screen.getByText("11. AI / LLM gateway")).toBeInTheDocument();
    expect(screen.getAllByText("Configure here").length).toBeGreaterThan(10);
    expect(screen.getAllByText("Outside the gateway").length).toBeGreaterThan(2);
    fireEvent.click(screen.getByLabelText(/JSON threat protection: refuse/));
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await screen.findByTestId("confirm-change");
    expect(JSON.parse(bodies[0]).jsonThreat).toMatchObject({ maxJsonDepth: 10 });
    expect(screen.getByRole("button", { name: "Deprecate" })).toBeInTheDocument();
  });
});

// Writes docs/CRUISE-SAUDI-POLICIES.md from the console's policy catalog (single source of truth).
//   npx tsx scripts/policy-doc.ts ../../docs/CRUISE-SAUDI-POLICIES.md
import { writeFileSync } from "node:fs";
import { CATALOG, FAMILIES, STATE_WORDS } from "../src/lib/policyCatalog.ts";

const out = process.argv[2] ?? "CRUISE-SAUDI-POLICIES.md";
const cell = (s: string) => s.replace(/\|/g, "\\|");
const lines: string[] = [
  "# Cruise Saudi Weave: gateway policy coverage",
  "",
  "Generated from `apps/gateway-admin/src/lib/policyCatalog.ts` (the same list the console's API page shows under **Policies**).",
  "Gateway: WSO2 API Manager 4.5. Every policy is in one of these states:",
  "",
  "- **Configure here**: applied by the Weave Gateway console through the API Manager REST APIs (update the API, new revision, deploy) and tested on a throw-away API (`cs-gw-test-*`).",
  "- **In API Manager portals**: API Manager 4.5 supports it, but this console does not offer it yet; do it in the Publisher or Admin portal.",
  "- **Handled in the service**: belongs in the migrated service or Studio flow (Weave Factory).",
  "- **Outside the gateway**: load balancer / WAF, broker, network, or an API Manager server-file change (shown on Gateway settings).",
  "- **Not supported by this API Manager**: not available in this installation.",
  "",
  "## What the tests on the real gateway proved",
  "",
  "| Policy | Proof on the live gateway (throw-away API) |",
  "|---|---|",
  "| Per-API IP deny / allow list | Calls from the VM got `403 Calls from your address are not allowed for this API` within ~15 s; removing the rule let them in again. |",
  "| Whole-API limit (3 per minute) | `429 Message throttled out` after the limit (API Manager counts asynchronously, so a few extra calls pass first). |",
  "| Block a subscription | `900907 The requested API is temporarily blocked`; unblock restored access. |",
  "| JSON threat protection | A 7-level JSON body was refused with `400 Threat Protection-JSON`; a flat body passed. |",
  "| Basic authentication | After switching, bearer tokens were refused (`900902 Missing Credentials`). |",
  "| Roll back | Rolling back to the revision without the limit removed the 429s. |",
  "| Revision limit | With 5 revisions the oldest undeployed one was removed before the new one was created. |",
  "| Regenerate secret | The old consumer secret was refused (`invalid_client`) right after. |",
  "| Caching, backend TPS, timeout/suspension, header add/remove, XML threat protection, schema validation, HTTPS only, API key header name | Accepted by API Manager, stored in the API definition and deployed in a new revision. Their runtime effect was not observable against the dead test backend. |",
  "",
  "Known API Manager 4.5 behaviour found in testing:",
  "",
  "- Key clean-up alone left the old consumer secret working, so the console's **Remove keys** first replaces the secret (the old one stops at once) and then removes the keys. Keys generated again on the same application afterwards produced tokens the gateway refused (`900901`): rotate with **Regenerate secret**, or create a new application.",
  "- A throttling policy referenced by any stored revision of an API cannot be deleted, even when the live definition no longer uses it. The console's clean-up reports API Manager's refusal instead of hiding it.",
  "- A deprecated API cannot be published again (only retired).",
  "- Throttling decisions are asynchronous: a few calls past a limit pass before 429 starts.",
  "- Policy names may not contain dashes, dots or spaces.",
  "",
];
FAMILIES.forEach((f, i) => {
  lines.push(`## ${i + 1}. ${f}`, "", "| Policy | State | Where | WSO2 term | MuleSoft | Apigee | Azure APIM | Kong |", "|---|---|---|---|---|---|---|---|");
  for (const c of CATALOG.filter((x) => x.family === i + 1)) {
    const where = c.where === "policies" ? "API page → Policies" : ["traffic", "access", "consumers", "history", "live"].includes(c.where) ? `API page → ${({ traffic: "Traffic limits", access: "Access", consumers: "Consumers", history: "Change history", live: "Live status" } as Record<string, string>)[c.where]}` : c.where;
    lines.push(`| ${cell(c.name)} | ${STATE_WORDS[c.state]} | ${cell(where)} | ${cell(c.wso2)} | ${cell(c.mule)} | ${cell(c.apigee)} | ${cell(c.azure)} | ${cell(c.kong)} |`);
  }
  lines.push("");
});
const counts = Object.entries(STATE_WORDS).map(([k, w]) => `${w}: ${CATALOG.filter((c) => c.state === k).length}`).join(" · ");
lines.push("## Totals", "", counts, "");
writeFileSync(out, lines.join("\n"));
console.log(`wrote ${out}: ${CATALOG.length} policies`);

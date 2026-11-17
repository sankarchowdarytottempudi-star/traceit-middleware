// Small shared helpers for connections: Zoho data centres and pasted secrets. No network, no secrets kept.

/** Zoho data centres: the accounts (token) host and the API host must be from the same centre;
 *  a token from one centre is refused (401) by another centre's API. */
const ZOHO_DC: { accounts: string; api: string; label: string }[] = [
  { accounts: "accounts.zoho.com.au", api: "www.zohoapis.com.au", label: "Australia" },
  { accounts: "accounts.zoho.com.cn", api: "www.zohoapis.com.cn", label: "China" },
  { accounts: "accounts.zoho.com", api: "www.zohoapis.com", label: "United States" },
  { accounts: "accounts.zoho.sa", api: "www.zohoapis.sa", label: "Saudi Arabia" },
  { accounts: "accounts.zoho.in", api: "www.zohoapis.in", label: "India" },
  { accounts: "accounts.zoho.eu", api: "www.zohoapis.eu", label: "Europe" },
  { accounts: "accounts.zoho.jp", api: "www.zohoapis.jp", label: "Japan" },
  { accounts: "accounts.zohocloud.ca", api: "www.zohoapis.ca", label: "Canada" },
];
const hostOf = (url: string | undefined) => /^https?:\/\/([^/:?#]+)/i.exec(String(url ?? "").trim())?.[1]?.toLowerCase() ?? "";
/** The Zoho data centre of an accounts or API address, or null when it is not a Zoho address. */
export function zohoCentre(url: string | undefined): { accounts: string; api: string; label: string } | null {
  const h = hostOf(url);
  if (!h) return null;
  return ZOHO_DC.find((d) => h === d.accounts || h === d.api || h === d.api.replace(/^www\./, "")) ?? null;
}
/** The API base URL that goes with a Zoho accounts (token) address: accounts.zoho.sa -> https://www.zohoapis.sa */
export function zohoApiFor(accountsUrl: string | undefined): string | null { const d = zohoCentre(accountsUrl); return d ? `https://${d.api}` : null; }
/** The token address for a Zoho centre: https://accounts.zoho.sa/oauth/v2/token */
export function zohoTokenUrlFor(url: string | undefined): string | null { const d = zohoCentre(url); return d ? `https://${d.accounts}/oauth/v2/token` : null; }
/** A plain-words problem when the token address and the API address are from different Zoho centres. */
export function zohoMismatch(tokenUrl: string | undefined, baseUrl: string | undefined): string | null {
  const a = zohoCentre(tokenUrl), b = zohoCentre(baseUrl);
  if (!a || !b || a === b) return null;
  return `The token address is in the Zoho ${a.label} data centre but the base URL is in ${b.label}. A token from one centre is refused (401) by the other: use https://${a.api} with ${a.accounts}.`;
}
/** True when a pasted secret still carries its label ("Client Secret: 1000.abc…", "Refresh Token = …").
 *  Only says that it looks wrong; the value itself is never shown. */
export function secretLooksLabelled(value: string | undefined): boolean {
  return /^\s*(?:client[\s_-]*(?:id|secret)|refresh[\s_-]*token|access[\s_-]*token|token|secret|password|api[\s_-]*key|code)\s*[:=]/i.test(String(value ?? ""));
}

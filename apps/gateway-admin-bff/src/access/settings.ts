// Sign-in settings, read from the environment. Same names in the Gateway and the Factory.
//   AUTH_PROVIDER        wso2 | oidc | local, or a comma list ("oidc,local"). Default: wso2 (TraceIT).
//   OIDC_ISSUER          e.g. https://login.microsoftonline.com/<tenant id>/v2.0
//   OIDC_CLIENT_ID, OIDC_CLIENT_SECRET (or OIDC_CLIENT_SECRET_FILE)
//   OIDC_REDIRECT_URI    default: <PUBLIC_BASE_URL>/api/auth/callback
//   OIDC_SCOPES          default: "openid profile email"
//   OIDC_GROUPS_CLAIM    default: "groups"
//   OIDC_LABEL           sign-in button text, default "Sign in with Microsoft"
//   WEAVE_USERS_FILE     shared users file (required for oidc and local)
//   WEAVE_AUDIT_FILE     audit log; default audit.jsonl next to the users file
//   WSO2_DEFAULT_ROLES   roles of an API Manager sign-in that has no user record; default all three
//                        (today's behaviour). Set to "" so only listed API Manager users get in.
//   AUTH_SESSION_HOURS   session length for oidc and local sign-ins, default 12
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanRoles, ROLES, type Role } from "./roles.js";
import type { OidcSettings } from "./oidc.js";

export type ProviderId = "wso2" | "oidc" | "local";

export interface AuthSettings {
  providers: ProviderId[];
  oidc: OidcSettings | null;
  usersFile: string;
  auditFile: string;
  wso2DefaultRoles: Role[];
  sessionSeconds: number;
}

export function readAuthSettings(env: NodeJS.ProcessEnv, publicBaseUrl: string): AuthSettings {
  const list = (env.AUTH_PROVIDER ?? "wso2").split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = list.filter((p) => !["wso2", "oidc", "local"].includes(p));
  if (bad.length) throw new Error(`AUTH_PROVIDER: unknown provider ${bad.join(", ")} (use wso2, oidc, local)`);
  const providers = [...new Set(list.length ? list : ["wso2"])] as ProviderId[];
  const usersFile = (env.WEAVE_USERS_FILE ?? "").trim();
  if (!usersFile && providers.some((p) => p !== "wso2")) throw new Error("WEAVE_USERS_FILE is required when AUTH_PROVIDER includes oidc or local");
  const auditFile = (env.WEAVE_AUDIT_FILE ?? "").trim() || (usersFile ? join(dirname(usersFile), "audit.jsonl") : "");

  let oidc: OidcSettings | null = null;
  if (providers.includes("oidc")) {
    let secret = env.OIDC_CLIENT_SECRET ?? "";
    if (!secret && env.OIDC_CLIENT_SECRET_FILE) secret = readFileSync(env.OIDC_CLIENT_SECRET_FILE, "utf8").trim();
    const missing = [["OIDC_ISSUER", env.OIDC_ISSUER], ["OIDC_CLIENT_ID", env.OIDC_CLIENT_ID], ["OIDC_CLIENT_SECRET", secret]].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) throw new Error(`AUTH_PROVIDER includes oidc but ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not set`);
    const issuer = String(env.OIDC_ISSUER).trim().replace(/\/+$/, "");
    if (!/^https:\/\//.test(issuer) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(issuer)) throw new Error("OIDC_ISSUER must be an https address");
    oidc = {
      issuer, clientId: String(env.OIDC_CLIENT_ID).trim(), clientSecret: secret,
      redirectUri: (env.OIDC_REDIRECT_URI ?? "").trim() || `${publicBaseUrl.replace(/\/+$/, "")}/api/auth/callback`,
      scopes: (env.OIDC_SCOPES ?? "").trim() || "openid profile email",
      groupsClaim: (env.OIDC_GROUPS_CLAIM ?? "").trim() || "groups",
      label: (env.OIDC_LABEL ?? "").trim() || "Sign in with Microsoft",
    };
    if (!oidc.scopes.split(/\s+/).includes("openid")) oidc.scopes = `openid ${oidc.scopes}`;
  }
  const hours = Number(env.AUTH_SESSION_HOURS ?? "12");
  return {
    providers, oidc, usersFile, auditFile,
    wso2DefaultRoles: env.WSO2_DEFAULT_ROLES === undefined ? [...ROLES] : cleanRoles(env.WSO2_DEFAULT_ROLES),
    sessionSeconds: Math.round((Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 7) : 12) * 3600),
  };
}

/** Name on the sign-in page: WEAVE_PRODUCT_NAME, else from the edition (WEAVE_EDITION / VITE_WEAVE_EDITION). */
export function productName(env: NodeJS.ProcessEnv): string {
  if (env.WEAVE_PRODUCT_NAME) return env.WEAVE_PRODUCT_NAME;
  const edition = (env.WEAVE_EDITION || env.VITE_WEAVE_EDITION || "").trim().toLowerCase();
  return edition === "cruise-saudi" ? "Cruise Saudi Weave" : "TraceIT Weave";
}

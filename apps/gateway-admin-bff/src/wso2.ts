import https from "node:https";
import crypto from "node:crypto";
import { URL } from "node:url";

export interface Wso2Opts { baseUrl: string; caPem: string; }

function request(opts: Wso2Opts, method: string, path: string, headers: Record<string, string>, body?: string):
  Promise<{ status: number; text: string }> {
  const u = new URL(path.startsWith("http") ? path : opts.baseUrl + path);
  const agentOpts: https.AgentOptions = opts.caPem ? { ca: opts.caPem } : {};
  // Never disable verification. If no CA is provided we still verify against the system store.
  const agent = new https.Agent(agentOpts);
  return new Promise((resolve, reject) => {
    const req = https.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers, agent },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export async function dcrRegister(opts: Wso2Opts, user: string, pass: string, callbackUrl: string):
  Promise<{ clientId: string; clientSecret: string }> {
  const basic = Buffer.from(`${user}:${pass}`).toString("base64");
  const r = await request(opts, "POST", "/client-registration/v0.17/register",
    { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
    JSON.stringify({ clientName: "weave-gateway-admin", owner: user,
      grantType: "authorization_code refresh_token password", saasApp: true,
      callbackUrl }));
  if (r.status >= 400) throw new Error(`DCR failed: ${r.status} ${r.text.slice(0, 200)}`);
  const j = JSON.parse(r.text);
  return { clientId: j.clientId, clientSecret: j.clientSecret };
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizeUrl(publicBaseUrl: string, clientId: string, redirectUri: string,
  challenge: string, state: string, scope: string): string {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId,
    redirect_uri: redirectUri, scope, state, code_challenge: challenge, code_challenge_method: "S256" });
  return `${publicBaseUrl}/oauth2/authorize?${q.toString()}`;
}

export interface TokenSet { access_token: string; refresh_token?: string; expires_in: number; scope?: string; }

async function token(opts: Wso2Opts, clientId: string, clientSecret: string, form: Record<string, string>):
  Promise<TokenSet> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const r = await request(opts, "POST", "/oauth2/token",
    { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    new URLSearchParams(form).toString());
  if (r.status >= 400) throw new Error(`token failed: ${r.status} ${r.text.slice(0, 200)}`);
  return JSON.parse(r.text) as TokenSet;
}

export const exchangeCode = (o: Wso2Opts, id: string, secret: string, code: string, redirectUri: string, verifier: string) =>
  token(o, id, secret, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });

export const refreshToken = (o: Wso2Opts, id: string, secret: string, refresh_token: string) =>
  token(o, id, secret, { grant_type: "refresh_token", refresh_token });

/** Resource-owner password grant. Used only by the loopback dev mode (service credentials). */
export const passwordGrant = (o: Wso2Opts, id: string, secret: string, username: string, password: string, scope: string) =>
  token(o, id, secret, { grant_type: "password", username, password, scope });

export async function api(opts: Wso2Opts, accessToken: string, method: string, path: string, body?: unknown):
  Promise<{ status: number; json: any }> {
  const r = await request(opts, method, path,
    { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
    body === undefined ? undefined : JSON.stringify(body));
  let json: any = null;
  try { json = r.text ? JSON.parse(r.text) : null; } catch { json = { raw: r.text }; }
  return { status: r.status, json };
}

// OpenID Connect sign-in (authorization code + PKCE + nonce), written for Microsoft Entra ID
// (issuer https://login.microsoftonline.com/<tenant>/v2.0) but standard for any OIDC provider.
import crypto, { type KeyObject } from "node:crypto";
import { checkClaims, keyFromJwk, verifySignature, TokenError, type Claims, type Jwk } from "./jwt.js";
import { createIdpFetch, type IdpFetch } from "./idpHttp.js";

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Full callback address registered at the provider, e.g. https://weave.aroya.com/api/auth/callback */
  redirectUri: string;
  scopes: string;
  /** Claim holding the person's groups (Entra: "groups"; "roles" for app roles). */
  groupsClaim: string;
  label: string;
}

interface Metadata { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; end_session_endpoint?: string; id_token_signing_alg_values_supported?: string[] }

export interface OidcIdentity {
  subject: string;
  email: string;
  name: string;
  groups: string[];
  /** Entra leaves the groups out when a person is in too many (it sends a link to Graph instead). */
  groupsOverage: boolean;
  claims: Claims;
}

const META_TTL = 3600_000;
const JWKS_MIN_REFRESH = 60_000;

export class OidcClient {
  private meta: { at: number; m: Metadata } | null = null;
  private keys = new Map<string, { key: KeyObject; jwk: Jwk }>();
  private keysAt = 0;
  constructor(readonly s: OidcSettings, private fetchFn: IdpFetch = createIdpFetch()) {}

  private async getJson(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<any> {
    const r = await this.fetchFn(url, { ...init, timeoutMs: 10_000, headers: { Accept: "application/json", ...(init?.headers ?? {}) } });
    const text = await r.text();
    let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) {
      const why = j && typeof j.error === "string" ? j.error : `HTTP ${r.status}`;
      throw Object.assign(new Error(`identity provider answered ${why}`), { providerError: why });
    }
    return j;
  }

  /** Discovery document, kept an hour. If the provider cannot be reached when it is due again, the
   *  copy in hand keeps being used (a short outage then only matters for the token exchange). */
  async metadata(): Promise<Metadata> {
    if (this.meta && Date.now() - this.meta.at < META_TTL) return this.meta.m;
    let m: Metadata;
    try { m = await this.getJson(`${this.s.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`) as Metadata; }
    catch (e) { if (this.meta) { this.meta.at = Date.now() - META_TTL + 60_000; return this.meta.m; } throw e; }
    if (!m?.authorization_endpoint || !m.token_endpoint || !m.jwks_uri) throw new Error("identity provider metadata is incomplete");
    if (m.issuer.replace(/\/+$/, "") !== this.s.issuer.replace(/\/+$/, "")) throw new Error("identity provider metadata names another issuer");
    this.meta = { at: Date.now(), m };
    return m;
  }

  private async loadKeys(force: boolean): Promise<void> {
    if (!force && this.keys.size) return;
    if (force && Date.now() - this.keysAt < JWKS_MIN_REFRESH) return;
    const m = await this.metadata();
    let j: { keys?: Jwk[] };
    // Keys in hand stay in use when the provider cannot be reached for a fresh list.
    try { j = await this.getJson(m.jwks_uri) as { keys?: Jwk[] }; } catch (e) { if (this.keys.size) { this.keysAt = Date.now(); return; } throw e; }
    const next = new Map<string, { key: KeyObject; jwk: Jwk }>();
    for (const jwk of j?.keys ?? []) {
      if (jwk.use && jwk.use !== "sig") continue;
      try { next.set(jwk.kid ?? `#${next.size}`, { key: keyFromJwk(jwk), jwk }); } catch { /* unusable key */ }
    }
    this.keys = next; this.keysAt = Date.now();
  }

  async authorizeUrl(p: { state: string; nonce: string; challenge: string; loginHint?: string }): Promise<string> {
    const m = await this.metadata();
    const q = new URLSearchParams({
      response_type: "code", client_id: this.s.clientId, redirect_uri: this.s.redirectUri, scope: this.s.scopes,
      state: p.state, nonce: p.nonce, code_challenge: p.challenge, code_challenge_method: "S256", response_mode: "query",
    });
    if (p.loginHint) q.set("login_hint", p.loginHint);
    return `${m.authorization_endpoint}${m.authorization_endpoint.includes("?") ? "&" : "?"}${q.toString()}`;
  }

  async exchange(code: string, verifier: string): Promise<{ id_token: string; access_token?: string; expires_in?: number }> {
    const m = await this.metadata();
    const t = await this.getJson(m.token_endpoint, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: this.s.redirectUri, client_id: this.s.clientId, client_secret: this.s.clientSecret, code_verifier: verifier }).toString(),
    });
    if (!t || typeof t.id_token !== "string") throw new Error("identity provider sent no ID token");
    return t;
  }

  /** Full check of an ID token: signature (JWKS), issuer, audience, expiry, nonce. */
  async validateIdToken(idToken: string, nonce: string): Promise<OidcIdentity> {
    await this.loadKeys(false);
    let d;
    try { d = verifySignature(idToken, (h) => this.pick(h.kid)); }
    catch (e) {
      // The provider may have rolled its keys: look once more, then decide.
      if (!(e instanceof TokenError) || e.reason !== "signing key not found") throw e;
      await this.loadKeys(true);
      d = verifySignature(idToken, (h) => this.pick(h.kid));
    }
    checkClaims(d.claims, { issuer: (await this.metadata()).issuer, audience: this.s.clientId, nonce });
    return identityOf(d.claims, this.s.groupsClaim);
  }

  private pick(kid: string | undefined) {
    if (kid) return this.keys.get(kid) ?? null;
    return this.keys.size === 1 ? [...this.keys.values()][0] : null;
  }
}

export function identityOf(c: Claims, groupsClaim: string): OidcIdentity {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const subject = str(c.oid) || str(c.sub);
  const email = (str(c.email) || str(c.preferred_username) || str(c.upn)).toLowerCase();
  if (!subject) throw new TokenError("no subject");
  if (!email) throw new TokenError("no e-mail or user name in the token (add the 'email' optional claim)");
  const raw = c[groupsClaim];
  const groups = Array.isArray(raw) ? raw.filter((g): g is string => typeof g === "string") : typeof raw === "string" ? [raw] : [];
  const names = c._claim_names as Record<string, unknown> | undefined;
  return { subject, email, name: str(c.name) || email, groups, groupsOverage: !!names && typeof names === "object" && groupsClaim in names, claims: c };
}

export function randomToken(bytes = 24): string { return crypto.randomBytes(bytes).toString("base64url"); }

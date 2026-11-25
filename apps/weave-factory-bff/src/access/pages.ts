// The sign-in chooser and the "no access" page, rendered by the server so the same page serves
// the Gateway and the Factory. No scripts; every value is escaped; messages come from a fixed list.
import type { ProviderId } from "./settings.js";

export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

export const SIGNIN_MESSAGES: Record<string, string> = {
  bad: "That e-mail and password do not match an active account.",
  locked: "Too many attempts. Wait a few minutes and try again.",
  expired: "The sign-in took too long or was started in another window. Please try again.",
  cancelled: "Sign-in was cancelled or refused by your identity provider.",
  provider: "Your identity provider could not complete the sign-in. Please try again.",
  unreachable: "The server cannot reach Microsoft sign-in right now. If you have a Weave account, sign in with it below; otherwise try again later.",
  token: "The answer from your identity provider could not be verified. Please try again, and tell your administrator if it keeps happening.",
  disabled: "This account is switched off. Ask an administrator.",
  noaccess: "You signed in, but you have not been given access to Weave yet. Ask an administrator.",
  signedout: "You are signed out.",
};

const STYLE = `
:root{--bg:#f4f6f9;--surface:#fff;--border:#dfe4ea;--text:#0c1b2a;--muted:#4c5b6b;--faint:#7a8796;--accent:#0c6b58;--onAccent:#fff;--bad:#b42318;--badSoft:#fdecea}
@media (prefers-color-scheme: dark){:root{--bg:#0b1520;--surface:#122130;--border:#22374b;--text:#e7eef5;--muted:#a9b8c7;--faint:#7f91a3;--accent:#3cc7a4;--onAccent:#06231c;--bad:#ff8a80;--badSoft:#3a1714}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{width:100%;max-width:400px;background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:32px 28px;display:flex;flex-direction:column;gap:16px;box-shadow:0 10px 30px rgba(0,0,0,.08)}
h1{margin:0;font-size:22px;font-weight:800}p{margin:0;color:var(--muted)}.sub{font-size:13px;color:var(--faint)}
a.btn,button{display:flex;align-items:center;justify-content:center;gap:10px;height:44px;border-radius:10px;font-weight:600;font-size:15px;text-decoration:none;cursor:pointer;border:1px solid var(--border);background:var(--surface);color:var(--text);width:100%}
a.btn.pri,button.pri{background:var(--accent);color:var(--onAccent);border-color:transparent}
a.btn:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
label{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:600}
input{height:42px;border-radius:9px;border:1px solid var(--border);background:transparent;color:var(--text);padding:0 12px;font-size:15px}
.or{display:flex;align-items:center;gap:10px;color:var(--faint);font-size:12px}.or:before,.or:after{content:"";flex:1;height:1px;background:var(--border)}
.msg{padding:10px 12px;border-radius:10px;background:var(--badSoft);color:var(--bad);font-size:14px}
form{display:flex;flex-direction:column;gap:12px}`;

const MS_ICON = `<svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export interface SignInPageOpts {
  product: string; area: string; base: string; providers: ProviderId[]; oidcLabel?: string; message?: string; email?: string;
}

export function signInPage(o: SignInPageOpts): string {
  const msg = o.message && SIGNIN_MESSAGES[o.message] ? `<div class="msg" role="alert">${esc(SIGNIN_MESSAGES[o.message])}</div>` : "";
  const parts: string[] = [];
  if (o.providers.includes("oidc")) parts.push(`<a class="btn pri" href="${esc(o.base)}/api/auth/login?provider=oidc">${MS_ICON}<span>${esc(o.oidcLabel || "Sign in with Microsoft")}</span></a>`);
  if (o.providers.includes("wso2")) parts.push(`<a class="btn${parts.length ? "" : " pri"}" href="${esc(o.base)}/api/auth/login?provider=wso2">Sign in with an API Manager account</a>`);
  if (o.providers.includes("local")) {
    if (parts.length) parts.push(`<div class="or">or with a Weave account</div>`);
    parts.push(`<form method="post" action="${esc(o.base)}/api/auth/local">
<label>E-mail<input name="email" type="email" autocomplete="username" required value="${esc(o.email ?? "")}"></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<button class="${parts.length ? "" : "pri"}" type="submit">Sign in</button></form>`);
  }
  return shell(`Sign in · ${o.product}`, `<h1>${esc(o.product)}</h1><p>Sign in to the ${esc(o.area)}.</p>${msg}${parts.join("\n")}<p class="sub">Access is granted per area by your administrator.</p>`);
}

export function noAccessPage(o: { product: string; base: string; who: string; message: string; status?: string }): string {
  return shell(`No access · ${o.product}`, `<h1>No access</h1>${o.who ? `<p>Signed in as <strong>${esc(o.who)}</strong>.</p>` : ""}
<div class="msg" role="alert">${esc(SIGNIN_MESSAGES[o.message] ?? SIGNIN_MESSAGES.noaccess)}</div>
<a class="btn" href="${esc(o.base)}/api/auth/login">Back to sign-in</a>`);
}

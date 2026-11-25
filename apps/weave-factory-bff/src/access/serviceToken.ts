// API Manager token from the server's own service account, for people who are not API Manager
// users (Microsoft and Weave accounts). Kept for at most `maxSeconds` (and never past its expiry),
// then asked for again: API Manager hands back the same token while it is valid and a new one once
// it has expired or been revoked, so a stale token never sticks for long. One request at a time.
export function cachedServiceToken(fetchToken: () => Promise<{ access_token: string; expires_in: number }>, maxSeconds = 60): () => Promise<string> {
  let tok: { token: string; expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;
  return async () => {
    if (tok && Date.now() < tok.expiresAt) return tok.token;
    if (!pending) {
      pending = fetchToken()
        .then((t) => { tok = { token: t.access_token, expiresAt: Date.now() + Math.max(5, Math.min(maxSeconds, t.expires_in - 30)) * 1000 }; return t.access_token; })
        .finally(() => { pending = null; });
    }
    return pending;
  };
}

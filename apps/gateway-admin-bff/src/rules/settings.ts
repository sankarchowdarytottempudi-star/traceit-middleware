// Gateway-wide settings, read-only: what TLS versions the gateway really accepts (probed with real
// handshakes), the certificates it presents and the backend certificates stored in API Manager.
// Settings that live in API Manager's server files are shown with the exact change to make.
import tls from "node:tls";

export interface TlsProbe { version: string; accepted: boolean; cipher?: string; }
export interface CertInfo { subject: string; issuer: string; validTo: string; daysLeft: number; }

function handshake(host: string, port: number, version: tls.SecureVersion): Promise<{ ok: boolean; cipher?: string; cert?: tls.PeerCertificate }> {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port, servername: host === "127.0.0.1" ? undefined : host, minVersion: version, maxVersion: version, rejectUnauthorized: false, timeout: 4000 }, () => {
      const out = { ok: true, cipher: s.getCipher()?.name, cert: s.getPeerCertificate() };
      s.end(); resolve(out);
    });
    s.on("error", () => resolve({ ok: false }));
    s.on("timeout", () => { s.destroy(); resolve({ ok: false }); });
  });
}
export function certInfo(c: tls.PeerCertificate | undefined, nowMs: number): CertInfo | null {
  if (!c || !c.valid_to) return null;
  const to = Date.parse(c.valid_to);
  const name = (x: any) => (x ? [x.CN, x.O].filter(Boolean).join(", ") : "");
  return { subject: name(c.subject), issuer: name(c.issuer), validTo: new Date(to).toISOString(), daysLeft: Math.floor((to - nowMs) / 86400000) };
}
export async function probeTls(host: string, port: number, nowMs = Date.now()) {
  const versions: tls.SecureVersion[] = ["TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"];
  const res: TlsProbe[] = []; let cert: CertInfo | null = null;
  for (const v of versions) {
    const r = await handshake(host, port, v);
    res.push({ version: v, accepted: r.ok, cipher: r.cipher });
    if (r.ok && !cert) cert = certInfo(r.cert, nowMs);
  }
  return { host: `${host}:${port}`, versions: res, certificate: cert };
}

export const SERVER_CHANGES = [
  { id: "tls", title: "Gateway TLS versions and ciphers",
    change: `[transport.passthru_https.listener.parameters]\nHttpsProtocols = "TLSv1.2,TLSv1.3"\nPreferredCiphers = "TLS_AES_128_GCM_SHA256,TLS_AES_256_GCM_SHA384,TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384"`,
    file: "repository/conf/deployment.toml (gateway)", restart: true },
  { id: "masking", title: "Hide personal data in logs",
    change: "Enable log masking: add the masking patterns to repository/conf/wso2-log-masking.properties (for example e-mail addresses and card numbers) and use the %mm layout instead of %m in repository/conf/log4j2.properties for the gateway and audit appenders.",
    file: "repository/conf/log4j2.properties, repository/conf/wso2-log-masking.properties", restart: true },
  { id: "analytics", title: "Personal data in analytics events",
    change: "The gateway metrics log records the caller address and user agent. To drop them, remove those fields in the analytics event publisher configuration ([apim.analytics] in deployment.toml) or filter them in the log shipper before storage.",
    file: "repository/conf/deployment.toml ([apim.analytics]) or the log shipper", restart: true },
  { id: "correlation", title: "Correlation logs and tracing",
    change: "[apim.open_tracer]\nremote_tracer.enable = true\nremote_tracer.name = \"otlp\"\nremote_tracer.properties.endpoint = \"http://<collector>:4317\"\n\nCorrelation logs: start the gateway with -DenableCorrelationLogs=true.",
    file: "repository/conf/deployment.toml / startup options", restart: true },
];

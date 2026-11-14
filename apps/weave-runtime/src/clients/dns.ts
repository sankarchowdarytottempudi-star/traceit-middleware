// Cluster DNS. The host does not resolve Kubernetes service names, so *.svc and
// *.svc.cluster.local are resolved through CLUSTER_DNS (the cluster's CoreDNS address).
import dns from "node:dns";
import net from "node:net";

export class ClusterDns {
  private resolver: dns.promises.Resolver | null = null;
  private cache = new Map<string, { ip: string; until: number }>();
  constructor(server: string, private ttlMs = 30_000) {
    if (server) { this.resolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 }); this.resolver.setServers([server]); }
  }
  isClusterName(host: string): boolean { return /\.svc(\.cluster\.local)?\.?$/i.test(host); }
  /** Resolves a host name to an address. Cluster names go to the cluster DNS, everything else to the system resolver. */
  async resolve(host: string): Promise<string> {
    if (net.isIP(host)) return host;
    if (!this.resolver || !this.isClusterName(host)) return (await dns.promises.lookup(host)).address;
    const hit = this.cache.get(host);
    if (hit && hit.until > Date.now()) return hit.ip;
    let fqdn = host.replace(/\.$/, "");
    if (/\.svc$/i.test(fqdn)) fqdn += ".cluster.local";
    try {
      const addrs = await this.resolver.resolve4(fqdn);
      if (!addrs.length) throw new Error("no address");
      this.cache.set(host, { ip: addrs[0], until: Date.now() + this.ttlMs });
      return addrs[0];
    } catch (e) {
      throw new Error(`Cannot resolve ${host} through the cluster DNS (${(e as { code?: string }).code || (e as Error).message})`);
    }
  }
  /** A `lookup` function for net/http/https that routes cluster names to the cluster DNS. */
  lookup = (hostname: string, options: unknown, callback?: unknown): void => {
    const cb = (typeof options === "function" ? options : callback) as (err: Error | null, address?: unknown, family?: number) => void;
    const opts = (typeof options === "object" && options ? options : {}) as { all?: boolean };
    if (!this.resolver || !this.isClusterName(hostname)) { (dns.lookup as unknown as (h: string, o: unknown, c: unknown) => void)(hostname, typeof options === "function" ? {} : options, cb); return; }
    this.resolve(hostname).then(
      (ip) => (opts.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4)),
      (err) => cb(err as Error),
    );
  };
}

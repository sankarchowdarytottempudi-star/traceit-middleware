// Migrated APIs read from the deployment target (another cluster) instead of this server's cluster.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseKubeconfig, parseYaml, targetFromEnv } from "../src/estate/kubeconfig";
import { K8s, estateK8sOptions } from "../src/estate/k8s";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const KUBECONFIG = `apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority-data: ${b64("-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n")}
    server: https://10.0.0.5:6443/
  name: cs
- name: other
  cluster:
    server: "https://other:6443"
    insecure-skip-tls-verify: true
contexts:
- context:
    cluster: cs
    namespace: cs-apis
    user: weave-reader
  name: cs-prod
- context: { }
  name: empty
- name: other-ctx
  context:
    cluster: other
    user: cert-user
current-context: cs-prod   # the default
users:
- name: weave-reader
  user:
    token: abc.def.ghi
- name: cert-user
  user:
    client-certificate-data: ${b64("CERT")}
    client-key-data: ${b64("KEY")}
- name: plugin-user
  user:
    exec:
      command: aws
`;

describe("kubeconfig reader", () => {
  it("reads the current context: server, CA, token and namespace", () => {
    const a = parseKubeconfig(KUBECONFIG);
    expect(a).toMatchObject({ apiUrl: "https://10.0.0.5:6443", token: "abc.def.ghi", namespace: "cs-apis", context: "cs-prod" });
    expect(a.ca).toContain("BEGIN CERTIFICATE");
  });
  it("reads another context with a client certificate and an untrusted server", () => {
    const a = parseKubeconfig(KUBECONFIG, "other-ctx");
    expect(a).toMatchObject({ apiUrl: "https://other:6443", cert: "CERT", key: "KEY", insecure: true });
    expect(a.token).toBeUndefined();
  });
  it("refuses what it cannot use, saying why", () => {
    expect(() => parseKubeconfig(KUBECONFIG, "missing")).toThrow(/no context "missing"/);
    const plugin = KUBECONFIG.replace("user: weave-reader", "user: plugin-user");
    expect(() => parseKubeconfig(plugin)).toThrow(/plugin/);
    expect(() => parseKubeconfig("apiVersion: v1\nkind: Config\n")).toThrow(/current-context/);
  });
  it("reads JSON and quoted values", () => {
    expect(parseYaml('{"a": [1, 2]}')).toEqual({ a: [1, 2] });
    expect(parseYaml("a: 'it''s'\nb: \"x # y\" # c\nc:\n  - one\n  - two: 2\n    three: 3\n")).toEqual({ a: "it's", b: "x # y", c: ["one", { two: "2", three: "3" }] });
  });
});

describe("target cluster from the environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "target-"));
  const file = join(dir, "kubeconfig");
  writeFileSync(file, KUBECONFIG);

  it("is not set by default: this server's cluster is used, unchanged", () => {
    expect(targetFromEnv({})).toBeNull();
    const o = estateK8sOptions({ K8S_API_URL: "https://local", K8S_TOKEN_FILE: "/t", K8S_NAMESPACE: "wso2" });
    expect(o).toEqual({ apiUrl: "https://local", tokenFile: "/t", caFile: undefined, namespace: "wso2", cluster: "local" });
    expect(new K8s(o).cluster).toBe("local");
  });
  it("uses the kubeconfig and its namespace, or TARGET_K8S_NAMESPACE over it", () => {
    let o = estateK8sOptions({ K8S_NAMESPACE: "wso2", TARGET_KUBECONFIG: file });
    expect(o).toMatchObject({ cluster: "target", namespace: "cs-apis", access: { apiUrl: "https://10.0.0.5:6443" } });
    o = estateK8sOptions({ K8S_API_URL: "https://local", K8S_TOKEN_FILE: "/t", K8S_NAMESPACE: "wso2", TARGET_KUBECONFIG: file, TARGET_K8S_NAMESPACE: "apis2" });
    expect(o.namespace).toBe("apis2");
    expect(o.apiUrl).toBeUndefined();
    const k = new K8s(o);
    expect(k.configured).toBe(true);
    expect(k.cluster).toBe("target");
    expect(k.namespace).toBe("apis2");
  });
  it("uses an API address and token file", () => {
    const t = targetFromEnv({ TARGET_K8S_API_URL: "https://remote:6443/", TARGET_K8S_TOKEN_FILE: "/run/token", TARGET_K8S_NAMESPACE: "x" });
    expect(t).toMatchObject({ access: { apiUrl: "https://remote:6443", tokenFile: "/run/token" }, namespace: "x" });
    expect(targetFromEnv({ TARGET_K8S_API_URL: "https://remote" })).toMatchObject({ error: expect.stringMatching(/TOKEN_FILE/) });
  });
  it("never falls back to the local cluster when the target is unusable", async () => {
    const o = estateK8sOptions({ K8S_API_URL: "https://local", K8S_TOKEN_FILE: "/t", K8S_NAMESPACE: "wso2", TARGET_KUBECONFIG: join(dir, "missing") });
    expect(o.error).toMatch(/not readable/);
    const k = new K8s(o);
    expect(k.configured).toBe(true);
    await expect(k.deployments()).rejects.toThrow(/Target cluster: the kubeconfig file is not readable/);
  });
});

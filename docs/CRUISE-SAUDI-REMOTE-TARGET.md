# Cruise Saudi: migrated APIs on a separate Kubernetes cluster

At Cruise Saudi, Weave (the UI, the migration tool and WSO2 API Manager) runs on one server. The
migrated APIs are installed on a **different** Kubernetes cluster, the "deployment target".
This page lists the settings that point Weave at that cluster and what Cruise Saudi has to give us.

When none of these settings is set, everything works as it does on the POC VM: images are imported
into the local k3s and helm installs into the local namespace `wso2`.

## 1. Migration tool: the deployment target

Kept in `DATA_DIR/deploy-target.json` (file mode 600). Read it with `GET /api/deploy-target` and
save it with `PUT /api/deploy-target` (admin token). Any field can also come from the environment
(`MT_TARGET_*`); the environment wins over the file.

| Field | Env | Meaning |
|---|---|---|
| `kubeconfig` | `MT_TARGET_KUBECONFIG` | Absolute path **on the build server** of the kubeconfig for the target cluster. Empty means no target (local behaviour). |
| `context` | `MT_TARGET_CONTEXT` | Context in that kubeconfig. Empty means its current context. |
| `namespace` | `MT_TARGET_NAMESPACE` | Namespace the APIs are installed into. It must already exist: the tool does not create it. |
| `registry` | `MT_TARGET_REGISTRY` | `host[:port][/path]` the images are pushed to, e.g. `registry.cs.local:5000/weave`. |
| `pullSecret` | `MT_TARGET_PULL_SECRET` | Optional. Name of an image pull Secret that already exists in the namespace. |
| `registryInsecure` | `MT_TARGET_REGISTRY_INSECURE` | `true` if the registry speaks plain HTTP or uses an untrusted certificate. Docker on the build server must list it under `insecure-registries`; localhost registries are always allowed. If docker does not allow it, the deploy stops before pushing and says so. |
| `serviceType` | `MT_TARGET_SERVICE_TYPE` | `ClusterIP` (default), `LoadBalancer` or `NodePort`. No NodePorts at Cruise Saudi. |
| `backendUrlPattern` | `MT_TARGET_BACKEND_URL_PATTERN` | The address the API Manager gateway uses to reach an API. Placeholders: `{service}`, `{namespace}`, `{port}` and optionally `{basePath}`. If the pattern has no `{basePath}`, the base path is added to the end. Default: `http://{service}.{namespace}.svc.cluster.local:{port}` (port 80, the chart's Service port). |

The setting is "active" only when `kubeconfig`, `namespace` and `registry` are all set.

**What Deployment does when the target is active** (the same four steps the Factory already shows):

1. `image`: `docker build` on the build server, as today.
2. `import`: `docker tag` and `docker push <registry>/<api>:w-<first 12 hex chars of the jar's sha256>`. The same code always gets the same tag.
3. `helm`: the `<api>-config` Secret, then `helm upgrade --install` into the target namespace using the target kubeconfig. It overrides `image.repository`, `image.tag`, `pullPolicy=IfNotPresent`, `service.type` and `imagePullSecrets`, and clears `service.nodePort` from the build server's values file.
4. `verify`: `kubectl rollout status` on the target.

The migration record gets `deployTarget` (`namespace`, `context`, `image`, `serviceType`,
`backendUrl`, `publishArgs`). No `testNodePort` is recorded and no NodePort values are generated.

**Checks that cannot be made from the build server.** These now say why instead of failing:

- Readiness: the node-port clash check and the backend host-resolve check are skipped. The report carries `targetNote` ("runs on the target cluster (namespace ...); it is checked through the gateway, not from the build server").
- Proxy and test calls by service name go to the `backendUrlPattern` address. If that address only exists inside the target cluster, the answer is HTTP 409 with the same note, telling you to register the gateway as an environment and test there.
- Compare (old API vs migrated) needs the migrated side's gateway address when the pattern is cluster-internal. Optimize (scale and re-measure) is refused with HTTP 409.
- The closed-room trial run is unchanged: it runs the jar on the build server and never used the cluster.

**API Manager publishing.** `deploy/customer/publish-api.py` takes `--backend-url-pattern` and
`--service-namespace`, and nothing else in it changed. Without them it publishes exactly the
address it did before (`weave-<env>` on the same server). `deployTarget.publishArgs` on the
migration holds the arguments to use for a target deploy.

## 2. Factory BFF and Gateway console BFF: reading the target

Both BFFs get the same new settings. When they are unset, the existing `K8S_*` cluster is used as before.

| Env | Meaning |
|---|---|
| `TARGET_KUBECONFIG` | Path of a kubeconfig file for the target cluster (inside the container: mount it read-only). |
| `TARGET_KUBE_CONTEXT` | Context in it. Default: its current context. |
| `TARGET_K8S_API_URL` + `TARGET_K8S_TOKEN_FILE` (+ `TARGET_K8S_CA_FILE`) | Instead of a kubeconfig: API address, token file and CA file. |
| `TARGET_K8S_NAMESPACE` | Namespace of the APIs. Default: the kubeconfig context's namespace, then `K8S_NAMESPACE`. |

- **Factory BFF:** Running APIs, migrated Executions, service logs and the on/off switch read the target cluster.
- **Gateway console BFF:** Inventory and service logs read the target. The gateway's own pods and logs stay on this server's cluster (`K8S_*`, `GATEWAY_NAMESPACE`).
- **If a target is set but cannot be used** (unreadable file, unknown context, an exec/auth-provider user), every call fails with `Target cluster: <reason>`. The BFFs never fall back to the local cluster, because that would show the wrong services.
- **Kubeconfig contents understood:** token, token file, client certificate and key (data or file), CA (data or file), `insecure-skip-tls-verify`. Exec plugins (aws, gke, oidc) are refused: use a service-account token.

## 3. What Cruise Saudi must provide

1. **A namespace for the APIs** on their cluster, e.g. `weave-apis`. Plus `-test` / `-uat` ones if they want separate environments.
2. **A deployer kubeconfig** for the migration tool: a service-account token scoped to that namespace only (a Role, not a ClusterRole):
   - create, update, patch, delete and read on: `secrets`, `configmaps`, `services`, `deployments`, `replicasets`, `horizontalpodautoscalers`, `poddisruptionbudgets`, `networkpolicies`, `ingresses`
   - read on: `pods`, `pods/log`, `events`

   Helm stores its release state as Secrets in the namespace. If they run the Prometheus Operator and want `serviceMonitor.enabled`, also `monitoring.coreos.com/servicemonitors`.
3. **A reader kubeconfig** for the two BFFs: get, list and watch on `pods`, `pods/log`, `services` and `deployments` in that namespace. If the Factory on/off switch should work, also `patch` on `deployments` and `horizontalpodautoscalers`.
4. **A container registry** that the build server can push to and the cluster can pull from:
   - Its address and path.
   - Its CA certificate if it is private, or whether it is plain HTTP.
   - Push credentials, used once with `docker login` on the build server. They are never stored in Weave.
   - The name of the pull Secret they create in the namespace, if the cluster needs one.
5. **How the gateway reaches the APIs.** Our API Manager runs on the Weave server, outside their cluster, so `*.svc.cluster.local` names will not resolve from it. One of:
   - an internal ingress or load balancer host per API, or one host with a path per API → `backendUrlPattern`, e.g. `https://{service}.apis.cs.local`
   - `serviceType: LoadBalancer` with DNS names they assign
   - a WSO2 gateway that runs inside their cluster (then the default pattern works)
6. **Network paths:**
   - Weave server → their Kubernetes API (443/6443)
   - Weave server → the registry
   - their cluster → the registry
   - the gateway → the API addresses in step 5

## 4. Not covered yet

- The release/promotion flow (`provisioner.deploy_release`, `deploy/customer/deploy-api.sh`) still installs into the Weave server's own cluster (`weave-<env>`). Only the Deployment step of a migration uses the target. `publish-api.py` can already be given the target address.
- No Factory UI form for the deployment target yet. It is set through the API or the environment.
- Factory "clone to flow" connector addresses (`ESTATE_NODE_HOST` plus a node port, or the cluster IP) are not reachable for APIs on another cluster.
- Prometheus metrics of the target's APIs need a Prometheus that scrapes that cluster (`PROMETHEUS_URL`).

# weave-gateway Helm chart

TraceIT Weave - Weave Gateway (admin UI + BFF for WSO2 API Manager).

Technical ids use `weave-gateway` (image, labels, chart). The product name is **TraceIT Weave**.

## Secrets
Create the referenced Secret before install:
```
kubectl create secret generic weave-gateway-secrets \
  --from-literal=APIM_DCR_USERNAME=admin \
  --from-literal=APIM_DCR_PASSWORD=... \
  --from-literal=SESSION_SECRET=$(head -c 32 /dev/urandom | base64)
```
Mount the WSO2 CA at `APIM_CA_CERT_PATH` (never disable TLS verification).

## Alias note
If replacing an earlier deployment that used a different release name, keep that old release
name as an alias (`helm upgrade <old-name> ...`) rather than renaming live resources, to avoid
recreating the Deployment/Service.

## Install (do not run in CI/build)
```
helm install weave-gateway deploy/helm/gateway-admin -n weave --create-namespace
```

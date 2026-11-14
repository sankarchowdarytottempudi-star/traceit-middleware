# TraceIT middleware tooling
Isolated workspace on the POC server for WSO2-management tooling built on the WSO2 REST APIs.
Separate from TraceIT monitoring and from the WSO2 runtime (k3s).
- apps/gateway-admin     - React admin portal (branded replacement for the WSO2 Admin Portal)
- apps/gateway-admin-bff - Fastify backend-for-frontend (owns all WSO2 communication)
- design/gateway-admin/  - approved design, source of truth (committed; do not edit)

# Multi-stage: build the workspace, then run the BFF which also serves the built React app.
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json tsconfig.base.json pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/gateway-admin/package.json ./apps/gateway-admin/package.json
COPY apps/gateway-admin-bff/package.json ./apps/gateway-admin-bff/package.json
RUN pnpm install --frozen-lockfile
COPY . .
ARG VITE_WEAVE_FACTORY_URL=""
ENV VITE_WEAVE_FACTORY_URL=$VITE_WEAVE_FACTORY_URL
# product edition: "traceit" (default) or "cruise-saudi"
ARG VITE_WEAVE_EDITION="traceit"
ENV VITE_WEAVE_EDITION=$VITE_WEAVE_EDITION
RUN pnpm --filter gateway-admin build && pnpm --filter gateway-admin-bff build
RUN pnpm --filter gateway-admin-bff deploy --prod /prod-bff

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# BFF (prod deps + dist)
COPY --from=build /prod-bff/node_modules ./apps/gateway-admin-bff/node_modules
COPY --from=build /app/apps/gateway-admin-bff/dist ./apps/gateway-admin-bff/dist
# Built SPA at the path the BFF serves (../../gateway-admin/dist from the bff dist dir)
COPY --from=build /app/apps/gateway-admin/dist ./apps/gateway-admin/dist
USER node
EXPOSE 8787
WORKDIR /app/apps/gateway-admin-bff
CMD ["node", "dist/index.js"]

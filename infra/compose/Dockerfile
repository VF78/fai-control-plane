# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS base

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

RUN corepack enable

WORKDIR /workspace

FROM base AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/integrations/package.json packages/integrations/package.json

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM dependencies AS build

COPY . .

RUN pnpm build

FROM base AS runtime

LABEL com.docker.compose.project=fai-control-plane-mvp

ENV NODE_ENV=production

COPY --from=build /workspace /workspace

RUN cp -R apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static \
    && if [ -d apps/web/public ]; then \
         cp -R apps/web/public apps/web/.next/standalone/apps/web/public; \
       fi \
    && mkdir -p apps/web/.next/standalone/apps/web/.next/cache \
    && chown -R node:node apps/web/.next/standalone/apps/web/.next/cache

RUN command -v setpriv >/dev/null

USER node

ENTRYPOINT ["sh", "infra/compose/container-entrypoint.sh"]

EXPOSE 3000 3001

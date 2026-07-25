# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS base

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
COPY packages/runners/package.json packages/runners/package.json
COPY packages/observability/package.json packages/observability/package.json

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM dependencies AS build

COPY . .

RUN pnpm build

FROM base AS runtime

ENV NODE_ENV=production

COPY --from=build /workspace /workspace

RUN cp -R apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static \
    && if [ -d apps/web/public ]; then \
         cp -R apps/web/public apps/web/.next/standalone/apps/web/public; \
       fi \
    && mkdir -p /var/lib/fai/artifacts \
    && chown -R node:node /var/lib/fai

USER node

EXPOSE 3000 3001

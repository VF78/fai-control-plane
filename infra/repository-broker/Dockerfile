# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/domain/package.json packages/domain/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/integrations/package.json packages/integrations/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/domain packages/domain
COPY packages/application packages/application
COPY packages/integrations packages/integrations
RUN pnpm --filter @fai-control-plane/domain build && pnpm --filter @fai-control-plane/integrations build

FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
RUN apt-get update \
    && apt-get install --no-install-recommends -y git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 10000 broker && useradd --uid 10000 --gid 10000 --no-create-home broker
WORKDIR /workspace
COPY --from=build --chown=10000:10000 /workspace/node_modules ./node_modules
COPY --from=build --chown=10000:10000 /workspace/packages/domain/package.json packages/domain/package.json
COPY --from=build --chown=10000:10000 /workspace/packages/domain/dist packages/domain/dist
COPY --from=build --chown=10000:10000 /workspace/packages/integrations/package.json packages/integrations/package.json
COPY --from=build --chown=10000:10000 /workspace/packages/integrations/dist packages/integrations/dist
USER 10000:10000
ENTRYPOINT ["node", "packages/integrations/dist/repository-broker-cli.js"]

ARG HERMES_UPSTREAM_IMAGE=nousresearch/hermes-agent:v2026.8.13@sha256:68e15ae2a6d894d0ccbd9f8aacbbe13d4d28fa5dc9b6a303970b67bb2499b1a6
FROM ${HERMES_UPSTREAM_IMAGE}

USER root

RUN npm install --global --omit=dev --no-audit --no-fund @openai/codex@0.144.1 \
    && test "$(codex --version)" = "codex-cli 0.144.1" \
    && npm cache clean --force

RUN if ! getent group 10000 >/dev/null; then groupadd --gid 10000 hermes-runtime; fi \
    && if ! getent passwd 10000 >/dev/null; then \
         useradd --uid 10000 --gid 10000 --home-dir /opt/data --no-create-home \
           --shell /usr/sbin/nologin hermes-runtime; \
       fi \
    && install -d -o 10000 -g 10000 -m 0700 \
      /opt/data /opt/data/codex-home /opt/data/work /opt/data/work/project

ENV CODEX_HOME=/opt/data/codex-home
WORKDIR /opt/data/work/project
USER 10000:10000

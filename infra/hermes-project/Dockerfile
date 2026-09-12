ARG HERMES_UPSTREAM_IMAGE=nousresearch/hermes-agent:v2026.9.11@sha256:9469b3e78b9545b6d576eb8887a95352e9a0ea83730eaf31431cf862ca1010e1
FROM ${HERMES_UPSTREAM_IMAGE}

ARG YC_VERSION=1.22.0

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gh git openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && curl --fail --silent --show-error --location \
      "https://storage.yandexcloud.net/yandexcloud-yc/release/${YC_VERSION}/linux/amd64/yc" \
      --output /usr/local/bin/yc \
    && chmod 0555 /usr/local/bin/yc \
    && npm install --global --omit=dev --no-audit --no-fund @openai/codex@0.153.4 \
    && test "$(codex --version)" = "codex-cli 0.153.4" \
    && uv pip show --python /opt/hermes/.venv/bin/python mautrix | grep -Fx 'Version: 0.21.1' \
    && uv pip show --python /opt/hermes/.venv/bin/python python-olm >/dev/null \
    && yc version | grep -Eq "^Yandex Cloud CLI ${YC_VERSION}([[:space:]]|$)" \
    && command -v git >/dev/null \
    && command -v gh >/dev/null \
    && command -v ssh >/dev/null \
    && npm cache clean --force

RUN if ! getent group 10000 >/dev/null; then groupadd --gid 10000 hermes-runtime; fi \
    && if ! getent passwd 10000 >/dev/null; then \
         useradd --uid 10000 --gid 10000 --home-dir /opt/data --no-create-home \
           --shell /usr/sbin/nologin hermes-runtime; \
       fi \
    && install -d -o 10000 -g 10000 -m 0700 \
      /opt/data /opt/data/codex-home /opt/data/work /opt/data/work/project

COPY --chown=root:root infra/hermes-project/runtime-init.sh /etc/cont-init.d/03-fai-runtime
COPY --chown=root:root infra/hermes-project/project-device-auth.sh /usr/local/bin/fai-project-device-auth
COPY --chown=root:root infra/hermes-project/import-codex-oauth.py /usr/local/lib/fai/import-codex-oauth.py
RUN chmod 0555 /etc/cont-init.d/03-fai-runtime /usr/local/bin/fai-project-device-auth \
    && chmod 0444 /usr/local/lib/fai/import-codex-oauth.py

ENV CODEX_HOME=/opt/data/codex-home
# Control Plane mounts reviewed configuration read-only; skip native boot migrations.
ENV HERMES_SKIP_CONFIG_MIGRATION=1
WORKDIR /opt/data/work/project
USER root

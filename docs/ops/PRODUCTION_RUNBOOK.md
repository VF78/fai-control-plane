# Production deployment is blocked

This repository now contains the fresh 16-table MVP architecture. It has not
been activated in production, and this file does not authorize a deployment.

## Canonical host and protected boundary

- SSH endpoint: `root@46.225.163.123`.
- Replaceable Control Plane public endpoint: `https://app.f-ai.studio/`.
- The OAuth callback is
  `https://app.f-ai.studio/oauth/github/complete`.
- The GitHub and Bitrix24 webhook endpoints are respectively
  `https://app.f-ai.studio/api/webhooks/github` and
  `https://app.f-ai.studio/api/webhooks/bitrix24`.

Vladimir has authorized replacing the application currently served at
`app.f-ai.studio` with the approved MVP version. That authorization is limited
to the exact reviewed Control Plane release. It does not authorize a deployment
before the exact commit and production diff are approved.

The VPS also runs the f(AI) Studio marketing site, the MSA project test
environment, the MSA-specific Hermes deployment and Amnezia VPN. These are
protected neighbouring services. Do not stop, restart, reconfigure, upgrade or
delete them, and do not reuse or modify their ports, proxy routes, files,
volumes, databases, credentials, systemd units, containers or
network/firewall/VPN rules. Preflight and smoke checks must prove that all four
remain healthy before and after the Control Plane change.

The existing Hermes belongs only to MSA. Never point ASCON at its endpoint,
reuse its credential, alter its profiles or share its state/work directory.
ASCON requires a separate project-isolated Hermes deployment with a distinct
literal HTTPS endpoint, state/work directory and credential. Its exact host
diff and activation require approval under issue #174.

## ASCON Telegram binding

- bot username: `@f_AI_Control_Bot`;
- internal group chat ID: `-5540760630`;
- Vladimir Telegram user ID: `96211907`;
- Vitaliy Telegram user ID: `355724486`.

The bot token is stored only in the macOS login Keychain under service
`fai-control-plane/ascon/telegram-bot-token`, account
`@f_AI_Control_Bot`. Never print or copy its value into Git, GitHub, Project,
logs or shell configuration. During an approved deployment, copy it directly
into the host-owned mode-0600 file
`/etc/fai-control-plane-mvp/secrets/telegram-bot-token` without exposing the
value.

The MVP must use a new independent host directory, Compose project and
PostgreSQL volume. The legacy database, commit and credentials remain unchanged
as the rollback boundary. The files under `infra/production/` are retained only
as rollback evidence for the legacy commit; they are not compatible with the
MVP and must not be applied from this branch.

Issue #174 must define and verify the minimal MVP deployment configuration,
exact secret references, ASCON bindings and rollback procedure. Vladimir must
approve the exact commit and production diff before that procedure is used.
Until then, `scripts/deploy-prod.sh` fails closed.

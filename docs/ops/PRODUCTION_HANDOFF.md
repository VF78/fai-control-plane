# `app.f-ai.studio` production handoff

Updated: 2026-07-29

## Current state

- Public internal-alpha origin: `https://app.f-ai.studio`.
- Production VPS: `46.225.163.123`.
- Production checkout: `/opt/fai-control-plane`.
- Isolated Compose project: `fai-control-plane-production`.
- Application ingress is separate from the marketing site.
- Last production release previously verified in the operating thread:
  `44a166fdb17d15e6deec866000ed47451cc2e5ff`.

These facts are a starting point, not authorization and not a guarantee that
the host has not changed. Verify the checkout, rendered Compose configuration,
containers, database backup path, Nginx site and public health endpoints before
proposing a release.

## Protected boundaries

- Do not alter `f-ai.studio`, its Nginx site or marketing containers.
- Do not inspect or modify protected Hermes or MSA services/configuration.
- Do not change DNS, TLS, firewall, shared Docker resources or host packages.
- Do not print secrets, OAuth codes, share tokens, callback queries or private
  payloads.
- Do not deploy without Vladimir's explicit approval of the exact commit and
  release action.

## Source of truth

1. GitHub `origin/main` is the release source.
2. GitHub Project `f(AI) Studio` and issue `#1` hold product/task truth.
3. `infra/production/compose.yaml` and
   `infra/production/production.env.example` define the committed topology.
4. Host-owned `/etc/fai-control-plane/production.env` and secret files are
   operational configuration and must never be copied into Git.
5. The historical activation procedure is retained in
   `APP_F_AI_STUDIO_DEPLOYMENT_PREPARATION.md`; verify every command against
   current host state before using any part of it.

## Read-only release preflight

Before any future deployment, report:

- local and `origin/main` commit;
- clean release worktree;
- production checkout commit and status;
- current Compose project/container health;
- database and artifact backup destinations;
- exact proposed diff and migrations;
- rollback commit/image and compatibility decision;
- public `/api/health` and `/api/ready` results.

Stop if the production worktree is dirty, the intended commit differs from
`origin/main`, backup cannot be verified, a migration lacks a restore plan, or
the proposed command can affect shared/protected services.

## Development rule

Normal feature work does not require production access. Implement one bounded
issue on a branch from current `origin/main`, use the smallest relevant checks,
open a reviewed PR, and leave deployment for a separate approved release step.

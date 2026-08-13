# Production deployment is blocked

This repository now contains the fresh 16-table MVP architecture. It has not
been activated in production, and this file does not authorize a deployment.

The legacy production host, database, credentials and running services must
remain unchanged. The files under `infra/production/` are retained only as
rollback evidence for the legacy commit; they are not compatible with the MVP
and must not be applied from this branch.

Issue #174 must define and verify the minimal MVP deployment configuration,
exact secret references, ASCON bindings and rollback procedure. Vladimir must
approve the exact commit and production diff before that procedure is used.
Until then, `scripts/deploy-prod.sh` fails closed.

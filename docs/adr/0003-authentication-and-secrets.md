# ADR 0003: Authentication and Secret Handling

- Status: Accepted
- Date: 2026-07-25
- Issue: #2

## Context

The web application handles privileged workflow actions and may act through
GitHub or runner credentials. Browser code, telemetry, database dumps, job
payloads, and artifacts are all inappropriate places for raw secret values.
Local convenience must not establish unsafe production defaults.

## Decision

The Next.js BFF is the browser trust boundary. In an authenticated environment
it uses an OpenID Connect provider, server-side authorization, and short-lived
sessions referenced by `HttpOnly`, `Secure`, `SameSite=Lax` cookies. State-
changing requests require CSRF protection and origin validation.

Authorization is deny-by-default and checked in domain use cases, not only in
routes or UI controls. Roles grant narrow capabilities within a tenant or
project. Sensitive actions such as approvals, credential changes, runner
execution, and share creation produce audit events. Service processes and
runners use separate identities from human users.

Secret values live outside PostgreSQL in an external secret manager or mounted
files. Local development may use untracked files or process environment where a
mounted provider is unavailable. PostgreSQL stores only:

- an opaque secret reference;
- provider/type metadata needed to resolve it;
- ownership, rotation, and last-used metadata;
- a non-secret fingerprint when needed for diagnostics.

The credential resolver returns scoped, short-lived material where the provider
supports it. Callers receive only the credential required for the current
operation. Secrets are never placed in URLs, tracker content, queue payloads,
runner inputs, artifacts, logs, traces, metrics, or error details. Redaction is
applied both at instrumentation boundaries and structured logging sinks.

The default Compose configuration disables authentication-dependent external
features and contains only disposable PostgreSQL credentials. It is not a
production authentication design.

For the bounded two-operator alpha, the authenticated-environment provider is a
dedicated GitHub OAuth application using authorization code, unpredictable
state, PKCE S256, and exact callback validation. Authorization uses exactly two
runtime-allowlisted immutable numeric GitHub user IDs. Each identity must bind
to an enabled canonical human Actor through `github:user:<id>`; usernames never
grant access. OAuth state and session tokens are stored only as hashes, the
transient verifier is held in a short-lived authenticated-encrypted cookie, and
the GitHub access token is discarded after the official user identity request.
This alpha profile does not add OIDC, roles, tenants, or a second Actor model.

## Consequences

- A database backup does not contain GitHub keys, OIDC client secrets, signing
  keys, or runner credentials.
- Deployments require a secret provider and a way to mount or resolve values.
- Local setup has explicit opt-in steps for integrations and sharing.
- Revocation and rotation happen at the secret provider without rewriting
  historical records.
- Tests use fakes or ephemeral credentials and must assert that telemetry and
  persisted payloads contain no secret material.

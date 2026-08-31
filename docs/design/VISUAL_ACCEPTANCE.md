# Visual Acceptance and Regression Policy

## Required evidence

A frontend task cannot be marked complete using text-only claims.

Required:

- before screenshot;
- after screenshot;
- visual diff where a baseline exists;
- test report;
- list of checked states and viewports.

## Viewports

- 1440 x 900
- 1280 x 800
- 390 x 844

Use the same browser engine and environment for baseline and comparison.

## Baseline policy

Codex must not update approved visual baselines on its own.

The following command or equivalent is prohibited unless the user has
sent an explicit message beginning with `UI-APPROVED:`:

`playwright test --update-snapshots`

Until approval:

- save candidates in `artifacts/ui-review/after/`;
- save diffs in `artifacts/ui-review/diff/`;
- keep golden snapshots unchanged.

## Approved Projects + Setup baseline

The Product Owner approved the exact PR 1 rendered package on 2026-08-31 with:

`UI-APPROVED: Projects + Setup PR 1`

Its 55 deterministic snapshots are stored under
`apps/web/tests/visual/golden/projects-setup/`. They cover 1440x900, 1280x800
and 390x844, including the approved portfolio, setup, command, degraded,
read-only and delete-dialog states. Use
`apps/web/tests/visual/capture-projects-setup.mjs` to generate a candidate in a
temporary directory; never overwrite this baseline without a new exact
`UI-APPROVED:` message.

## Browser fallback order

1. interactive Playwright skill, when available;
2. repository Playwright test runner;
3. deterministic Playwright CLI screenshot script;
4. stop and report the missing capability.

Never claim «visually verified» if Codex did not inspect real rendered
screenshots.

## Structural verification

Where practical, add:

- ARIA snapshots;
- keyboard navigation tests;
- focus-order checks;
- accessible name checks;
- reduced-motion handling.

## Scope regression

The final report must explicitly confirm:

- which routes were rendered;
- whether unrelated screenshots changed;
- whether API/network behavior changed;
- whether permissions/auth changed;
- whether any dependency was added;
- whether any baseline was updated.

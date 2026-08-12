import {beforeEach, expect, it, vi} from 'vitest';

const {execute, end, health, configuration} = vi.hoisted(() => ({
  execute: vi.fn(), end: vi.fn(), health: vi.fn(), configuration: vi.fn()
}));
vi.mock('@fai-control-plane/db', () => ({createDatabase: () => ({db: {execute}, pool: {end}})}));
vi.mock('../../../src/hermes-semantic-planner', () => ({
  checkHermesSemanticPlannerHealth: health,
  hermesSemanticPlanningConfiguration: configuration
}));

import {GET} from './route';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DATABASE_URL = 'postgresql://local.invalid/fai';
  execute.mockResolvedValue({});
  end.mockResolvedValue(undefined);
});

it('keeps disabled planning ready while reporting the fail-closed state', async () => {
  configuration.mockReturnValue({configured: false, remediation: 'disabled'});
  const response = await GET();
  await expect(response.json()).resolves.toMatchObject({status: 'ready', checks: {database: 'ok', hermesPlanner: 'disabled'}});
  expect(response.status).toBe(200);
  expect(health).not.toHaveBeenCalled();
});

it('requires authenticated planner health whenever planning is enabled', async () => {
  configuration.mockReturnValue({configured: true, remediation: 'configured'});
  health.mockResolvedValue({healthy: false, remediation: 'down', releaseCommit: null});
  const failed = await GET();
  expect(failed.status).toBe(503);
  await expect(failed.json()).resolves.toMatchObject({status: 'not_ready', checks: {database: 'ok', hermesPlanner: 'failed'}});
  health.mockResolvedValue({healthy: true, remediation: 'ready', releaseCommit: 'a'.repeat(40)});
  const ready = await GET();
  expect(ready.status).toBe(200);
  await expect(ready.json()).resolves.toMatchObject({status: 'ready', checks: {hermesPlanner: 'ok'}});
});

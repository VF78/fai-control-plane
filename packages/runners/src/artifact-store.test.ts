import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, realpath, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  ArtifactStoreError,
  createLocalFilesystemArtifactStore
} from './artifact-store';

describe('local filesystem artifact store', () => {
  it('allocates an immutable per-run evidence set with stable correlation and hashes', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'fai-artifacts-')));
    const runId = randomUUID();
    const store = createLocalFilesystemArtifactStore({root});
    const run = await store.allocateRun(runId);
    const summary = {
      schemaVersion: 1,
      status: 'completed',
      changedFiles: ['packages/runners/src/artifact-store.ts'],
      checks: [{name: 'focused test', status: 'passed'}]
    };
    const stored = await run.writeJson('summary', summary);
    const body = Buffer.from(`${JSON.stringify(summary, null, 2)}\n`, 'utf8');

    expect(run.reference).toBe(`runs/${runId}`);
    expect(run.correlationId).toBe(`artifact-run-${runId}`);
    expect(stored).toEqual({
      provider: 'workstation-local',
      name: 'structured-summary.json',
      reference: `runs/${runId}/structured-summary.json`,
      sha256: createHash('sha256').update(body).digest('hex'),
      sizeBytes: body.byteLength,
      contentType: 'application/json'
    });
    await expect(run.writeJson('summary', summary)).rejects.toMatchObject({
      code: 'artifact_collision'
    } satisfies Partial<ArtifactStoreError>);
    await expect(store.allocateRun(runId)).rejects.toMatchObject({code: 'run_collision'});
    await expect(store.allocateRun(`../${runId}`)).rejects.toMatchObject({
      code: 'invalid_run_id'
    } satisfies Partial<ArtifactStoreError>);
    await expect(readFile(path.join(root, runId, 'structured-summary.json'), 'utf8'))
      .resolves.toContain('"focused test"');
    await expect(run.abandon()).rejects.toMatchObject({
      code: 'artifact_set_retained'
    } satisfies Partial<ArtifactStoreError>);
    await run.discardRuntimeScratch();
    await run.finalize();
    await expect(run.writeJson('receipt', {schemaVersion: 1})).rejects.toMatchObject({
      code: 'artifact_set_finalized'
    } satisfies Partial<ArtifactStoreError>);
  });

  it('rejects symlinked roots and keeps scratch output out of retained evidence', async () => {
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'fai-artifacts-link-')));
    const link = path.join(parent, 'link');
    await symlink(parent, link);
    const store = createLocalFilesystemArtifactStore({root: link});
    await expect(store.allocateRun(randomUUID())).rejects.toMatchObject({
      code: 'unsafe_root'
    } satisfies Partial<ArtifactStoreError>);

    const validRoot = await realpath(parent);
    const run = await createLocalFilesystemArtifactStore({root: validRoot}).allocateRun(randomUUID());
    await run.abandon();
    await expect(run.discardRuntimeScratch()).rejects.toMatchObject({
      code: 'artifact_set_abandoned'
    } satisfies Partial<ArtifactStoreError>);
    await expect(run.finalize()).rejects.toMatchObject({
      code: 'artifact_set_abandoned'
    } satisfies Partial<ArtifactStoreError>);
  });
});

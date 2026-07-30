import {createHash} from 'node:crypto';
import {chmod, lstat, mkdir, open, realpath, rm} from 'node:fs/promises';
import path from 'node:path';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ARTIFACT_FILENAMES = {
  receipt: 'agent-run-receipt.json',
  summary: 'structured-summary.json',
  pathManifest: 'observed-path-manifest.json'
} as const;
const LOCAL_FILESYSTEM_PROVIDER = 'workstation-local';

export type ArtifactKind = keyof typeof ARTIFACT_FILENAMES;

export type ArtifactDescriptor = Readonly<{
  provider: string;
  name: string;
  reference: string;
  sha256: string;
  sizeBytes: number;
  contentType: 'application/json';
}>;

export type ArtifactRun = Readonly<{
  runId: string;
  provider: string;
  reference: string;
  correlationId: string;
  runtimePath: string;
  writeJson(kind: ArtifactKind, value: unknown): Promise<ArtifactDescriptor>;
  discardRuntimeScratch(): Promise<void>;
  finalize(): Promise<void>;
  abandon(): Promise<void>;
}>;

/** Provider-neutral retained-evidence boundary. */
export interface ArtifactStore {
  allocateRun(runId: string): Promise<ArtifactRun>;
}

export type LocalFilesystemArtifactStoreOptions = Readonly<{root: string}>;

export class ArtifactStoreError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'ArtifactStoreError';
    this.code = code;
  }
}

const fail = (code: string): never => {
  throw new ArtifactStoreError(code);
};

const sha256 = (body: Uint8Array): string =>
  createHash('sha256').update(body).digest('hex');

const safeAbsoluteDirectory = async (value: string): Promise<string> => {
  if (
    value.includes('\0') ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    path.resolve(value) !== value ||
    value === path.parse(value).root
  ) fail('unsafe_root');
  let canonical: string;
  let metadata;
  try {
    [canonical, metadata] = await Promise.all([realpath(value), lstat(value)]);
  } catch {
    return fail('missing_root');
  }
  if (canonical !== value || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail('unsafe_root');
  }
  return canonical;
};

const safeChildDirectory = async (parent: string, name: string): Promise<string> => {
  const candidate = path.join(parent, name);
  try {
    await mkdir(candidate, {mode: 0o700});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      fail('run_collision');
    }
    throw error;
  }
  const [canonical, metadata] = await Promise.all([realpath(candidate), lstat(candidate)]);
  if (canonical !== candidate || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail('unsafe_run_directory');
  }
  return candidate;
};

const jsonBody = (value: unknown): Buffer =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

export const createLocalFilesystemArtifactStore = (
  options: LocalFilesystemArtifactStoreOptions
): ArtifactStore => ({
  async allocateRun(runId) {
    if (!UUID_PATTERN.test(runId)) fail('invalid_run_id');
    const root = await safeAbsoluteDirectory(options.root);
    const runPath = await safeChildDirectory(root, runId);
    const runtimePath = await safeChildDirectory(runPath, 'runtime');
    const reference = `runs/${runId}`;
    const correlationId = `artifact-run-${runId}`;
    let scratchDiscarded = false;
    let finalized = false;
    let abandoned = false;
    const written = new Set<string>();

    return {
      runId,
      provider: LOCAL_FILESYSTEM_PROVIDER,
      reference,
      correlationId,
      runtimePath,
      async writeJson(kind, value) {
        if (abandoned) fail('artifact_set_abandoned');
        if (finalized) fail('artifact_set_finalized');
        const name = ARTIFACT_FILENAMES[kind];
        const destination = path.join(runPath, name);
        const body = jsonBody(value);
        let handle;
        try {
          handle = await open(destination, 'wx', 0o600);
          await handle.writeFile(body);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            fail('artifact_collision');
          }
          throw error;
        } finally {
          await handle?.close();
        }
        const metadata = await lstat(destination);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== body.byteLength) {
          fail('unsafe_artifact_file');
        }
        written.add(destination);
        return {
          provider: LOCAL_FILESYSTEM_PROVIDER,
          name,
          reference: `${reference}/${name}`,
          sha256: sha256(body),
          sizeBytes: body.byteLength,
          contentType: 'application/json'
        };
      },
      async discardRuntimeScratch() {
        if (abandoned) fail('artifact_set_abandoned');
        if (scratchDiscarded) return;
        const metadata = await lstat(runtimePath).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        });
        if (metadata !== undefined && !metadata.isDirectory()) fail('unsafe_runtime_scratch');
        await rm(runtimePath, {recursive: true, force: false});
        scratchDiscarded = true;
      },
      async finalize() {
        if (abandoned) fail('artifact_set_abandoned');
        if (finalized) return;
        if (!scratchDiscarded) fail('runtime_scratch_not_discarded');
        await Promise.all([...written].map(async (destination) => {
          const metadata = await lstat(destination);
          if (!metadata.isFile() || metadata.isSymbolicLink()) fail('unsafe_artifact_file');
          await chmod(destination, 0o400);
        }));
        await chmod(runPath, 0o500);
        finalized = true;
      },
      async abandon() {
        if (abandoned) fail('artifact_set_abandoned');
        if (finalized || written.size > 0) fail('artifact_set_retained');
        await rm(runPath, {recursive: true, force: false});
        scratchDiscarded = true;
        abandoned = true;
      }
    };
  }
});

export const isArtifactDescriptor = (value: unknown): value is ArtifactDescriptor => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.provider === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.reference === 'string' &&
    typeof candidate.sha256 === 'string' && SHA256_PATTERN.test(candidate.sha256) &&
    typeof candidate.sizeBytes === 'number' && Number.isSafeInteger(candidate.sizeBytes) &&
    candidate.sizeBytes > 0 &&
    candidate.contentType === 'application/json';
};

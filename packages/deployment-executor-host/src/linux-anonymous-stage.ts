import {constants} from 'node:fs';
import {open, type FileHandle} from 'node:fs/promises';

// Linux UAPI defines O_TMPFILE as __O_TMPFILE | O_DIRECTORY. Node exposes
// only the architecture-specific O_DIRECTORY component.
const O_TMPFILE = 0o20000000 | constants.O_DIRECTORY;
const fail = (): never => { throw new Error('deployment_executor_client_artifact_anonymous_staging_unavailable'); };

const openWriter = async (stagingRoot: string): Promise<FileHandle> => {
  if (process.platform !== 'linux') return fail();
  let handle: FileHandle | undefined;
  try {
    handle = await open(stagingRoot, constants.O_RDWR | constants.O_EXCL | O_TMPFILE, 0o600);
    const value = await handle.stat();
    if (!value.isFile() || value.nlink !== 0 || (value.mode & 0o7777) !== 0o600) {
      await handle.close(); return fail();
    }
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof Error && error.message ===
      'deployment_executor_client_artifact_anonymous_staging_unavailable') throw error;
    return fail();
  }
};

export const preflightLinuxAnonymousStage = async (stagingRoot: string): Promise<void> => {
  const handle = await openWriter(stagingRoot);
  await handle.close();
};

export const createLinuxAnonymousStage = async (
  stagingRoot: string
): Promise<Readonly<{writer: FileHandle; openReadOnly(): Promise<FileHandle>}>> => {
  const writer = await openWriter(stagingRoot);
  return Object.freeze({writer, async openReadOnly() {
    let reader: FileHandle | undefined;
    try {
      reader = await open(`/proc/self/fd/${writer.fd}`, constants.O_RDONLY);
      const [written, read] = await Promise.all([writer.stat(), reader.stat()]);
      if (written.dev !== read.dev || written.ino !== read.ino || read.nlink !== 0 ||
        (read.mode & 0o7777) !== 0o400) {
        await reader.close(); return fail();
      }
      return reader;
    } catch (error) {
      await reader?.close().catch(() => undefined);
      if (error instanceof Error && error.message ===
        'deployment_executor_client_artifact_anonymous_staging_unavailable') throw error;
      return fail();
    }
  }});
};

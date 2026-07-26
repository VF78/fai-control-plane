import {createProjectShareService} from '@fai-control-plane/application';
import {
  createDatabase,
  createPostgresProjectShareStore
} from '@fai-control-plane/db';

let runtimePromise: Promise<ReturnType<typeof createProjectShareService>> | undefined;

export const getProjectShareRuntime = async () => {
  runtimePromise ??= (async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error('DATABASE_URL is required for project sharing');
    }
    const {db} = createDatabase(databaseUrl);
    return createProjectShareService({
      store: createPostgresProjectShareStore(db)
    });
  })();
  return runtimePromise;
};

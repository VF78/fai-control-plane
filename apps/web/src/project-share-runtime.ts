import {createProjectShareService} from '@fai-control-plane/application';
import {
  createDatabase,
  createPostgresProjectShareStore,
  projects
} from '@fai-control-plane/db';
import {and, eq} from 'drizzle-orm';
import type {OperatorProjectSlug} from './operator-data';

type RuntimeState = Readonly<{
  db: ReturnType<typeof createDatabase>['db'];
  service: ReturnType<typeof createProjectShareService>;
}>;

let runtimePromise: Promise<RuntimeState> | undefined;

const getRuntimeState = async (): Promise<RuntimeState> => {
  runtimePromise ??= (async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error('DATABASE_URL is required for project sharing');
    }
    const {db} = createDatabase(databaseUrl);
    return {
      db,
      service: createProjectShareService({
        store: createPostgresProjectShareStore(db)
      })
    };
  })();
  return runtimePromise;
};

export const getProjectShareRuntime = async () =>
  (await getRuntimeState()).service;

export const getProjectShareOperatorRuntime = async () => {
  const state = await getRuntimeState();
  return {
    service: state.service,
    async findProjectId(
      workspaceId: string,
      slug: OperatorProjectSlug
    ): Promise<string | null> {
      const [project] = await state.db.select({id: projects.id})
        .from(projects)
        .where(and(
          eq(projects.workspaceId, workspaceId),
          eq(projects.slug, slug)
        ))
        .limit(1);
      return project?.id ?? null;
    }
  };
};

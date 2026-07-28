import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from 'node:crypto';
import type {Clock, IdGenerator} from './index';

const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DUMMY_SHARE_TOKEN = 'A'.repeat(43);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SHARED_WORK_ITEMS = 100;

export type PublicProjectItem = Readonly<{
  publicTitle: string;
  publicStatus: string;
  publicSummary: string | null;
  updatedTime: string;
}>;

export type PublicProjectProjection = Readonly<{
  items: readonly PublicProjectItem[];
}>;

export type ProjectShareGrant = Readonly<{
  id: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  items: readonly Readonly<{
    title: string;
    status: string;
    summary: string | null;
    updatedAt: Date;
  }>[];
}>;

export type CreateProjectShareGrantInput = Readonly<{
  id: string;
  workspaceId: string;
  projectId: string;
  createdByActorId: string;
  workItemIds: readonly string[];
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  commandId: string;
  correlationId: string;
}>;

export type RevokeProjectShareGrantInput = Readonly<{
  workspaceId: string;
  shareId: string;
  revokedByActorId: string;
  revokedAt: Date;
  commandId: string;
  correlationId: string;
}>;

export interface ProjectShareStore {
  createGrant(input: CreateProjectShareGrantInput): Promise<boolean>;
  revokeGrant(input: RevokeProjectShareGrantInput): Promise<boolean>;
  findGrantByTokenHash(tokenHash: string): Promise<ProjectShareGrant | null>;
  recordAccessIfActive(
    shareId: string,
    tokenHash: string,
    accessedAt: Date
  ): Promise<boolean>;
}

export type CreateProjectShareInput = Readonly<{
  workspaceId: string;
  projectId: string;
  createdByActorId: string;
  workItemIds: readonly string[];
  expiresAt: Date;
  commandId: string;
  correlationId: string;
}>;

export type RevokeProjectShareInput = Readonly<{
  workspaceId: string;
  shareId: string;
  revokedByActorId: string;
  commandId: string;
  correlationId: string;
}>;

export interface ProjectShareService {
  create(input: CreateProjectShareInput): Promise<Readonly<{
    shareId: string;
    token: string;
    expiresAt: Date;
  }>>;
  revoke(input: RevokeProjectShareInput): Promise<boolean>;
  resolve(token: string): Promise<PublicProjectProjection | null>;
}

export type CreateProjectShareServiceInput = Readonly<{
  store: ProjectShareStore;
  clock?: Clock;
  idGenerator?: IdGenerator;
  tokenGenerator?: () => string;
}>;

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const sameHash = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.byteLength === 32 &&
    rightBuffer.byteLength === 32 &&
    timingSafeEqual(leftBuffer, rightBuffer);
};

const publicProjection = (
  grant: ProjectShareGrant
): PublicProjectProjection => ({
  items: grant.items.map((item) => ({
    publicTitle: item.title,
    publicStatus: item.status,
    publicSummary: item.summary,
    updatedTime: item.updatedAt.toISOString()
  }))
});

const validWorkItemScope = (workItemIds: readonly string[]): boolean =>
  workItemIds.length > 0 &&
  workItemIds.length <= MAX_SHARED_WORK_ITEMS &&
  workItemIds.every((id) => UUID_PATTERN.test(id)) &&
  new Set(workItemIds).size === workItemIds.length;

export const createProjectShareService = (
  input: CreateProjectShareServiceInput
): ProjectShareService => {
  const clock = input.clock ?? {now: () => new Date()};
  const idGenerator = input.idGenerator ?? {
    next: () => randomUUID()
  };
  const tokenGenerator = input.tokenGenerator ??
    (() => randomBytes(32).toString('base64url'));

  return {
    async create(createInput) {
      const now = clock.now();
      if (
        !Number.isFinite(createInput.expiresAt.getTime()) ||
        createInput.expiresAt.getTime() <= now.getTime()
      ) {
        throw new Error('project_share_expiry_invalid');
      }
      if (!validWorkItemScope(createInput.workItemIds)) {
        throw new Error('project_share_scope_invalid');
      }
      const token = tokenGenerator();
      if (!SHARE_TOKEN_PATTERN.test(token)) {
        throw new Error('project_share_token_generation_failed');
      }
      const shareId = idGenerator.next();
      const created = await input.store.createGrant({
        ...createInput,
        id: shareId,
        tokenHash: sha256(token),
        createdAt: now
      });
      if (!created) throw new Error('project_share_scope_invalid');
      return {shareId, token, expiresAt: createInput.expiresAt};
    },

    revoke(revokeInput) {
      return input.store.revokeGrant({
        ...revokeInput,
        revokedAt: clock.now()
      });
    },

    async resolve(token) {
      const wellFormed = SHARE_TOKEN_PATTERN.test(token);
      const tokenHash = sha256(wellFormed ? token : DUMMY_SHARE_TOKEN);
      const grant = await input.store.findGrantByTokenHash(tokenHash);
      const now = clock.now();
      if (
        !wellFormed ||
        grant === null ||
        !sameHash(tokenHash, grant.tokenHash) ||
        grant.revokedAt !== null ||
        grant.expiresAt.getTime() <= now.getTime()
      ) {
        return null;
      }
      const recorded = await input.store.recordAccessIfActive(
        grant.id,
        tokenHash,
        now
      );
      return recorded ? publicProjection(grant) : null;
    }
  };
};

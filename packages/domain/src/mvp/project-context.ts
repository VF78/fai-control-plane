import {createHash} from 'node:crypto';
import {isBoundedId} from './model.ts';

export const projectContextSnapshotKind = 'project_context_snapshot_v1';
export const projectContextSourceKind = 'project_context_source_v1';
export const projectContextSnapshotMaxBytes = 4_000;

export type ProjectContextSource = Readonly<{
  contract: 'fai.project-context-source.v1';
  key: string;
  content: string;
}>;

export type ProjectContextSourceManifestEntry = Readonly<{
  id: string;
  key: string;
  kind: typeof projectContextSourceKind;
  version: string;
  provenance: string;
}>;

export type ProjectContextSnapshot = Readonly<{
  contract: 'fai.project-context.v1';
  sources: readonly ProjectContextSourceManifestEntry[];
  content: string;
}>;

const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0');
const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
const sourceKey = (value: unknown): value is string => typeof value === 'string' &&
  /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value);

export const parseProjectContextSource = (value: unknown): ProjectContextSource | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Partial<ProjectContextSource>;
  return source.contract === 'fai.project-context-source.v1' && sourceKey(source.key) && text(source.content, 200_000)
    ? {contract:'fai.project-context-source.v1',key:source.key,content:source.content} : null;
};

export const serializeProjectContextSource = (source: ProjectContextSource): string => {
  const parsed = parseProjectContextSource(source);
  if (parsed === null) throw new Error('project_context_source_invalid');
  return JSON.stringify(parsed);
};

export const parseProjectContextSnapshot = (value: unknown): ProjectContextSnapshot | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = value as Partial<ProjectContextSnapshot>;
  if (snapshot.contract !== 'fai.project-context.v1' || !Array.isArray(snapshot.sources) ||
    snapshot.sources.length === 0 || snapshot.sources.length > 20 || !text(snapshot.content, projectContextSnapshotMaxBytes)) {
    return null;
  }
  const sources: ProjectContextSourceManifestEntry[] = [];
  for (const candidate of snapshot.sources as unknown[]) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const source = candidate as Record<string, unknown>;
    if (!isBoundedId(source.id) || !sourceKey(source.key) || source.kind !== projectContextSourceKind ||
      !/^[a-f0-9]{64}$/.test(String(source.version)) ||
      !text(source.provenance, 512)) return null;
    sources.push(source as unknown as ProjectContextSourceManifestEntry);
  }
  if (new Set(sources.map((source) => source.id)).size !== sources.length ||
    new Set(sources.map((source) => source.key)).size !== sources.length) return null;
  const normalized = {contract: 'fai.project-context.v1' as const,
    sources: [...sources].sort((left, right) => left.key.localeCompare(right.key)), content: snapshot.content};
  return bytes(JSON.stringify(normalized)) <= projectContextSnapshotMaxBytes ? normalized : null;
};

export const serializeProjectContextSnapshot = (snapshot: ProjectContextSnapshot): string => {
  const parsed = parseProjectContextSnapshot(snapshot);
  if (parsed === null) throw new Error('project_context_invalid');
  return JSON.stringify(parsed);
};

export const projectContextSnapshotVersion = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

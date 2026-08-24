import {isBoundedId} from './model.ts';

export type ProjectProcessStage = Readonly<{
  id: string;
  title: string;
  responsibility: string;
  gate: string;
  evidence: string;
  nextStageId: string | null;
}>;

export type ProjectProcessPolicy = Readonly<{
  contract: 'fai.project-process.v1';
  stages: readonly ProjectProcessStage[];
}>;

const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0');

export const parseProjectProcessPolicy = (value: unknown): ProjectProcessPolicy | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const policy = value as Partial<ProjectProcessPolicy>;
  if (policy.contract !== 'fai.project-process.v1' || !Array.isArray(policy.stages) ||
    policy.stages.length === 0 || policy.stages.length > 50) return null;
  const stages: ProjectProcessStage[] = [];
  for (const candidate of policy.stages as unknown[]) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const stage = candidate as Record<string, unknown>;
    if (!isBoundedId(stage.id) || !text(stage.title, 200) || !text(stage.responsibility, 500) ||
      !text(stage.gate, 500) || !text(stage.evidence, 1_000) ||
      (stage.nextStageId !== null && !isBoundedId(stage.nextStageId))) return null;
    stages.push(stage as unknown as ProjectProcessStage);
  }
  const ids = new Set(stages.map((stage) => stage.id));
  if (ids.size !== stages.length || stages.some((stage) => stage.nextStageId !== null && !ids.has(stage.nextStageId))) {
    return null;
  }
  return {contract: 'fai.project-process.v1', stages};
};

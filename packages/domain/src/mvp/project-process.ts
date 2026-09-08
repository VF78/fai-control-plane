import {isBoundedId} from './model.ts';

export type ProjectProcessStage = Readonly<{
  id: string;
  title: string;
  responsibility: string;
  gate: string;
  evidence: string;
  nextStageId: string | null;
  automation: Readonly<{agentRole: 'manager'|'developer'|'qa'|'devops'; afterRoles: readonly ('manager'|'developer'|'qa'|'devops')[];
    maxStarts: number; reworkStageId: string | null}> | null;
}>;

export type ProjectProcessPolicy = Readonly<{
  contract: 'fai.project-process.v1';
  stages: readonly ProjectProcessStage[];
}>;

export const defaultProjectProcessPolicy: ProjectProcessPolicy = {contract: 'fai.project-process.v1', stages: [
  {id:'backlog',title:'Backlog',responsibility:'Product Owner',gate:'Уточнение',evidence:'Цель, требования, риски',nextStageId:'ready',automation:null},
  {id:'ready',title:'Ready',responsibility:'Product Owner',gate:'PO Ready: требуется',evidence:'Acceptance criteria, исполнитель, проверка',nextStageId:'in-dev',automation:null},
  {id:'in-dev',title:'In Dev',responsibility:'Разработчик или ИИ-агент',gate:'Явная команда оператора для запуска цепочки ИИ-агента',evidence:'Branch/worktree, PR, локальная проверка',nextStageId:'qa',automation:{agentRole:'developer',afterRoles:['qa'],maxStarts:2,reworkStageId:null}},
  {id:'qa',title:'QA',responsibility:'ИИ-агент',gate:'Автоматическое продолжение явно запущенной цепочки после подтверждённого статуса QA',evidence:'PR, checks, QA evidence',nextStageId:'acceptance',automation:{agentRole:'qa',afterRoles:['developer'],maxStarts:2,reworkStageId:'in-dev'}},
  {id:'acceptance',title:'Acceptance',responsibility:'Product Owner',gate:'Точное production-подтверждение перед DevOps',evidence:'QA evidence и production-подтверждение Product Owner',nextStageId:'done',automation:{agentRole:'devops',afterRoles:['qa'],maxStarts:1,reworkStageId:'qa'}},
  {id:'done',title:'Done',responsibility:'Product Owner',gate:'Терминальное состояние',evidence:'Явная приёмка результата',nextStageId:null,automation:null}
]};

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
    let automation: ProjectProcessStage['automation'] = null;
    if (stage.automation !== undefined && stage.automation !== null) {
      if (typeof stage.automation !== 'object' || Array.isArray(stage.automation)) return null;
      const configured = stage.automation as Record<string, unknown>;
      if (!['manager','developer','qa','devops'].includes(String(configured.agentRole)) ||
        !Array.isArray(configured.afterRoles) || configured.afterRoles.length === 0 || configured.afterRoles.length > 2 ||
        !configured.afterRoles.every((role) => ['manager','developer','qa','devops'].includes(String(role))) ||
        !Number.isInteger(configured.maxStarts) || (configured.maxStarts as number) < 1 || (configured.maxStarts as number) > 5) return null;
      if (configured.reworkStageId !== undefined && configured.reworkStageId !== null &&
        !isBoundedId(configured.reworkStageId)) return null;
      automation = {agentRole: configured.agentRole as 'manager'|'developer'|'qa'|'devops',
        afterRoles: configured.afterRoles as ('manager'|'developer'|'qa'|'devops')[],
        maxStarts: configured.maxStarts as number, reworkStageId: configured.reworkStageId as string | null ?? null};
    }
    stages.push({...stage, automation} as unknown as ProjectProcessStage);
  }
  const ids = new Set(stages.map((stage) => stage.id));
  if (ids.size !== stages.length || stages.some((stage) => stage.nextStageId !== null && !ids.has(stage.nextStageId))) {
    return null;
  }
  if (stages.some((stage) => stage.automation !== null && stage.automation.reworkStageId !== null &&
    !ids.has(stage.automation.reworkStageId))) return null;
  return {contract: 'fai.project-process.v1', stages};
};

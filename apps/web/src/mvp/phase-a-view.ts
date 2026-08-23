import {trackerEstimateMaximum, type TrackerItemFact} from '@fai-control-plane/domain';

export const phaseAStages = ['Backlog', 'Ready', 'In Dev', 'QA', 'Acceptance', 'Done'] as const;
export type PhaseAState = 'accepted' | 'review' | 'in-progress' | 'not-started';

export const phaseAState = (status: string | null): PhaseAState =>
  status === 'Done' ? 'accepted' : status === 'QA' || status === 'Acceptance' ? 'review'
    : status === 'Ready' || status === 'In Dev' ? 'in-progress' : 'not-started';

export const readableAssignees = (item: TrackerItemFact): string =>
  item.assignees.map((assignee) => assignee.name ?? assignee.login).join(', ') || 'Не назначен';

export type DashboardProjection = Readonly<{
  configured: boolean;
  total: number;
  states: Readonly<Record<PhaseAState, number>>;
  phase: string;
  deadline: string | null;
  blocked: number | null;
}>;

export const dashboardProjection = (tasks: readonly TrackerItemFact[]): DashboardProjection => {
  const configured = tasks.length > 0 && tasks.every((task) => task.estimate !== null &&
    Number.isFinite(task.estimate) && task.estimate > 0 && task.estimate <= trackerEstimateMaximum);
  const states: Record<PhaseAState, number> = {accepted: 0, review: 0, 'in-progress': 0, 'not-started': 0};
  if (configured) for (const task of tasks) states[phaseAState(task.statusOptionName)] += task.estimate!;
  const active = tasks.filter((task) => task.statusOptionName !== 'Done');
  const dates = active.map((task) => task.targetDate).filter((date): date is string => date !== null).sort();
  const hasBlockedFact = active.some((task) => task.blocked !== null);
  return {configured, total: Object.values(states).reduce((sum, value) => sum + value, 0), states,
    phase: [...phaseAStages].reverse().find((stage) => active.some((task) => task.statusOptionName === stage)) ?? 'Не определена',
    deadline: dates[0] ?? null, blocked: hasBlockedFact ? active.filter((task) => task.blocked === true).length : null};
};

export type ProcessStage = Readonly<{name: typeof phaseAStages[number]; responsibility: string; gate: string; evidence: string; next: string}>;
export const asconProcess: readonly ProcessStage[] = [
  {name: 'Backlog', responsibility: 'Product Owner', gate: 'Уточнение', evidence: 'Цель, требования, риски', next: 'Ready'},
  {name: 'Ready', responsibility: 'Product Owner', gate: 'PO Ready: требуется', evidence: 'Acceptance criteria, исполнитель, проверка', next: 'In Dev'},
  {name: 'In Dev', responsibility: 'Разработчик или Hermes', gate: 'Явная команда оператора для Hermes', evidence: 'Branch/worktree, PR, локальная проверка', next: 'QA'},
  {name: 'QA', responsibility: 'Hermes', gate: 'Явная команда оператора', evidence: 'PR, checks, QA evidence', next: 'Acceptance'},
  {name: 'Acceptance', responsibility: 'Product Owner', gate: 'PO gate в Done: требуется', evidence: 'QA evidence, staging deploy, smoke-test', next: 'Done'},
  {name: 'Done', responsibility: 'Product Owner', gate: 'Терминальное состояние', evidence: 'Явная приёмка результата', next: 'Завершение процесса'}
];

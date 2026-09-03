import type {TrackerItemFact} from '@fai-control-plane/domain';

export const phaseAStages = ['Backlog', 'Ready', 'In Dev', 'QA', 'Acceptance', 'Done'] as const;
export type PhaseAState = 'accepted' | 'review' | 'in-progress' | 'not-started';

export const phaseAState = (status: string | null): PhaseAState =>
  status === 'Done' ? 'accepted' : status === 'QA' || status === 'Acceptance' ? 'review'
    : status === 'Ready' || status === 'In Dev' ? 'in-progress' : 'not-started';

export const executorFact = (item: TrackerItemFact, hermesOwnerOptionId: string | undefined): string => {
  const humans = item.assignees.map((assignee) => assignee.name ?? assignee.login).join(', ');
  const hermes = hermesOwnerOptionId !== undefined && item.ownerOptionId === hermesOwnerOptionId;
  if (hermes && humans) return `Конфликт: ИИ-агент + ${humans}`;
  return hermes ? 'ИИ-агент' : humans || 'Не назначен';
};
export const readableAssignees = (item: TrackerItemFact, hermesOwnerOptionId?: string): string => executorFact(item, hermesOwnerOptionId);

export type DashboardProjection = Readonly<{
  total: number;
  states: Readonly<Record<PhaseAState, number>>;
  phase: string;
  deadline: string | null;
  blocked: number | null;
}>;

export const dashboardProjection = (tasks: readonly TrackerItemFact[]): DashboardProjection => {
  const states: Record<PhaseAState, number> = {accepted: 0, review: 0, 'in-progress': 0, 'not-started': 0};
  for (const task of tasks) states[phaseAState(task.statusOptionName)] += 1;
  const active = tasks.filter((task) => task.statusOptionName !== 'Done');
  const dates = active.map((task) => task.targetDate).filter((date): date is string => date !== null).sort();
  const hasBlockedFact = active.some((task) => task.blocked !== null);
  return {total: tasks.length, states,
    phase: [...phaseAStages].reverse().find((stage) => active.some((task) => task.statusOptionName === stage)) ??
      (tasks.some((task) => task.statusOptionName === 'Done') ? 'Done' : 'Не определена'),
    deadline: dates[0] ?? null, blocked: active.length === 0 && tasks.length > 0 ? 0 :
      hasBlockedFact ? active.filter((task) => task.blocked === true).length : null};
};

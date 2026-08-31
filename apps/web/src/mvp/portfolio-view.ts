export type PortfolioTask = Readonly<{
  itemId: string;
  issueId: string;
  title: string;
  url: string;
  statusOptionName: string | null;
  blocked: boolean | null;
  targetDate: string | null;
}>;

export type PortfolioProjectInput = Readonly<{
  id: string;
  name: string;
  repositoryUrl: string;
  tracker: Readonly<{
    sourceUrl: string | null;
    observedAt: string | null;
    freshness: 'fresh' | 'stale' | 'error' | 'unavailable';
    errorCode: string | null;
  }>;
  tasks: readonly PortfolioTask[];
}>;

export type PortfolioFocus = Readonly<{
  itemId: string;
  issueId: string;
  title: string;
  url: string;
  status: string;
  detail: string;
  kind: 'overdue' | 'blocked' | 'control';
}>;

export type PortfolioProject = Readonly<{
  id: string;
  name: string;
  sourceUrl: string;
  freshness: PortfolioProjectInput['tracker']['freshness'];
  observedAt: string | null;
  total: number;
  done: number;
  open: number;
  blocked: number | null;
  overdue: number;
  phase: string;
  nextControl: string | null;
  health: 'attention' | 'steady' | 'unavailable';
  healthReason: string;
  focus: readonly PortfolioFocus[];
  decision: PortfolioFocus | null;
}>;

const isDone = (status: string | null): boolean => /(^|\s)done(\s|$)|заверш/i.test(status ?? '');
const isBlockedByStatus = (task: PortfolioTask): boolean => /block|заблок/i.test(task.statusOptionName ?? '');
const isBlocked = (task: PortfolioTask): boolean => task.blocked === true || isBlockedByStatus(task);
const todayKey = (now: Date): string => now.toISOString().slice(0, 10);
const status = (task: PortfolioTask): string => task.statusOptionName ?? 'Без статуса';
const dateSort = (left: PortfolioTask, right: PortfolioTask): number =>
  (left.targetDate ?? '9999-12-31').localeCompare(right.targetDate ?? '9999-12-31');
const focusFor = (task: PortfolioTask, kind: PortfolioFocus['kind'], detail: string): PortfolioFocus => ({
  itemId: task.itemId, issueId: task.issueId, title: task.title, url: task.url, status: status(task), detail, kind
});

export const buildPortfolioProject = (input: PortfolioProjectInput, now = new Date()): PortfolioProject => {
  const current = todayKey(now);
  const total = input.tasks.length;
  const done = input.tasks.filter((task) => isDone(task.statusOptionName)).length;
  const openTasks = input.tasks.filter((task) => !isDone(task.statusOptionName));
  const overdueTasks = openTasks.filter((task) => task.targetDate !== null && task.targetDate < current).sort(dateSort);
  const blockedTasks = openTasks.filter(isBlocked).sort(dateSort);
  const controlTasks = openTasks.filter((task) => task.targetDate !== null && task.targetDate > current).sort(dateSort);
  const phase = [...new Set(openTasks.map(status))].slice(0, 2).join(' · ') || 'Не определена';
  const focus = [
    ...overdueTasks.map((task) => focusFor(task, 'overdue', `Просрочено · срок ${task.targetDate}`)),
    ...blockedTasks.filter((task) => !overdueTasks.includes(task)).map((task) =>
      focusFor(task, 'blocked', 'Подтверждённая блокировка требует внимания')),
    ...controlTasks.filter((task) => !overdueTasks.includes(task) && !blockedTasks.includes(task)).map((task) =>
      focusFor(task, 'control', `Контроль ${task.targetDate}`))
  ].slice(0, 2);
  const unavailable = input.tracker.freshness === 'unavailable' || input.tracker.freshness === 'error';
  const health = unavailable || input.tracker.freshness === 'stale' || overdueTasks.length > 0 || blockedTasks.length > 0
    ? unavailable ? 'unavailable' : 'attention' : 'steady';
  const healthReason = input.tracker.errorCode !== null ? 'Источник пока не подтвердил обновление.'
    : input.tracker.freshness === 'unavailable' ? 'Подтверждённый снимок задач ещё не получен.'
      : input.tracker.freshness === 'stale' ? 'Снимок задач устарел; требуется обновление источника.'
        : blockedTasks.length > 0 && overdueTasks.length > 0 ? `Вывод по фактам: заблокировано ${blockedTasks.length} · просрочено ${overdueTasks.length}.`
          : blockedTasks.length > 0 ? `Вывод по фактам: заблокировано ${blockedTasks.length}.`
          : overdueTasks.length > 0 ? `Вывод по фактам: ${overdueTasks.length} открытых задач просрочено.`
            : 'В доступном снимке нет просроченных задач или статусов «Заблокировано».';
  return {id: input.id, name: input.name, sourceUrl: input.tracker.sourceUrl ?? input.repositoryUrl,
    freshness: input.tracker.freshness, observedAt: input.tracker.observedAt, total, done, open: total - done,
    blocked: openTasks.some((task) => task.blocked !== null || isBlockedByStatus(task)) ? blockedTasks.length : null,
    overdue: overdueTasks.length, phase,
    nextControl: controlTasks[0]?.targetDate ?? null, health, healthReason, focus, decision: focus[0] ?? null};
};

export const buildPortfolio = (projects: readonly PortfolioProjectInput[], now = new Date()): readonly PortfolioProject[] =>
  projects.map((project) => buildPortfolioProject(project, now));

import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

const source = () => readFile(new URL('./phase-a-ui.tsx', import.meta.url), 'utf8');

describe('sections-first operator navigation', () => {
  it('keeps internal workspace navigation in the persistent router without background prefetches', async () => {
    const [phaseA,phaseB]=await Promise.all([source(),readFile(new URL('./phase-b-ui.tsx',import.meta.url),'utf8')]);
    for (const view of [phaseA,phaseB]) {
      expect(view).toContain("import Link from 'next/link'");
      expect(view).toContain('prefetch={false}');
      expect(view).not.toMatch(/<a[^>]+href=\{phaseHref/);
    }
    expect(phaseA).not.toContain('<a href={item.href}');
  });

  it('keeps one complete section list without project navigation modes', async () => {
    const view=await source();
    expect(view).toContain("const navigation: readonly PhaseArea[] = ['dashboard','tasks','process','conversations','systems','settings','people']");
    expect(view).toContain('aria-label="Разделы"');
    expect(view).not.toContain('Все проекты');
    expect(view).not.toContain('fcp-selected-project');
    expect(view).not.toContain('fcp-project-list-nav');
  });

  it('uses a Tasks-only project selector and deterministic default project', async () => {
    const [view,page]=await Promise.all([source(),readFile(new URL('../../app/page.tsx',import.meta.url),'utf8')]);
    expect(view).toContain('function ProjectSelector');
    expect(view).toContain('className="fcp-task-project-selector"');
    expect(view).toContain('<nav aria-label="Выберите проект">');
    expect(view).toContain("aria-current={item.id === project.id ? 'page' : undefined}");
    expect(view).toContain("href={phaseHref('tasks',item.slug)} prefetch={false}");
    expect(page).toContain("const selected = view === 'tasks'");
    expect(page).toContain('?? projects[0] ?? null');
    expect(page).toContain('<Tasks projects={projects} project={selected}');
  });
});

describe('portfolio Phase A pages', () => {
  it('keeps task-count visualization separated by project', async () => {
    const view=await source();
    expect(view).toContain('dashboardProjection(project.tasks)');
    expect(view).toContain('fcp-dashboard-progress-card');
    expect(view).toContain('Прогресс по количеству задач');
    expect(view).not.toContain('freshness(');
  });

  it('renders one process block per project with progressive agent actions', async () => {
    const [view,page]=await Promise.all([source(),readFile(new URL('../../app/page.tsx',import.meta.url),'utf8')]);
    expect(view).toContain('export function Process({projects}');
    expect(view).toContain('projects.map(({project,processPolicy,executionMode,routing,context,canManageRouting,canManageContext})');
    expect(view).toContain('ProjectExecutionModeControl');
    expect(view).toContain('AgentRoutingControl');
    expect(view).toContain('HermesContextControl');
    expect(view).toContain('<summary>Настройка ИИ-агента</summary>');
    expect(view).toContain('<summary>Контекст ИИ-агента</summary>');
    expect(page).toContain('const processProjects = await Promise.all(projects.map');
  });
});

describe('Task detail operator surface', () => {
  it('keeps only task facts, GitHub link and assignment action', async () => {
    const view=await source();const detail=view.slice(view.indexOf('function TaskDetail'),view.indexOf('export function Tasks'));
    expect(detail).toContain('Открыть issue в GitHub');
    expect(detail).toContain('Исполнитель');
    expect(detail).toContain('Состояние');
    expect(detail).not.toContain('Провайдер');
    expect(detail).not.toContain('Свежесть');
    expect(detail).not.toContain('Ошибка');
  });
});

import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

const source = () => readFile(new URL('./phase-a-ui.tsx', import.meta.url), 'utf8');

describe('sections-first operator navigation', () => {
  it('keeps query-only workspace navigation on the reliable document path', async () => {
    const [phaseA,phaseB]=await Promise.all([source(),readFile(new URL('./phase-b-ui.tsx',import.meta.url),'utf8')]);
    expect(phaseA).not.toContain("import Link from 'next/link'");
    expect(phaseB).toContain("import Link from 'next/link'");
    expect(phaseA).not.toContain('prefetch={false}');
    expect(phaseB).not.toContain('prefetch={false}');
    expect(phaseA).toMatch(/<a[^>]+href=\{phaseHref/);
    expect(phaseA).toContain('<a href={item.url}');
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
    expect(view).toContain('className="fcp-c-task-project-selector"');
    expect(view).toContain('<nav aria-label="Выберите проект">');
    expect(view).toContain("aria-current={item.id === project.id ? 'page' : undefined}");
    expect(view).toContain("href={phaseHref('tasks',item.slug)}");
    expect(page).toContain("const selected = view === 'tasks'");
    expect(page).toContain('?? projects[0] ?? null');
    expect(page).toContain('<Tasks projects={projects} project={selected}');
  });
});

describe('portfolio Phase A pages', () => {
  it('keeps task-count visualization separated by project', async () => {
    const view=await source();
    expect(view).toContain('buildPortfolio(projects)');
    expect(view).toContain('ProjectPanel');
    expect(view).toContain('className="fcp-c-project-panel-grid is-stack" aria-label="Портфель проектов"');
    expect(view).toContain('dashboardProjection(source.tasks)');
    expect(view).toContain('fcp-c-task-count-bar');
    expect(view).toContain('Открыть задачи');
    expect(view).toContain('role="progressbar"');
    expect(view).toContain('aria-valuetext={stateLegend.map');
    expect(view).toContain('текущий фокус и подтверждённые риски');
    expect(view).not.toContain('errorCode');
    expect(view).toContain("['warning','Снимок GitHub устарел.']");
    expect(view).toContain("['danger','Источник пока не подтвердил обновление.']");
  });

  it('renders scan-first project sections with one project-qualified agent action', async () => {
    const [view,page]=await Promise.all([source(),readFile(new URL('../../app/page.tsx',import.meta.url),'utf8')]);
    expect(view).toContain('export function ProcessRail');
    expect(view).toContain('export function Process({projects}');
    expect(view).toContain('projects.map((item)=><ProcessProjectSection item={item}');
    expect(view).toContain('ProjectExecutionModeControl');
    expect(view).toContain('AgentRoutingControl');
    expect(view).toContain('HermesContextControl');
    expect(view).toContain('className="fcp-c-project-sections" aria-label="Процессы проектов"');
    expect(view).toContain('<ProjectSection name={project.name}');
    expect(view).toContain('projectName={project.name}');
    expect(view).toContain('fcp-c-process-facts');
    expect(view).toContain('Сначала завершите настройку проекта.');
    expect(view).toContain('configured?<><ProcessRail');
    expect(view).not.toContain('Настройка ИИ-агента</summary>');
    expect(view).not.toContain('Контекст ИИ-агента</summary>');
    expect(page).toContain('const processProjects = await Promise.all(projects.map');
  });
});

describe('Task detail operator surface', () => {
  it('keeps only task facts, GitHub link and assignment action', async () => {
    const view=await source();const detail=view.slice(view.indexOf('function TaskDetail'),view.indexOf('export function Tasks'));
    expect(detail).toContain('Открыть задачу в GitHub');
    expect(detail).toContain('Исполнитель');
    expect(detail).toContain('Состояние');
    expect(detail).not.toContain('Провайдер');
    expect(detail).not.toContain('Свежесть');
    expect(detail).not.toContain('Ошибка');
  });

  it('renders a mobile stage switch without a clipped board', async () => {
    const board=await readFile(new URL('./task-board.tsx',import.meta.url),'utf8');
    expect(board).toContain('className="fcp-c-task-mobile-stages"');
    expect(board).toContain('role="tablist"');
    expect(board).toContain('role="tabpanel"');
    expect(board).toContain("event.key==='ArrowRight'");
    expect(board).toContain("event.key==='ArrowLeft'");
    expect(board).toContain("event.key==='Home'");
    expect(board).toContain("event.key==='End'");
    expect(board).toContain('tabIndex={stage===candidate?0:-1}');
    expect(board).toContain('aria-labelledby={`${stageBase}-tab-${index}`}');
    expect(await readFile(new URL('../../app/styles/foundation.css',import.meta.url),'utf8')).toContain('.fcp-c-task-mobile-list[hidden] { display:none; }');
    expect(board).not.toContain('GitHub #');
  });
});

import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

const source = () => readFile(new URL('./phase-a-ui.tsx', import.meta.url), 'utf8');

describe('Process Hermes execution surface', () => {
  it('keeps execution in Process with the existing context-tab grammar', async () => {
    const view = await source();
    expect(view).toContain("{label:'Этапы'");
    expect(view).toContain("{label:'Исполнение Hermes'");
    expect(view).toContain("filter === 'hermes'");
    expect(view).toContain('AgentRoutingControl');
    expect(view).toContain('Hermes сам определяет класс задачи');
  });

  it('keeps the project process policy read-only and excludes manual task classification', async () => {
    const view = await source();
    expect(view).toContain('Проектная политика процесса · только чтение');
    expect(view).toContain("{label:'Контекст Hermes'");
    expect(view).toContain('Назначать класс вручную не требуется.');
    expect(view).not.toContain('Назначить класс задачи');
  });

  it('keeps policy reads in the page composition instead of the client control', async () => {
    const [page, control] = await Promise.all([
      readFile(new URL('../../app/page.tsx', import.meta.url), 'utf8'),
      readFile(new URL('./operator-controls.tsx', import.meta.url), 'utf8')
    ]);
    expect(page).toContain('readAgentRoutingPolicy(database, session.actorId, selected.id)');
    expect(page).toContain('<Process project={selected} filter={query.filter} routing={routing} processPolicy={processPolicy} activeContext={activeContext} canManageRouting={canManageRouting} canManageContext={canManageContext}/>');
    expect(control).not.toContain('readAgentRoutingPolicy(');
  });

  it('keeps only the permitted execution classes editable and Claude unavailable', async () => {
    const control = await readFile(new URL('./operator-controls.tsx', import.meta.url), 'utf8');
    expect(control).toContain("['manager_project_ops', 'architecture_design', 'critical_decision', 'release_preflight']");
    expect(control).toContain('Claude Code CLI · недоступен');
    expect(control).toContain('disabled');
    expect(control).toContain('Сохранение недоступно, пока Control Plane не подтвердит runtime Codex CLI.');
  });
});

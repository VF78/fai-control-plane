import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

const source = () => readFile(new URL('./phase-a-ui.tsx', import.meta.url), 'utf8');

describe('Process Hermes execution surface', () => {
  it('keeps execution in Process with the existing context-tab grammar', async () => {
    const view = await source();
    expect(view).toContain("{label:'Этапы'");
    expect(view).toContain("{label:'Настройка ИИ агента'");
    expect(view).toContain("filter === 'hermes'");
    expect(view).toContain('AgentRoutingControl');
    expect(view).toContain('ИИ агент сам определяет класс задачи');
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

  it('keeps only valid routing fields editable and Claude unavailable', async () => {
    const control = await readFile(new URL('./operator-controls.tsx', import.meta.url), 'utf8');
    expect(control).toContain("['manager_project_ops', 'architecture_design', 'critical_decision', 'release_preflight']");
    expect(control).toContain('Claude Code CLI');
    expect(control).toContain('label="Рассуждение"');
    expect(control).toContain('value={route.effort === \'high\' ? \'Высокое\' : \'Среднее\'}');
    expect(control).toContain('<Pencil');
    expect(control).toContain('fcp-agent-routing-setting');
    expect(control).not.toContain('Изменить исполнение и модель');
    expect(control).not.toContain('label="Усилие"');
    expect(control).toContain('disabled');
    expect(control).toContain('Редактирование станет доступно после подключения Codex CLI.');
  });
});

describe('Task detail operator surface', () => {
  it('keeps only task facts, the issue link, and the assignment action', async () => {
    const [view, page] = await Promise.all([
      source(),
      readFile(new URL('../../app/page.tsx', import.meta.url), 'utf8')
    ]);
    const taskDetail = view.slice(view.indexOf('export function TaskDetail'), view.indexOf('export function Tasks'));
    expect(taskDetail).toContain('className="fcp-task-detail"');
    expect(taskDetail).toContain('showTrackerState={false}');
    expect(taskDetail).toContain('Открыть issue в GitHub');
    expect(taskDetail).toContain('Исполнитель');
    expect(taskDetail).toContain('Состояние');
    expect(taskDetail).not.toContain('Project item');
    expect(taskDetail).not.toContain('Единственный источник task lifecycle');
    expect(taskDetail).not.toContain('Провайдер');
    expect(taskDetail).not.toContain('Свежесть');
    expect(taskDetail).not.toContain('Ошибка');
    expect(page).not.toContain('approvalControl=');
    expect(page).not.toContain('TaskApprovalEvidence');
  });
});

import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

const source = async (name:string) => readFile(new URL(`./${name}`,import.meta.url),'utf8');

describe('portfolio Phase B operator surfaces', () => {
  it('composes every Phase B page from separated project blocks', async () => {
    const view=await source('phase-b-ui.tsx');
    expect(view).toContain('export type PhaseBProject');
    expect(view).toContain('function ProjectBlock');
    expect(view).toContain('className="fcp-portfolio-blocks"');
    expect(view).toContain('projects.map');
    expect(view).not.toContain('project: ProjectTaskView|null');
  });

  it('keeps chats and systems actionable without event, audit or receipt feeds', async () => {
    const [view,page]=await Promise.all([source('phase-b-ui.tsx'),source('../../app/page.tsx')]);
    expect(view).toContain('Рабочие каналы и доступ команды');
    expect(view).toContain('Перейти к задачам');
    expect(view).not.toContain('EvidenceList');
    expect(view).not.toMatch(/receipts|audit|agentSubmissions|lastOccurredAt|occurredAt/);
    expect(page).not.toMatch(/'receipts'|'audit'|'agentSubmissions'|'messenger'/);
  });

  it('keeps one resumable project wizard and per-project settings', async () => {
    const [view,wizard]=await Promise.all([source('phase-b-ui.tsx'),source('project-wizard.tsx')]);
    expect(view).toContain('<ProjectSetupWizard item={selected} contextCurrent={selectedContextCurrent} actorId={actorId} workspacePeople={workspacePeople}/>');
    expect(view).toContain('/?view=settings&setup=create');
    expect(view).toContain('Настройка не завершена');
    expect(view).toContain('Продолжить настройку');
    expect(wizard).toContain('export function ProjectSetupWizard');
    expect(wizard).toContain('<ProjectDeleteControl');
    expect(wizard).toContain("action:'confirm_and_start'");
    expect(view).toContain('activeDocuments.map');
    expect(view).toContain('ProjectDocumentUploadControl');
    expect(view).toContain('ProjectAgentActivationControl');
    expect(view).toContain('Репозиторий');
    expect(view).toContain('GitHub Project');
  });

  it('loads shared projections once and per-project facts concurrently', async () => {
    const page=await source('../../app/page.tsx');
    expect(page).toContain('listProjectOperatorEvidenceViews(database, session.actorId, evidenceSections)');
    expect(page).toContain('listProjectSourceViews(database, session.actorId)');
    expect(page).toContain('Promise.all(projects.map(async (project)');
    expect(page).toContain('<PhaseB view={view} projects={phaseBProjects}');
  });

  it('uses shared async controls for all mutations', async () => {
    const [control,wizard]=await Promise.all([source('operator-controls.tsx'),source('project-wizard.tsx')]);
    expect(wizard).toContain('useAsyncCommand');
    expect(control).not.toContain('export function ProjectRegistrationControl');
    expect(control).toContain('export function ProjectDocumentUploadControl');
    expect(control).toContain('export function AccessControls');
    expect(control).toContain('AsyncButton');
    expect(control).toContain('aria-busy={command.pending}');
    expect(control).not.toContain('export function ApprovalControl');
  });

  it('renders the exact persisted Hermes approval through the canonical approval API',async()=>{
    const [wizard,api]=await Promise.all([source('project-wizard.tsx'),source('api.ts')]);
    expect(wizard).toContain("kind:'internal_operation'");
    expect(wizard).toContain('targetReference:approval.version');
    expect(wizard).toContain('/api/approvals/${encodeURIComponent(approval.id)}');
    expect(wizard).toContain('preparation.approval.text');
    expect(api).toContain("kind==='internal_operation'?await persistence.targets.resolve");
    expect(api).toContain('if(artifactTarget!==null)return');
  });

  it('keeps the approved ten-step order and persists optional skips outside local state',async()=>{
    const wizard=await source('project-wizard.tsx');const titles=['Репозиторий и задачи','Документы','Процесс','Команда и роли',
      'Коммуникации','ИИ-агент','Контекст','Подготовка Project','Проверка готовности','Первая задача'];
    let offset=-1;for(const title of titles){const next=wizard.indexOf(`title="${title}"`);expect(next).toBeGreaterThan(offset);offset=next;}
    expect(wizard).toContain("action:'confirm_process'");expect(wizard).toContain("action:'skip_team'");
    expect(wizard).toContain("action:'skip_communications'");expect(wizard).toContain('<AccessControls');
    expect(wizard).toContain('<TelegramSettingsControl');expect(wizard).not.toContain('function Messenger(');
  });

  it('keeps setup sequential and reuses the bounded document editor',async()=>{
    const [wizard,control]=await Promise.all([source('project-wizard.tsx'),source('operator-controls.tsx')]);
    expect(wizard).toContain('<ProjectDocumentsEditor projectId={item.project.id}/>');
    expect(wizard).toContain('Будет доступен позже');
    expect(wizard).toContain('Вставить ссылку GitHub');
    expect(wizard).not.toContain('<select value={task?.itemId');
    expect(control).toContain('export function ProjectDocumentsEditor');
    expect(control).toContain('Загрузить документы');
    expect(control).toContain('upload_timeout');
    expect(control).not.toContain('Изменить членство');
    expect(control).toContain('Справочник сотрудников');
    expect(control).toContain('existingActorId:candidate.actorId');
    const access=control.split('export function AccessControls',2)[1]!.split('type AssignableUser',1)[0]!;
    expect(access).not.toContain('<select');
  });
});

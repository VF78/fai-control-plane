import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

const source = async (name: string) => readFile(new URL(`./${name}`, import.meta.url), 'utf8');

describe('Phase B operator surfaces', () => {
  it('keeps Systems diagnostics without restoring a launch control', async () => {
    const view = await source('phase-b-ui.tsx');
    expect(view).toContain("export type PhaseBView = 'conversations'|'people'|'systems'|'settings'");
    expect(view).toContain('function Systems');
    expect(view).toContain('задачу GitHub Project');
    expect(view).not.toContain('AgentSubmitControl');
    expect(view).toContain('AccessControls');
    expect(view).not.toContain('SourceAddControl');
    expect(view).not.toContain('TaskApprovalEvidence');
    expect(view).not.toContain('Маршрутизация ролей');
    expect(view).not.toContain('AgentRoutingControl');
  });

  it('does not reintroduce deleted runtime, chat, or access-control surfaces', async () => {
    const view = await source('phase-b-ui.tsx');
    expect(view).not.toMatch(/AgentRun|RuntimeRegistrationControls|InstructionHistory|ConversationChannel|message-list|scheduler|currentWork|heartbeat/);
    expect(view).not.toContain('ApprovalControl');
  });

  it('keeps settings to project setup and exposes explicit project registration and agent activation', async () => {
    const page = await source('../../app/page.tsx');
    const view = await source('phase-b-ui.tsx');
    expect(page).toContain("view === 'tasks'");
    expect(page).not.toContain('ApprovalControl');
    expect(page).not.toContain('TaskApprovalEvidence');
    expect(page).toContain('<PhaseB view={view}');
    expect(page).toContain('TaskExecutorControl');
    expect(page).toContain('readProjectAgentSubmissionView(database, session.actorId, selected.id, query.task)');
    expect(page).toContain('projectAgentDeliveryConfigured(database, session.actorId, selected.id)');
    expect(page).toContain('integrationConfig(process.env, agentDeliveryConfigured)');
    expect(view).not.toContain('integrationConfig(');
    expect(view).toContain('title="Настройки проектов"');
    expect(view).toContain('action={<ProjectRegistrationControl/>}');
    expect(view).toContain('ProjectAgentActivationControl');
    expect(view).toContain('activeDocuments.map');
    expect(view).not.toContain('Другие источники');
    expect(view).not.toContain('Точные согласования');
    expect(view).not.toContain('Другой проект');
    expect(view).not.toContain('источники Control Plane');
  });

  it('loads only the projections required by the selected surface', async () => {
    const page = await source('../../app/page.tsx');
    expect(page).toContain("view === 'settings' ? listProjectSourceViews");
    expect(page).not.toContain('listApprovalEvidenceViews');
    expect(page).toContain("view === 'systems' ? projectAgentDeliveryConfigured");
    expect(page).toContain("view === 'conversations'\n      ? ['people','messenger','conversations']");
    expect(page).toContain("view === 'systems' ? ['receipts','audit','agentSubmissions']");
    expect(page).not.toContain('const [projects, sources, approvals, operatorEvidence]');
  });

  it('uses direct buttons and inline forms for project and document setup', async () => {
    const control = await source('operator-controls.tsx');
    const registration = control.slice(control.indexOf('export function ProjectRegistrationControl'), control.indexOf('export function ProjectAgentActivationControl'));
    const documents = control.slice(control.indexOf('export function ProjectDocumentUploadControl'), control.indexOf('export function ProjectRegistrationControl'));
    expect(registration).toContain('Добавить проект');
    expect(registration).toContain('className="fcp-inline-form"');
    expect(registration).not.toContain('<details');
    expect(documents).toContain('Загрузить документ');
    expect(documents).toContain('className="fcp-inline-form"');
    expect(documents).not.toContain('<details');
    expect(control).not.toContain('export function SourceAddControl');
  });
});

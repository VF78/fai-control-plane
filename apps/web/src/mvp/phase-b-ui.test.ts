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
    expect(view).toContain('SourceAddControl');
    expect(view).toContain('TaskApprovalEvidence');
    expect(view).toContain('Точные согласования');
    expect(view).not.toContain('Маршрутизация ролей');
    expect(view).not.toContain('AgentRoutingControl');
  });

  it('does not reintroduce deleted runtime, chat, or access-control surfaces', async () => {
    const view = await source('phase-b-ui.tsx');
    expect(view).not.toMatch(/AgentRun|RuntimeRegistrationControls|InstructionHistory|ConversationChannel|message-list|scheduler|currentWork|heartbeat/);
    expect(view).not.toContain('ApprovalControl');
  });

  it('keeps approvals selected-task-only and exposes explicit project registration and agent activation', async () => {
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
    expect(view).toContain('ProjectRegistrationControl');
    expect(view).toContain('ProjectAgentActivationControl');
  });

  it('loads only the projections required by the selected surface', async () => {
    const page = await source('../../app/page.tsx');
    expect(page).toContain("view === 'settings' ? listProjectSourceViews");
    expect(page).toContain("view === 'settings' ? listApprovalEvidenceViews");
    expect(page).toContain("view === 'systems' ? projectAgentDeliveryConfigured");
    expect(page).toContain("view === 'conversations'\n      ? ['people','messenger','conversations']");
    expect(page).toContain("view === 'systems' ? ['receipts','audit','agentSubmissions']");
    expect(page).not.toContain('const [projects, sources, approvals, operatorEvidence]');
  });
});

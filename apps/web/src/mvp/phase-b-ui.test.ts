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

  it('keeps direct portfolio registration and per-project settings', async () => {
    const view=await source('phase-b-ui.tsx');
    expect(view).toContain('action={<ProjectRegistrationControl/>}');
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
    const control=await source('operator-controls.tsx');
    expect(control).toContain('export function ProjectRegistrationControl');
    expect(control).toContain('export function ProjectDocumentUploadControl');
    expect(control).toContain('export function AccessControls');
    expect(control).toContain('AsyncButton');
    expect(control).toContain('aria-busy={command.pending}');
    expect(control).not.toContain('export function ApprovalControl');
  });
});

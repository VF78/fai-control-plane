import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

const read = (name: string) => readFile(new URL(`./${name}`, import.meta.url), 'utf8');

describe('operator UI foundation', () => {
  it('keeps one shared async command contract for all current operator mutations', async () => {
    const [control, primitive] = await Promise.all([read('operator-controls.tsx'), read('async-command.tsx')]);
    expect(control).toContain("from './async-command.tsx'");
    expect(control).toContain('useAsyncCommand');
    expect(control).toContain('AsyncButton');
    expect(control.match(/<button/g)).toHaveLength(1);
    expect(control).toContain('function DocumentCategoryChoice');
    expect(control).toContain('aria-pressed={value===category}');
    expect(primitive).toContain('inFlight.current');
    expect(primitive).toContain('aria-busy={pending || undefined}');
    expect(primitive).toContain('fcp-button-spinner');
    expect(primitive).toContain('CommandNoticeView');
  });

  it('does not render technical diagnostics in the operator surfaces', async () => {
    const [phaseA, phaseB, control] = await Promise.all([read('phase-a-ui.tsx'), read('phase-b-ui.tsx'), read('operator-controls.tsx')]);
    expect(phaseA).not.toContain('Ошибка: ${project.tracker.errorCode}');
    expect(phaseB).not.toContain('subjectHash.slice');
    expect(phaseB).not.toContain('item.resultReference');
    expect(control).not.toContain('sha256:');
    expect(control).not.toContain('Квитанция {activeRun.deliveryReference}');
  });

  it('keeps overflow containment and mobile layouts in the shared workspace CSS', async () => {
    const [css,tokens,foundation,projects] = await Promise.all([read('../../app/styles/controls.css'),read('../../app/styles/tokens.css'),read('../../app/styles/foundation.css'),read('../../app/styles/projects.css')]);
    expect(css).toContain('overflow-x: clip');
    expect(css).toContain('@media (max-width:700px)');
    expect(tokens).toContain('--fcp-target:44px');
    expect(tokens).toContain('--fcp-action-primary:#0969da');
    expect(foundation).toContain('.fcp-c-tab-list');
    expect(projects).toContain('.fcp-c-project-row');
    expect(css).not.toContain('.fcp-project-wizard');
  });

  it('keeps status columns aligned and control typography on the shared type scale', async () => {
    const [css,projects,foundation] = await Promise.all([read('../../app/styles/controls.css'),read('../../app/styles/projects.css'),read('../ui/foundation.tsx')]);
    expect(projects).toContain('grid-template-columns:minmax(0,1fr) 150px 170px');
    expect(foundation).toContain('className="fcp-c-project-row-status"');
    expect(css).toContain('.fcp-document-drop {');
    expect(css).toContain('font-family:inherit; font-size:12px; font-weight:400;');
    expect(projects).not.toMatch(/font:[^;]*px[^;]*inherit/);
    expect(css).not.toMatch(/\.fcp-document-drop \{[^}]*font:[^;}]*inherit/);
  });

  it('uses one desktop content scroller while mobile keeps a natural document flow', async () => {
    const css = await read('../../app/styles/controls.css');
    expect(css).toContain('.fcp-workspace { height:100dvh; min-height:0; overflow:hidden; }');
    expect(css).toContain('.fcp-main { min-height:0; overflow-y:auto;');
    expect(css).toContain('.fcp-workspace, .fcp-shell-layout { height:auto; min-height:100dvh; overflow:visible; overflow-x:clip; }');
    expect(css).toContain('.fcp-message-list, .fcp-plan-source-selection { max-block-size:none; max-height:none; overflow:visible; }');
  });

  it('migrates the remaining portfolio-wide pages to canonical rows and shell recovery', async () => {
    const [phaseA,phaseB,shell,foundation,css] = await Promise.all([read('phase-a-ui.tsx'),read('phase-b-ui.tsx'),read('workspace-shell.tsx'),read('../ui/foundation.tsx'),read('../../app/styles/controls.css')]);
    expect(phaseB).toContain('<ProjectSection');
    expect(phaseB).toContain('<DividerList');
    expect(phaseB).toContain('<ReadOnlyNotice/>');
    expect(phaseB).not.toContain('ProjectBlock');
    expect(phaseB).not.toContain('fcp-project-block');
    expect(phaseB).not.toContain('fcp-channel-grid');
    expect(foundation).toContain('export function OfflineNotice');
    expect(foundation).toContain('export function ProjectSection');
    expect(shell).toContain('href="#fcp-main"');
    expect(shell).toContain('id="fcp-main"');
    expect(css).not.toContain('.fcp-project-block');
    expect(css).not.toContain('.fcp-channel-grid');
  });
});

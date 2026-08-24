import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

const read = (name: string) => readFile(new URL(`./${name}`, import.meta.url), 'utf8');

describe('operator UI foundation', () => {
  it('keeps one shared async command contract for all current operator mutations', async () => {
    const [control, primitive] = await Promise.all([read('operator-controls.tsx'), read('async-command.tsx')]);
    expect(control).toContain("from './async-command.tsx'");
    expect(control).toContain('useAsyncCommand');
    expect(control).toContain('AsyncButton');
    expect(control).not.toContain('<button');
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
    const css = await read('../../app/styles.css');
    expect(css).toContain('overflow-x: clip');
    expect(css).toContain('@media (max-width:700px)');
    expect(css).toContain('--fcp-target: 44px');
  });
});

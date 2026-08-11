import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

describe('governed environment access UI', () => {
  const ui = readFileSync(new URL('./workspace-ui.tsx', import.meta.url), 'utf8');
  const projection = readFileSync(new URL('./operator-data.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../app/styles.css', import.meta.url), 'utf8');

  it('shows dev/prod desired versus observed truth and no browser apply action', () => {
    expect(ui).toContain("card('development')");
    expect(ui).toContain("card('production')");
    expect(ui).toContain('desired {grant?.desiredLevel');
    expect(ui).toContain('observed {grant?.observedLevel');
    expect(ui).toContain('adapter недоступен');
    expect(ui).toContain("kind === 'production' ? eligibleMembers.filter");
    expect(ui).toContain('Обычные ИИ-агенты не получают production SSH');
    expect(ui).toContain('access.environmentReconcilers ?? []');
    expect(projection).toContain('Отзыв SSH-доступа ожидает подтверждения доверенного reconciler.');
    expect(ui).not.toContain('Применить SSH');
  });

  it('collapses environment cards and principal controls for a 390px viewport', () => {
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.fcp-environments > div:last-child \{ grid-template-columns: 1fr; \}/);
    expect(css).toContain('.fcp-environment-principal { grid-template-columns: 1fr;');
  });
});

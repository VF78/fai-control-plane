import {readFile} from 'node:fs/promises';
import {describe, expect, it} from 'vitest';

describe('task executor control', () => {
  it('is visible, grouped, and requires an inline confirmation before its single action', async () => {
    const source = await readFile(new URL('./operator-controls.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('<details className="fcp-control fcp-task-executor"');
    expect(source).toContain('<optgroup label="Люди">');
    expect(source).toContain('<optgroup label="Агенты">');
    expect(source).toContain('Назначить и начать');
    expect(source).toContain('Подтвердить и начать');
    expect(source).toContain('Запуск Hermes подтверждён');
    expect(source).toContain("currentExecutor === 'Hermes' ? confirmedRun : null");
    expect(source).toContain('Квитанция {activeRun.deliveryReference}');
    expect(source).toContain('<summary>Сменить исполнителя</summary>');
    expect(source).toContain('tone={noticeTone}');
    expect(source).toContain('Отмена');
    expect(source).toContain('role="status"');
  });
});

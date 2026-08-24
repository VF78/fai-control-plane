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
    expect(source).toContain('Запуск Hermes выполняется');
    expect(source).toContain('Проверить статус');
    expect(source).toContain('Подтвердить завершение и повтор');
    expect(source).toContain('confirmUnobservableFailure');
    expect(source).toContain('const activeRun = confirmedRun');
    expect(source).toContain("task.status === 'Backlog' || task.status === 'Ready'");
    expect(source).toContain('Blocked станет No');
    expect(source).toContain('Квитанция {activeRun.deliveryReference}');
    expect(source).toContain("runStatus === 'completed' ? 'Начать текущий этап или сменить исполнителя' : 'Сменить исполнителя'");
    expect(source).toContain('tone={noticeTone}');
    expect(source).toContain('Отмена');
    expect(source).toContain('role="status"');
    expect(source).toContain('taskExecutorErrorNotice');
    expect(source).toContain('execution_unavailable');
    expect(source).toContain('context_unavailable');
    expect(source).toContain('delivery_failed');
    expect(source).not.toContain("'Новая попытка не подтверждена.'");
  });
});

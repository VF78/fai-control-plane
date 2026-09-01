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
    expect(source).toContain('Worker проверяет результат автоматически раз в минуту');
    expect(source).not.toContain('Проверить статус');
    expect(source).toContain('Запустить заново');
    expect(source).toContain('pendingLabel="Запускаем…"');
    expect(source).not.toContain('confirmUnobservableFailure');
    expect(source).toContain('const activeRun = confirmedRun');
    expect(source).toContain("task.status === 'Backlog' || task.status === 'Ready'");
    expect(source).toContain('Blocked станет No');
    expect(source).not.toContain('Квитанция {activeRun.deliveryReference}');
    expect(source).toContain("runStatus === 'completed' ? 'Начать текущий этап или сменить исполнителя' : 'Сменить исполнителя'");
    expect(source).toContain('useAsyncCommand');
    expect(source).toContain('AsyncButton');
    expect(source).toContain('Отмена');
    expect(source).toContain('role="status"');
    expect(source).toContain('taskExecutorErrorNotice');
    expect(source).toContain('execution_unavailable');
    expect(source).toContain('profile_unavailable');
    expect(source).toContain('context_unavailable');
    expect(source).toContain('delivery_failed');
    expect(source).not.toContain('Квитанция {activeRun.deliveryReference}');
  });
});

describe('project document upload', () => {
  it('sends the original File objects in one multipart request without a client deadline', async () => {
    const source = await readFile(new URL('./operator-controls.tsx', import.meta.url), 'utf8');
    expect(source).toContain("form.append('file',source)");
    expect(source).not.toContain('source.arrayBuffer()');
    expect(source).not.toContain('new AbortController()');
    expect(source).not.toContain('45_000');
    expect(source).toContain("fetch(`/api/projects/${projectId}/documents`,{method:'POST',body:form})");
    expect(source).toContain("form.append('idempotencyKey',batchKey)");
  });
});

describe('project document deletion', () => {
  it('uses the scoped DELETE endpoint behind an accessible exact-name confirmation', async () => {
    const source = await readFile(new URL('./operator-controls.tsx', import.meta.url), 'utf8');
    expect(source).toContain('export function ProjectDocumentDeleteControl');
    expect(source).toContain('`/api/projects/${projectId}/documents/${documentId}`');
    expect(source).toContain('idempotencyKey:`project-document-delete:${id()}`');
    expect(source).toContain('title={`Удалить «${documentName}»?`}');
    expect(source).toContain('confirmation!==documentName');
    expect(source).toContain('router.refresh()');
  });
});

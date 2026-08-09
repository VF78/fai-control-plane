import type {ProjectData, RunsData} from './operator-data';
import {TaskPacketConfirmationControls} from './task-packet-confirmation-controls';

type Task = ProjectData['workItems'][number];
type Packet = RunsData['packets'][number];
type Run = RunsData['runs'][number];

export function TaskPacketBuildControls({
  task,
  profiles,
  csrfToken
}: Readonly<{
  task: Task;
  profiles: ProjectData['agentProfiles'];
  csrfToken: string | null;
}>) {
  if (!task.canBuildPacket || csrfToken === null) return null;
  return <div className="packet-build-actions" aria-label="Собрать пакет задачи">
    <form action={`/api/task-packets/${task.id}/build`} className="packet-build" method="post">
      <input name="_csrf" type="hidden" value={csrfToken}/>
      <button type="submit">Собрать пакет задачи</button>
    </form>
    {profiles.map((profile) => <form action={`/api/task-packets/${task.id}/build`} className="packet-build" key={profile.id} method="post">
      <input name="_csrf" type="hidden" value={csrfToken}/>
      <input name="agentProfileId" type="hidden" value={profile.id}/>
      <button type="submit">Собрать для {profile.runtimeId}</button>
    </form>)}
  </div>;
}

export function TaskPacketPreview({
  packet,
  csrfToken,
  operatorActorId
}: Readonly<{
  packet: Packet;
  csrfToken: string | null;
  operatorActorId: string | null;
}>) {
  return <article className="packet-preview" id={`packet-${packet.id}`}>
    <header><div><strong>{packet.workItemTitle}</strong><span>{packet.project} · зафиксирована v{packet.frozenWorkItemVersion} · текущая v{packet.currentWorkItemVersion}</span></div><span className={`state ${packet.runnable ? 'active' : 'failed'}`}>{packet.runnable ? 'Готов к запуску' : 'Запуск заблокирован'}</span></header>
    <p className="packet-goal">{packet.goal}</p>
    <dl className="packet-facts">
      <div><dt>Hash содержимого</dt><dd><code>{packet.contentHash}</code></dd></div>
      <div><dt>Лимит времени</dt><dd>{packet.timeboxMinutes} мин.</dd></div>
      <div><dt>Исполнитель</dt><dd>{packet.runtimeProfile}</dd></div>
      <div><dt>Конфигурация профиля</dt><dd>{packet.agentProfileSnapshotVersion === null ? 'Без привязки к профилю' : `v${packet.agentProfileSnapshotVersion} · ${packet.agentProfileSnapshotHash}`}</dd></div>
      <div><dt>Режим доступа</dt><dd>{packet.authMode}</dd></div>
      <div><dt>Ревьюер</dt><dd>{packet.reviewer}</dd></div>
      <div><dt>Утверждает</dt><dd>{packet.approver}</dd></div>
    </dl>
    <div className="packet-sections">
      <section><h3>Критерии приёмки</h3><ul>{packet.acceptanceCriteria.map((value) => <li key={value}>{value}</li>)}</ul></section>
      <section><h3>В рамках задачи</h3><ul>{packet.inScope.map((value) => <li key={value}>{value}</li>)}</ul></section>
      <section><h3>За рамками</h3><ul>{packet.outOfScope.map((value) => <li key={value}>{value}</li>)}</ul></section>
      <section><h3>Ссылки</h3><ul>{packet.relevantLinks.length === 0 ? <li>Ссылки не зафиксированы</li> : packet.relevantLinks.map((value) => <li key={value}>{value}</li>)}</ul></section>
      <section><h3>Файлы</h3><ul>{packet.relevantFiles.length === 0 ? <li>Файлы не зафиксированы</li> : packet.relevantFiles.map((value) => <li key={value}>{value}</li>)}</ul></section>
      <section><h3>Разрешённые инструменты</h3><ul>{packet.allowedTools.map((value) => <li key={value}>{value}</li>)}</ul></section>
      <section><h3>Запрещённые поверхности</h3><ul>{packet.forbiddenSurfaces.map((value) => <li key={value}>{value}</li>)}</ul></section>
      <section><h3>Политика данных</h3><pre>{JSON.stringify(packet.dataPolicy, null, 2)}</pre></section>
      <section><h3>Ожидаемый результат</h3><pre>{JSON.stringify(packet.expectedOutputSchema, null, 2)}</pre></section>
    </div>
    <TaskPacketConfirmationControls
      packet={packet}
      csrfToken={csrfToken}
      enabled={operatorActorId !== null}
      canQueue={operatorActorId === packet.approverActorId}
    />
  </article>;
}

export function RunActionControls({
  run,
  csrfToken,
  operatorActorId
}: Readonly<{
  run: Run;
  csrfToken: string | null;
  operatorActorId: string | null;
}>) {
  if (csrfToken === null) return null;
  return <div className="packet-build-actions" aria-label="Действия с запуском">
    {run.status !== 'queued' ? null : <form action={`/api/agent-runs/${run.id}/cancel?project=${run.projectSlug}`} method="post">
      <input name="_csrf" type="hidden" value={csrfToken}/>
      <input name="expectedVersion" type="hidden" value={run.version}/>
      <button type="submit">Отменить запуск в очереди</button>
    </form>}
    {!run.canAcceptReceipt || run.receipt === null || run.workItemVersion === null || operatorActorId !== run.approverActorId ? null : <form action={`/api/agent-runs/${run.id}/accept-receipt?project=${run.projectSlug}`} method="post">
      <input name="_csrf" type="hidden" value={csrfToken}/>
      <input name="expectedWorkItemVersion" type="hidden" value={run.workItemVersion}/>
      <input name="expectedReceiptSha256" type="hidden" value={run.receipt.receiptSha256}/>
      <button type="submit">Принять evidence и передать на этап «{run.acceptanceTargetStage ?? 'следующий'}»</button>
      {run.workItemStatus === run.acceptanceTargetStatus
        ? <small>Этап изменится; статус задачи останется прежним.</small> : null}
    </form>}
    {run.canAcceptReceipt && operatorActorId !== run.approverActorId
      ? <small>Решение доступно только записанному Product Owner.</small> : null}
  </div>;
}

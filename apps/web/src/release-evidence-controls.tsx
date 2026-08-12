'use client';

import {useState, type FormEvent} from 'react';
import type {CanonicalDeploymentProjection} from '@fai-control-plane/domain';

const environmentLabel = (value: string) => value === 'production' ? 'Продакшен'
  : value === 'staging' ? 'Тестовый контур' : 'Разработка';
const nextLabel = (value: CanonicalDeploymentProjection['nextAction']) => value === 'approve_production'
  ? 'Следующее действие: отдельное подтверждение человеком'
  : value === 'await_executor' ? 'Следующее действие: отдельный привилегированный executor выполняет утверждённый job'
  : value === 'record_observation' ? 'Следующее действие: доверенная система фиксирует результат и smoke checks'
    : value === 'review_observation' ? 'Следующее действие: проверить наблюдаемый результат'
      : 'Следующее действие: перенести старую запись в канонический lifecycle';
const availability = <T,>(value: {availability: string; value?: T}): T | null =>
  value.availability === 'known' ? value.value ?? null : null;

export function ReleaseEvidenceControls({projectId, projectVersion, materialization, workItems,
  deployments, csrfToken, canManage}: Readonly<{
  projectId: string;
  projectVersion: number;
  materialization: Readonly<{id: string; planVersionId: string}> | null;
  workItems: readonly Readonly<{id: string; title: string; sourcePlanVersionId: string | null;
    status: string; blocked: boolean; journey?: Readonly<{stage: Readonly<{taskStatus: string; terminal: boolean;
      terminalEvidenceComplete: boolean; protocolFinalizable: boolean}> | null}> | null}>[];
  deployments: readonly CanonicalDeploymentProjection[];
  csrfToken: string | null;
  canManage: boolean;
}>) {
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState<string | null>(null);
  const [environment, setEnvironment] = useState<'development' | 'staging' | 'production'>('staging');
  const eligible = (item: typeof workItems[number]) => {
    if (item.blocked) return false;
    if (environment === 'development') return true;
    const stage = item.journey?.stage;
    if (stage === null || stage === undefined || !stage.protocolFinalizable || item.status !== stage.taskStatus) return false;
    return environment === 'staging' ? stage.taskStatus === 'acceptance' || stage.taskStatus === 'done'
      : item.status === 'done' && stage.taskStatus === 'done' && stage.terminal && stage.terminalEvidenceComplete;
  };
  const plannedItems = materialization === null ? [] : workItems.filter((item) =>
    item.sourcePlanVersionId === materialization.planVersionId);
  const eligibleItems = plannedItems.filter(eligible);
  const projectEligible = plannedItems.length > 0 && eligibleItems.length === plannedItems.length;
  const send = async (body: Record<string, unknown>) => {
    setBusy(true); setNotice(null);
    try {
      const response = await fetch('/api/deployments', {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({_csrf: csrfToken, ...body})});
      const value = await response.json().catch(() => ({})) as {status?: string; message?: string};
      if (!response.ok) throw new Error(value.message ?? value.status ?? 'Команда релиза не принята.');
      setNotice('Команда принята; обновляем подтверждённые факты…');
      window.setTimeout(() => window.location.reload(), 350);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Команда недоступна.'); }
    finally { setBusy(false); }
  };
  const request = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (materialization === null) return;
    const data = new FormData(event.currentTarget);
    void send({action: 'request', deploymentId: crypto.randomUUID(), projectId,
      workItemId: data.get('workItemId') === '' ? null : data.get('workItemId'),
      planVersionId: materialization.planVersionId, materializationId: materialization.id,
      environment: data.get('environment'), sourceCommit: data.get('sourceCommit'),
      releasePackageReference: data.get('releasePackageReference'),
      releasePackageSha256: data.get('releasePackageSha256'), expectedProjectVersion: projectVersion});
  };
  return <section className="fcp-section" id="releases"><div className="fcp-section-head"><div>
    <h2>Релиз и развёртывание</h2><span>Желаемое, запрос, подтверждение и наблюдаемый факт разделены</span>
  </div></div>
    {deployments.length === 0 ? <p className="fcp-empty-line">Запросы на развёртывание не зафиксированы.</p>
      : <div className="fcp-list">{deployments.map((deployment) => {
        const desired = availability(deployment.desired); const requested = availability(deployment.requested);
        const approval = availability(deployment.approval); const observed = availability(deployment.externalEvidence);
        const releasePackage = availability(deployment.releasePackage); const executorJob = availability(deployment.executorJob);
        return <article className="fcp-row" key={deployment.id}><div><strong>{desired === null
          ? `Старая запись · ${deployment.revision}` : `${environmentLabel(desired.environment)} · ${desired.reference.kind}: ${desired.reference.reference}`}</strong>
          <small>Желаемое: {desired === null ? 'Неизвестно' : `план ${desired.planVersionId}`}</small>
          <small>Release package: {releasePackage === null ? 'Не зафиксирован' : `${releasePackage.value.artifactReference} · ${releasePackage.value.sourceCommit} · sha256 ${releasePackage.value.artifactSha256}`}</small>
          <small>Запрос: {requested === null ? 'Не подтверждён' : `${requested.at} · ${availability(requested.by)?.displayName ?? 'автор неизвестен'}`}</small>
          <small>Подтверждение: {approval === null ? 'Неизвестно' : approval.state === 'pending'
            ? 'Ожидает отдельного решения' : `${approval.at ?? 'время неизвестно'} · ${availability(approval.by)?.displayName ?? 'утвердивший неизвестен'}`}</small>
          <small>Наблюдаемый факт: {observed === null ? 'Не зафиксирован' : `${observed.outcome} · ${observed.completedAt} · smoke checks ${observed.smokeChecks.length}`}</small>
          <small>Executor job: {executorJob === null ? 'Не зафиксирован' : `${executorJob.status} · попытка ${executorJob.attempt}${executorJob.completedAt === null ? '' : ` · ${executorJob.completedAt}`}`}</small>
          <span>{nextLabel(deployment.nextAction)}</span>{observed === null ? null : <details><summary>Smoke checks и rollback</summary>
            <ul>{observed.smokeChecks.map((check) => <li key={check.name}>{check.name}: {check.status} · {check.reference}</li>)}</ul>
            <p>Rollback: {observed.rollback.outcome}{observed.rollback.reference === null ? '' : ` · ${observed.rollback.reference}`}</p></details>}
        </div>{deployment.nextAction === 'approve_production' && canManage && csrfToken !== null
          ? <button className="fcp-primary-button" disabled={busy} onClick={() => void send({action: 'approve_production',
              deploymentId: deployment.id, expectedVersion: deployment.version})}>Подтвердить продакшен</button> : null}</article>;
      })}</div>}
    {!canManage || csrfToken === null ? <p className="fcp-empty-line">Для запроса нужна авторизованная сессия менеджера или Product Owner.</p>
      : materialization === null ? <p className="fcp-empty-line">Сначала материализуйте утверждённый план проекта.</p>
        : <details className="fcp-system-details"><summary>Новый запрос на развёртывание</summary>
          <form className="fcp-profile-form" onSubmit={request}><label>Контур<select name="environment" value={environment}
            onChange={(event) => setEnvironment(event.target.value as typeof environment)}>
            <option value="development">Разработка</option><option value="staging">Тестовый</option><option value="production">Продакшен</option>
          </select></label><label>Объект<select name="workItemId">{projectEligible
            ? <option value="">Проект целиком</option> : null}{eligibleItems
            .map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label>
          {eligibleItems.length === 0 ? <small>Нет готового объекта: проверьте блокировки, текущую стадию и обязательные evidence.</small> : null}
          <label>Точный commit SHA<input name="sourceCommit" pattern="[0-9a-f]{40}" maxLength={40} required placeholder="40 символов в нижнем регистре"/></label>
          <label>Ссылка на release package<input name="releasePackageReference" maxLength={512} required placeholder="artifact:release-package:…"/></label>
          <label>SHA-256 release package<input name="releasePackageSha256" pattern="[0-9a-f]{64}" maxLength={64} required placeholder="64 символа в нижнем регистре"/></label>
          <button className="fcp-primary-button" disabled={busy || eligibleItems.length === 0} type="submit">Создать запрос</button>
          <small>Запрос ничего не развёртывает. Он только замораживает commit и пакет; для продакшена отдельный job появится после подтверждения человеком.</small></form>
        </details>}{notice === null ? null : <small className="fcp-command-notice">{notice}</small>}
  </section>;
}

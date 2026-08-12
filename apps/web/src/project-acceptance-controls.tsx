'use client';

import {useState, type FormEvent} from 'react';
import {BadgeCheck, ClipboardCheck, ShieldCheck} from 'lucide-react';
import type {CanonicalDeploymentProjection, ProjectExecutionProjection} from '@fai-control-plane/domain';

const split = (value: FormDataEntryValue | null) => String(value ?? '').split(/[,\n]/)
  .map((item) => item.trim()).filter(Boolean);

export function ProjectAcceptanceControls({projectId, execution, csrfToken, canProductOwner,
  canClientRepresentative, deployments}: Readonly<{projectId: string; execution: ProjectExecutionProjection;
    deployments: readonly CanonicalDeploymentProjection[];
    csrfToken: string | null; canProductOwner: boolean; canClientRepresentative: boolean}>) {
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState<string | null>(null);
  const acceptance = execution.acceptance ?? null;
  const canonicalAttempts = deployments.filter((deployment) => ['staging', 'production'].includes(deployment.environment) &&
    deployment.desired.availability === 'known' && deployment.requested.availability === 'known');
  const latestByEnvironment = canonicalAttempts.filter((candidate) => !canonicalAttempts.some((other) =>
    other.environment === candidate.environment && (other.requested.availability === 'known' &&
      candidate.requested.availability === 'known') &&
      (other.requested.value.at > candidate.requested.value.at ||
        other.requested.value.at === candidate.requested.value.at && other.id > candidate.id)));
  const eligibleDeployments = latestByEnvironment.filter((deployment) => deployment.status === 'observed' &&
    deployment.externalEvidence.availability === 'known' && deployment.externalEvidence.value.outcome === 'succeeded' &&
    (deployment.releasePackage.availability !== 'known' || deployment.executorJob.availability === 'known' &&
      deployment.executorJob.value.status === 'succeeded'));
  const canReplaceProtocol = acceptance?.blockers.some((blocker) =>
    blocker === 'bound_deployment_not_latest' || blocker === 'uat_release_binding_required') === true;
  const send = async (body: Record<string, unknown>) => {
    setBusy(true); setNotice(null);
    try {
      const response = await fetch('/api/project-acceptance', {method: 'POST',
        headers: {'content-type': 'application/json'}, body: JSON.stringify({_csrf: csrfToken, projectId, ...body})});
      const value = await response.json().catch(() => ({})) as {status?: string; message?: string};
      if (!response.ok) throw new Error(value.message ?? value.status ?? 'Команда приёмки не принята.');
      setNotice('Факт сохранён с audit и receipt; обновляем состояние…');
      window.setTimeout(() => window.location.reload(), 350);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Команда недоступна.'); }
    finally { setBusy(false); }
  };
  const prepare = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget);
    const deploymentId = String(data.get('deploymentId') ?? '');
    const deployment = eligibleDeployments.find((candidate) => candidate.id === deploymentId);
    void send({action: 'prepare', protocolId: crypto.randomUUID(), expectedExecutionVersion: execution.version,
      requiredSmokeChecks: split(data.get('requiredSmokeChecks')),
      requiredDeploymentEnvironment: deployment?.environment ?? data.get('requiredDeploymentEnvironment'),
      deploymentId: deployment?.id ?? null}); };
  const record = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (acceptance === null) return;
    const data = new FormData(event.currentTarget); const checks = acceptance.protocol.checklist.map((item) => ({key: item.key,
      outcome: data.get(`outcome:${item.key}`), evidenceReferences: split(data.get(`evidence:${item.key}`)),
      artifactReferences: split(data.get(`artifacts:${item.key}`))}));
    void send({action: 'record_result', protocolId: acceptance.protocol.id, resultId: crypto.randomUUID(),
      expectedVersion: acceptance.version, outcome: checks.every(({outcome}) => outcome === 'passed') ? 'passed' : 'failed', checks}); };
  const signoff = (kind: 'product_owner' | 'client_representative', evidenceReference: string) => {
    if (acceptance?.latestResult === null || acceptance === null) return;
    void send({action: 'signoff', protocolId: acceptance.protocol.id, resultId: acceptance.latestResult.id,
      expectedVersion: acceptance.version, kind, evidenceReference});
  };
  return <section className="fcp-section" id="uat"><div className="fcp-section-head"><div>
    <h2>UAT и завершение проекта</h2><span>Неизменяемый протокол · два отдельных signoff · строгая граница релиза</span>
  </div><ClipboardCheck aria-hidden="true" size={18}/></div>
    {acceptance !== null && !canReplaceProtocol ? null : <>{!canProductOwner || csrfToken === null || !['blocked', 'paused'].includes(execution.status)
      ? <p className="fcp-empty-line">Протокол UAT можно подготовить после приёмки всего скопа и terminal evidence.</p>
      : <details className="fcp-system-details"><summary>Подготовить неизменяемый протокол UAT</summary>
        <form className="fcp-profile-form" onSubmit={prepare}><label>Обязательные smoke checks
          <textarea name="requiredSmokeChecks" required maxLength={1024} placeholder="health, critical_path"/></label>
          <label>Точный deployment<select name="deploymentId" defaultValue="">
            <option value="">Релиз не требуется (нужен отдельный waiver PO)</option>
            {eligibleDeployments.map((deployment) => <option value={deployment.id} key={deployment.id}>
              {deployment.environment} · {deployment.revision} · {deployment.id}</option>)}</select></label>
          <label>Обязательный контур<select name="requiredDeploymentEnvironment" defaultValue="staging">
            <option value="staging">Тестовый</option><option value="production">Продакшен</option></select></label>
          <button className="fcp-primary-button" disabled={busy} type="submit">Зафиксировать протокол</button>
          <small>Checklist и выбранный deployment/package hash будут заморожены вместе с точным активным plan, materialization, baseline и terminal journey evidence. Только latest attempt контура допустим.</small>
        </form></details>}</>}
    {acceptance === null ? null : <>
      <div className="fcp-orchestrator-summary"><div><span>Протокол</span><strong>{acceptance.protocol.checklist.length} проверок</strong>
        <small>hash {acceptance.protocol.contentHash.slice(0, 12)}… · версия сессии {acceptance.version}</small></div>
        <div><span>UAT</span><strong>{acceptance.latestResult === null ? 'Не проводился' : acceptance.latestResult.outcome === 'passed' ? 'Пройден' : 'Не пройден'}</strong>
          <small>{acceptance.protocol.requiredDeploymentEnvironment} · smoke: {acceptance.protocol.requiredSmokeChecks.join(', ')}</small></div>
        <div><span>Условие релиза</span><strong>{acceptance.release.state === 'deployment_observed' ? 'Развёртывание подтверждено' : acceptance.release.state === 'not_required' ? 'Не требуется · waiver PO' : 'Не выполнено'}</strong>
          <small>{acceptance.release.deploymentId ?? acceptance.release.waiver?.reason ?? 'Нужен успешный observed deployment или явный waiver.'}</small></div></div>
      <details><summary>Checklist и точные привязки</summary><dl className="fcp-details"><div><dt>Plan</dt><dd>{acceptance.protocol.planVersionId}</dd></div>
        <div><dt>Materialization</dt><dd>{acceptance.protocol.materializationId}</dd></div><div><dt>Baseline</dt><dd>{acceptance.protocol.baselineId}</dd></div>
        <div><dt>Deployment</dt><dd>{acceptance.protocol.deploymentId ?? 'not_required pending waiver'}</dd></div>
        <div><dt>Package hash</dt><dd>{acceptance.protocol.deploymentReleasePackageHash ?? 'legacy / not_required'}</dd></div></dl>
        <ol>{acceptance.protocol.checklist.map((item) => <li key={item.key}><strong>{item.title}</strong><small>{item.requiredEvidence.join(', ')}</small></li>)}</ol></details>
      {acceptance.latestResult?.outcome === 'passed' || !canProductOwner || csrfToken === null ? null
        : <details className="fcp-system-details"><summary>Записать результат UAT</summary><form className="fcp-profile-form" onSubmit={record}>
          {acceptance.protocol.checklist.map((item) => <fieldset key={item.key}><legend>{item.title}</legend>
            <label>Результат<select name={`outcome:${item.key}`} defaultValue="passed"><option value="passed">Пройдено</option><option value="failed">Не пройдено</option></select></label>
            <label>Evidence references<textarea name={`evidence:${item.key}`} required placeholder="uat:evidence:…"/></label>
            <label>Artifact references<textarea name={`artifacts:${item.key}`} required placeholder="artifact:…"/></label></fieldset>)}
          <button className="fcp-primary-button" disabled={busy} type="submit">Сохранить неизменяемый результат</button></form></details>}
      {acceptance.latestResult?.outcome !== 'passed' ? null : <div className="fcp-list">
        <Signoff label="Product Owner" value={acceptance.signoffs.productOwner?.evidenceReference ?? null}
          enabled={canProductOwner && csrfToken !== null && !busy} onSubmit={(value) => signoff('product_owner', value)}/>
        <Signoff label="Представитель клиента" value={acceptance.signoffs.clientRepresentative?.evidenceReference ?? null}
          enabled={canClientRepresentative && csrfToken !== null && !busy} onSubmit={(value) => signoff('client_representative', value)}/></div>}
      {acceptance.release.state !== 'pending' || !canProductOwner || csrfToken === null ? null
        : <details className="fcp-system-details"><summary>Релиз не требуется</summary><form className="fcp-profile-form"
          onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void send({action: 'waive_release',
            protocolId: acceptance.protocol.id, expectedVersion: acceptance.version, reason: data.get('reason')}); }}>
          <label>Обоснование Product Owner<textarea name="reason" minLength={1} maxLength={500} required/></label>
          <button className="fcp-secondary" disabled={busy} type="submit">Зафиксировать not_required waiver</button></form></details>}
      {acceptance.completionReady && canProductOwner && csrfToken !== null ? <button className="fcp-primary-button" disabled={busy}
        onClick={() => void send({action: 'complete', protocolId: acceptance.protocol.id,
          expectedVersion: acceptance.version, expectedExecutionVersion: execution.version})}><BadgeCheck aria-hidden="true" size={16}/>Завершить проект</button>
        : execution.status !== 'completed' ? <p className="fcp-empty-line">Блокеры: {acceptance.blockers.join(', ') || 'повторная проверка completion gate'}</p> : null}</>}
    {notice === null ? null : <p className="fcp-command-notice">{notice}</p>}
  </section>;
}

function Signoff({label, value, enabled, onSubmit}: Readonly<{label: string; value: string | null; enabled: boolean;
  onSubmit(value: string): void}>) {
  if (value !== null) return <article className="fcp-row"><ShieldCheck aria-hidden="true" size={18}/><div><strong>{label}</strong><small>{value}</small></div></article>;
  return <article className="fcp-row"><div><strong>{label}</strong>{enabled ? <form className="fcp-profile-form"
    onSubmit={(event) => { event.preventDefault(); onSubmit(String(new FormData(event.currentTarget).get('evidenceReference') ?? '')); }}>
    <label>Evidence reference<input name="evidenceReference" required maxLength={2048}/></label>
    <button className="fcp-secondary" type="submit">Подписать</button></form> : <small>Ожидается отдельный уполномоченный участник.</small>}</div></article>;
}

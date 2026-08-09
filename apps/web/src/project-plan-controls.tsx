'use client';

import {useMemo, useState} from 'react';
import {CheckCircle2, FilePlus2, PackageCheck, Save, ShieldCheck} from 'lucide-react';
import type {ProjectPlanDefinition, ProjectPlanMaterialization, ProjectPlanSimulation} from '@fai-control-plane/domain';
import type {ProjectData} from './operator-data';

type PlanData = NonNullable<ProjectData['plan']>;
type Notice = Readonly<{tone: 'success' | 'error' | 'neutral'; text: string}>;
export const postProjectPlan = async (body: Record<string, unknown>) => {
  const response = await fetch('/api/project-plan', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const result = await response.json().catch(() => ({})) as {status?: string; message?: string; receipt?: unknown; simulation?: ProjectPlanSimulation; materialization?: ProjectPlanMaterialization};
  if (!response.ok) throw new Error(result.message ?? result.status ?? 'Команда не принята сервером.');
  return result;
};

export function ProjectPlanControls({projectId, plan, csrfToken, canEdit, canApprove}: Readonly<{projectId: string; plan: PlanData; csrfToken: string | null; canEdit: boolean; canApprove: boolean}>) {
  const [sourceName, setSourceName] = useState(''); const [sourceLabel, setSourceLabel] = useState(''); const [sourceContent, setSourceContent] = useState('');
  const [artifactId, setArtifactId] = useState(() => crypto.randomUUID());
  const [mediaType, setMediaType] = useState('text/markdown');
  const initial = plan.draft?.definition ?? null;
  const [draftText, setDraftText] = useState(initial === null ? '' : JSON.stringify(initial, null, 2));
  const [simulation, setSimulation] = useState<ProjectPlanSimulation | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null); const [busy, setBusy] = useState(false);
  const [planId] = useState(() => plan.draft?.id ?? crypto.randomUUID());
  const editable = csrfToken !== null && canEdit;
  const approvable = csrfToken !== null && canApprove;
  const parsed = useMemo(() => { try { return JSON.parse(draftText) as ProjectPlanDefinition; } catch { return null; } }, [draftText]);
  const run = async (operation: () => Promise<{receipt?: unknown; simulation?: ProjectPlanSimulation; materialization?: ProjectPlanMaterialization}>) => {
    setBusy(true); setNotice(null);
    try {
      const result = await operation();
      if (result.simulation !== undefined) { setSimulation(result.simulation); setNotice({tone: result.simulation.readyForApproval ? 'success' : 'error', text: result.simulation.readyForApproval ? 'План готов к утверждению.' : result.simulation.blockers.join(' ')}); }
      if (result.receipt !== undefined) { setNotice({tone: 'success', text: 'Команда выполнена, audit и receipt сохранены. Обновляем факты…'}); window.setTimeout(() => window.location.reload(), 450); }
    } catch (error) { setNotice({tone: 'error', text: error instanceof Error ? error.message : 'Команда недоступна.'}); }
    finally { setBusy(false); }
  };
  return <div className="fcp-plan-workspace">
    {!editable ? <p className="fcp-empty-line">Просмотр доступен. Для изменения нужна роль Product Owner или административная роль delivery.</p> : !approvable ? <p className="fcp-empty-line">Редактирование доступно, но утвердить план может только активный Product Owner проекта.</p> : null}
    <section className="fcp-plan-step"><header><span>1</span><div><h3>Исходные материалы</h3><p>Текст хранится в PostgreSQL; сервер сам фиксирует размер и SHA-256.</p></div></header>
      <div className="fcp-plan-sources">{plan.artifacts.length === 0 ? <p className="fcp-empty-line">Источники ещё не добавлены.</p> : plan.artifacts.map((artifact) => <details key={artifact.id}><summary><strong>{artifact.name}</strong><span>{artifact.mediaType} · {artifact.sizeBytes} байт · {artifact.sha256.slice(0, 12)}</span></summary><pre>{artifact.content}</pre><small>ID для citation: <code>{artifact.id}</code> · {artifact.provenance.label}</small></details>)}</div>
      <details className="fcp-plan-compose"><summary><FilePlus2 aria-hidden="true" size={16}/>Добавить заметку или текстовый источник</summary><div className="fcp-plan-source-form"><label>Название<input disabled={!editable} maxLength={160} value={sourceName} onChange={(event) => {setSourceName(event.target.value); setArtifactId(crypto.randomUUID());}}/></label><label>Происхождение<input disabled={!editable} maxLength={160} placeholder="Например: интервью с заказчиком 09.08" value={sourceLabel} onChange={(event) => {setSourceLabel(event.target.value); setArtifactId(crypto.randomUUID());}}/></label><label>Формат<select disabled={!editable} value={mediaType} onChange={(event) => {setMediaType(event.target.value); setArtifactId(crypto.randomUUID());}}><option value="text/markdown">Markdown</option><option value="text/plain">Обычный текст</option><option value="application/json">JSON</option></select></label><label>Содержимое<textarea disabled={!editable} maxLength={262144} rows={8} value={sourceContent} onChange={(event) => {setSourceContent(event.target.value); setArtifactId(crypto.randomUUID());}}/></label><button className="fcp-primary-button" disabled={!editable || busy || sourceName.trim() === '' || sourceLabel.trim() === '' || sourceContent === ''} onClick={() => void run(() => postProjectPlan({_csrf: csrfToken!, action: 'record_source', projectId, artifactId, name: sourceName.trim(), mediaType, content: sourceContent, provenanceLabel: sourceLabel.trim()}))}><FilePlus2 aria-hidden="true" size={16}/>Зафиксировать источник</button></div></details>
    </section>
    <section className="fcp-plan-step"><header><span>2</span><div><h3>Черновик плана</h3><p>5–10 результатов, сумма весов 100, milestones, risks, DAG и acceptance evidence.</p></div></header>
      <label className="fcp-plan-json">Структура плана JSON<textarea disabled={!editable} spellCheck={false} rows={22} placeholder={'{"title":"…","outcomes":[…],"milestones":[…],"risks":[…],"tasks":[…]}'} value={draftText} onChange={(event) => {setDraftText(event.target.value); setSimulation(null);}}/></label>
      <details className="fcp-plan-help"><summary>Формат citation и assumption</summary><pre>{JSON.stringify({citation: {kind: 'citation', artifactId: '<UUID выше>', locator: {kind: 'line_range', startLine: 1, endLine: 3}}, assumption: {kind: 'assumption', statement: 'Что именно должен подтвердить Product Owner'}}, null, 2)}</pre></details>
      <div className="fcp-plan-actions"><button className="fcp-secondary" disabled={!editable || busy || parsed === null} onClick={() => void run(() => postProjectPlan({_csrf: csrfToken!, action: 'simulate', projectId, planId, expectedRevision: plan.draft?.revision ?? null, definition: parsed}))}><CheckCircle2 aria-hidden="true" size={16}/>Проверить последствия</button><button className="fcp-primary-button" disabled={!editable || busy || parsed === null} onClick={() => void run(() => postProjectPlan({_csrf: csrfToken!, action: 'save_draft', projectId, planId, expectedRevision: plan.draft?.revision ?? null, definition: parsed}))}><Save aria-hidden="true" size={16}/>Сохранить черновик</button></div>
      {simulation === null ? null : <div className={`fcp-plan-simulation ${simulation.readyForApproval ? 'ready' : 'blocked'}`}><strong>{simulation.readyForApproval ? 'Готов к утверждению' : 'Есть блокеры'}</strong><span>Protocol: {simulation.protocol.state} · edit {String(simulation.capabilities.canEdit)} · approve {String(simulation.capabilities.canApprove)}</span>{simulation.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
    </section>
    <section className="fcp-plan-step"><header><span>3</span><div><h3>Утверждение Product Owner</h3><p>Утверждённая версия неизменяема. Baseline и задачи создаются отдельной подтверждённой командой ниже.</p></div></header>
      {plan.draft === null ? <p className="fcp-empty-line">Сначала сохраните канонический черновик.</p> : <div className="fcp-plan-approval"><div><strong>{plan.draft.definition.title}</strong><span>Revision {plan.draft.revision} · {plan.draft.contentHash.slice(0, 12)}</span></div>{!approvable ? <span>Требуется активная роль Product Owner</span> : <button className="fcp-primary-button" disabled={busy || simulation?.readyForApproval !== true || simulation.planHash !== plan.draft.contentHash} onClick={() => void run(() => postProjectPlan({_csrf: csrfToken!, action: 'approve', projectId, planId: plan.draft!.id, expectedRevision: plan.draft!.revision, expectedPlanHash: simulation!.planHash, expectedSimulationHash: simulation!.simulationHash}))}><ShieldCheck aria-hidden="true" size={16}/>Утвердить версию</button>}</div>}
      {plan.approved === null ? null : <div className="fcp-plan-approved"><ShieldCheck aria-hidden="true" size={18}/><div><strong>Утверждённый план · версия {plan.approved.approvedVersion}</strong><span>{plan.approved.definition.title} · sources frozen: {plan.approvedSourceManifest.length} · {plan.approved.contentHash.slice(0, 12)}</span></div></div>}
    </section>
    <section className="fcp-plan-step"><header><span>4</span><div><h3>Материализация утверждённого плана</h3><p>Одна команда создаёт канонический weighted scope, контрольные точки, задачи, зависимости и желаемое состояние публикации. Исполнение не запускается.</p></div></header>
      {plan.approved === null ? <p className="fcp-empty-line">Сначала утвердите неизменяемую версию плана.</p> : plan.materialization === null ? <div className="fcp-plan-approval"><div><strong>Готова версия {plan.approved.approvedVersion}</strong><span>Будут использованы точные plan hash и frozen source manifest.</span></div>{!approvable ? <span>Требуется активная роль Product Owner</span> : <button className="fcp-primary-button" disabled={busy || plan.approved.approvedVersion === null || plan.approvedSourceManifestHash === null} onClick={() => void run(() => postProjectPlan({_csrf: csrfToken!, action: 'materialize', projectId, planId: plan.approved!.id, expectedPlanVersion: plan.approved!.approvedVersion, expectedPlanHash: plan.approved!.contentHash, expectedSourceManifestHash: plan.approvedSourceManifestHash}))}><PackageCheck aria-hidden="true" size={16}/>Материализовать план</button>}</div> : <div className="fcp-plan-approved"><PackageCheck aria-hidden="true" size={18}/><div><strong>План материализован · версия {plan.materialization.planVersion}</strong><span>{plan.materialization.outcomeCount} результатов · {plan.materialization.milestoneCount} контрольных точек · {plan.materialization.workItemCount} задач · {plan.materialization.dependencyCount} зависимостей</span><span>{plan.materialization.journeyCount === 0 ? 'Delivery protocol не настроен: journeys не созданы.' : `Создано journeys: ${plan.materialization.journeyCount}.`} {plan.materialization.publicationIntentCount === 0 ? 'Внешние bindings не настроены: публикация не заявлена.' : `Желаемая публикация: ${plan.materialization.publicationIntentCount} ресурсов; подтверждение появится только после подключения и observation адаптера.`}</span><span>Следующее действие: проверить baseline и задачи. Запуск исполнения остаётся отдельным решением.</span></div></div>}
    </section>
    {notice === null ? null : <p className={`fcp-command-notice ${notice.tone}`}>{notice.text}</p>}
  </div>;
}

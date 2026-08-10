'use client';

import {useMemo, useState} from 'react';
import {CheckCircle2, FilePlus2, ListTree, PackageCheck, Save, ShieldCheck} from 'lucide-react';
import {projectDossierReadiness, sourceFileMediaTypeForFilename, sourceFileUploadLimits, type ProjectPlanDefinition, type ProjectPlanMaterialization, type ProjectPlanSimulation, type ProjectSourceArtifactKind, type SourceFileMediaType} from '@fai-control-plane/domain';
import type {ProjectData} from './operator-data';

type PlanData = NonNullable<ProjectData['plan']>;
type Notice = Readonly<{tone: 'success' | 'error' | 'neutral'; text: string}>;
const sourceKindLabel: Record<ProjectSourceArtifactKind, string> = {
  project_passport: 'Паспорт проекта',
  client_requirements: 'Требования клиента',
  contract_scope: 'Контрактные границы',
  acceptance_method: 'Метод приёмки',
  architecture_constraints: 'Архитектурные ограничения',
  other: 'Другое'
};
export const postProjectPlan = async (body: Record<string, unknown>) => {
  const response = await fetch('/api/project-plan', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const result = await response.json().catch(() => ({})) as {status?: string; message?: string; receipt?: unknown; simulation?: ProjectPlanSimulation; materialization?: ProjectPlanMaterialization};
  if (!response.ok) throw new Error(result.message ?? result.status ?? 'Команда не принята сервером.');
  return result;
};
export const postProjectSourceFile = async (body: Record<string, unknown>) => {
  const response = await fetch('/api/project-plan/source-file', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const result = await response.json().catch(() => ({})) as {status?: string; message?: string; receipt?: unknown};
  if (!response.ok) throw new Error(result.message ?? result.status ?? 'Файл не принят сервером.');
  return result;
};
const bytesToBase64 = (bytes: Uint8Array) => {
  let output = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) output += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(output);
};
export const defaultGenerationArtifactIds = (artifacts: PlanData['artifacts']) => {
  const allBytes = artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0);
  if (artifacts.length <= 32 && allBytes <= 512 * 1024) return artifacts.map(({id}) => id);
  let bytes = 0;
  return artifacts.flatMap((artifact) => {
    if (bytes + artifact.sizeBytes > 512 * 1024) return [];
    bytes += artifact.sizeBytes; return [artifact.id];
  }).slice(0, 32);
};

export function ProjectPlanControls({projectId, plan, csrfToken, canEdit, canApprove}: Readonly<{projectId: string; plan: PlanData; csrfToken: string | null; canEdit: boolean; canApprove: boolean}>) {
  const [sourceName, setSourceName] = useState(''); const [sourceLabel, setSourceLabel] = useState(''); const [sourceContent, setSourceContent] = useState('');
  const [artifactId, setArtifactId] = useState(() => crypto.randomUUID());
  const [sourceKind, setSourceKind] = useState<ProjectSourceArtifactKind>('other');
  const [mediaType, setMediaType] = useState('text/markdown');
  const [fileName, setFileName] = useState(''); const [fileLabel, setFileLabel] = useState(''); const [fileSourceKind, setFileSourceKind] = useState<ProjectSourceArtifactKind>('other');
  const [fileArtifactId, setFileArtifactId] = useState(() => crypto.randomUUID()); const [fileFilename, setFileFilename] = useState('');
  const [fileMediaType, setFileMediaType] = useState<SourceFileMediaType | null>(null); const [fileBase64, setFileBase64] = useState('');
  const initial = plan.draft?.definition ?? plan.approved?.definition ?? null;
  const [draftText, setDraftText] = useState(initial === null ? '' : JSON.stringify(initial, null, 2));
  const [simulation, setSimulation] = useState<ProjectPlanSimulation | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null); const [busy, setBusy] = useState(false);
  const [planId] = useState(() => plan.draft?.id ?? crypto.randomUUID());
  const [selectedArtifactIds, setSelectedArtifactIds] = useState(() => defaultGenerationArtifactIds(plan.artifacts));
  const editable = csrfToken !== null && canEdit;
  const draftEditable = editable && plan.approved === null;
  const approvable = csrfToken !== null && canApprove;
  const parsed = useMemo(() => { try { return JSON.parse(draftText) as ProjectPlanDefinition; } catch { return null; } }, [draftText]);
  const selectedArtifacts = useMemo(() => plan.artifacts.filter(({id}) => selectedArtifactIds.includes(id)), [plan.artifacts, selectedArtifactIds]);
  const sourceBytes = selectedArtifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0);
  const selectedDossier = projectDossierReadiness(selectedArtifacts);
  const generationReady = selectedArtifacts.length > 0 && selectedArtifacts.length <= 32 && sourceBytes <= 512 * 1024 && selectedDossier.ready;
  const generationAllowed = generationReady && plan.approved === null;
  const dossier = projectDossierReadiness(plan.artifacts);
  const toggleArtifact = (artifactId: string) => setSelectedArtifactIds((current) => current.includes(artifactId)
    ? current.filter((id) => id !== artifactId) : [...current, artifactId]);
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
    <section className="fcp-plan-step"><header><span>1</span><div><h3>Исходные материалы</h3><p>Можно вставить text/plain, text/markdown, application/json или добавить .txt, .md, .json, .pdf, .docx до 2 МиБ. PostgreSQL хранит только извлечённый текст до 256 КиБ и SHA-256, не бинарный файл.</p></div></header>
      <div className="fcp-plan-approval"><div><strong>Готовность досье · {dossier.ready ? 'готово' : 'нужно дополнить'}</strong><span>Обязательны: паспорт проекта, требования клиента и метод приёмки.</span>{dossier.required.map((item) => <span key={item.kind}>{item.present ? '✓' : '○'} {item.remediation ?? 'Источник зафиксирован.'}</span>)}</div></div>
      <div className="fcp-plan-sources">{plan.artifacts.length === 0 ? <p className="fcp-empty-line">Источники ещё не добавлены.</p> : plan.artifacts.map((artifact) => <details key={artifact.id}><summary><strong>{artifact.name}</strong><span>{sourceKindLabel[artifact.sourceKind]} · {artifact.mediaType} · {artifact.sizeBytes} байт · {artifact.sha256.slice(0, 12)}</span></summary><pre>{artifact.content}</pre><small>ID для citation: <code>{artifact.id}</code> · {artifact.provenance.label}{artifact.sourceFile === null ? '' : ` · ${artifact.sourceFile.filename} (${artifact.sourceFile.mediaType}, ${artifact.sourceFile.rawSizeBytes} байт; ${artifact.sourceFile.extractionMethod})`}</small></details>)}</div>
      <details className="fcp-plan-compose"><summary><FilePlus2 aria-hidden="true" size={16}/>Добавить заметку или текстовый источник</summary><div className="fcp-plan-source-form"><label>Название<input disabled={!editable} maxLength={160} value={sourceName} onChange={(event) => {setSourceName(event.target.value); setArtifactId(crypto.randomUUID());}}/></label><label>Категория<select disabled={!editable} value={sourceKind} onChange={(event) => {setSourceKind(event.target.value as ProjectSourceArtifactKind); setArtifactId(crypto.randomUUID());}}><option value="project_passport">Паспорт проекта</option><option value="client_requirements">Требования клиента</option><option value="contract_scope">Контрактные границы</option><option value="acceptance_method">Метод приёмки</option><option value="architecture_constraints">Архитектурные ограничения</option><option value="other">Другое</option></select></label><label>Происхождение<input disabled={!editable} maxLength={160} placeholder="Например: интервью с заказчиком 09.08" value={sourceLabel} onChange={(event) => {setSourceLabel(event.target.value); setArtifactId(crypto.randomUUID());}}/></label><label>Формат<select disabled={!editable} value={mediaType} onChange={(event) => {setMediaType(event.target.value); setArtifactId(crypto.randomUUID());}}><option value="text/markdown">Markdown</option><option value="text/plain">Обычный текст</option><option value="application/json">JSON</option></select></label><label>Содержимое<textarea disabled={!editable} maxLength={262144} rows={8} value={sourceContent} onChange={(event) => {setSourceContent(event.target.value); setArtifactId(crypto.randomUUID());}}/></label><button className="fcp-primary-button" disabled={!editable || busy || sourceName.trim() === '' || sourceLabel.trim() === '' || sourceContent === ''} onClick={() => void run(() => postProjectPlan({_csrf: csrfToken!, action: 'record_source', projectId, artifactId, name: sourceName.trim(), sourceKind, mediaType, content: sourceContent, provenanceLabel: sourceLabel.trim()}))}><FilePlus2 aria-hidden="true" size={16}/>Зафиксировать источник</button></div></details>
      <details className="fcp-plan-compose"><summary><FilePlus2 aria-hidden="true" size={16}/>Добавить файл источника</summary><div className="fcp-plan-source-form"><p className="fcp-empty-line">.txt, .md, .json, .pdf, .docx; файл до {sourceFileUploadLimits.rawBytes / 1024 / 1024} МиБ. PDF/DOCX извлекаются на сервере; оригинал не сохраняется.</p><label>Файл<input disabled={!editable} type="file" accept=".txt,.md,.json,.pdf,.docx" onChange={(event) => { const selected = event.currentTarget.files?.item(0); if (selected === null || selected === undefined) return; const selectedMediaType = sourceFileMediaTypeForFilename(selected.name); if (selectedMediaType === null || selected.size < 1 || selected.size > sourceFileUploadLimits.rawBytes) { setFileFilename(''); setFileMediaType(null); setFileBase64(''); setNotice({tone: 'error', text: 'Выберите поддерживаемый непустой файл до 2 МиБ.'}); return; } void selected.arrayBuffer().then((buffer) => { setFileFilename(selected.name); setFileMediaType(selectedMediaType); setFileBase64(bytesToBase64(new Uint8Array(buffer))); setFileName((current) => current === '' ? selected.name : current); setFileArtifactId(crypto.randomUUID()); }).catch(() => setNotice({tone: 'error', text: 'Не удалось прочитать выбранный файл.'})); }}/></label><label>Название<input disabled={!editable} maxLength={160} value={fileName} onChange={(event) => {setFileName(event.target.value); setFileArtifactId(crypto.randomUUID());}}/></label><label>Категория<select disabled={!editable} value={fileSourceKind} onChange={(event) => {setFileSourceKind(event.target.value as ProjectSourceArtifactKind); setFileArtifactId(crypto.randomUUID());}}><option value="project_passport">Паспорт проекта</option><option value="client_requirements">Требования клиента</option><option value="contract_scope">Контрактные границы</option><option value="acceptance_method">Метод приёмки</option><option value="architecture_constraints">Архитектурные ограничения</option><option value="other">Другое</option></select></label><label>Происхождение<input disabled={!editable} maxLength={160} value={fileLabel} onChange={(event) => {setFileLabel(event.target.value); setFileArtifactId(crypto.randomUUID());}}/></label><button className="fcp-primary-button" disabled={!editable || busy || fileName.trim() === '' || fileLabel.trim() === '' || fileFilename === '' || fileMediaType === null || fileBase64 === ''} onClick={() => void run(() => postProjectSourceFile({_csrf: csrfToken!, projectId, artifactId: fileArtifactId, name: fileName.trim(), sourceKind: fileSourceKind, provenanceLabel: fileLabel.trim(), filename: fileFilename, mediaType: fileMediaType, contentBase64: fileBase64}))}><FilePlus2 aria-hidden="true" size={16}/>Зафиксировать файл</button></div></details>
    </section>
    <section className="fcp-plan-step"><header><span>2</span><div><h3>Черновик плана</h3><p>5–10 результатов, сумма весов 100, milestones, risks, DAG и acceptance evidence.</p></div></header>
      <div className="fcp-plan-approval"><div><strong>Систематическая сборка черновика</strong><span>Использует только выбранные записанные источники и явные допущения; до 32 материалов и 512 КБ. Результат остаётся редактируемым и не запускает утверждение или исполнение.</span><span>Выбрано: {selectedArtifacts.length} · {sourceBytes} байт</span>{plan.approved !== null ? <span>Новый черновик заблокирован: для утверждённого плана сначала нужен явный scope-delta re-plan.</span> : selectedArtifacts.length === 0 ? <span>Выберите хотя бы один источник.</span> : selectedArtifacts.length > 32 || sourceBytes > 512 * 1024 ? <span>Выбор превышает лимит. Оставьте не более 32 источников общим объёмом до 512 КБ.</span> : !selectedDossier.ready ? selectedDossier.required.filter((item) => !item.present).map((item) => <span key={item.kind}>{item.remediation}</span>) : null}</div><button className="fcp-secondary" disabled={!editable || busy || !generationAllowed} onClick={() => void run(() => postProjectPlan({_csrf: csrfToken!, action: 'generate_draft', projectId, planId, expectedRevision: plan.draft?.revision ?? null, sourceManifest: selectedArtifacts.map(({id: artifactId, version, sha256}) => ({artifactId, version, sha256}))}))}><ListTree aria-hidden="true" size={16}/>Собрать черновик из источников</button></div>
      {plan.artifacts.length === 0 ? null : <details className="fcp-plan-help"><summary>Выбрать источники для черновика</summary><div className="fcp-plan-source-selection">{plan.artifacts.map((artifact) => <label key={artifact.id}><input type="checkbox" checked={selectedArtifactIds.includes(artifact.id)} disabled={!editable || busy || plan.approved !== null} onChange={() => toggleArtifact(artifact.id)}/><span><strong>{artifact.name}</strong><small>{artifact.sizeBytes} байт · {artifact.sha256.slice(0, 12)}</small></span></label>)}</div></details>}
      <label className="fcp-plan-json">{plan.approved === null ? 'Структура плана JSON' : 'Утверждённая структура плана · только чтение'}<textarea disabled={!draftEditable} spellCheck={false} rows={22} placeholder={'{"title":"…","outcomes":[…],"milestones":[…],"risks":[…],"tasks":[…]}'} value={draftText} onChange={(event) => {setDraftText(event.target.value); setSimulation(null);}}/></label>
      <details className="fcp-plan-help"><summary>Формат citation и assumption</summary><pre>{JSON.stringify({citation: {kind: 'citation', artifactId: '<UUID выше>', locator: {kind: 'line_range', startLine: 1, endLine: 3}}, assumption: {kind: 'assumption', statement: 'Что именно должен подтвердить Product Owner'}}, null, 2)}</pre></details>
      <div className="fcp-plan-actions"><button className="fcp-secondary" disabled={!draftEditable || busy || parsed === null} onClick={() => void run(() => postProjectPlan({_csrf: csrfToken!, action: 'simulate', projectId, planId, expectedRevision: plan.draft?.revision ?? null, definition: parsed}))}><CheckCircle2 aria-hidden="true" size={16}/>Проверить последствия</button><button className="fcp-primary-button" disabled={!draftEditable || busy || parsed === null} onClick={() => void run(() => postProjectPlan({_csrf: csrfToken!, action: 'save_draft', projectId, planId, expectedRevision: plan.draft?.revision ?? null, definition: parsed}))}><Save aria-hidden="true" size={16}/>Сохранить черновик</button></div>
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

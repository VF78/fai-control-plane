'use client';

import {useMemo, useState} from 'react';
import {ArrowRight, CheckCircle2, CircleDot, FileCheck2, Play, Save, Send, ShieldAlert, Sparkles, UserRound} from 'lucide-react';
import type {DeliveryProtocol, DeliveryProtocolDefinition} from '@fai-control-plane/domain';

type Notice = Readonly<{tone: 'success' | 'error' | 'neutral'; text: string}>;
type ProtocolResponse = Readonly<{receipt?: {commandId: string; commandType: string}; simulation?: {valid: boolean; simulationHash: string; violations: readonly string[]}}>;

const roleOptions = ['project_owner', 'contributor', 'reviewer', 'workspace_owner'] as const;
const taskStatuses = ['backlog', 'ready', 'in_dev', 'qa', 'acceptance', 'done'] as const;
const modes = ['manual', 'human_approval', 'autonomous'] as const;
const clone = (definition: DeliveryProtocolDefinition): DeliveryProtocolDefinition => structuredClone(definition);
const roleOf = (stage: DeliveryProtocolDefinition['stages'][number]) =>
  stage.responsibility.kind === 'project_role' ? stage.responsibility.role : 'project_owner';
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const responsibilityLabel = (stage: DeliveryProtocolDefinition['stages'][number]) => stage.responsibility.kind === 'project_role'
  ? stage.responsibility.role.replaceAll('_', ' ')
  : stage.responsibility.actorType === 'agent' ? 'Configured agent' : 'Configured human';

function ProtocolStageRead({stage, next}: {stage: DeliveryProtocolDefinition['stages'][number]; next: string}) {
  return <div className="fcp-protocol-read-stage" role="row"><div><CircleDot aria-hidden="true" size={16}/><strong>{stage.name}</strong><small>{stage.key} · {stage.enabled ? stage.taskStatus : 'Disabled'}</small></div><div><UserRound aria-hidden="true" size={15}/><span>{responsibilityLabel(stage)}</span><small>{stage.executionMode.replaceAll('_', ' ')}</small></div><div><FileCheck2 aria-hidden="true" size={15}/><span>{stage.requiredEvidence.join(', ')}</span></div><div><ArrowRight aria-hidden="true" size={15}/><span>{next}</span></div></div>;
}

async function mutate(path: string, body: Record<string, unknown>): Promise<ProtocolResponse> {
  const response = await fetch(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const value = await response.json().catch(() => ({})) as ProtocolResponse & {status?: string; message?: string};
  if (!response.ok) throw new Error(value.message ?? value.status ?? 'The canonical command was not accepted.');
  return value;
}

export function DeliveryProtocolEditor({projectId, protocol, csrfToken}: {
  projectId: string; protocol: DeliveryProtocol | null; csrfToken: string | null;
}) {
  const original = protocol?.definition ?? null;
  const [definition, setDefinition] = useState<DeliveryProtocolDefinition | null>(original === null ? null : clone(original));
  const [simulation, setSimulation] = useState<ProtocolResponse['simulation']>();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const changed = useMemo(() => original !== null && definition !== null && !same(original, definition), [definition, original]);
  const editable = protocol?.state === 'draft' && csrfToken !== null;
  const update = (index: number, patch: Partial<DeliveryProtocolDefinition['stages'][number]>) => setDefinition((current) => current === null ? null : {
    ...current, stages: current.stages.map((stage, candidate) => candidate === index ? {...stage, ...patch} : stage)
  });
  const request = async (action: 'create_default' | 'draft' | 'simulate' | 'publish' | 'activate') => {
    if (csrfToken === null) return setNotice({tone: 'error', text: 'An authenticated operator session is required.'});
    setBusy(true); setNotice(null);
    try {
      const result = await mutate('/api/delivery-protocol', action === 'create_default'
        ? {_csrf: csrfToken, action, projectId}
        : action === 'publish' || action === 'activate'
          ? {_csrf: csrfToken, action, projectId, protocolId: protocol!.id, expectedRevision: protocol!.revision}
          : {_csrf: csrfToken, action, projectId, ...(protocol === null ? {} : {protocolId: protocol.id, expectedRevision: protocol.revision}), definition});
      if (result.simulation !== undefined) setSimulation(result.simulation);
      setNotice(result.receipt === undefined
        ? {tone: 'neutral', text: result.simulation?.valid ? 'Simulation is valid and has no side effects.' : 'Simulation found protocol violations.'}
        : {tone: 'success', text: `Receipt recorded for ${result.receipt.commandType}. Reloading canonical facts…`});
      if (result.receipt !== undefined) window.setTimeout(() => window.location.reload(), 450);
    } catch (error) { setNotice({tone: 'error', text: error instanceof Error ? error.message : 'Command unavailable.'}); }
    finally { setBusy(false); }
  };
  if (protocol === null) return <section className="fcp-delivery-empty"><ShieldAlert aria-hidden="true" size={20}/><div><h2>Not configured</h2><p>No delivery protocol record is persisted for this project.</p></div>{csrfToken === null ? <p className="fcp-muted">Sign in to create the canonical default draft.</p> : <button className="fcp-primary-button" disabled={busy} onClick={() => void request('create_default')}><Sparkles aria-hidden="true" size={16}/>Create default draft</button>}{notice === null ? null : <p className={`fcp-command-notice ${notice.tone}`}>{notice.text}</p>}</section>;
  return <section className="fcp-protocol-editor"><div className="fcp-protocol-facts"><span>Version {protocol.version}</span><span>Revision {protocol.revision}</span><span>{protocol.state}</span><span>{protocol.active ? 'Active' : 'Inactive'}</span></div>{editable ? <div className="fcp-protocol-table" role="table" aria-label="Delivery protocol stages"><div className="fcp-protocol-head" role="row"><span>Stage</span><span>Status</span><span>Responsibility</span><span>Mode</span><span>Evidence</span><span>Next</span></div>{definition?.stages.map((stage, index) => <div className="fcp-protocol-stage" role="row" key={stage.key}><label>Stage<input aria-label={`${stage.name} stage name`} value={stage.name} onChange={(event) => update(index, {name: event.target.value})}/><small>{stage.key}</small></label><label>Status<select aria-label={`${stage.name} task status`} value={stage.taskStatus} onChange={(event) => update(index, {taskStatus: event.target.value as typeof stage.taskStatus})}>{taskStatuses.map((status) => <option key={status}>{status}</option>)}</select><span className="fcp-check"><input aria-label={`${stage.name} enabled`} checked={stage.enabled} onChange={(event) => update(index, {enabled: event.target.checked})}/>Enabled</span></label><label>Responsibility<select aria-label={`${stage.name} responsibility`} value={roleOf(stage)} onChange={(event) => update(index, {responsibility: {kind: 'project_role', role: event.target.value as typeof roleOptions[number]}})}>{roleOptions.map((role) => <option key={role}>{role}</option>)}</select></label><label>Execution<select aria-label={`${stage.name} execution mode`} value={stage.executionMode} onChange={(event) => update(index, {executionMode: event.target.value as typeof stage.executionMode})}>{modes.map((mode) => <option key={mode}>{mode}</option>)}</select></label><label>Evidence<input aria-label={`${stage.name} required evidence`} value={stage.requiredEvidence.join(', ')} onChange={(event) => update(index, {requiredEvidence: event.target.value.split(',').map((item) => item.trim()).filter(Boolean)})}/></label><label>Next<select aria-label={`${stage.name} next stage`} value={stage.allowedNextStageKey ?? ''} onChange={(event) => update(index, {allowedNextStageKey: event.target.value || null})}><option value="">Complete</option>{definition.stages.slice(index + 1).map((item) => <option value={item.key} key={item.key}>{item.name}</option>)}</select></label></div>)}</div> : <div className="fcp-protocol-read" role="table" aria-label="Published delivery protocol stages">{protocol.definition.stages.map((stage) => <ProtocolStageRead stage={stage} key={stage.key} next={stage.allowedNextStageKey === null ? 'Complete' : protocol.definition.stages.find((candidate) => candidate.key === stage.allowedNextStageKey)?.name ?? stage.allowedNextStageKey}/>)}</div>}<div className="fcp-protocol-actions">{protocol.state === 'draft' ? <><button className="fcp-secondary" disabled={!editable || busy || !changed} onClick={() => void request('draft')}><Save aria-hidden="true" size={16}/>Save draft</button><button className="fcp-secondary" disabled={!editable || busy} onClick={() => void request('simulate')}><CheckCircle2 aria-hidden="true" size={16}/>Simulate</button><button className="fcp-primary-button" disabled={!editable || busy || simulation?.valid !== true} onClick={() => void request('publish')}><Send aria-hidden="true" size={16}/>Publish</button></> : protocol.state === 'published' && !protocol.active ? <button className="fcp-primary-button" disabled={csrfToken === null || busy} onClick={() => void request('activate')}><Play aria-hidden="true" size={16}/>Activate</button> : <p className="fcp-muted">Published versions are immutable. This is the active canonical version.</p>}</div>{changed ? <p className="fcp-diff"><strong>Before → after</strong> {definition?.stages.filter((stage, index) => !same(stage, original?.stages[index])).map((stage) => stage.name).join(', ') || 'No stage change'}</p> : null}{simulation === undefined ? null : <p className={`fcp-command-notice ${simulation.valid ? 'success' : 'error'}`}>{simulation.valid ? `Simulation valid · ${simulation.simulationHash.slice(0, 12)}` : simulation.violations.join(' ')}</p>}{notice === null ? null : <p className={`fcp-command-notice ${notice.tone}`}>{notice.text}</p>}</section>;
}

export function DeliveryJourneyAction({workItemId, taskVersion, journey, activeProtocolId, csrfToken,
  terminal, terminalEvidenceComplete, requiredEvidence}: {workItemId: string; taskVersion: number;
  activeProtocolId: string | null; csrfToken: string | null;
  journey: {version: number; deadlineAt: Date | null; protocolId: string; protocolVersion: number;
    stageKey: string; requiredEvidence?: readonly string[]; canRecordTerminalEvidence?: boolean;
    stage?: Readonly<{
      terminal?: boolean; terminalEvidenceComplete?: boolean;
    }> | null;} | null;
  terminal?: boolean; terminalEvidenceComplete?: boolean; requiredEvidence?: readonly string[];}) {
  const [notice, setNotice] = useState<Notice | null>(null); const [busy, setBusy] = useState(false); const [evidence, setEvidence] = useState('');
  const isTerminal = terminal ?? journey?.stage?.terminal ?? false;
  const hasTerminalEvidence = terminalEvidenceComplete ?? journey?.stage?.terminalEvidenceComplete ?? false;
  const evidenceRequirements = requiredEvidence ?? journey?.requiredEvidence ?? [];
  const submit = async () => { if (csrfToken === null) return; setBusy(true); try { const action = journey === null ? 'start' : 'advance'; const result = await mutate(`/api/delivery-journeys/${workItemId}`, journey === null ? {_csrf: csrfToken, action, protocolId: activeProtocolId, expectedWorkItemVersion: taskVersion, deadlineAt: null} : {_csrf: csrfToken, action, expectedWorkItemVersion: taskVersion, expectedJourneyVersion: journey.version, evidenceReferences: evidence === '' ? [] : evidence.split('\n').filter(Boolean).map((reference) => ({requirement: reference.split(':')[0]?.trim() ?? '', reference: reference.slice(reference.indexOf(':') + 1).trim()}))}); if (result.receipt === undefined) throw new Error('No persisted receipt was returned.'); setNotice({tone: 'success', text: `Receipt recorded for ${result.receipt.commandType}. Reloading canonical facts…`}); window.setTimeout(() => window.location.reload(), 450); } catch (error) { setNotice({tone: 'error', text: error instanceof Error ? error.message : 'Command unavailable.'}); } finally {setBusy(false);} };
  if (csrfToken === null || taskVersion < 1 || (journey === null && activeProtocolId === null)) return null;
  return <div className="fcp-journey-action">{journey === null ? <button className="fcp-primary-button" disabled={busy} onClick={() => void submit()}><Play aria-hidden="true" size={16}/>Start delivery journey</button> : hasTerminalEvidence ? <p className="fcp-command-notice success">Финальные evidence зафиксированы. Результат можно принять в weighted scope.</p> : isTerminal && journey.canRecordTerminalEvidence !== true ? <p className="fcp-command-notice neutral">Финальную приёмку фиксирует только выбранный Product Owner с правом записи.</p> : <><label>{isTerminal ? 'Финальные evidence Product Owner' : 'Evidence references'}<textarea aria-label="Evidence references" value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder={evidenceRequirements.length === 0 ? 'Requirement: canonical evidence reference' : evidenceRequirements.map((item) => `${item}: canonical evidence reference`).join('\n')} /></label><button className="fcp-primary-button" disabled={busy} onClick={() => void submit()}><Send aria-hidden="true" size={16}/>{isTerminal ? 'Зафиксировать финальную приёмку' : 'Advance if allowed'}</button></>}{notice === null ? null : <p className={`fcp-command-notice ${notice.tone}`}>{notice.text}</p>}</div>;
}

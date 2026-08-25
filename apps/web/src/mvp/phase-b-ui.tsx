import type {ApprovalEvidenceView, ProjectAgentProfileView, ProjectOperatorEvidenceView, ProjectSourceView, ProjectTaskView} from '@fai-control-plane/db';
import type {ReactNode} from 'react';
import {Bot, CheckCircle2, CircleDot, FileText, Link2, ShieldCheck, UsersRound} from 'lucide-react';
import {AccessControls, ProjectAgentActivationControl, ProjectRegistrationControl, SourceAddControl} from './operator-controls.tsx';
import type {IntegrationConfig} from './integration-config.ts';
import {phaseHref} from './phase-a-ui.tsx';

export type PhaseBView = 'conversations'|'people'|'systems'|'settings';
type Props = Readonly<{
  view: PhaseBView; project: ProjectTaskView|null; evidence: ProjectOperatorEvidenceView|null;
  sources: readonly ProjectSourceView[]; approvals: readonly ApprovalEvidenceView[]; actorId: string; config: IntegrationConfig;
  agentProfile: ProjectAgentProfileView|null;
}>;
const instant = (value: string) => new Intl.DateTimeFormat('ru-RU', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow'}).format(new Date(value));
const delivery = (value: {pending: number; delivered: number; failed: number}) => value.failed > 0 ? `Ошибка · ${value.failed}` : value.pending > 0 ? `Ожидает · ${value.pending}` : value.delivered > 0 ? `Доставлено · ${value.delivered}` : 'Нет данных';
const empty = (title: string) => <section className="fcp-blank"><div><h2>{title}</h2><p>После подключения данные появятся здесь.</p></div></section>;

function Header({title, detail, state}: Readonly<{title: string; detail: string; state?: string}>) { return <div className="fcp-phase-b-header"><div><h1>{title}</h1><p>{detail}</p></div>{state === undefined ? null : <span>{state}</span>}</div>; }
function Facts({children, columns = 3}: Readonly<{children: ReactNode; columns?: 3|4}>) { return <dl className={`fcp-phase-b-facts${columns === 4 ? ' fcp-phase-b-facts--four' : ''}`}>{children}</dl>; }
function Fact({label, children}: Readonly<{label: string; children: ReactNode}>) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
function EvidenceList({title, rows}: Readonly<{title: string; rows: readonly Readonly<{id: string; title: string; detail: string; at?: string; url?: string}>[]}>) {
  return <section className="fcp-phase-b-panel fcp-phase-b-evidence"><header><div><h2>{title}</h2><p>Ограниченные подтверждённые факты, без runtime-консоли.</p></div><span>{rows.length}</span></header>{rows.length === 0 ? <p className="fcp-empty">Нет подтверждённых записей.</p> : <div>{rows.map((row) => <article key={row.id}><div><strong>{row.title}</strong><small>{row.detail}</small></div>{row.at === undefined && row.url === undefined ? null : <div>{row.at === undefined ? null : <time>{instant(row.at)}</time>}{row.url === undefined ? null : <a href={row.url}>Открыть ↗</a>}</div>}</article>)}</div>}</section>;
}

export function TaskApprovalEvidence({projectId, taskId, approvals}: Readonly<{projectId: string; taskId: string; approvals: readonly ApprovalEvidenceView[]}>) {
  return <EvidenceList title="Зафиксированные согласования" rows={approvals.filter((approval) => approval.projectId === projectId && approval.targetReference === taskId).map((approval) => ({id: approval.id, title: approval.decision === 'approved' ? 'Согласовано' : 'Отклонено', detail: approval.kind, at: approval.decidedAt, url: approval.targetUrl}))}/>;
}

function Systems({project, evidence, config}: Readonly<Pick<Props, 'project'|'evidence'|'config'>>) {
  if (project === null) return empty('Нет доступных проектов');
  const submissions = evidence?.agentSubmissions ?? {count: 0, lastOccurredAt: null};
  const records = [...(evidence?.receipts ?? []).map((item, index) => ({id: `receipt-${index}`, title: 'Команда подтверждена', detail: item.commandType, at: item.occurredAt})), ...(evidence?.audit ?? []).map((item, index) => ({id: `audit-${index}`, title: 'Действие зафиксировано', detail: item.action, at: item.occurredAt}))];
  return <div className="fcp-phase-b"><Header title="Агенты и системы" detail="Готовность Hermes и подтверждённые receipts/audit без отдельного запуска."/><section className="fcp-phase-b-panel fcp-phase-b-agent"><header><div><span>ASCON Hermes</span><h2>AgentDeliveryPort · диагностика</h2></div><b className={config.hermes ? 'ready' : 'danger'}><CircleDot aria-hidden="true" size={14}/>{config.hermes ? 'Настроено' : 'Не настроено'}</b></header><div className="fcp-phase-b-agent-name"><i><Bot aria-hidden="true" size={22}/></i><div><strong>Hermes</strong><small>Провайдер-независимый адаптер доставки · секретная ссылка скрыта</small></div><b className={config.hermes ? 'ready' : 'danger'}><CircleDot aria-hidden="true" size={14}/>{config.hermes ? 'Готов' : 'Нет готовности'}</b></div><Facts><Fact label="Готовность интеграции"><strong>{config.hermes ? 'Точка подключения и ссылка на credential' : 'Требуется composition'}</strong></Fact><Fact label="Допустимый запуск"><strong>Только из карточки GitHub Project</strong><small>Явное назначение исполнителя</small></Fact><Fact label="Последняя квитанция"><strong>{submissions.lastOccurredAt === null ? 'Нет подтверждённого факта' : instant(submissions.lastOccurredAt)}</strong><small>{submissions.count} явных команд</small></Fact></Facts><footer><span>● GitHub snapshot</span><span>● Hermes delivery</span><span>● receipts / audit</span></footer></section><p className="fcp-phase-b-note">Чтобы назначить человека или Hermes, откройте <a href={phaseHref('tasks', project.slug)}>задачу GitHub Project</a>.</p><EvidenceList title="Подтверждённые receipts и интеграции" rows={records}/></div>;
}

function Conversations({project, evidence, config}: Readonly<Pick<Props, 'project'|'evidence'|'config'>>) {
  if (project === null) return empty('Нет доступных проектов');
  const card = (input: Readonly<{title: string; provider: 'telegram'|'bitrix24'; contour: 'trusted-main'|'client-edge'; configured: boolean; blocked?: boolean}>) => {
    const fact = evidence?.conversations.find((item) => item.contour === input.contour);
    const linked = evidence?.people.filter((person) => person.identityBindings.some((binding) => binding.provider === input.provider)).length ?? 0;
    return <article className="fcp-phase-b-chat" key={input.provider}><header><div><h2>{input.title}</h2><small>{input.provider === 'telegram' ? 'Telegram · внутренний контур' : 'Bitrix24 · клиентский контур'}</small></div><b className={input.blocked ? 'danger' : input.configured ? 'ready' : 'danger'}>{input.blocked ? 'Блокировано policy' : input.configured ? 'Готов' : 'Не настроено'}</b></header><div><aside><strong>ПРИВЯЗКА И ГОТОВНОСТЬ</strong><p>{input.configured ? `Привязано identity: ${linked}. Действие проходит аутентификацию и policy.` : 'Подключение не подтверждено.'}</p></aside><p>{fact === undefined ? 'Подтверждённая активность отсутствует.' : `Подтверждённая активность: ${fact.count} · ${instant(fact.lastOccurredAt)}.`} Состояние доставки: {input.contour === 'trusted-main' ? delivery(evidence?.messenger ?? {pending: 0, delivered: 0, failed: 0}) : 'не включено'}.</p></div></article>;
  };
  return <div className="fcp-phase-b"><Header title={project.name} detail="Внутренний Telegram и внешний Bitrix: контуры, привязки и подтверждённая активность." state="Без транскриптов и локальной истории чата"/><h2 className="fcp-phase-b-context">{project.name}</h2><section className="fcp-phase-b-chat-grid">{card({title: 'Внутренний чат', provider: 'telegram', contour: 'trusted-main', configured: config.telegram.configured})}{card({title: 'Чат с клиентом', provider: 'bitrix24', contour: 'client-edge', configured: config.bitrix.configured && config.bitrix.clientActionsEnabled, blocked: !config.bitrix.clientActionsEnabled})}</section></div>;
}

function People({project, evidence, actorId}: Readonly<Pick<Props, 'project'|'evidence'|'actorId'>>) {
  if (project === null) return empty('Нет доступных проектов');
  const people = evidence?.people ?? [];
  const canManage = people.some((person) => person.actorId === actorId && person.active && person.role === 'project_owner');
  const linked = people.reduce((sum, person) => sum + person.identityBindings.length, 0);
  return <div className="fcp-phase-b"><Header title="Роли и доступы" detail="Состав проекта, роли и внешние привязки — только подтверждённые факты."/><section><h2 className="fcp-phase-b-section-title">Участники проектов</h2><div className="fcp-phase-b-roster">{people.length === 0 ? <p className="fcp-empty">Нет данных о членствах.</p> : people.map((person) => <article key={person.membershipId}><UsersRound aria-hidden="true" size={20}/><div><strong>{person.displayName}</strong><small>{project.name} · {person.role} · {person.kind === 'human' ? 'человек' : 'система'}</small><span><CheckCircle2 aria-hidden="true" size={15}/>{person.active ? 'Активен' : 'Неактивен'}</span><p>{person.identityBindings.length === 0 ? 'Внешние привязки не настроены' : `Подтверждено привязок: ${person.identityBindings.length}`}</p></div></article>)}</div></section><section><header className="fcp-phase-b-section-head"><h2>Состояние доступов</h2><span>Подтверждённая проекция</span></header><Facts columns={4}><Fact label="Люди и системы"><strong>{people.length}</strong></Fact><Fact label="Активные роли"><strong>{people.filter((person) => person.active).length}</strong></Fact><Fact label="Внешние привязки"><strong>{linked}</strong></Fact><Fact label="Подтверждено"><strong>{linked}</strong></Fact></Facts></section><section className="fcp-phase-b-manage"><header><div><h2>Управление составом проекта</h2><p>Добавление и изменение членства — только owner через canonical command.</p></div><ShieldCheck aria-hidden="true" size={20}/></header><AccessControls projectId={project.id} canManage={canManage} members={people}/></section></div>;
}

function Settings({project, sources, approvals, agentProfile}: Readonly<Pick<Props, 'project'|'sources'|'approvals'|'agentProfile'>>) {
  if (project === null) return empty('Нет доступных проектов');
  const projectSources = sources.filter((source) => source.projectId === project.id);
  const projectApprovals = approvals.filter((approval) => approval.projectId === project.id);
  return <div className="fcp-phase-b"><Header title={project.name} detail="Факты проекта, источники Control Plane и точные согласования."/><section className="fcp-phase-b-binding"><header><div><h2>Подключение проекта</h2><p>GitHub остаётся единственным источником задач и статусов.</p></div><span><CircleDot aria-hidden="true" size={15}/>{project.tracker.freshness === 'fresh' ? 'Данные актуальны' : project.tracker.freshness === 'stale' ? 'Требуется обновление' : 'Нет свежих данных'}</span></header><p>Только чтение: здесь показаны факт подключения и свежесть данных.</p><Facts columns={4}><Fact label="Репозиторий"><strong>{project.name}</strong></Fact><Fact label="Задачи"><strong>GitHub Project</strong></Fact><Fact label="Источник"><strong>{project.tracker.sourceUrl === null ? 'Не подключён' : 'Подключён'}</strong></Fact><Fact label="Свежесть"><strong>{project.tracker.errorCode ? 'Требуется обновление' : project.tracker.freshness === 'fresh' ? 'Актуально' : 'Ожидает обновления'}</strong></Fact></Facts></section><section className="fcp-phase-b-manage"><header><div><h2>ИИ агент проекта</h2><p>Один постоянный Hermes-профиль для диалога, памяти и управления проектом.</p></div><Bot aria-hidden="true" size={20}/></header><ProjectAgentActivationControl projectId={project.id} status={agentProfile?.status??'not_configured'} profile={agentProfile?.profile??null}/></section><section className="fcp-phase-b-manage"><header><div><h2>Другой проект</h2><p>Подключение GitHub Project и репозитория без ввода секретов.</p></div><Link2 aria-hidden="true" size={20}/></header><ProjectRegistrationControl/></section><section className="fcp-phase-b-manage"><header><div><h2>Подтверждённые источники</h2><p>Источники Control Plane</p></div><FileText aria-hidden="true" size={20}/></header><div className="fcp-phase-b-source-list">{projectSources.length === 0 ? <p className="fcp-empty">Источники ещё не добавлены.</p> : projectSources.map((source) => <article key={source.id}><div><strong>{source.name}</strong><small>Подтверждённый источник</small></div>{source.sourceUrl === null ? null : <a href={source.sourceUrl}><Link2 aria-hidden="true" size={14}/>Источник ↗</a>}</article>)}</div><SourceAddControl projectId={project.id}/></section><EvidenceList title="Точные согласования" rows={projectApprovals.map((approval) => ({id: approval.id, title: `${approval.kind} · ${approval.decision === 'approved' ? 'Согласовано' : 'Отклонено'}`, detail: 'Подтверждённая версия', at: approval.decidedAt, url: approval.targetUrl}))}/><p className="fcp-phase-b-note">Команда согласования доступна только после выбора свежей карточки в <a href={phaseHref('tasks', project.slug)}>«Задачах»</a>.</p></div>;
}

export function PhaseB(props: Props) {
  switch (props.view) {
    case 'conversations': return <Conversations {...props}/>;
    case 'people': return <People {...props}/>;
    case 'systems': return <Systems {...props}/>;
    case 'settings': return <Settings {...props}/>;
  }
}

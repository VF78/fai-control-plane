import {createHash} from 'node:crypto';
import type {ProjectAgentProfileView, ProjectOperatorEvidenceView, ProjectSourceView, ProjectTaskView} from '@fai-control-plane/db';
import type {ReactNode} from 'react';
import {Bot, CheckCircle2, CircleDot, FileText, ShieldCheck, UsersRound} from 'lucide-react';
import {AccessControls, ArchitectureProposalDecision, ProjectAgentActivationControl, ProjectDocumentUploadControl, ProjectRegistrationControl} from './operator-controls.tsx';
import type {IntegrationConfig} from './integration-config.ts';
import {phaseHref} from './phase-a-ui.tsx';

export type PhaseBView = 'conversations'|'people'|'systems'|'settings';
type Props = Readonly<{
  view: PhaseBView; project: ProjectTaskView|null; evidence: ProjectOperatorEvidenceView|null;
  sources: readonly ProjectSourceView[]; actorId: string; config: IntegrationConfig;
  agentProfile: ProjectAgentProfileView|null;
}>;
const instant = (value: string) => new Intl.DateTimeFormat('ru-RU', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow'}).format(new Date(value));
const delivery = (value: {pending: number; delivered: number; failed: number}) => value.failed > 0 ? `Ошибка · ${value.failed}` : value.pending > 0 ? `Ожидает · ${value.pending}` : value.delivered > 0 ? `Доставлено · ${value.delivered}` : 'Нет данных';
const empty = (title: string) => <section className="fcp-blank"><div><h2>{title}</h2><p>После подключения данные появятся здесь.</p></div></section>;

function Header({title, detail, state, action}: Readonly<{title: string; detail: string; state?: string; action?: ReactNode}>) { return <div className="fcp-phase-b-header"><div><h1>{title}</h1><p>{detail}</p></div>{action ?? (state === undefined ? null : <span>{state}</span>)}</div>; }
function Facts({children, columns = 3}: Readonly<{children: ReactNode; columns?: 3|4}>) { return <dl className={`fcp-phase-b-facts${columns === 4 ? ' fcp-phase-b-facts--four' : ''}`}>{children}</dl>; }
function Fact({label, children}: Readonly<{label: string; children: ReactNode}>) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
function EvidenceList({title, rows}: Readonly<{title: string; rows: readonly Readonly<{id: string; title: string; detail: string; at?: string; url?: string}>[]}>) {
  return <section className="fcp-phase-b-panel fcp-phase-b-evidence"><header><div><h2>{title}</h2><p>Ограниченные подтверждённые факты, без runtime-консоли.</p></div><span>{rows.length}</span></header>{rows.length === 0 ? <p className="fcp-empty">Нет подтверждённых записей.</p> : <div>{rows.map((row) => <article key={row.id}><div><strong>{row.title}</strong><small>{row.detail}</small></div>{row.at === undefined && row.url === undefined ? null : <div>{row.at === undefined ? null : <time>{instant(row.at)}</time>}{row.url === undefined ? null : <a href={row.url}>Открыть ↗</a>}</div>}</article>)}</div>}</section>;
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

function Settings({project, sources, agentProfile}: Readonly<Pick<Props, 'project'|'sources'|'agentProfile'>>) {
  const header = <Header title="Настройки проектов" detail="Подключите проект, документы и ИИ-агента для работы команды." action={<ProjectRegistrationControl/>}/>;
  if (project === null) return <div className="fcp-phase-b fcp-settings">{header}<section className="fcp-settings-panel"><p className="fcp-empty">Добавьте первый проект, чтобы настроить документы и ИИ-агента.</p></section></div>;
  const projectSources = sources.filter((source) => source.projectId === project.id);
  const documents=projectSources.filter(({kind})=>kind.startsWith('project_document_v1:'));
  const activeFixed=new Map<string,ProjectSourceView>();const activeSupplemental:ProjectSourceView[]=[];
  for(const document of documents){const category=document.kind.split(':')[1]??'';
    if(category==='supplemental')activeSupplemental.push(document);else if(!activeFixed.has(category))activeFixed.set(category,document);}
  const activeDocuments=[...activeFixed.values(),...activeSupplemental];
  const documentCategories=new Set(activeDocuments.map(({kind})=>kind.split(':')[1]));
  const documentsReady=documentCategories.has('combined')||
    (documentCategories.has('requirements')&&documentCategories.has('passport'));
  const documentFingerprint=createHash('sha256').update(activeDocuments.slice().sort((left,right)=>
    left.kind.localeCompare(right.kind)||left.sha256.localeCompare(right.sha256))
    .map(({kind,sha256})=>`${kind}:${sha256}`).join('\n')).digest('hex');
  const agentStatus=documentsReady&&agentProfile?.documentFingerprint!==null&&
    agentProfile?.documentFingerprint!==documentFingerprint?'not_configured':agentProfile?.status??'not_configured';
  const architectureProposal=projectSources.find(({kind,sha256})=>kind==='project_architecture_proposal_v1'&&
    sha256===agentProfile?.proposalSha)??null;
  const category=(kind:string)=>({requirements:'Требования / ТЗ',passport:'Паспорт проекта',combined:'Требования + паспорт',
    architecture:'Архитектура',supplemental:'Дополнительный'}[kind.split(':')[1]??'']??kind);
  return <div className="fcp-phase-b fcp-settings">{header}<div className="fcp-crumbs"><a href={phaseHref('dashboard')}>Все проекты</a><span>›</span><strong>{project.name}</strong></div><h2 className="fcp-settings-project-title">{project.name}</h2><section className="fcp-settings-connections" aria-label="Подключения GitHub"><div><span>Репозиторий</span><a href={project.repositoryUrl} target="_blank" rel="noreferrer">{project.repositoryUrl.replace(/^https:\/\/github\.com\//, '') || 'Репозиторий'} ↗</a></div><div><span>Задачи</span>{project.tracker.sourceUrl === null ? <span>GitHub Project не подключён</span> : <a href={project.tracker.sourceUrl} target="_blank" rel="noreferrer">GitHub Project ↗</a>}</div></section><section className="fcp-settings-panel"><header><div><h2>Документы</h2><p>ТЗ и паспорт или один объединённый документ.</p></div><FileText aria-hidden="true" size={19}/></header><div className="fcp-phase-b-source-list">{activeDocuments.length===0?<p className="fcp-empty">Документы ещё не загружены.</p>:activeDocuments.map((source)=><article key={source.id}><div><strong>{source.name}</strong><small>{category(source.kind)} · {(source.sizeBytes/1024).toFixed(1)} КиБ</small></div><a href={`/api/projects/${project.id}/documents/${source.id}`}>Скачать</a></article>)}</div><ProjectDocumentUploadControl projectId={project.id}/></section><section className="fcp-settings-panel"><header><div><h2>ИИ-агент</h2><p>Настройте агента после загрузки документов.</p></div><Bot aria-hidden="true" size={19}/></header><ProjectAgentActivationControl projectId={project.id} status={agentStatus} profile={agentProfile?.profile??null} documentsReady={documentsReady}/>{agentStatus==='awaiting_architecture'&&architectureProposal!==null?<ArchitectureProposalDecision projectId={project.id} proposalSha={architectureProposal.sha256}/>:null}</section></div>;
}

export function PhaseB(props: Props) {
  switch (props.view) {
    case 'conversations': return <Conversations {...props}/>;
    case 'people': return <People {...props}/>;
    case 'systems': return <Systems {...props}/>;
    case 'settings': return <Settings {...props}/>;
  }
}

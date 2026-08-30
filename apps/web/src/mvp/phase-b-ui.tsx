import {createHash} from 'node:crypto';
import type {ProjectAgentProfileView, ProjectHermesRuntimeSetupView, ProjectOperatorEvidenceView,
  ProjectSourceView, ProjectTaskView, ProjectTrackerCapabilities,ProjectTrackerPreparationView,ProjectWizardProgress,
  WorkspaceHumanActorView} from '@fai-control-plane/db';
import type {ReactNode} from 'react';
import {Bot, CheckCircle2, CircleDot, FileText, MessageSquareText, ShieldCheck, UsersRound} from 'lucide-react';
import {AccessControls, ArchitectureProposalDecision, ProjectAgentActivationControl, ProjectDeleteControl,ProjectDocumentUploadControl, projectRoleLabel,TelegramSettingsControl} from './operator-controls.tsx';
import {ProjectSetupWizard,projectSetupState} from './project-wizard.tsx';
import type {IntegrationConfig} from './integration-config.ts';
import {phaseHref} from './phase-a-ui.tsx';

export type PhaseBView = 'conversations'|'people'|'systems'|'settings';
export type PhaseBProject = Readonly<{project:ProjectTaskView;evidence:ProjectOperatorEvidenceView|null;
  sources:readonly ProjectSourceView[];config:IntegrationConfig;agentProfile:ProjectAgentProfileView|null;
  runtimeSetup:ProjectHermesRuntimeSetupView|null;trackerCapabilities:ProjectTrackerCapabilities|null;
  trackerPreparation:ProjectTrackerPreparationView|null;wizardProgress:ProjectWizardProgress|null}>;
type Props = Readonly<{view:PhaseBView;projects:readonly PhaseBProject[];actorId:string;setup:string|undefined;
  workspacePeople:readonly WorkspaceHumanActorView[]}>;

function Header({title,detail,action}: Readonly<{title:string;detail:string;action?:ReactNode}>) { return <div className="fcp-phase-b-header"><div><h1>{title}</h1><p>{detail}</p></div>{action}</div>; }
function EmptyProjects() { return <section className="fcp-blank"><div><h2>Нет доступных проектов</h2><p>Добавьте проект в настройках.</p></div></section>; }
function ProjectBlock({project,children}: Readonly<{project:ProjectTaskView;children:ReactNode}>) { return <section className="fcp-project-block"><header><div><strong>{project.name}</strong><span>Проект</span></div></header>{children}</section>; }
const participantNoun=(count:number)=>count%10===1&&count%100!==11?'участник':count%10>=2&&count%10<=4&&(count%100<10||count%100>=20)?'участника':'участников';

function Systems({projects}: Readonly<{projects:readonly PhaseBProject[]}>) { return <div className="fcp-phase-b"><Header title="Агенты и системы" detail="Готовность рабочих систем по каждому проекту."/>{projects.length===0?<EmptyProjects/>:<div className="fcp-portfolio-blocks">{projects.map(({project,config})=><ProjectBlock project={project} key={project.id}><div className="fcp-system-summary"><i><Bot aria-hidden="true" size={20}/></i><div><strong>Hermes</strong><small>ИИ-агент проекта</small></div><span className={`fcp-status ${config.hermes?'success':'warning'}`}><CircleDot aria-hidden="true" size={14}/>{config.hermes?'Готов к работе':'Требует настройки'}</span><a href={phaseHref('tasks',project.slug)}>Перейти к задачам</a></div></ProjectBlock>)}</div>}</div>; }

function Conversations({projects,actorId}: Readonly<{projects:readonly PhaseBProject[];actorId:string}>) { return <div className="fcp-phase-b"><Header title="Чаты" detail="Рабочие каналы и доступ команды по каждому проекту."/>{projects.length===0?<EmptyProjects/>:<div className="fcp-portfolio-blocks">{projects.map(({project,evidence,config})=>{const people=evidence?.people??[];const telegramLinked=people.filter((person)=>person.active&&person.identityBindings.some((binding)=>binding.provider==='telegram')).length;const bitrixLinked=people.filter((person)=>person.active&&person.identityBindings.some((binding)=>binding.provider==='bitrix24')).length;const canManage=people.some((person)=>person.actorId===actorId&&person.active&&person.role==='project_owner');return <ProjectBlock project={project} key={project.id}><div className="fcp-channel-grid"><article><MessageSquareText aria-hidden="true" size={19}/><div><strong>Внутренний чат</strong><small>Telegram · {telegramLinked} {participantNoun(telegramLinked)} с доступом</small></div><span className={`fcp-status ${config.telegram.configured?'success':'warning'}`}><CircleDot aria-hidden="true" size={13}/>{config.telegram.configured?'Готов':'Не настроен'}</span></article><article><MessageSquareText aria-hidden="true" size={19}/><div><strong>Чат с клиентом</strong><small>Bitrix24 · {bitrixLinked} {participantNoun(bitrixLinked)} с доступом</small></div><span className={`fcp-status ${config.bitrix.configured&&config.bitrix.clientActionsEnabled?'success':'neutral'}`}><CircleDot aria-hidden="true" size={13}/>{config.bitrix.configured&&config.bitrix.clientActionsEnabled?'Готов':'Недоступен'}</span></article></div>{canManage&&!config.telegram.configured?<TelegramSettingsControl projectId={project.id}/>:null}</ProjectBlock>;})}</div>}</div>; }

function People({projects,actorId,workspacePeople}: Readonly<{projects:readonly PhaseBProject[];actorId:string;workspacePeople:readonly WorkspaceHumanActorView[]}>) { return <div className="fcp-phase-b"><Header title="Роли и доступы" detail="Участники и управление доступом по каждому проекту."/>{projects.length===0?<EmptyProjects/>:<div className="fcp-portfolio-blocks">{projects.map(({project,evidence})=>{const people=evidence?.people??[];const canManage=people.some((person)=>person.actorId===actorId&&person.active&&person.role==='project_owner');return <ProjectBlock project={project} key={project.id}><div className="fcp-people-list">{people.length===0?<p className="fcp-empty">Участники ещё не добавлены.</p>:people.map((person)=><article key={person.membershipId}><UsersRound aria-hidden="true" size={18}/><div><strong>{person.displayName}</strong><small>{projectRoleLabel[person.role]??'Участник'} · {person.kind==='human'?'человек':'система'}</small></div><span className={`fcp-status ${person.active?'success':'neutral'}`}><CheckCircle2 aria-hidden="true" size={14}/>{person.active?'Активен':'Неактивен'}</span></article>)}</div><div className="fcp-block-actions"><ShieldCheck aria-hidden="true" size={17}/><span>Управление составом</span><AccessControls projectId={project.id} canManage={canManage} members={people} workspacePeople={workspacePeople}/></div></ProjectBlock>;})}</div>}</div>; }

const category=(kind:string)=>({requirements:'Техническое задание',passport:'Паспорт проекта',combined:'Прочее',architecture:'Архитектура',supplemental:'Прочее'}[kind.split(':')[1]??'']??'Прочее');
const projectDocumentState=({project,sources}:PhaseBProject)=>{
  const projectSources=sources.filter((source)=>source.projectId===project.id);const documents=projectSources.filter(({kind})=>kind.startsWith('project_document_v1:'));
  const activeFixed=new Map<string,ProjectSourceView>();const activeSupplemental:ProjectSourceView[]=[];
  for(const document of documents){const key=document.kind.split(':')[1]??'';if(key==='supplemental')activeSupplemental.push(document);else if(!activeFixed.has(key))activeFixed.set(key,document);}
  const activeDocuments=[...activeFixed.values(),...activeSupplemental];const documentCategories=new Set(activeDocuments.map(({kind})=>kind.split(':')[1]));
  const documentsReady=documentCategories.has('combined')||(documentCategories.has('requirements')&&documentCategories.has('passport'));
  const fingerprint=createHash('sha256').update(activeDocuments.slice().sort((left,right)=>left.kind.localeCompare(right.kind)||left.sha256.localeCompare(right.sha256)).map(({kind,sha256})=>`${kind}:${sha256}`).join('\n')).digest('hex');
  return {projectSources,activeDocuments,documentsReady,fingerprint};
};
function SettingsProject(item: PhaseBProject) {
  const {project,agentProfile}=item;const {projectSources,activeDocuments,documentsReady,fingerprint}=projectDocumentState(item);
  const agentStatus=documentsReady&&agentProfile?.documentFingerprint!==null&&agentProfile?.documentFingerprint!==fingerprint?'not_configured':agentProfile?.status??'not_configured';
  const proposal=projectSources.find(({kind,sha256})=>kind==='project_architecture_proposal_v1'&&sha256===agentProfile?.proposalSha)??null;
  const contextCurrent=agentProfile?.status==='ready'&&agentProfile.documentFingerprint===fingerprint;const setup=projectSetupState(item,contextCurrent);
  return <ProjectBlock project={project}><div className="fcp-project-setup-actions"><span className={`fcp-status ${setup.complete?'success':'warning'}`}><CircleDot aria-hidden="true" size={13}/>{setup.complete?'Настройка готова':'Настройка не завершена'}</span>{setup.complete?null:<a className="fcp-secondary" href={`/?view=settings&setup=${encodeURIComponent(project.slug)}`}>Продолжить настройку</a>}<ProjectDeleteControl projectId={project.id} projectName={project.name}/></div><div className="fcp-settings-connections"><div><span>Репозиторий</span><a href={project.repositoryUrl} target="_blank" rel="noreferrer">{project.repositoryUrl.replace(/^https:\/\/github\.com\//,'')||'Открыть'} ↗</a></div><div><span>GitHub Project</span>{project.tracker.sourceUrl===null?<span>Не подключён</span>:<a href={project.tracker.sourceUrl} target="_blank" rel="noreferrer">Открыть ↗</a>}</div></div><div className="fcp-settings-sections"><section><header><div><h2>Документы</h2><p>Активные материалы проекта.</p></div><FileText aria-hidden="true" size={18}/></header><div className="fcp-phase-b-source-list">{activeDocuments.length===0?<p className="fcp-empty">Документы ещё не загружены.</p>:activeDocuments.map((source)=><article key={source.id}><div><strong>{source.name}</strong><small>{category(source.kind)}</small></div><a href={`/api/projects/${project.id}/documents/${source.id}`}>Скачать</a></article>)}</div><ProjectDocumentUploadControl projectId={project.id}/></section><section><header><div><h2>ИИ-агент</h2><p>Подключение и контекст работы.</p></div><Bot aria-hidden="true" size={18}/></header><ProjectAgentActivationControl projectId={project.id} status={agentStatus} profile={agentProfile?.profile??null} documentsReady={documentsReady}/>{agentStatus==='awaiting_architecture'&&proposal!==null?<ArchitectureProposalDecision projectId={project.id} proposalSha={proposal.sha256}/>:null}</section></div></ProjectBlock>;
}
function Settings({projects,setup,actorId,workspacePeople}: Readonly<{projects:readonly PhaseBProject[];setup:string|undefined;actorId:string;workspacePeople:readonly WorkspaceHumanActorView[]}>) {
  const ordered=[...projects].sort((left,right)=>{const state=(item:PhaseBProject)=>projectSetupState(item,item.agentProfile?.status==='ready'&&item.agentProfile.documentFingerprint===projectDocumentState(item).fingerprint).complete;
    return Number(state(left))-Number(state(right));});
  const incomplete=ordered.filter((item)=>!projectSetupState(item,item.agentProfile?.status==='ready'&&item.agentProfile.documentFingerprint===projectDocumentState(item).fingerprint).complete);
  const selected=setup==='new'?(incomplete[0]??null):setup===undefined||setup==='create'?null:projects.find(({project})=>project.slug===setup)??null;
  const selectedContextCurrent=selected!==null&&selected.agentProfile?.status==='ready'&&
    selected.agentProfile.documentFingerprint===projectDocumentState(selected).fingerprint;
  return <div className={`fcp-phase-b fcp-settings ${setup!==undefined?'fcp-settings-wizard-open':''}`}><Header title="Настройки проектов"
    detail="Репозитории, документы и ИИ-агенты портфеля."
    action={<a className="fcp-primary fcp-add-project" href="/?view=settings&setup=create">Добавить проект</a>}/>
    {setup!==undefined?<ProjectSetupWizard item={selected} contextCurrent={selectedContextCurrent} actorId={actorId} workspacePeople={workspacePeople}/>:null}
    {setup===undefined?(projects.length===0?<section className="fcp-settings-panel"><p className="fcp-empty">Добавьте первый проект.</p></section>:<div className="fcp-portfolio-blocks">{ordered.map((item)=><SettingsProject {...item} key={item.project.id}/>)}</div>):null}
  </div>;
}

export function PhaseB(props:Props) { switch(props.view){case'conversations':return <Conversations projects={props.projects} actorId={props.actorId}/>;case'people':return <People projects={props.projects} actorId={props.actorId} workspacePeople={props.workspacePeople}/>;case'systems':return <Systems projects={props.projects}/>;case'settings':return <Settings projects={props.projects} setup={props.setup} actorId={props.actorId} workspacePeople={props.workspacePeople}/>;} }

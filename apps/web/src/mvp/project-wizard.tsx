'use client';

import {useEffect,useMemo,useState,type FormEvent,type ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import {Check,ChevronRight,ExternalLink,GitBranch,MessageCircle,Play,ShieldCheck,Sparkles} from 'lucide-react';
import type {TrackerItemFact} from '@fai-control-plane/domain';
import type {WorkspaceHumanActorView} from '@fai-control-plane/db';
import {defaultProjectProcessPolicy} from '@fai-control-plane/domain';
import type {PhaseBProject} from './phase-b-ui.tsx';
import {AccessControls,ArchitectureProposalDecision,ProjectDeleteControl,ProjectDocumentsEditor,TelegramSettingsControl} from './operator-controls.tsx';
import {AsyncButton,CommandNoticeView,useAsyncCommand} from './async-command.tsx';
import {ProcessStages} from './phase-a-ui.tsx';
import {projectSetupState} from './project-setup-state.ts';

type Result=Readonly<{error?:string;projectId?:string;slug?:string;status?:string;itemId?:string;itemUrl?:string}>;
const id=()=>globalThis.crypto?.randomUUID?.()??`${Date.now()}-${Math.random()}`;
const json=async(path:string,body:Record<string,unknown>):Promise<Result>=>{const response=await fetch(path,{method:'POST',
  headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await response.json().catch(()=>({})) as Result;
  if(!response.ok)throw new Error(value.error??'request_failed');return value;};
const errorText=(error:unknown)=>{const code=error instanceof Error?error.message:'request_failed';return ({
  github_binding_invalid:'GitHub не подтвердил репозиторий и Project. Проверьте ссылки и поля Owner, Status и Blocked.',
  github_read_failed:'GitHub сейчас не подтвердил подключение. Повторите позже.',
  project_registration_conflict:'Проект с таким коротким именем уже подключён к другому репозиторию или Project.',
  project_registration_denied:'Только владелец проекта может добавить новый проект.',
  project_registration_unavailable:'Подключение GitHub для рабочего пространства не настроено.',
  project_document_pdf_text_layer_required:'В PDF нет текстового слоя. Загрузите текстовый PDF или DOCX.',
  project_document_set_too_large:'Активный набор документов превышает лимит.',
  project_document_invalid:'Поддерживаются DOCX, PDF с текстовым слоем, MD и TXT.',
  project_messenger_verification_failed:'Telegram не подтвердил бота или чат. Проверьте данные и доступ бота.',
  project_repository_verification_failed:'Токен не даёт ИИ-агенту доступ к репозиторию.',
  project_tracker_verification_failed:'Токен не даёт ИИ-агенту доступ к GitHub Project.',
  project_runtime_unavailable:'ИИ-агент пока недоступен. Повторите проверку или установку.',
  authentication_expired:'Срок кода входа истёк. Запустите установку ещё раз.',
  context_unavailable:'Сначала завершите настройку контекста проекта.',
  execution_unavailable:'GitHub не подтвердил готовность задачи к запуску.',
  delivery_failed:'Задача назначена ИИ-агенту, но старт не подтверждён. Проверьте её в GitHub перед повтором.',
  provider_error:'GitHub или ИИ-агент не подтвердил операцию.'
} as Record<string,string>)[code]??'Действие не подтверждено. Проверьте данные и повторите.';};

const documentFacts=(item:PhaseBProject|null)=>{const documents=(item?.sources??[]).filter((source)=>
  source.projectId===item?.project.id&&source.kind.startsWith('project_document_v1:'));
  const latest=new Set<string>();for(const source of documents)latest.add(source.kind.split(':')[1]??'');
  return {documents,ready:latest.has('combined')||(latest.has('requirements')&&latest.has('passport'))};};
const done=(task:TrackerItemFact,doneOptionId:string)=>task.statusOptionId===doneOptionId;
const taskUrl=(value:string):string=>{try{const url=new URL(value);url.search='';url.hash='';return url.toString().replace(/\/$/,'');}catch{return value.trim().replace(/\/$/,'');}};

function Step({number,title,complete,active,children}:Readonly<{number:number;title:string;complete:boolean;active:boolean;children:ReactNode}>) {
  return <section className={`fcp-wizard-step ${complete?'complete':''} ${active?'active':''}`}>
    <div className="fcp-wizard-rail"><span>{complete?<Check aria-hidden="true" size={14}/>:number}</span><i/></div>
    <div className="fcp-wizard-step-body"><header><h3>{title}</h3>{complete?<small>Готово</small>:active?<small>Текущий шаг</small>:<small>Будет доступен позже</small>}</header>{active?children:complete?<p className="fcp-wizard-summary">Шаг подтверждён.</p>:null}</div>
  </section>;
}

function Registration() {const command=useAsyncCommand();const router=useRouter();const submit=(event:FormEvent<HTMLFormElement>)=>{
  event.preventDefault();const form=new FormData(event.currentTarget);void command.run(()=>json('/api/projects',{name:form.get('name'),
    slug:form.get('slug'),projectUrl:form.get('projectUrl'),repositoryUrl:form.get('repositoryUrl'),
    idempotencyKey:`project-register:${id()}`}),{refresh:false,error:errorText,success:(result)=>{
      if(result.slug!==undefined)router.replace(`/?view=settings&setup=${encodeURIComponent(result.slug)}`);
      return 'GitHub подтвердил проект.';}});};
  return <form className="fcp-wizard-form" onSubmit={submit} aria-busy={command.pending}>
    <label>Название проекта<input name="name" required maxLength={200} disabled={command.pending}/></label>
    <label>Короткое имя<input name="slug" required maxLength={100} pattern="[a-z0-9][a-z0-9-]+[a-z0-9]" placeholder="new-project" disabled={command.pending}/></label>
    <label className="wide">Репозиторий<input name="repositoryUrl" type="url" required placeholder="https://github.com/owner/repository" disabled={command.pending}/></label>
    <label className="wide">GitHub Project<input name="projectUrl" type="url" required placeholder="https://github.com/users/owner/projects/1" disabled={command.pending}/></label>
    <p className="fcp-wizard-note"><GitBranch aria-hidden="true" size={16}/> GitHub остаётся источником кода и задач. Здесь сохраняется только проверенная привязка.</p>
    <AsyncButton pending={command.pending} pendingLabel="Проверяем GitHub…">Подтвердить проект <ChevronRight aria-hidden="true" size={16}/></AsyncButton>
    <CommandNoticeView notice={command.notice}/>
  </form>;}

function ProcessConfirmation({item}:Readonly<{item:PhaseBProject}>){const command=useAsyncCommand();const confirmed=item.wizardProgress?.processConfirmed===true;
  const confirm=()=>void command.run(()=>json(`/api/projects/${item.project.id}/wizard-progress`,{action:'confirm_process',
    idempotencyKey:`project-process-confirm:${id()}`}),{success:'Процесс подтверждён.',error:errorText});return <div className="fcp-wizard-action"><div>
    <strong>Текущий процесс разработки ПО</strong><ProcessStages stages={defaultProjectProcessPolicy.stages} label="Подтверждаемый процесс"/>
    <small>Сейчас процесс можно подтвердить как есть. Редактирование будет добавлено в этот же компонент.</small></div>{confirmed?null:<AsyncButton type="button"
      pending={command.pending} pendingLabel="Сохраняем…" onClick={confirm}>Подтвердить процесс</AsyncButton>}<CommandNoticeView notice={command.notice}/></div>;}

function Team({item,actorId,workspacePeople}:Readonly<{item:PhaseBProject;actorId:string;workspacePeople:readonly WorkspaceHumanActorView[]}>){const command=useAsyncCommand();const people=item.evidence?.people??[];
  const canManage=people.some((person)=>person.actorId===actorId&&person.active&&person.role==='project_owner');const skip=()=>void command.run(()=>
    json(`/api/projects/${item.project.id}/wizard-progress`,{action:'skip_team',idempotencyKey:`project-team-skip:${id()}`}),
  {success:'Команду можно настроить позднее в разделе «Роли и доступы».',error:errorText});return <div><AccessControls projectId={item.project.id}
    canManage={canManage} members={people.filter((person)=>person.active).map((person)=>({membershipId:person.membershipId,
      actorId:person.actorId,displayName:person.displayName,role:person.role}))} workspacePeople={workspacePeople}/><AsyncButton type="button" className="fcp-secondary" pending={command.pending}
      pendingLabel="Сохраняем…" onClick={skip}>Настроить позже</AsyncButton><CommandNoticeView notice={command.notice}/></div>;}

function Communications({item}:Readonly<{item:PhaseBProject}>){const command=useAsyncCommand();const skip=()=>void command.run(()=>
  json(`/api/projects/${item.project.id}/wizard-progress`,{action:'skip_communications',idempotencyKey:`project-communications-skip:${id()}`}),
  {success:'Мессенджеры можно подключить позднее в разделе «Чаты».',error:errorText});return <div><TelegramSettingsControl projectId={item.project.id}/><article className="fcp-client-chat-disabled" aria-disabled="true"><MessageCircle aria-hidden="true" size={17}/><div><strong>Чат с клиентом</strong><p>Настройка будет доступна позже.</p></div><span>Отключён</span></article>
    <AsyncButton type="button" className="fcp-secondary" pending={command.pending} pendingLabel="Сохраняем…" onClick={skip}>Настроить позже</AsyncButton>
    <CommandNoticeView notice={command.notice}/></div>;}

function Install({item}:Readonly<{item:PhaseBProject}>) {const command=useAsyncCommand();const router=useRouter();const status=item.runtimeSetup?.status;
  useEffect(()=>{if(!['installing','auth_required'].includes(status??''))return;const timer=setInterval(()=>router.refresh(),4_000);return()=>clearInterval(timer);},[router,status]);
  const submit=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const form=new FormData(event.currentTarget);
    void command.run(()=>json(`/api/projects/${item.project.id}/runtime`,{action:'install',githubToken:form.get('githubToken'),
      idempotencyKey:`project-runtime:${id()}`}),{success:'Установка ИИ-агента началась.',error:errorText});};
  if(status==='installing')return <div className="fcp-wizard-wait"><span className="fcp-button-spinner" aria-hidden="true"/><div><strong>Устанавливаем отдельного ИИ-агента</strong><p>Статус обновится автоматически.</p></div></div>;
  const auth=item.runtimeSetup?.auth;
  if(status==='auth_required'&&auth!==null&&auth!==undefined)return <div className="fcp-device-auth"><p>Откройте страницу OpenAI и введите одноразовый код. Авторизация останется только внутри защищённой среды этого проекта.</p>
    <a href={auth.verificationUrl} target="_blank" rel="noreferrer">Открыть вход OpenAI <ExternalLink aria-hidden="true" size={15}/></a>
    <div><span>Одноразовый код</span><strong>{auth.userCode}</strong></div>
    <button type="button" className="fcp-secondary" onClick={()=>router.refresh()}>Проверить вход</button></div>;
  return <form className="fcp-wizard-form" onSubmit={submit} aria-busy={command.pending}>
    {status==='error'?<p className="fcp-wizard-error">Готовность ИИ-агента не подтверждена. Повторная установка продолжит тот же изолированный экземпляр.</p>:null}
    <p className="fcp-wizard-intro">Будет создан один изолированный Hermes для проекта: собственные данные, память, сессии, рабочая папка и учётные данные.</p>
    <label className="wide">Токен GitHub для ИИ-агента<input name="githubToken" type="password" required autoComplete="off" disabled={command.pending}/></label>
    <p className="fcp-wizard-note"><ShieldCheck aria-hidden="true" size={16}/> Токен сохраняется только в защищённом хранилище этого проекта.</p>
    <AsyncButton pending={command.pending} pendingLabel="Проверяем доступ…">Установить ИИ-агента</AsyncButton><CommandNoticeView notice={command.notice}/>
  </form>;}

function Context({item}:Readonly<{item:PhaseBProject}>) {const command=useAsyncCommand();const router=useRouter();const status=item.agentProfile?.status??'not_configured';
  useEffect(()=>{if(status!=='configuring')return;const timer=setInterval(()=>router.refresh(),4_000);return()=>clearInterval(timer);},[router,status]);
  if(status==='configuring')return <div className="fcp-wizard-wait"><span className="fcp-button-spinner" aria-hidden="true"/><div><strong>Собираем контекст проекта</strong><p>ИИ-агент читает только привязанный репозиторий, GitHub Project и загруженные документы.</p></div></div>;
  if(status==='awaiting_architecture'&&item.agentProfile?.proposalSha!==undefined&&item.agentProfile.proposalSha!==null)
    return <ArchitectureProposalDecision projectId={item.project.id} proposalSha={item.agentProfile.proposalSha}/>;
  const configure=()=>void command.run(()=>json(`/api/projects/${item.project.id}/agent-profile`,{idempotencyKey:`agent-profile:${id()}`,
    force:status==='ready'||status==='error'}),{success:(result)=>result.status==='ready'?'Контекст проекта актуален.':'Настройка контекста началась.',error:errorText});
  return <div className="fcp-wizard-action"><div><strong>{status==='ready'?'Контекст готов':'Настроить рабочий контекст'}</strong>
    <p>{status==='ready'?'Можно повторно собрать контекст после изменения документов.':'ИИ-агент соберёт компактный контекст. Если архитектуры нет, предложит её для отдельного согласования.'}</p></div>
    <AsyncButton type="button" pending={command.pending} pendingLabel="Настраиваем…" onClick={configure}>{status==='ready'?'Настроить повторно':'Настроить контекст'}</AsyncButton><CommandNoticeView notice={command.notice}/></div>;
}

function PrepareProject({item}:Readonly<{item:PhaseBProject}>){const command=useAsyncCommand();const router=useRouter();
  const preparation=item.trackerPreparation;const status=preparation?.status??'not_started';
  useEffect(()=>{if(!['configuring','verifying'].includes(status))return;const timer=setInterval(()=>router.refresh(),4_000);
    return()=>clearInterval(timer);},[router,status]);
  const start=()=>void command.run(()=>json(`/api/projects/${item.project.id}/tracker-preparation`,{
    idempotencyKey:`project-tracker-preparation:${id()}`}),{success:'Hermes получил задачу привести Project к подтверждённому процессу.',error:errorText});
  const decide=(decision:'approved'|'rejected')=>{const approval=preparation?.approval;if(approval===null||approval===undefined)return;
    void command.run(()=>json(`/api/approvals/${encodeURIComponent(approval.id)}`,{projectId:item.project.id,kind:'internal_operation',
      targetReference:approval.version,decision,idempotencyKey:`project-tracker-preparation:${approval.version}:${decision}`}),
    {success:decision==='approved'?'Разрешение передано Hermes.':'Операция отклонена.',error:errorText});};
  if(['configuring','verifying'].includes(status))return <div className="fcp-wizard-wait"><span className="fcp-button-spinner" aria-hidden="true"/><div>
    <strong>{status==='verifying'?'Проверяем результат в GitHub':'Hermes настраивает Project'}</strong><p>Control Plane только читает итоговое состояние.</p></div></div>;
  if(status==='approval_required'&&preparation?.approval!==null&&preparation?.approval!==undefined)return <div className="fcp-wizard-action"><div>
    <strong>Hermes запрашивает разрешение</strong><p>{preparation.approval.text}</p></div><div><AsyncButton type="button" pending={command.pending}
      pendingLabel="Сохраняем…" onClick={()=>decide('approved')}>Подтвердить</AsyncButton><AsyncButton type="button" className="fcp-secondary"
      pending={command.pending} pendingLabel="Сохраняем…" onClick={()=>decide('rejected')}>Отклонить</AsyncButton></div><CommandNoticeView notice={command.notice}/></div>;
  return <div className="fcp-wizard-action"><div><strong>{status==='ready'?'Project готов':'Подготовить GitHub Project'}</strong>
    <p>{status==='blocked'?(preparation?.blocker??'Hermes не смог завершить настройку.'):'Hermes приведёт поля и этапы к подтверждённому процессу; Control Plane проверит итог.'}</p>
    {(preparation?.remainingDelta.length??0)>0?<small>{preparation!.remainingDelta.join(' · ')}</small>:null}</div>{status==='ready'?null:<AsyncButton type="button"
      pending={command.pending} pendingLabel="Запускаем…" onClick={start}>Поставить задачу Hermes</AsyncButton>}<CommandNoticeView notice={command.notice}/></div>;
}

function FirstTask({item}:Readonly<{item:PhaseBProject}>) {const command=useAsyncCommand();const router=useRouter();const [mode,setMode]=useState<'existing'|'create'>('existing');const [url,setUrl]=useState('');
  const capabilities=item.trackerCapabilities;const tasks=useMemo(()=>capabilities===null?[]:item.project.tasks.filter((task)=>
    !done(task,capabilities.doneStatusOptionId)&&task.blocked!==true),[capabilities,item.project.tasks]);
  const task=tasks.find((candidate)=>taskUrl(candidate.url)===taskUrl(url))??null;
  const activeMode=mode;
  const submit=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const form=new FormData(event.currentTarget);
    const key=`project-first-task:${id()}`;const body=activeMode==='existing'?{action:'confirm_and_start',projectId:item.project.id,
      projectItemId:task?.itemId,version:task?.version,exactStatement:task?.statement,confirmed:form.get('confirmed')==='on',
      idempotencyKey:key}:{action:'create_and_start',projectId:item.project.id,title:form.get('title'),
      scope:form.get('scope'),acceptance:form.get('acceptance'),confirmed:form.get('confirmed')==='on',idempotencyKey:key};
    void command.run(()=>json('/api/tasks/executor',body),{refresh:false,success:(result)=>{const itemId=result.itemId??task?.itemId;
      if(itemId!==undefined)router.push(`/?view=tasks&project=${encodeURIComponent(item.project.slug)}&task=${encodeURIComponent(itemId)}`);
      return 'ИИ-агент назначен и старт задачи подтверждён.';},error:errorText});};
  return <div><div className="fcp-wizard-tabs" role="tablist"><button type="button" className={activeMode==='existing'?'active':''} onClick={()=>setMode('existing')}>Вставить ссылку GitHub</button><button type="button" className={activeMode==='create'?'active':''} onClick={()=>setMode('create')}>Создать новую</button></div>
    <form className="fcp-wizard-form" onSubmit={submit} aria-busy={command.pending}>{activeMode==='existing'?<>
      <label className="wide">Ссылка на issue или элемент GitHub Project<input type="url" value={url} onChange={(event)=>setUrl(event.target.value)} placeholder="https://github.com/owner/repository/issues/123" disabled={command.pending}/></label>
      {url.trim()!==''&&task===null?<p className="fcp-wizard-error">Ссылка не найдена среди подтверждённых снимков привязанного GitHub Project или задача ещё не готова для Hermes. Создание или привязка задачи вне этого Project недоступны.</p>:null}
      {task===null?<p className="fcp-wizard-intro">Вставьте URL незавершённой незаблокированной задачи из уже привязанного GitHub Project. Hermes назначит себя и уточнит неполное описание перед дальнейшей работой.</p>:<><a className="fcp-wizard-source" href={task.url} target="_blank" rel="noreferrer">Открыть задачу в GitHub <ExternalLink aria-hidden="true" size={14}/></a><div className="fcp-task-statement"><span>Точный scope и acceptance из GitHub</span><pre>{task.statement?.trim()||'Описание пока не заполнено — Hermes запросит уточнение.'}</pre></div><label className="fcp-confirm wide"><input name="confirmed" type="checkbox" required disabled={command.pending}/> Подтверждаю эту задачу и явно запускаю ИИ-агента.</label></>}
    </>:<><label className="wide">Название задачи<input name="title" required maxLength={160} disabled={command.pending}/></label><label className="wide">Область работ<textarea name="scope" required maxLength={1500} rows={4} disabled={command.pending}/></label><label className="wide">Критерии приёмки<textarea name="acceptance" required maxLength={1500} rows={4} disabled={command.pending}/></label><label className="fcp-confirm wide"><input name="confirmed" type="checkbox" required disabled={command.pending}/> Подтверждаю этот scope и критерии приёмки и явно запускаю ИИ-агента.</label></>}
      <AsyncButton pending={command.pending} pendingLabel="Запускаем…" disabled={activeMode==='existing'&&task===null}><Play aria-hidden="true" size={15}/> Назначить и запустить</AsyncButton><CommandNoticeView notice={command.notice}/>
    </form></div>;
}

export function ProjectSetupWizard({item,contextCurrent,actorId,workspacePeople}:Readonly<{item:PhaseBProject|null;contextCurrent:boolean;actorId:string;workspacePeople:readonly WorkspaceHumanActorView[]}>) {const documents=documentFacts(item);
  const projectReady=item!==null;const setup=item===null?null:projectSetupState(item,documents.ready,contextCurrent);
  const states=setup?.states??[false,false,false,false,false,false,false,false];const processReady=states[2]===true;
  const teamReady=states[3]===true;const communicationsReady=states[4]===true;const runtimeReady=states[5]===true;
  const contextReady=states[6]===true;const trackerReady=states[7]===true;
  const docsReady=documents.ready;const active=setup?.nextStep??0;
  return <section className="fcp-project-wizard" aria-label="Добавить проект"><header><span><Sparkles aria-hidden="true" size={15}/> Настройка проекта</span><h2>{item===null?'Добавить проект':item.project.name}</h2><p>Один путь от GitHub до первой явно запущенной задачи.</p>{item===null?null:<ProjectDeleteControl projectId={item.project.id} projectName={item.project.name}/>}</header><div className="fcp-wizard-steps">
    <Step number={1} title="Репозиторий и задачи" complete={projectReady} active={active===0}>{item===null?<Registration/>:<div className="fcp-wizard-summary"><a href={item.project.repositoryUrl} target="_blank" rel="noreferrer">{item.project.repositoryUrl.replace(/^https:\/\/github\.com\//,'')}</a><a href={item.project.tracker.sourceUrl??'#'} target="_blank" rel="noreferrer">GitHub Project</a></div>}</Step>
    {item!==null?<><Step number={2} title="Документы" complete={docsReady} active={active===1}><ProjectDocumentsEditor projectId={item.project.id}/></Step>
      <Step number={3} title="Процесс" complete={processReady} active={active===2}><ProcessConfirmation item={item}/></Step>
      <Step number={4} title="Команда и роли" complete={teamReady} active={active===3}><Team item={item} actorId={actorId} workspacePeople={workspacePeople}/></Step>
      <Step number={5} title="Коммуникации" complete={communicationsReady} active={active===4}><Communications item={item}/></Step>
      <Step number={6} title="ИИ-агент" complete={runtimeReady} active={active===5}><Install item={item}/></Step>
      <Step number={7} title="Контекст" complete={contextReady} active={active===6}><Context item={item}/></Step>
      <Step number={8} title="Подготовка Project" complete={trackerReady} active={active===7}><PrepareProject item={item}/></Step>
      <Step number={9} title="Проверка готовности" complete={states.every(Boolean)} active={active===8}><div className="fcp-readiness">{[
        ['Репозиторий и GitHub Project',projectReady],['Документы',docsReady],['Процесс',processReady],['Команда',teamReady],['Коммуникации',communicationsReady],['ИИ-агент',runtimeReady],['Контекст',contextReady],['Подготовка Project',trackerReady]
      ].map(([label,ready])=><div className={ready===true?'ready':'pending'} key={label as string}>{ready===true?<Check aria-hidden="true" size={15}/>:<span aria-hidden="true">•</span>}{label as string}</div>)}</div></Step>
      <Step number={10} title="Первая задача" complete={false} active={active===9}><FirstTask item={item}/></Step></>:null}
  </div></section>;
}

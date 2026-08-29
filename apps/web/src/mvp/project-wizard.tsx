'use client';

import {useEffect,useMemo,useState,type FormEvent,type ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import {Check,ChevronRight,ExternalLink,FileText,GitBranch,MessageCircle,Play,ShieldCheck,Sparkles} from 'lucide-react';
import type {TrackerItemFact} from '@fai-control-plane/domain';
import type {PhaseBProject} from './phase-b-ui.tsx';
import {ArchitectureProposalDecision} from './operator-controls.tsx';
import {AsyncButton,CommandNoticeView,useAsyncCommand} from './async-command.tsx';

type Result=Readonly<{error?:string;projectId?:string;slug?:string;status?:string;itemId?:string;itemUrl?:string}>;
const id=()=>globalThis.crypto?.randomUUID?.()??`${Date.now()}-${Math.random()}`;
const json=async(path:string,body:Record<string,unknown>):Promise<Result>=>{const response=await fetch(path,{method:'POST',
  headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await response.json().catch(()=>({})) as Result;
  if(!response.ok)throw new Error(value.error??'request_failed');return value;};
const errorText=(error:unknown)=>{const code=error instanceof Error?error.message:'request_failed';return ({
  github_binding_invalid:'GitHub не подтвердил репозиторий и Project. Проверьте ссылки и поля Owner, Status и Blocked.',
  github_read_failed:'GitHub сейчас не подтвердил подключение. Повторите позже.',
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

function Step({number,title,complete,active,open=active,children}:Readonly<{number:number;title:string;complete:boolean;active:boolean;open?:boolean;children:ReactNode}>) {
  return <section className={`fcp-wizard-step ${complete?'complete':''} ${active?'active':''}`}>
    <div className="fcp-wizard-rail"><span>{complete?<Check aria-hidden="true" size={14}/>:number}</span><i/></div>
    <div className="fcp-wizard-step-body"><header><h3>{title}</h3>{complete?<small>Готово</small>:active?<small>Текущий шаг</small>:null}</header>{open||!complete?children:null}</div>
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
    <p className="fcp-wizard-note"><GitBranch aria-hidden="true" size={16}/> GitHub остаётся источником кода и задач. Здесь сохраняется только проверанная привязка.</p>
    <AsyncButton pending={command.pending} pendingLabel="Проверяем GitHub…">Подтвердить проект <ChevronRight aria-hidden="true" size={16}/></AsyncButton>
    <CommandNoticeView notice={command.notice}/>
  </form>;}

function Documents({projectId,count}:Readonly<{projectId:string;count:number}>) {const command=useAsyncCommand();const submit=(event:FormEvent<HTMLFormElement>)=>{
  event.preventDefault();const form=new FormData(event.currentTarget);form.set('idempotencyKey',`project-document:${id()}`);
  void command.run(async()=>{const response=await fetch(`/api/projects/${projectId}/documents`,{method:'POST',body:form});
    const value=await response.json().catch(()=>({})) as Result;if(!response.ok)throw new Error(value.error??'request_failed');return value;},
  {success:'Документ проверен и добавлен.',error:errorText});};return <form className="fcp-wizard-form" onSubmit={submit} aria-busy={command.pending}>
    <p className="fcp-wizard-intro">Загрузите один объединённый документ или отдельно требования и паспорт проекта. Архитектура необязательна.</p>
    {count>0?<p className="fcp-wizard-fact"><FileText aria-hidden="true" size={16}/> Загружено версий: {count}</p>:null}
    <label>Тип документа<select name="category" defaultValue="combined" disabled={command.pending}><option value="combined">Требования + паспорт</option><option value="requirements">Требования / ТЗ</option><option value="passport">Паспорт проекта</option><option value="architecture">Архитектура</option><option value="supplemental">Дополнительный</option></select></label>
    <label>Файл<input name="file" type="file" required accept=".docx,.pdf,.md,.txt,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf,text/markdown,text/plain" disabled={command.pending}/></label>
    <AsyncButton pending={command.pending} pendingLabel="Загружаем…">Загрузить документ</AsyncButton><CommandNoticeView notice={command.notice}/>
  </form>;}

function Messenger({projectId}:Readonly<{projectId:string}>) {const command=useAsyncCommand();const submit=(event:FormEvent<HTMLFormElement>)=>{
  event.preventDefault();const form=new FormData(event.currentTarget);void command.run(()=>json(`/api/projects/${projectId}/runtime`,{
    action:'connect_messenger',botToken:form.get('botToken'),chatId:form.get('chatId'),allowedUserIds:form.get('allowedUserIds'),
    idempotencyKey:`project-messenger:${id()}`}),{success:'Telegram подтвердил отдельного бота и чат проекта.',error:errorText});};
  return <form className="fcp-wizard-form" onSubmit={submit} aria-busy={command.pending}>
    <p className="fcp-wizard-intro">Для этого проекта нужен отдельный Telegram-бот и отдельный рабочий чат.</p>
    <label className="wide">Токен бота<input name="botToken" type="password" required autoComplete="off" disabled={command.pending}/></label>
    <label>ID чата<input name="chatId" inputMode="numeric" required placeholder="-100…" disabled={command.pending}/></label>
    <label>Telegram ID участников<input name="allowedUserIds" inputMode="numeric" required placeholder="12345, 67890" disabled={command.pending}/></label>
    <p className="fcp-wizard-note"><MessageCircle aria-hidden="true" size={16}/> Бот отправит одно подтверждение в выбранный чат.</p>
    <AsyncButton pending={command.pending} pendingLabel="Проверяем Telegram…">Подключить Telegram</AsyncButton><CommandNoticeView notice={command.notice}/>
  </form>;}

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

function FirstTask({item}:Readonly<{item:PhaseBProject}>) {const command=useAsyncCommand();const router=useRouter();const [mode,setMode]=useState<'existing'|'create'>('existing');const [selected,setSelected]=useState('');
  const capabilities=item.trackerCapabilities;const tasks=useMemo(()=>capabilities===null?[]:item.project.tasks.filter((task)=>
    !done(task,capabilities.doneStatusOptionId)&&task.blocked!==true&&task.ownerOptionId===capabilities.agentOwnerOptionId&&
    typeof task.statement==='string'&&task.statement.trim().length>0),[capabilities,item.project.tasks]);
  const task=tasks.find((candidate)=>candidate.itemId===selected)??tasks[0]??null;
  const activeMode=tasks.length===0?'create':mode;
  const submit=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const form=new FormData(event.currentTarget);
    const key=`project-first-task:${id()}`;const body=activeMode==='existing'?{action:'confirm_and_start',projectId:item.project.id,
      projectItemId:task?.itemId,version:task?.version,exactStatement:task?.statement,confirmed:form.get('confirmed')==='on',
      idempotencyKey:key}:{action:'create_and_start',projectId:item.project.id,title:form.get('title'),
      scope:form.get('scope'),acceptance:form.get('acceptance'),confirmed:form.get('confirmed')==='on',idempotencyKey:key};
    void command.run(()=>json('/api/tasks/executor',body),{refresh:false,success:(result)=>{const itemId=result.itemId??task?.itemId;
      if(itemId!==undefined)router.push(`/?view=tasks&project=${encodeURIComponent(item.project.slug)}&task=${encodeURIComponent(itemId)}`);
      return 'ИИ-агент назначен и старт задачи подтверждён.';},error:errorText});};
  return <div><div className="fcp-wizard-tabs" role="tablist"><button type="button" className={activeMode==='existing'?'active':''} onClick={()=>setMode('existing')} disabled={tasks.length===0}>Выбрать в GitHub</button><button type="button" className={activeMode==='create'?'active':''} onClick={()=>setMode('create')}>Создать в GitHub</button></div>
    <form className="fcp-wizard-form" onSubmit={submit} aria-busy={command.pending}>{activeMode==='existing'?<>
      <label className="wide">Задача<select value={task?.itemId??''} onChange={(event)=>setSelected(event.target.value)} disabled={command.pending}>{tasks.map((candidate)=><option key={candidate.itemId} value={candidate.itemId}>{candidate.title}</option>)}</select></label>
      {task===null?<p className="fcp-wizard-intro">Нет готовой задачи с назначенным в GitHub владельцем Hermes и заполненным описанием.</p>:<><a className="fcp-wizard-source" href={task.url} target="_blank" rel="noreferrer">Открыть задачу в GitHub <ExternalLink aria-hidden="true" size={14}/></a><div className="fcp-task-statement"><span>Точный scope и acceptance из GitHub</span><pre>{task.statement}</pre></div><label className="fcp-confirm wide"><input name="confirmed" type="checkbox" required disabled={command.pending}/> Подтверждаю этот scope и критерии приёмки и явно запускаю ИИ-агента.</label></>}
    </>:<><label className="wide">Название задачи<input name="title" required maxLength={160} disabled={command.pending}/></label><label className="wide">Scope<textarea name="scope" required maxLength={1500} rows={4} disabled={command.pending}/></label><label className="wide">Acceptance criteria<textarea name="acceptance" required maxLength={1500} rows={4} disabled={command.pending}/></label><label className="fcp-confirm wide"><input name="confirmed" type="checkbox" required disabled={command.pending}/> Подтверждаю этот scope и критерии приёмки и явно запускаю ИИ-агента.</label></>}
      <AsyncButton pending={command.pending} pendingLabel="Запускаем…" disabled={activeMode==='existing'&&task===null}><Play aria-hidden="true" size={15}/> Назначить и запустить</AsyncButton><CommandNoticeView notice={command.notice}/>
    </form></div>;
}

export function ProjectSetupWizard({item,contextCurrent}:Readonly<{item:PhaseBProject|null;contextCurrent:boolean}>) {const documents=documentFacts(item);
  const projectReady=item!==null;const docsReady=documents.ready;const messengerReady=item?.runtimeSetup?.telegramConfigured===true;
  const runtimeReady=item?.runtimeSetup?.status==='ready';const contextReady=contextCurrent;
  const states=[projectReady,docsReady,messengerReady,runtimeReady,contextReady];const pending=states.findIndex((value)=>!value);const active=pending===-1?5:pending;
  return <section className="fcp-project-wizard" aria-label="Добавить проект"><header><span><Sparkles aria-hidden="true" size={15}/> Настройка проекта</span><h2>{item===null?'Добавить проект':item.project.name}</h2><p>Один путь от GitHub до первой явно запущенной задачи.</p></header><div className="fcp-wizard-steps">
    <Step number={1} title="Репозиторий и задачи" complete={projectReady} active={active===0}>{item===null?<Registration/>:<p className="fcp-wizard-summary">GitHub подтвердил репозиторий и Project.</p>}</Step>
    {item!==null?<><Step number={2} title="Документы проекта" complete={docsReady} active={active===1}><Documents projectId={item.project.id} count={documents.documents.length}/></Step>
      <Step number={3} title="Telegram проекта" complete={messengerReady} active={active===2}><Messenger projectId={item.project.id}/></Step>
      <Step number={4} title="Отдельный ИИ-агент" complete={runtimeReady} active={active===3}><Install item={item}/></Step>
      <Step number={5} title="Контекст работы" complete={contextReady} active={active===4}><Context item={item}/></Step>
      <Step number={6} title="Готовность и первая задача" complete={false} active={active===5}><div className="fcp-readiness"><div><Check aria-hidden="true" size={15}/> GitHub и документы подтверждены</div><div><Check aria-hidden="true" size={15}/> Telegram и отдельный ИИ-агент готовы</div><div><Check aria-hidden="true" size={15}/> Контекст проекта актуален</div></div><FirstTask item={item}/></Step></>:null}
  </div></section>;
}

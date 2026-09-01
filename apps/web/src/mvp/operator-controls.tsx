'use client';

import {useEffect, useRef, useState, type DragEvent, type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {FileUp, Pencil, Plus, Trash2, UsersRound} from 'lucide-react';
import type {ProjectContextStatusView, ProjectExecutionModeView} from '@fai-control-plane/db';
import type {AgentExecutorCatalog, AgentRoutingPolicy} from '@fai-control-plane/domain';
import {AsyncButton, CommandNoticeView, useAsyncCommand} from './async-command.tsx';
import {Dialog,DividerList,ReadOnlyNotice,StatusIndicator} from '../ui/foundation.tsx';

type Result = {error?: string; status?: string; version?: string; projectId?:string; slug?:string; profile?:string|null};
const post = async (path: string, body: Record<string, unknown>): Promise<Result> => {
  const response = await fetch(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const value = await response.json().catch(() => ({})) as Result;
  if (!response.ok) throw new Error(value.error ?? 'request_failed');
  return value;
};
const remove = async (path:string,body:Record<string,unknown>):Promise<Result>=>{
  const response=await fetch(path,{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const value=await response.json().catch(()=>({})) as Result;if(!response.ok)throw new Error(value.error??'request_failed');return value;
};
const taskExecutorErrorNotice = (code: string): string => ({
  task_conflict: 'Команда не выполнена: задача уже изменилась в GitHub. Обновите страницу и проверьте исполнителя.',
  candidate_unavailable: 'Команда не выполнена: пользователь больше не доступен. Выберите другого.',
  operation_unavailable: 'Назначение недоступно для текущей стадии или конфигурации.',
  retry_unavailable: 'Повтор отклонён: предыдущая попытка не подтверждена как завершившаяся.',
  assignment_partial: 'GitHub применил операцию частично. Не повторяйте команду до проверки исполнителя и статуса.',
  delivery_failed: 'GitHub назначил Hermes, но запуск не подтверждён. Обновите задачу перед повтором.',
  context_unavailable: 'Запуск Hermes недоступен: сначала актуализируйте контекст проекта в разделе «Процесс».',
  execution_unavailable: 'Запуск Hermes недоступен: настройки исполнения проекта не готовы.',
  profile_unavailable: 'Профиль ИИ агента недоступен после восстановления. Задача не запущена.',
  provider_error: 'GitHub или Hermes не подтвердил операцию. Обновите задачу перед повтором.'
}[code] ?? 'Команда не подтверждена. Обновите задачу и проверьте её состояние перед повтором.');
const id = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

export function LogoutControl() {
  const command = useAsyncCommand();
  return <div className="fcp-logout"><AsyncButton type="button" pending={command.pending} pendingLabel="Выходим…" onClick={() => void command.run(async () => {
    const result = await post('/api/auth/logout', {}); window.location.assign('/'); return result;
  }, {success: 'Сеанс завершён.', refresh: false})}>Выйти</AsyncButton><CommandNoticeView notice={command.notice}/></div>;
}

export function ProjectDeleteControl({projectId,projectName}:Readonly<{projectId:string;projectName:string}>){
  const router=useRouter();const [confirming,setConfirming]=useState(false);const [confirmation,setConfirmation]=useState('');const command=useAsyncCommand();
  const execute=()=>void command.run(()=>remove('/api/projects',{projectId,confirmed:true}),{refresh:false,
    success:()=>{router.replace('/projects');return 'Проект удалён из f(AI) Control.';},
    error:(error)=>error instanceof Error&&error.message==='project_delete_denied'?'Удалить проект может только его владелец.':
      'Проект не удалён. Проверьте состояние ИИ-агента и повторите.'});
  const close=()=>{if(command.pending)return;setConfirming(false);setConfirmation('');};
  return <div className="fcp-project-delete"><AsyncButton type="button" className="fcp-danger-button" pending={false} pendingLabel="" onClick={()=>setConfirming(true)}><Trash2 aria-hidden="true" size={14}/> Удалить проект</AsyncButton><Dialog open={confirming} title={`Удалить «${projectName}»?`} description="Данные проекта и ресурсы ИИ-агента будут удалены. Репозиторий, GitHub Project и задачи останутся без изменений." onClose={close}><form method="post" className="fcp-delete-dialog" onSubmit={(event)=>{event.preventDefault();execute();}} aria-busy={command.pending}><label>Введите точное название проекта <strong>{projectName}</strong><input value={confirmation} onChange={(event)=>setConfirmation(event.target.value)} autoComplete="off" disabled={command.pending}/></label><div><AsyncButton className="fcp-danger-button" pending={command.pending} pendingLabel="Удаляем…" disabled={confirmation!==projectName}><Trash2 aria-hidden="true" size={15}/> Удалить проект</AsyncButton><AsyncButton type="button" className="fcp-secondary" pending={command.pending} pendingLabel="" onClick={close}>Отмена</AsyncButton></div><CommandNoticeView notice={command.notice}/></form></Dialog></div>;
}

type DocumentDraft=Readonly<{id:string;category:'passport'|'requirements'|'architecture'|'supplemental';file:File|null}>;
const documentCategories=Object.freeze([
  ['passport','Паспорт проекта'],['requirements','Техническое задание'],['architecture','Архитектура'],['supplemental','Прочее']
] as const);
const uploadAccept='.docx,.pdf,.md,.txt,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf,text/markdown,text/plain';
const newDocument=(category:DocumentDraft['category']='passport'):DocumentDraft=>({id:id(),category,file:null});
const nextDocumentCategory=(rows:readonly DocumentDraft[]):DocumentDraft['category']=>
  (['passport','requirements','architecture'] as const).find((category)=>!rows.some((row)=>row.category===category))??'supplemental';
function DocumentCategoryChoice({label,value,pending,onChange}:Readonly<{label:string;value:DocumentDraft['category'];pending:boolean;onChange:(category:DocumentDraft['category'])=>void}>){return <div className="fcp-document-category"><span>{label}</span><div className="fcp-document-category-options" role="group" aria-label={label}>{documentCategories.map(([category,option])=><button type="button" aria-pressed={value===category} disabled={pending} onClick={()=>onChange(category)} key={category}>{option}</button>)}</div></div>;}

export function ProjectDocumentsEditor({projectId,compact=false}:Readonly<{projectId:string;compact?:boolean}>) {
  const command=useAsyncCommand();const [rows,setRows]=useState<readonly DocumentDraft[]>([newDocument()]);const [batchKey,setBatchKey]=useState(()=>`project-documents:${id()}`);const inputs=useRef<Record<string,HTMLInputElement|null>>({});
  const [localError,setLocalError]=useState<string|null>(null);
  const error=(value:unknown):string=>({
    project_document_pdf_text_layer_required:'В PDF нет текстового слоя. Загрузите текстовый PDF или DOCX.',
    project_document_set_too_large:'Лимит активного набора: до 10 файлов и 100 МиБ.',
    project_document_batch_invalid:'В одной отправке можно передать по одному документу каждой основной категории и не более 100 МиБ.',
    project_document_invalid:'Файл не распознан. Поддерживаются DOCX, PDF с текстовым слоем, MD и TXT до 50 МиБ.',
    project_document_denied:'Загружать документы может владелец проекта.'
  }[value instanceof Error?value.message:'']??(value instanceof Error&&value.message==='upload_timeout'
    ?'Отправка не завершилась вовремя. Ничего не было принято; повторите ту же отправку.'
    :'Документы не загружены: весь набор оставлен без изменений. Проверьте файлы и повторите.'));
  const update=(rowId:string,change:Partial<DocumentDraft>)=>setRows((current)=>current.map((row)=>row.id===rowId?{...row,...change}:row));
  const choose=(rowId:string,files:FileList|null)=>{const file=files?.[0]??null;setLocalError(null);update(rowId,{file});};
  const drop=(event:DragEvent<HTMLButtonElement>,rowId:string)=>{event.preventDefault();choose(rowId,event.dataTransfer.files);};
  const submit=()=>{const ready=rows.filter((row)=>row.file!==null);if(ready.length===0||ready.length!==rows.length){setLocalError('Выберите файл в каждой строке или удалите пустую строку.');return;}
    const fixed=ready.filter(({category})=>category!=='supplemental');if(new Set(fixed.map(({category})=>category)).size!==fixed.length){setLocalError('Основную категорию можно добавить только один раз за отправку.');return;}
    if(ready.some(({file})=>file!.size>50*1024*1024)||ready.reduce((total,{file})=>total+file!.size,0)>100*1024*1024){setLocalError('Ограничение: до 50 МиБ на файл и до 100 МиБ за одну отправку.');return;}
    setLocalError(null);void command.run(async()=>{const form=new FormData();for(const row of ready){const source=row.file!;
      form.append('category',row.category);form.append('file',source);}form.append('idempotencyKey',batchKey);
      const response=await fetch(`/api/projects/${projectId}/documents`,{method:'POST',body:form});
      const value=await response.json().catch(()=>({}));if(response.status===408)throw new Error('upload_timeout');if(!response.ok)throw new Error((value as Result).error??'request_failed');return value as Result;
    },
    {success:(value)=>{const uploaded=Array.isArray((value as {documents?:unknown}).documents)?(value as {documents:unknown[]}).documents.length:ready.length;setRows([newDocument()]);setBatchKey(`project-documents:${id()}`);return `Загружено документов: ${uploaded}. Весь набор подтверждён.`;},error});};
  return <section className={`fcp-documents-editor ${compact?'compact':''}`} aria-busy={command.pending}><p className="fcp-documents-help">DOCX, PDF с текстовым слоем, MD или TXT. До 50 МиБ на файл; до 100 МиБ за одну отправку.</p>
    <div className="fcp-document-rows">{rows.map((row,index)=><article key={row.id}><DocumentCategoryChoice label={`Тип документа ${index+1}`} value={row.category} pending={command.pending} onChange={(category)=>update(row.id,{category})}/>
      <input className="fcp-visually-hidden" ref={(node)=>{inputs.current[row.id]=node;}} type="file" accept={uploadAccept} disabled={command.pending} onChange={(event)=>choose(row.id,event.currentTarget.files)}/>
      <AsyncButton type="button" pending={false} pendingLabel="" className="fcp-document-drop" disabled={command.pending} onClick={()=>inputs.current[row.id]?.click()} onDragOver={(event)=>event.preventDefault()} onDrop={(event)=>drop(event,row.id)}><FileUp aria-hidden="true" size={16}/><span>{row.file===null?'Выбрать файл или перетащить сюда':row.file.name}</span>{row.file===null?null:<small>{Math.ceil(row.file.size/1024)} КБ</small>}</AsyncButton>
      <AsyncButton type="button" pending={false} pendingLabel="" className="fcp-icon-button" aria-label="Удалить документ" disabled={command.pending||rows.length===1} onClick={()=>setRows((current)=>current.filter((candidate)=>candidate.id!==row.id))}><Trash2 aria-hidden="true" size={15}/></AsyncButton></article>)}</div>
    <div className="fcp-document-actions"><AsyncButton type="button" className="fcp-secondary" pending={false} pendingLabel="" disabled={command.pending||rows.length===10} onClick={()=>setRows((current)=>[...current,newDocument(nextDocumentCategory(current))])}><Plus aria-hidden="true" size={15}/> Добавить ещё файл</AsyncButton><AsyncButton type="button" pending={command.pending} pendingLabel="Загружаем документы…" disabled={command.pending} onClick={submit}>Загрузить документы</AsyncButton></div>
    {localError===null?null:<p className="fcp-wizard-error">{localError}</p>}<CommandNoticeView notice={command.notice}/>
  </section>;
}

export function ProjectDocumentDeleteControl({projectId,documentId,documentName}:Readonly<{projectId:string;documentId:string;documentName:string}>){
  const router=useRouter();const command=useAsyncCommand();const [open,setOpen]=useState(false);const [confirmation,setConfirmation]=useState('');
  const close=()=>{if(!command.pending){setOpen(false);setConfirmation('');}};
  const execute=()=>void command.run(()=>remove(`/api/projects/${projectId}/documents/${documentId}`,{idempotencyKey:`project-document-delete:${id()}`}),{refresh:false,
    success:()=>{close();router.refresh();return 'Документ удалён.';},error:(value)=>value instanceof Error&&value.message==='project_document_denied'?'Удалять документы может только владелец проекта.':'Документ не удалён. Проверьте состояние и повторите.'});
  return <><AsyncButton type="button" className="fcp-danger-button fcp-document-delete-trigger" pending={false} pendingLabel="" aria-label={`Удалить документ: ${documentName}`} onClick={()=>setOpen(true)}>Удалить</AsyncButton><Dialog open={open} title={`Удалить «${documentName}»?`} description="Документ будет удалён из контекста проекта. Это действие нельзя отменить." onClose={close}><form method="post" className="fcp-delete-dialog" onSubmit={(event)=>{event.preventDefault();execute();}} aria-busy={command.pending}><label>Введите точное имя документа <strong>{documentName}</strong><input value={confirmation} onChange={(event)=>setConfirmation(event.target.value)} autoComplete="off" disabled={command.pending}/></label><div><AsyncButton className="fcp-danger-button" pending={command.pending} pendingLabel="Удаляем…" disabled={confirmation!==documentName}>Удалить</AsyncButton><AsyncButton type="button" className="fcp-secondary" pending={command.pending} pendingLabel="" onClick={close}>Отмена</AsyncButton></div><CommandNoticeView notice={command.notice}/></form></Dialog></>;
}

export function ProjectAgentActivationControl({projectId,status,profile,documentsReady}:Readonly<{projectId:string;
  status:'not_configured'|'configuring'|'awaiting_architecture'|'ready'|'error';profile:string|null;
  documentsReady:boolean}>) {
  const command=useAsyncCommand(); const activate=()=>void command.run(()=>post(`/api/projects/${projectId}/agent-profile`,
    {idempotencyKey:`agent-profile:${id()}`,force:status==='ready'||status==='error'}),
    {success:(result)=>result.status==='ready'?'ИИ агент готов к работе.':'Настройка не подтверждена.',
      error:(error)=>error instanceof Error&&error.message==='project_documents_required'
        ?'Сначала загрузите техническое задание и паспорт проекта.'
        :error instanceof Error&&error.message==='agent_profile_probe_failed'
          ?'Профиль создан, но Hermes ещё не подтвердил готовность. Повторите активацию после запуска gateway.'
          :'Не удалось активировать ИИ агента. Существующая конфигурация не изменена.'});
  const title=!documentsReady?'Нужны документы':status==='not_configured'?'Готов к настройке':
    status==='configuring'?'Настраивается':status==='awaiting_architecture'?'Ожидает согласования архитектуры':
      status==='ready'?'ИИ агент готов':'Ошибка настройки';
  const detail=!documentsReady?'Загрузите техническое задание и паспорт проекта.':
    status==='configuring'?'Hermes собирает компактный контекст в фоне.':
      status==='awaiting_architecture'?'Согласуйте точную версию архитектурного предложения; повторный анализ не требуется.':
        status==='ready'?`Постоянный профиль ${profile??''} активен для этого проекта.`:profile===null
          ?'Будет создан отдельный постоянный Hermes-профиль из общего шаблона.':
          `Профиль ${profile} сохранён и может быть настроен повторно.`;
  return <div className="fcp-agent-activation"><div><strong>{title}</strong><small>{detail}</small></div>
    <AsyncButton type="button" disabled={!documentsReady||status==='configuring'||status==='awaiting_architecture'}
      pending={command.pending} pendingLabel="Настраиваем…" onClick={activate}>
      {status==='ready'||status==='error'?'Обновить настройку':'Настроить ИИ агента'}
    </AsyncButton>
    <CommandNoticeView notice={command.notice}/></div>;
}

export function ArchitectureProposalDecision({projectId,proposalSha}:Readonly<{projectId:string;
  proposalSha:string}>) {
  const command=useAsyncCommand();
  const approve=()=>void command.run(()=>post(`/api/approvals/${id()}`,{projectId,targetReference:proposalSha,
    kind:'plan',decision:'approved',idempotencyKey:`architecture-approval:${id()}`}),
  {success:'Архитектурное предложение согласовано. ИИ агент станет готов после обработки worker.'});
  return <div className="fcp-agent-activation"><div><strong>Архитектурное предложение готово</strong>
    <small><a href={`/api/projects/${projectId}/sources?architectureProposal=${proposalSha}`}>Скачать точную версию</a> и согласуйте её без повторного анализа документов.</small></div>
    <AsyncButton type="button" pending={command.pending} pendingLabel="Согласуем…" onClick={approve}>
      Согласовать архитектуру</AsyncButton><CommandNoticeView notice={command.notice}/></div>;
}

export function ProjectExecutionModeControl({projectId, mode, canManage}: Readonly<{
  projectId: string; mode: ProjectExecutionModeView; canManage: boolean;
}>) {
  const command = useAsyncCommand(); const autonomous = mode.mode === 'autonomous';
  const change = () => void command.run(() => post(`/api/projects/${projectId}/execution-mode`, {
    mode: autonomous ? 'manual' : 'autonomous', idempotencyKey: `project-execution-mode:${id()}`
  }), {success: autonomous ? 'Автономный режим остановлен.' : 'Автономный режим включён.'});
  return <div className="fcp-agent-activation fcp-project-execution-mode"><div>
    <strong>{autonomous ? 'Автономное выполнение включено' : 'Ручной запуск задач'}</strong>
    <small>{autonomous ? 'Система запускает по одной готовой задаче и останавливается на согласовании или блокере.'
      : 'Новые задачи запускаются только человеком в разделе «Задачи».'}</small></div>
    {canManage ? <AsyncButton type="button" className="fcp-secondary"
      pending={command.pending} pendingLabel={autonomous ? 'Останавливаем…' : 'Включаем…'} onClick={change}>
      {autonomous ? 'Остановить' : 'Включить автономно'}</AsyncButton> : null}
    <CommandNoticeView notice={command.notice}/></div>;
}

const editableExecutors = new Set(['manager_project_ops', 'architecture_design', 'critical_decision', 'release_preflight']);
const routingClassLabel: Record<AgentRoutingPolicy['routes'][number]['taskClass'], string> = {manager_project_ops:'Управление проектом',ordinary_implementation:'Обычная реализация',ui_responsive:'Интерфейс и адаптивность',complex_implementation:'Сложная реализация',qa_audit:'Проверка и аудит',architecture_design:'Архитектура и дизайн',critical_decision:'Критическое решение',release_preflight:'Предрелизная проверка',protected_operation:'Защищённая операция'};
const routingGateLabel: Record<AgentRoutingPolicy['routes'][number]['humanGate'], string> = {none:'контроль человека не требуется',product_visual:'нужно согласование UI/UX',architecture_decision:'нужно архитектурное решение',production_exact:'нужно точное production-подтверждение'};

/** One project-qualified action opens the complete routing policy without expanding the Process scan path. */
export function AgentRoutingControl({projectId,projectName,canManage,policy,executorCatalog}:Readonly<{projectId:string;projectName:string;canManage:boolean;policy:AgentRoutingPolicy;executorCatalog:AgentExecutorCatalog}>) {
  const command=useAsyncCommand();const [open,setOpen]=useState(false);const [draft,setDraft]=useState(policy);const [saved,setSaved]=useState(policy);const [taskClass,setTaskClass]=useState(policy.routes[0]!.taskClass);const codexReady=executorCatalog['codex-cli']?.available??false;const route=draft.routes.find((item)=>item.taskClass===taskClass)!;const editable=canManage&&codexReady;
  const update=(change:(current:AgentRoutingPolicy['routes'][number])=>AgentRoutingPolicy['routes'][number])=>setDraft((current)=>({...current,routes:current.routes.map((item)=>item.taskClass===taskClass?change(item):item)}));
  const close=()=>{if(command.pending)return;setOpen(false);setDraft(saved);};
  const save=()=>void command.run(()=>post(`/api/projects/${projectId}/agent-routing`,{policy:draft,idempotencyKey:`agent-routing:${id()}`}),{success:()=>{setSaved(draft);return 'Настройка сохранена.';}});
  const actionLabel=`${canManage?'Настроить':'Просмотреть'} ИИ-агента: ${projectName}`;
  return <section className="fcp-c-process-action"><div><strong>Политика ИИ-агента</strong><span>{policy.routes.length} классов задач · {codexReady?'Codex CLI готов':'Codex CLI не подключён'}</span></div><AsyncButton type="button" className="fcp-secondary" pending={false} pendingLabel="" disabled={command.pending} aria-label={actionLabel} onClick={()=>setOpen(true)}>{canManage?'Настроить ИИ-агента':'Просмотреть настройки'}</AsyncButton><Dialog open={open} title={`Настройка ИИ-агента: ${projectName}`} description="Выберите класс задач и проверьте разрешённые параметры. Приёмка и контроль человека заданы процессом." onClose={close}><form method="post" className="fcp-c-routing-dialog" onSubmit={(event)=>{event.preventDefault();save();}} aria-busy={command.pending}><label className="fcp-c-routing-field">Класс задач<select value={taskClass} disabled={command.pending} onChange={(event)=>setTaskClass(event.target.value as typeof taskClass)}>{draft.routes.map((item)=><option value={item.taskClass} key={item.taskClass}>{routingClassLabel[item.taskClass]}</option>)}</select></label><div className="fcp-c-routing-summary" aria-label={`Политика: ${routingClassLabel[route.taskClass]}`}><label className="fcp-c-routing-field">Исполнитель<select value={route.executor.kind==='direct-agent'?'direct-agent':route.executor.id} disabled={!editable||!editableExecutors.has(route.taskClass)||command.pending} onChange={(event)=>update((current)=>({...current,executor:event.target.value==='direct-agent'?{kind:'direct-agent'}:{kind:'cli',id:event.target.value}}))}><option value="direct-agent">Hermes</option><option value="codex-cli">Codex CLI</option><option value="claude-code-cli" disabled>Claude Code CLI</option></select></label><label className="fcp-c-routing-field">Модель<select value={route.model} disabled={!editable||command.pending} onChange={(event)=>update((current)=>({...current,model:event.target.value}))}><option value="gpt-5.6-terra">GPT-5.6 Terra</option><option value="gpt-5.6-sol">GPT-5.6 Sol</option></select></label><label className="fcp-c-routing-field">Рассуждение<select value={route.effort} disabled={!editable||command.pending} onChange={(event)=>update((current)=>({...current,effort:event.target.value as AgentRoutingPolicy['routes'][number]['effort']}))}><option value="medium">Среднее</option><option value="high">Высокое</option></select></label><div className="fcp-c-routing-fact"><span>Приёмка агентом</span><strong>Обязательна</strong></div><div className="fcp-c-routing-fact"><span>Контроль человека</span><strong>{routingGateLabel[route.humanGate]}</strong></div></div>{!canManage?<p className="fcp-control-note">Доступ только для просмотра. Изменения доступны владельцу проекта.</p>:codexReady?null:<p className="fcp-control-note">Редактирование станет доступно после подключения Codex CLI.</p>}<div className="fcp-c-routing-actions">{canManage?<AsyncButton pending={command.pending} pendingLabel="Сохраняем…">Сохранить</AsyncButton>:null}<AsyncButton type="button" className="fcp-secondary" pending={false} pendingLabel="" disabled={command.pending} onClick={close}>Закрыть</AsyncButton></div><CommandNoticeView notice={command.notice}/></form></Dialog></section>;
}

export function HermesContextControl({projectId,canManage,context}:Readonly<{projectId:string;canManage:boolean;context:ProjectContextStatusView|null}>) { const command=useAsyncCommand();const status=context===null?'Не настроен':context.status==='stale'?'Требует обновления':'Готов к работе';const refresh=()=>void command.run(()=>post(`/api/projects/${projectId}/context/refresh`,{idempotencyKey:`project-context:${id()}`}),{success:'Контекст актуализирован и будет применён к новым задачам.',error:'Не удалось актуализировать контекст. Текущая версия сохранена.'});return <div className="fcp-context-action"><div><strong>{status}</strong><p>Контекст применяется к новым задачам проекта.</p></div>{canManage?<AsyncButton type="button" className="fcp-secondary" pending={command.pending} pendingLabel="Актуализируем…" onClick={refresh}>Актуализировать контекст</AsyncButton>:null}<CommandNoticeView notice={command.notice}/></div>; }

export const projectRoleLabel: Record<string,string> = {project_owner:'Владелец проекта',operator:'Руководитель проекта',contributor:'Исполнитель',client:'Представитель клиента'};

const membershipRoles:readonly (readonly [string,string])[]=[['project_owner','Владелец проекта'],['operator','Руководитель проекта'],['contributor','Исполнитель'],['client','Представитель клиента']];

type MembershipEditorMember=Readonly<{membershipId:string;actorId:string;displayName:string;role:string}>;

function MembershipRoleField({value,onChange,disabled,includeOwner=true}:Readonly<{value:string;onChange:(value:string)=>void;disabled:boolean;includeOwner?:boolean}>){return <label className="fcp-c-membership-field">Роль<select value={value} disabled={disabled} onChange={(event)=>onChange(event.target.value)} required><option value="" disabled>Выберите роль</option>{membershipRoles.filter(([role])=>includeOwner||role!=='project_owner').map(([role,label])=><option value={role} key={role}>{label}</option>)}</select></label>;}

/** The Roles portfolio keeps mutations deliberately out of the scan path. */
export function MembershipEditor({projectName,member}:Readonly<{projectName:string;member:MembershipEditorMember}>){
  const [open,setOpen]=useState(false);const [role,setRole]=useState(member.role);const command=useAsyncCommand();
  const close=()=>{if(!command.pending)setOpen(false);};
  const submit=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();void command.run(()=>post(`/api/access/memberships/${member.membershipId}`,{role,active:true}),{success:'Членство обновлено.'});};
  return <><AsyncButton type="button" className="fcp-secondary fcp-c-membership-edit" pending={false} pendingLabel="" aria-label={`Изменить членство: ${member.displayName} · ${projectName}`} disabled={command.pending} onClick={()=>setOpen(true)}><Pencil aria-hidden="true" size={14}/>Изменить</AsyncButton><Dialog open={open} title={`Изменить: ${member.displayName}`} description="Изменения применяются только к этому проекту." onClose={close}><form method="post" className="fcp-c-membership-form" onSubmit={submit} aria-busy={command.pending}><div className="fcp-c-membership-fact"><strong>Участник</strong><span>{member.displayName}</span></div><MembershipRoleField value={role} onChange={setRole} disabled={command.pending}/><div className="fcp-c-membership-actions"><AsyncButton pending={command.pending} pendingLabel="Сохраняем…">Сохранить</AsyncButton><AsyncButton type="button" className="fcp-secondary" pending={false} pendingLabel="" disabled={command.pending} onClick={close}>Отмена</AsyncButton></div><CommandNoticeView notice={command.notice}/></form></Dialog></>;
}

type MembershipAddProps=Readonly<{
  projectId:string;
  projectName:string;
  members:readonly MembershipEditorMember[];
  workspacePeople:readonly {actorId:string;displayName:string}[];
}>;

export function MembershipAddControl({projectId,projectName,members,workspacePeople}:MembershipAddProps){
  const [open,setOpen]=useState(false);const [mode,setMode]=useState<'directory'|'new'|null>(null);const [candidateId,setCandidateId]=useState('');const [role,setRole]=useState('');const command=useAsyncCommand();
  const directorySelectRef=useRef<HTMLSelectElement>(null);const newMemberNameRef=useRef<HTMLInputElement>(null);
  const candidates=workspacePeople.filter((person)=>!members.some((member)=>member.actorId===person.actorId));
  useEffect(()=>{if(!open)return;if(mode==='directory')directorySelectRef.current?.focus();if(mode==='new')newMemberNameRef.current?.focus();},[open,mode]);
  const close=()=>{if(!command.pending){setOpen(false);setMode(null);setCandidateId('');setRole('');}};
  const addExisting=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();if(candidateId==='')return;void command.run(()=>post('/api/access/onboarding',{projectId,existingActorId:candidateId,role}),{success:'Сотрудник добавлен в проект.'});};
  const onboard=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const form=new FormData(event.currentTarget);const telegramUserId=empty(form.get('telegramUserId'));const bitrix24UserId=empty(form.get('bitrix24UserId'));void command.run(()=>post('/api/access/onboarding',{projectId,displayName:form.get('displayName'),githubUserId:form.get('githubUserId'),role,...(telegramUserId===null?{}:{telegramUserId}),...(bitrix24UserId===null?{}:{bitrix24UserId})}),{success:'Участник добавлен.'});};
  return <><AsyncButton type="button" className="fcp-secondary fcp-c-membership-add" pending={false} pendingLabel="" aria-label={`Добавить участника: ${projectName}`} disabled={command.pending} onClick={()=>setOpen(true)}><Plus aria-hidden="true" size={15}/>Добавить участника</AsyncButton><Dialog open={open} title="Добавить участника" description="Выберите существующего сотрудника или создайте нового для этого проекта." onClose={close}>{mode===null?<div className="fcp-c-membership-start"><AsyncButton type="button" className="fcp-secondary" pending={false} pendingLabel="" disabled={command.pending||candidates.length===0} onClick={()=>setMode('directory')}>Выбрать сотрудника</AsyncButton><AsyncButton type="button" className="fcp-secondary" pending={false} pendingLabel="" disabled={command.pending} onClick={()=>setMode('new')}>Добавить нового</AsyncButton>{candidates.length===0?<p>Все сотрудники из справочника уже добавлены в проект.</p>:null}</div>:mode==='directory'?<form method="post" className="fcp-c-membership-form" onSubmit={addExisting} aria-busy={command.pending}><label className="fcp-c-membership-field">Сотрудник<select ref={directorySelectRef} value={candidateId} disabled={command.pending} onChange={(event)=>setCandidateId(event.target.value)} required><option value="" disabled>Выберите сотрудника</option>{candidates.map((person)=><option value={person.actorId} key={person.actorId}>{person.displayName}</option>)}</select></label><MembershipRoleField value={role} onChange={setRole} disabled={command.pending} includeOwner={false}/><div className="fcp-c-membership-actions"><AsyncButton pending={command.pending} pendingLabel="Добавляем…" disabled={candidateId===''||role===''}>Добавить в проект</AsyncButton><AsyncButton type="button" className="fcp-secondary" pending={false} pendingLabel="" disabled={command.pending} onClick={()=>setMode(null)}>Назад</AsyncButton></div><CommandNoticeView notice={command.notice}/></form>:<form method="post" className="fcp-c-membership-form" onSubmit={onboard} aria-busy={command.pending}><label className="fcp-c-membership-field">Имя<input ref={newMemberNameRef} name="displayName" required maxLength={200} disabled={command.pending}/></label><MembershipRoleField value={role} onChange={setRole} disabled={command.pending} includeOwner={false}/><label className="fcp-c-membership-field">GitHub ID<input name="githubUserId" inputMode="numeric" pattern="[1-9][0-9]*" disabled={command.pending}/></label><label className="fcp-c-membership-field">Telegram ID<input name="telegramUserId" inputMode="numeric" disabled={command.pending}/></label><label className="fcp-c-membership-field">Bitrix24 ID<input name="bitrix24UserId" disabled={command.pending}/></label><p className="fcp-c-membership-help">Для руководителя или исполнителя нужен GitHub ID. Для представителя клиента достаточно GitHub или Bitrix24 ID.</p><div className="fcp-c-membership-actions"><AsyncButton pending={command.pending} pendingLabel="Добавляем…" disabled={role===''}>Добавить участника</AsyncButton><AsyncButton type="button" className="fcp-secondary" pending={false} pendingLabel="" disabled={command.pending} onClick={()=>setMode(null)}>Назад</AsyncButton></div><CommandNoticeView notice={command.notice}/></form>}</Dialog></>;
}

type ProjectMembershipMember=MembershipEditorMember&Readonly<{active:boolean;kind:'human'|'agent'|'system'}>;

/** Shared membership surface for the Roles portfolio and project setup. */
export function ProjectMembershipManager({projectId,projectName,canManage,members,workspacePeople}:Readonly<{projectId:string;projectName:string;canManage:boolean;members:readonly ProjectMembershipMember[];workspacePeople:readonly {actorId:string;displayName:string}[]}>){return <><DividerList label={`Участники проекта ${projectName}`}>{members.length===0?<p className="fcp-c-empty-line">Участники ещё не добавлены.</p>:members.map((person)=><div className="fcp-c-person-row" key={person.membershipId}><UsersRound aria-hidden="true" size={18}/><div><strong>{person.displayName}</strong><span>{person.kind==='human'?'Человек':'Система'} · {projectRoleLabel[person.role]??'Участник'}</span></div><StatusIndicator tone={person.active?'success':'neutral'}>{person.active?'Активен':'Неактивен'}</StatusIndicator>{canManage?<MembershipEditor projectName={projectName} member={person}/>:null}</div>)}</DividerList>{canManage?<div className="fcp-c-project-section-action"><MembershipAddControl projectId={projectId} projectName={projectName} members={members} workspacePeople={workspacePeople}/></div>:<ReadOnlyNotice/>}</>;}

type TelegramSettingsFormProps=Readonly<{projectId:string;composition:'inline'|'dialog';command:ReturnType<typeof useAsyncCommand>;onClose?:()=>void}>;

/** One runtime command and field set, composed inline by the setup wizard or in Chats dialog. */
function TelegramSettingsForm({projectId,composition,command,onClose}:TelegramSettingsFormProps){const submit=(event:FormEvent<HTMLFormElement>)=>{
  event.preventDefault();const form=new FormData(event.currentTarget);void command.run(()=>post(`/api/projects/${projectId}/runtime`,{
    action:'connect_messenger',botToken:form.get('botToken'),chatId:form.get('chatId'),allowedUserIds:form.get('allowedUserIds'),
    idempotencyKey:`project-messenger:${id()}`}),{success:'Telegram подтвердил отдельного бота и чат проекта.'});};
  const inline=composition==='inline';return <form method="post" className={inline?'fcp-wizard-form':'fcp-c-telegram-dialog-form'} onSubmit={submit} aria-busy={command.pending}>
    <p>Внутренний Telegram необязателен: проект полноценно работает через интерфейс.</p>
    <label className={inline?'wide':undefined}>Токен бота<input name="botToken" type="password" required autoComplete="off" disabled={command.pending}/></label>
    <label>ID чата<input name="chatId" inputMode="numeric" required placeholder="-100…" disabled={command.pending}/></label>
    <label>Telegram ID участников<input name="allowedUserIds" inputMode="numeric" required placeholder="12345, 67890" disabled={command.pending}/></label>
    {inline?<><AsyncButton pending={command.pending} pendingLabel="Проверяем Telegram…">Подключить Telegram</AsyncButton><CommandNoticeView notice={command.notice}/></>:<><div className="fcp-c-telegram-dialog-actions"><AsyncButton pending={command.pending} pendingLabel="Проверяем Telegram…">Подключить Telegram</AsyncButton>{onClose===undefined?null:<AsyncButton type="button" className="fcp-secondary" pending={false} pendingLabel="" disabled={command.pending} onClick={onClose}>Отмена</AsyncButton>}</div><CommandNoticeView notice={command.notice}/></>}</form>;}

/** The approved project wizard keeps its inline Telegram composition unchanged. */
export function TelegramSettingsControl({projectId}:Readonly<{projectId:string}>){const command=useAsyncCommand();return <TelegramSettingsForm projectId={projectId} composition="inline" command={command}/>;}

/** Chats keeps its project scan path closed until an owner explicitly opens this scoped setup dialog. */
export function TelegramSettingsDialogControl({projectId,projectName}:Readonly<{projectId:string;projectName:string}>){const [open,setOpen]=useState(false);const command=useAsyncCommand();const close=()=>{if(!command.pending)setOpen(false);};const actionLabel=`Настроить Telegram: ${projectName}`;return <><AsyncButton type="button" className="fcp-secondary fcp-c-telegram-settings" pending={false} pendingLabel="" aria-label={actionLabel} disabled={command.pending} onClick={()=>setOpen(true)}>Настроить Telegram</AsyncButton><Dialog open={open} title={actionLabel} description="Подключите отдельного бота и внутренний чат этого проекта." onClose={close}><TelegramSettingsForm projectId={projectId} composition="dialog" command={command} onClose={close}/></Dialog></>;}


type AssignableUser = Readonly<{id: string; login: string; name: string|null}>;
type ConfirmedRun = Readonly<{deliveryReference: string; occurredAt: string; status: 'started'|'completed'|'failed'}>;
export function TaskExecutorControl({projectId, task, currentExecutor, confirmedRun}: Readonly<{projectId: string; currentExecutor: string; confirmedRun: ConfirmedRun|null; task: {itemId: string; status: string|null; blocked: boolean|null}}>) {
  const [users, setUsers] = useState<readonly AssignableUser[]|null>(null); const [selected, setSelected] = useState('');
  const [confirming, setConfirming] = useState(false);
  const runStatus: 'started'|'completed'|'failed' = confirmedRun?.status ?? 'started';
  const confirmRef = useRef<HTMLDivElement>(null); const actionRef = useRef<HTMLButtonElement>(null); const command = useAsyncCommand();
  useEffect(() => { let active = true; void fetch(`/api/tasks/executor?projectId=${encodeURIComponent(projectId)}`).then(async (response) => {
    const value = await response.json().catch(() => ({})) as {users?: AssignableUser[]; error?: string}; if (!response.ok) throw new Error(value.error ?? 'provider_error');
    if (active) setUsers(value.users ?? []);
  }).catch(() => { if (active) setUsers([]); }); return () => { active = false; }; }, [projectId]);
  const choice = selected === 'hermes' ? 'hermes' : users?.find((user) => `human:${user.id}` === selected);
  const human = choice !== undefined && choice !== 'hermes' ? choice : null;
  const activeRun = confirmedRun;
  const unavailable = task.blocked === null || task.status === null || ['Blocked', 'Done'].includes(task.status);
  const startsDevelopment = task.status === 'Backlog' || task.status === 'Ready';
  const unblock = task.blocked === true ? ' Blocked станет No.' : '';
  const effects = human === null ? `GitHub: Owner станет Hermes, Assignee очистится.${unblock}${startsDevelopment ? ' Этап станет In Dev.' : ` Этап ${task.status} сохранится.`} Hermes получит явную команду.` : `GitHub: Assignee станет @${human.login}, Owner очистится.${unblock}${startsDevelopment ? ' Этап станет In Dev.' : ` Этап ${task.status} сохранится.`} Уведомление человеку не отправляется.`;
  useEffect(() => { if (confirming) requestAnimationFrame(() => confirmRef.current?.focus()); }, [confirming]);
  const retryAttempt = () => { if (activeRun === null) return; void command.run(() => post('/api/tasks/executor', {projectId, projectItemId: task.itemId, executor: {kind: 'hermes'}, retry: {deliveryReference: activeRun.deliveryReference, nonce: crypto.randomUUID()}}), {success: 'Новая попытка Hermes запущена.', error: (error) => taskExecutorErrorNotice(error instanceof Error ? error.message : 'request_failed')}); };
  const execute = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (choice === undefined) return; void command.run(() => post('/api/tasks/executor', {projectId, projectItemId: task.itemId, executor: human === null ? {kind: 'hermes'} : {kind: 'human', candidate: {id: human.id, login: human.login}}}), {success: (result) => { setConfirming(false); return result.status === 'duplicate' ? 'Команда уже была подтверждена.' : human === null ? 'Запуск Hermes подтверждён.' : 'Исполнитель назначен.'; }, error: (error) => taskExecutorErrorNotice(error instanceof Error ? error.message : 'request_failed')}); };
  if (unavailable) return <section className="fcp-task-executor"><header><div><h2>Исполнитель</h2><p>Назначение недоступно только для терминального или неизвестного этапа.</p></div></header><p className="fcp-control-note">Для текущего статуса GitHub Project назначение недоступно.</p></section>;
  const form = <form method="post" onSubmit={execute} aria-busy={command.pending}><label>Кому назначить<select value={selected} onChange={(event) => { setSelected(event.target.value); setConfirming(false); }} disabled={command.pending}><option value="">{users === null ? 'Загружаем пользователей…' : 'Выберите исполнителя'}</option><optgroup label="Люди">{users?.map((user) => <option key={user.id} value={`human:${user.id}`}>{user.name === null ? `@${user.login}` : `${user.name} · @${user.login}`}</option>)}</optgroup>{task.status === 'Acceptance' || (activeRun !== null && runStatus !== 'completed') ? null : <optgroup label="Агенты"><option value="hermes">Hermes</option></optgroup>}</select></label>{confirming ? <div className="fcp-task-confirm" role="status" tabIndex={-1} ref={confirmRef}><strong>{human === null ? 'Hermes' : `${human.name ?? human.login} · @${human.login}`}</strong><p>{effects}</p>{human === null ? <small>Запуск Hermes — явная внешняя операция; merge, release, deploy и production недоступны.</small> : null}<div><AsyncButton pending={command.pending} pendingLabel="Запускаем…">Подтвердить и начать</AsyncButton><AsyncButton type="button" className="fcp-secondary" pending={command.pending} pendingLabel="Отменяем…" onClick={() => { setConfirming(false); actionRef.current?.focus(); }}>Отмена</AsyncButton></div></div> : <AsyncButton type="button" ref={actionRef} pending={command.pending} pendingLabel="Готовим…" disabled={choice === undefined} onClick={() => setConfirming(true)}>{activeRun === null ? 'Назначить и начать' : 'Подтвердить смену исполнителя'}</AsyncButton>}</form>;
  const runTitle = runStatus === 'completed' ? 'Запуск Hermes завершён' : runStatus === 'failed' ? 'Запуск Hermes завершился ошибкой' : 'Запуск Hermes выполняется';
  const runAction = runStatus === 'failed' ? <AsyncButton type="button" pending={command.pending} pendingLabel="Запускаем…" onClick={retryAttempt}>Запустить заново</AsyncButton> : null;
  return <section className="fcp-task-executor"><header><div><h2>Исполнитель</h2><p>GitHub остаётся источником назначения и статуса.</p></div><span>{currentExecutor}</span></header>{activeRun === null ? form : <><div className="fcp-task-outcome" role="status"><strong>{runTitle}</strong><p>{runStatus === 'started' ? `Текущий этап: ${task.status ?? 'не подтверждён'}. Worker проверяет результат автоматически раз в минуту.` : `Текущий этап: ${task.status ?? 'не подтверждён'}.`}</p><small>{new Intl.DateTimeFormat('ru-RU', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Moscow'}).format(new Date(activeRun.occurredAt))}</small><div>{runAction}</div></div><details className="fcp-task-reassign"><summary>{runStatus === 'completed' ? 'Начать текущий этап или сменить исполнителя' : 'Сменить исполнителя'}</summary>{form}</details></>}<CommandNoticeView notice={command.notice}/></section>;
}

function empty(value: FormDataEntryValue | null): string | null { return typeof value === 'string' && value.trim().length > 0 ? value : null; }

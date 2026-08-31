'use client';

import {useEffect,useId,useRef,useState,type KeyboardEvent,type ReactNode} from 'react';
import Link from 'next/link';
import {AlertCircle,Check,ChevronRight} from 'lucide-react';

export type StatusTone='success'|'warning'|'danger'|'neutral'|'info';

export function PageHeader({title,detail,action}:Readonly<{title:string;detail?:string;action?:ReactNode}>){return <header className="fcp-c-page-header"><div><h1>{title}</h1>{detail===undefined?null:<p>{detail}</p>}</div>{action}</header>;}

export function StatusIndicator({tone='neutral',children}:Readonly<{tone?:StatusTone;children:ReactNode}>){return <span className={`fcp-c-status is-${tone}`}><span aria-hidden="true"/>{children}</span>;}

export function DividerList({label,children}:Readonly<{label?:string;children:ReactNode}>){return <div className="fcp-c-divider-list" aria-label={label}>{children}</div>;}

/** A portfolio-wide project boundary: a heading and divider-led operational rows, never a card. */
export function ProjectSection({name,status,children}:Readonly<{name:string;status?:ReactNode;children:ReactNode}>){return <section className="fcp-c-project-section"><header><strong>{name}</strong>{status}</header><div>{children}</div></section>;}

/** One project-scoped boundary shared by the Overview and Process operating surfaces. */
export function ProjectPanel({name,status,action,children}:Readonly<{name:string;status?:ReactNode;action?:ReactNode;children:ReactNode}>){return <article className="fcp-c-project-panel"><header><div><strong>{name}</strong><span>Проект</span></div><div className="fcp-c-project-panel-actions">{status}{action}</div></header><div className="fcp-c-project-panel-body">{children}</div></article>;}

export function ProjectListRow({name,status,setup,facts,href,nextAction}:Readonly<{name:string;status:ReactNode;setup:string;facts:readonly string[];href:string;nextAction:string}>){return <article className="fcp-c-project-row"><div className="fcp-c-project-row-title"><Link href={href}>{name}</Link><span>{setup}</span></div><div className="fcp-c-project-row-status">{status}</div><p>{facts.map((fact,index)=><span key={`${fact}-${index}`}>{fact}</span>)}</p><Link className="fcp-c-project-row-action" href={href} aria-label={`${nextAction}: ${name}`}>{nextAction}<ChevronRight aria-hidden="true" size={16}/></Link></article>;}

export type SetupNode=Readonly<{id:string;label:string;state:'complete'|'active'|'pending'|'error'}>;
export function SetupRail({nodes,onSelect}:Readonly<{nodes:readonly SetupNode[];onSelect?:(id:string)=>void}>){return <ol className="fcp-c-setup-rail" aria-label="Готовность проекта">{nodes.map((node,index)=><li className={`is-${node.state}`} key={node.id}>{onSelect===undefined?<span className="fcp-c-setup-node">{node.state==='complete'?<Check aria-hidden="true" size={14}/>:index+1}<b>{node.label}</b></span>:<button type="button" className="fcp-c-setup-node" onClick={()=>onSelect(node.id)}>{node.state==='complete'?<Check aria-hidden="true" size={14}/>:index+1}<b>{node.label}</b></button>}{index===nodes.length-1?null:<i aria-hidden="true"/>}</li>)}</ol>;}

export type TabItem=Readonly<{id:string;label:string;panel:ReactNode}>;
export function Tabs({items,active,onChange,label}:Readonly<{items:readonly TabItem[];active:string;onChange:(id:string)=>void;label:string}>){const base=useId();const key=(event:KeyboardEvent<HTMLButtonElement>,index:number)=>{let next=index;if(event.key==='ArrowRight')next=(index+1)%items.length;else if(event.key==='ArrowLeft')next=(index-1+items.length)%items.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=items.length-1;else return;event.preventDefault();onChange(items[next]!.id);document.getElementById(`${base}-tab-${items[next]!.id}`)?.focus();};return <div className="fcp-c-tabs"><div className="fcp-c-tab-list" role="tablist" aria-label={label}>{items.map((item,index)=><button id={`${base}-tab-${item.id}`} type="button" role="tab" aria-selected={active===item.id} aria-controls={`${base}-panel-${item.id}`} tabIndex={active===item.id?0:-1} onClick={()=>onChange(item.id)} onKeyDown={(event)=>key(event,index)} key={item.id}>{item.label}</button>)}</div>{items.map((item)=><section id={`${base}-panel-${item.id}`} className="fcp-c-tab-panel" role="tabpanel" aria-labelledby={`${base}-tab-${item.id}`} hidden={active!==item.id} tabIndex={0} key={item.id}>{item.panel}</section>)}</div>;}

export function SettingRow({label,detail,status,action}:Readonly<{label:string;detail:ReactNode;status?:ReactNode;action?:ReactNode}>){return <div className="fcp-c-setting-row"><div><strong>{label}</strong><span>{detail}</span></div>{status}{action}</div>;}

export function EmptyState({title,detail,action}:Readonly<{title:string;detail:string;action?:ReactNode}>){return <section className="fcp-c-empty"><h2>{title}</h2><p>{detail}</p>{action}</section>;}

export function ErrorState({title='Не удалось загрузить данные',detail,action}:Readonly<{title?:string;detail:string;action?:ReactNode}>){return <section className="fcp-c-error" role="alert"><AlertCircle aria-hidden="true" size={20}/><div><h2>{title}</h2><p>{detail}</p>{action}</div></section>;}

export function Skeleton({rows=2,label='Загружаем проекты'}:Readonly<{rows?:number;label?:string}>){return <div className="fcp-c-skeleton" role="status" aria-label={label}>{Array.from({length:rows},(_,index)=><span key={index}/>)}</div>;}

export function ReadOnlyNotice(){return <p className="fcp-c-readonly" role="note">Доступ только для просмотра. Изменения доступны владельцу проекта.</p>;}

/** Keeps confirmed server-rendered facts visible while the browser is offline. */
export function OfflineNotice(){const [offline,setOffline]=useState(false);useEffect(()=>{const sync=()=>setOffline(!navigator.onLine);sync();window.addEventListener('online',sync);window.addEventListener('offline',sync);return()=>{window.removeEventListener('online',sync);window.removeEventListener('offline',sync);};},[]);return offline?<p className="fcp-c-offline" role="status">Нет подключения к сети. Показаны последние подтверждённые данные.</p>:null;}

export function DangerZone({title='Удаление проекта',detail,children}:Readonly<{title?:string;detail:string;children:ReactNode}>){return <section className="fcp-c-danger-zone"><div><h2>{title}</h2><p>{detail}</p></div>{children}</section>;}

export function Dialog({open,title,description,onClose,children}:Readonly<{open:boolean;title:string;description:string;onClose:()=>void;children:ReactNode}>){const titleId=useId();const descriptionId=useId();const dialogRef=useRef<HTMLDivElement>(null);const returnFocus=useRef<HTMLElement|null>(null);const closeRef=useRef(onClose);useEffect(()=>{closeRef.current=onClose;},[onClose]);useEffect(()=>{if(!open)return;returnFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;const dialog=dialogRef.current;const controls=()=>Array.from(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),a[href]')??[]);controls()[0]?.focus();const onKey=(event:globalThis.KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();closeRef.current();return;}if(event.key!=='Tab')return;const available=controls();if(available.length===0)return;const first=available[0]!;const last=available.at(-1)!;if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}};document.addEventListener('keydown',onKey);return()=>{document.removeEventListener('keydown',onKey);returnFocus.current?.focus();};},[open]);if(!open)return null;return <div className="fcp-c-dialog-backdrop" onMouseDown={(event)=>{if(event.target===event.currentTarget)closeRef.current();}}><div className="fcp-c-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} ref={dialogRef}><header><h2 id={titleId}>{title}</h2><p id={descriptionId}>{description}</p></header>{children}</div></div>;}

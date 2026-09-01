'use client';

import {useRef} from 'react';
import {ChevronDown,CircleDot} from 'lucide-react';
import type {ProjectTaskView} from '@fai-control-plane/db';
import {WorkspaceLink} from '../ui/workspace-link.tsx';
import {phaseHref} from './navigation.ts';

export function TaskProjectSelector({projects,project}:Readonly<{
  projects:readonly ProjectTaskView[];
  project:ProjectTaskView;
}>){
  const details=useRef<HTMLDetailsElement>(null);
  const close=()=>{if(details.current!==null)details.current.open=false;};
  return <details className="fcp-c-task-project-selector" ref={details}>
    <summary><span><small>Проект</small><strong>{project.name}</strong></span><ChevronDown aria-hidden="true" size={16}/></summary>
    <nav aria-label="Выберите проект">{projects.map((item)=><WorkspaceLink aria-current={item.id===project.id?'page':undefined} href={phaseHref('tasks',item.slug)} key={item.id} onClick={close}><i>{item.name[0]}</i><span><strong>{item.name}</strong><small>{item.tasks.length} задач</small></span>{item.id===project.id?<CircleDot aria-hidden="true" size={14}/>:null}</WorkspaceLink>)}</nav>
  </details>;
}

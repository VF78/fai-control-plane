'use client';

import type {ProjectTaskView} from '@fai-control-plane/db';
import {Bot,LayoutDashboard,ListChecks,Menu,MessageSquareText,Settings2,ShieldCheck,UsersRound,Workflow} from 'lucide-react';
import {usePathname} from 'next/navigation';
import type {ReactNode} from 'react';
import {LogoutControl} from './operator-controls.tsx';
import {areaForPath,labels,navigation,phaseHref,type PhaseArea} from './navigation.ts';
import {OfflineNotice} from '../ui/foundation.tsx';
import {WorkspaceLink} from '../ui/workspace-link.tsx';

const icons: Record<PhaseArea,typeof LayoutDashboard> = {dashboard:LayoutDashboard,tasks:ListChecks,process:Workflow,conversations:MessageSquareText,systems:Bot,settings:Settings2,people:UsersRound};
const projectNoun = (count: number) => count % 10 === 1 && count % 100 !== 11 ? 'проект' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 10 || count % 100 >= 20) ? 'проекта' : 'проектов';

export function Shell({view,projects,projectCount,operatorName,children}: Readonly<{view?:PhaseArea;projects?:readonly ProjectTaskView[];projectCount?:number;operatorName:string;children:ReactNode}>) {
  const pathname=usePathname();
  const active=view??areaForPath(pathname);
  const count=projectCount??projects?.length??0;
  const nav = navigation.map((item) => { const Icon = icons[item]; return <WorkspaceLink href={phaseHref(item)} prefetch={null} aria-current={active === item ? 'page' : undefined} key={item}><span className="fcp-nav-icon"><Icon aria-hidden="true" size={17}/></span><span>{labels[item]}</span></WorkspaceLink>; });
  return <div className="fcp-workspace"><a className="fcp-skip-link" href="#fcp-main">Перейти к содержимому</a><div className="fcp-shell-layout"><aside className="fcp-sidebar"><WorkspaceLink className="fcp-brand" href={phaseHref('dashboard')}><i aria-hidden="true">f</i><b>f(AI) Control</b></WorkspaceLink><nav className="fcp-sidebar-section fcp-sidebar-nav" aria-label="Разделы">{nav}</nav></aside><header className="fcp-topbar"><WorkspaceLink className="fcp-mobile-brand" href={phaseHref('dashboard')}>f(AI) Control</WorkspaceLink><strong>{labels[active]}</strong><div className="fcp-topbar-actions"><span className="fcp-access-count"><ShieldCheck aria-hidden="true" size={15}/>{count} {projectNoun(count)}</span><span className="fcp-user-avatar" aria-label={`Оператор: ${operatorName}`}>{operatorName.split(/\s+/).map((part) => part[0]).join('').slice(0,2).toUpperCase()}</span><LogoutControl/></div><details className="fcp-mobile-menu"><summary aria-label="Открыть навигацию"><Menu aria-hidden="true" size={20}/></summary><div className="fcp-mobile-menu-body"><nav aria-label="Разделы">{nav}</nav><LogoutControl/></div></details></header><main className="fcp-main" id="fcp-main" tabIndex={-1}><OfflineNotice/>{children}</main></div></div>;
}

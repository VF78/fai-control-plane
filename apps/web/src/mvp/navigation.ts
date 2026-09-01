export type PhaseArea = 'dashboard'|'tasks'|'process'|'conversations'|'people'|'systems'|'settings';

export const navigation: readonly PhaseArea[] = ['dashboard','tasks','process','conversations','systems','settings','people'];
export const labels: Record<PhaseArea,string> = {dashboard:'Обзор',tasks:'Задачи',process:'Процесс',conversations:'Чаты',systems:'Агенты и системы',settings:'Проекты',people:'Роли и доступы'};
export const paths: Record<PhaseArea,string> = {dashboard:'/overview',tasks:'/tasks',process:'/process',conversations:'/chats',systems:'/systems',settings:'/projects',people:'/people'};

export const phaseHref = (view: PhaseArea, project?: string, task?: string, filter?: string) => {
  const query = new URLSearchParams();
  if (project) query.set('project', project);
  if (task) query.set('task', task);
  if (filter) query.set('filter', filter);
  const suffix=query.size===0?'':`?${query}`;
  return `${paths[view]}${suffix}`;
};

export const areaForPath = (pathname:string):PhaseArea => {
  const entry=(Object.entries(paths) as [PhaseArea,string][]).find(([,path])=>pathname===path||pathname.startsWith(`${path}/`));
  return entry?.[0]??'dashboard';
};

export const legacyPath = (query:Readonly<Record<string,string|string[]|undefined>>):string => {
  const requested=Array.isArray(query.view)?query.view[0]:query.view;
  const view:PhaseArea=['dashboard','tasks','process','conversations','people','systems','settings'].includes(requested??'')?requested as PhaseArea:'dashboard';
  const preserved=new URLSearchParams();
  for(const key of ['project','task','filter','setup'] as const){const value=query[key];const first=Array.isArray(value)?value[0]:value;if(first!==undefined)preserved.set(key,first);}
  const suffix=preserved.size===0?'':`?${preserved}`;
  return `${paths[view]}${suffix}`;
};

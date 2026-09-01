import {readFile} from 'node:fs/promises';
import {describe,expect,it} from 'vitest';
import {areaForPath,legacyPath,phaseHref} from './navigation.ts';

describe('path-based workspace navigation',()=>{
  it('builds canonical section paths and retains Tasks query state',()=>{
    expect(phaseHref('dashboard')).toBe('/overview');
    expect(phaseHref('tasks','fai','item-1','blocked')).toBe('/tasks?project=fai&task=item-1&filter=blocked');
    expect(areaForPath('/projects')).toBe('settings');
  });

  it('maps each legacy view once while preserving supported query parameters',()=>{
    expect(legacyPath({view:'settings',setup:'fai'})).toBe('/projects?setup=fai');
    expect(legacyPath({view:'tasks',project:'fai',task:'item-1',filter:'blocked'})).toBe('/tasks?project=fai&task=item-1&filter=blocked');
    expect(legacyPath({view:'unknown',project:'fai'})).toBe('/overview?project=fai');
  });

  it('keeps the shell in one shared layout and removes the query-view page router',async()=>{
    const [entry,layout,loading,taskBoard,pages]=await Promise.all([
      readFile(new URL('../../app/page.tsx',import.meta.url),'utf8'),
      readFile(new URL('../../app/(workspace)/layout.tsx',import.meta.url),'utf8'),
      readFile(new URL('../../app/(workspace)/loading.tsx',import.meta.url),'utf8'),
      readFile(new URL('./task-board.tsx',import.meta.url),'utf8'),
      Promise.all(['overview','tasks','process','chats','systems','projects','people'].map((route)=>readFile(new URL(`../../app/(workspace)/${route}/page.tsx`,import.meta.url),'utf8')))
    ]);
    expect(entry).toContain('redirect(legacyPath(await searchParams))');
    expect(entry).not.toContain('<Shell');
    expect(layout).toContain('<Shell projectCount={workspace.projects.length}');
    expect(loading).toContain('<Skeleton/>');
    expect(taskBoard).toContain("phaseHref('tasks',project,task)");
    expect(taskBoard).not.toContain('?view=');
    expect(pages).toHaveLength(7);
    expect(pages.join('\n')).not.toContain('?view=');
  });
});

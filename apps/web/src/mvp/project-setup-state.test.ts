import {describe,expect,it} from 'vitest';
import {readFile} from 'node:fs/promises';
import {projectActiveDocuments,projectSetupGroups,projectSetupState} from './project-setup-state.ts';

const item={evidence:{people:[{active:true}]},runtimeSetup:null,trackerPreparation:null,
  wizardProgress:{processConfirmed:false,teamSkipped:false,communicationsSkipped:false}};

describe('project setup state',()=>{
  it('keeps provider-native tracker preparation behind its real prerequisites',()=>{
    expect(projectSetupState(item,false,false)).toMatchObject({complete:false,nextStep:1});
  });

  it('marks a fully prepared project complete',()=>{
    expect(projectSetupState({evidence:{people:[{active:true},{active:true}]},
      runtimeSetup:{telegramConfigured:true,status:'ready'},trackerPreparation:{status:'ready'},
      wizardProgress:{processConfirmed:true,teamSkipped:false,communicationsSkipped:false}},true,true))
      .toMatchObject({complete:true,nextStep:9});
  });

  it('accepts a verified provider-neutral internal channel without legacy Telegram runtime fields',()=>{
    expect(projectSetupState({...item,config:{channels:{internal:{configured:true}}},
      trackerPreparation:{status:'ready'}},true,false)).toMatchObject({nextStep:5});
  });

  it('lets an explicitly deferred optional chat step advance without marking the channel configured',()=>{
    const deferred={...item,wizardProgress:{...item.wizardProgress,communicationsSkipped:true},
      trackerPreparation:{status:'ready'}};expect(projectSetupGroups(deferred,true,false,true))
      .toMatchObject({groups:[true,true,true,true,false,false],communicationsSkipped:true,complete:4});
  });

  it('projects one authoritative fixed version and every supplemental document',()=>{
    const documents=projectActiveDocuments([
      {kind:'project_document_v1:requirements',name:'active'},
      {kind:'project_document_v1:requirements',name:'historical'},
      {kind:'project_document_v1:passport',name:'passport'},
      {kind:'project_document_v1:supplemental',name:'extra-a'},
      {kind:'project_document_v1:supplemental',name:'extra-b'}]);
    expect(documents.activeDocuments.map(({name})=>name)).toEqual(['active','passport','extra-a','extra-b']);
    expect(documents.documentsReady).toBe(true);
  });

  it('owns the six presentation groups used by portfolio and detail',()=>{
    expect(projectSetupGroups(item,false,false,true)).toMatchObject({groups:[true,true,false,false,false,false],complete:2});
  });

  it('shows the verified tracker binding early and its Hermes preparation in final verification',()=>{
    const prepared={...item,evidence:{people:[{active:true},{active:true}]},
      runtimeSetup:{telegramConfigured:false,status:'ready'},
      wizardProgress:{processConfirmed:true,teamSkipped:false,communicationsSkipped:true}};
    expect(projectSetupGroups(prepared,true,true,true)).toMatchObject({
      groups:[true,true,true,true,true,false],setup:{complete:false,nextStep:7}});
  });

  it('cannot report completion while the tracker binding is unavailable',()=>{
    const prepared={evidence:{people:[{active:true},{active:true}]},
      runtimeSetup:{telegramConfigured:true,status:'ready'},trackerPreparation:{status:'ready'},
      wizardProgress:{processConfirmed:true,teamSkipped:false,communicationsSkipped:false}};
    expect(projectSetupGroups(prepared,true,true,false)).toMatchObject({
      groups:[true,false,true,true,true,true],setup:{complete:false,nextStep:8}});
  });

  it('keeps the shared calculation outside the client component boundary',async()=>{
    const [stateSource,phaseSource]=await Promise.all([
      readFile(new URL('./project-setup-state.ts',import.meta.url),'utf8'),
      readFile(new URL('./phase-b-ui.tsx',import.meta.url),'utf8')]);
    expect(stateSource).not.toContain("'use client'");
    expect(phaseSource).toContain("from './project-setup-state.ts'");
    expect(phaseSource).not.toMatch(/import\s*\{[^}]*projectSetupState[^}]*\}\s*from '\.\/project-wizard\.tsx'/);
  });
});

import {describe,expect,it} from 'vitest';
import {readFile} from 'node:fs/promises';
import {projectSetupState} from './project-setup-state.ts';

const item={evidence:{people:[{active:true}]},runtimeSetup:null,trackerPreparation:null,
  wizardProgress:{processConfirmed:false,teamSkipped:false,communicationsSkipped:false}};

describe('project setup state',()=>{
  it('returns the first unfinished wizard step without a client runtime',()=>{
    expect(projectSetupState(item,false,false)).toMatchObject({complete:false,nextStep:1});
  });

  it('marks a fully prepared project complete',()=>{
    expect(projectSetupState({evidence:{people:[{active:true},{active:true}]},
      runtimeSetup:{telegramConfigured:true,status:'ready'},trackerPreparation:{status:'ready'},
      wizardProgress:{processConfirmed:true,teamSkipped:false,communicationsSkipped:false}},true,true))
      .toMatchObject({complete:true,nextStep:9});
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

import {describe,expect,it} from 'vitest';
import type {Database} from '@fai-control-plane/db';
import {projectTaskCommand} from './project-task-command.ts';

const database={} as Database;

describe('worker-owned project task commands',()=>{
  it('rejects unauthenticated reads before provider access',async()=>{
    const response=await projectTaskCommand(database,new Request(
      'http://worker/project-task?projectId=00000000-0000-4000-8000-000000000001'));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({error:'authentication_required'});
  });

  it('rejects unauthenticated writes before parsing the command',async()=>{
    const response=await projectTaskCommand(database,new Request('http://worker/project-task',{
      method:'POST',headers:{'content-type':'application/json'},body:'{}'}));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({error:'authentication_required'});
  });
});

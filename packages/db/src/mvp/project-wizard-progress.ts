import type {Database} from './runtime.ts';

export type ProjectWizardProgress=Readonly<{processConfirmed:boolean;teamSkipped:boolean;communicationsSkipped:boolean}>;
const commands=['project.wizard.process-confirm','project.wizard.team-skip','project.wizard.communications-skip'] as const;
export type ProjectWizardDecision=typeof commands[number];

export const readProjectWizardProgress=async(database:Database,actorId:string,projectId:string):Promise<ProjectWizardProgress>=>{
  const result=await database.query<{commandType:string}>(`select distinct r.command_type as "commandType" from command_receipts r
    join project_memberships m on m.project_id=r.project_id and m.actor_id=$1 and m.active=true
    where r.project_id=$2 and r.command_type=any($3::text[])`,[actorId,projectId,commands]);const found=new Set(result.rows.map((row)=>row.commandType));
  return {processConfirmed:found.has(commands[0]),teamSkipped:found.has(commands[1]),communicationsSkipped:found.has(commands[2])};};

export const recordProjectWizardDecision=async(database:Database,input:Readonly<{workspaceId:string;projectId:string;actorId:string;
  decision:ProjectWizardDecision;idempotencyKey:string;occurredAt:string}>):Promise<ProjectWizardProgress>=>{if(!commands.includes(input.decision))
    throw new Error('project_wizard_decision_invalid');const client=await database.connect();try{await client.query('begin');const allowed=await client.query(
      `select 1 from project_memberships where project_id=$1 and actor_id=$2 and role='project_owner' and active=true for update`,
    [input.projectId,input.actorId]);if(allowed.rowCount!==1)throw new Error('project_wizard_decision_denied');await client.query(
      `insert into command_receipts(project_id,actor_id,idempotency_key,command_type,result_reference,occurred_at)
       values($1,$2,$3,$4,$5,$6) on conflict(idempotency_key) do nothing`,[input.projectId,input.actorId,input.idempotencyKey,input.decision,
      input.projectId,input.occurredAt]);await client.query(`insert into audit_events(workspace_id,project_id,actor_id,action,target_reference,
      correlation_id,details,occurred_at) select $1,$2,$3,$4,$2,$5,$6,$7 where not exists(select 1 from audit_events where project_id=$2
      and action=$4 and correlation_id=$5)`,[input.workspaceId,input.projectId,input.actorId,input.decision,input.idempotencyKey,
      JSON.stringify({wizard:true}),input.occurredAt]);await client.query('commit');return readProjectWizardProgress(database,input.actorId,input.projectId);
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}};

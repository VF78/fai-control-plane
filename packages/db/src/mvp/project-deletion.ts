import type {Database} from './runtime.ts';

export type ProjectDeletionTarget=Readonly<{workspaceId:string;projectId:string;slug:string}>;

export const readProjectDeletionTarget=async(database:Database,actorId:string,projectId:string):Promise<ProjectDeletionTarget>=>{
  const result=await database.query<ProjectDeletionTarget>(`select p.workspace_id as "workspaceId",p.id as "projectId",p.slug
    from projects p join project_memberships m on m.project_id=p.id
    where p.id=$1 and m.actor_id=$2 and m.role='project_owner' and m.active=true`,[projectId,actorId]);
  const target=result.rows[0];if(target===undefined)throw new Error('project_delete_denied');return target;
};

/** Deletes only Control Plane state. Provider-owned repository, Project and issues are never mutated. */
export const deleteProjectRecords=async(database:Database,input:ProjectDeletionTarget&Readonly<{actorId:string}>):Promise<void>=>{
  const client=await database.connect();try{await client.query('begin');
    const allowed=await client.query(`select 1 from projects p join project_memberships m on m.project_id=p.id
      where p.id=$1 and p.workspace_id=$2 and m.actor_id=$3 and m.role='project_owner' and m.active=true for update`,
    [input.projectId,input.workspaceId,input.actorId]);if(allowed.rowCount!==1)throw new Error('project_delete_denied');
    await client.query(`delete from tracker_snapshots where binding_id in
      (select id from tracker_bindings where project_id=$1)`,[input.projectId]);
    for(const table of ['outbox_events','approval_evidence','incoming_events','command_receipts','project_source_artifacts'])
      await client.query(`delete from ${table} where project_id=$1`,[input.projectId]);
    await client.query('update audit_events set project_id=null where project_id=$1',[input.projectId]);
    await client.query('delete from tracker_bindings where project_id=$1',[input.projectId]);
    await client.query('delete from project_memberships where project_id=$1',[input.projectId]);
    await client.query(`delete from secret_refs where workspace_id=$1 and purpose like $2`,
      [input.workspaceId,`project-hermes:${input.projectId}:%`]);
    await client.query('delete from projects where id=$1 and workspace_id=$2',[input.projectId,input.workspaceId]);
    await client.query('commit');
  }catch(error){await client.query('rollback');throw error;}finally{client.release();}
};

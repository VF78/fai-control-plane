import {createHash, randomUUID} from 'node:crypto';
import type {Database} from './runtime.ts';

export const projectDocumentCategories = Object.freeze([
  'requirements', 'passport', 'combined', 'architecture', 'supplemental'
] as const);
export type ProjectDocumentCategory = typeof projectDocumentCategories[number];
export const projectDocumentUploadCategories = Object.freeze([
  'passport', 'requirements', 'architecture', 'supplemental'
] as const);
export type ProjectDocumentUploadCategory = typeof projectDocumentUploadCategories[number];
/** The browser sends one checked batch; keep this below the matching proxy limit. */
export const projectDocumentMaxFileBytes = 50 * 1024 * 1024;
export const projectDocumentMaxBatchBytes = 100 * 1024 * 1024;
export const projectDocumentMaxSetBytes = 100 * 1024 * 1024;
export const projectDocumentMaxFiles = 10;

const canonicalMediaType = (name:string,mediaType:string):string|null => {
  const extension=/\.[^.]+$/.exec(name.toLowerCase())?.[0];
  const generic = mediaType === '' || mediaType === 'application/octet-stream';
  if(extension==='.docx'&&(generic || mediaType==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if(extension==='.pdf'&&(generic || mediaType==='application/pdf'))return 'application/pdf';
  if(extension==='.md'&&['text/markdown','text/plain','application/octet-stream',''].includes(mediaType))return 'text/markdown';
  if(extension==='.txt'&&['text/plain','application/octet-stream',''].includes(mediaType))return 'text/plain';
  return null;
};
const kind = (category: ProjectDocumentCategory): string => `project_document_v1:${category}`;
const categoryOf = (value: string): ProjectDocumentCategory | null => {
  const valueCategory = value.startsWith('project_document_v1:')
    ? value.slice('project_document_v1:'.length).split(':',1)[0]! : '';
  return projectDocumentCategories.includes(valueCategory as ProjectDocumentCategory)
    ? valueCategory as ProjectDocumentCategory : null;
};

export type ProjectDocumentView = Readonly<{
  id: string; projectId: string; category: ProjectDocumentCategory; name: string; mediaType: string;
  artifactKind:string;sha256: string; sizeBytes: number; provenance: string; createdAt: string; downloadPath: string;
}>;

const validateDocument = (input: Readonly<{name: string; mediaType: string; bytes: Buffer}>): string => {
  const mediaType=canonicalMediaType(input.name,input.mediaType);
  if (mediaType === null ||
    input.bytes.byteLength < 1 || input.bytes.byteLength > projectDocumentMaxFileBytes) {
    throw new Error('project_document_invalid');
  }
  if (mediaType === 'application/pdf') {
    const sample = input.bytes.toString('latin1');
    if (!sample.startsWith('%PDF-') || !/(?:BT|\/Font|ToUnicode)/.test(sample)) {
      throw new Error('project_document_pdf_text_layer_required');
    }
  }
  if (mediaType.includes('wordprocessingml')) {
    const archive = input.bytes.toString('latin1');
    if (!(input.bytes[0] === 0x50 && input.bytes[1] === 0x4b) ||
      !archive.includes('[Content_Types].xml') || !archive.includes('word/document.xml')) {
      throw new Error('project_document_invalid');
    }
  }
  if (mediaType.startsWith('text/')) {
    try { new TextDecoder('utf-8', {fatal: true}).decode(input.bytes); }
    catch { throw new Error('project_document_invalid'); }
  }
  return mediaType;
};

export type ProjectDocumentUpload = Readonly<{
  workspaceId: string; projectId: string; actorId: string; category: ProjectDocumentUploadCategory;
  name: string; mediaType: string; bytes: Buffer; provenance: string; idempotencyKey: string; occurredAt: string;
}>;

export const uploadProjectDocuments = async (database: Database, inputs: readonly ProjectDocumentUpload[]): Promise<readonly ProjectDocumentView[]> => {
  if(inputs.length===0 || inputs.length>projectDocumentMaxFiles) throw new Error('project_document_batch_invalid');
  const validated=inputs.map((input)=>({...input,mediaType:validateDocument(input)}));
  const first=validated[0]!;
  if(validated.some((input)=>input.workspaceId!==first.workspaceId||input.projectId!==first.projectId||input.actorId!==first.actorId) ||
    new Set(validated.filter(({category})=>category!=='supplemental').map(({category})=>category)).size!==validated.filter(({category})=>category!=='supplemental').length ||
    validated.reduce((total,{bytes})=>total+bytes.byteLength,0)>projectDocumentMaxBatchBytes) throw new Error('project_document_batch_invalid');
  const client = await database.connect();
  try {
    await client.query('begin');
    const allowed = await client.query(`select 1 from projects p join project_memberships m on m.project_id=p.id
      where p.id=$1 and p.workspace_id=$2 and m.actor_id=$3 and m.role='project_owner' and m.active=true
      for update of p`, [first.projectId, first.workspaceId, first.actorId]);
    if (allowed.rowCount !== 1) throw new Error('project_document_denied');
    const active = await client.query<{kind: string; sizeBytes: string | number}>(`select distinct on (kind) kind,
      size_bytes as "sizeBytes" from project_source_artifacts where project_id=$1 and kind like 'project_document_v1:%'
      order by kind,created_at desc,id desc`, [first.projectId]);
    const prepared=validated.map((input,index)=>({...input,artifactKind:input.category==='supplemental'
      ?`${kind(input.category)}:${createHash('sha256').update(`${input.idempotencyKey}:${index}`).digest('hex').slice(0,24)}`:kind(input.category)}));
    const replaced=new Set(prepared.map(({artifactKind})=>artifactKind));
    const retained = active.rows.filter((row) => !replaced.has(row.kind));
    if (retained.length + validated.length > projectDocumentMaxFiles ||
      retained.reduce((total, row) => total + Number(row.sizeBytes), 0) + validated.reduce((total,{bytes})=>total+bytes.byteLength,0) > projectDocumentMaxSetBytes) {
      throw new Error('project_document_set_too_large');
    }
    const results:ProjectDocumentView[]=[];
    for(const input of prepared){const {artifactKind}=input;const sha256=createHash('sha256').update(input.bytes).digest('hex');
      const inserted=await client.query<{id:string;createdAt:Date}>(`insert into project_source_artifacts
        (id,project_id,created_by_actor_id,kind,name,media_type,sha256,content_text,content_bytes,source_url,provenance)
        values($1,$2,$3,$4,$5,$6,$7,null,$8,null,$9)
        on conflict(project_id,kind,sha256) do update set sha256=excluded.sha256
        returning id,created_at as "createdAt"`,[randomUUID(),input.projectId,input.actorId,artifactKind,input.name,input.mediaType,
        sha256,input.bytes,input.provenance]);const row=inserted.rows[0]!;
      await client.query(`insert into audit_events(workspace_id,project_id,actor_id,action,target_reference,
        correlation_id,details,occurred_at) values($1,$2,$3,'project.document.upload',$4,$5,$6,$7)`,
      [input.workspaceId,input.projectId,input.actorId,row.id,input.idempotencyKey,
        JSON.stringify({category:input.category,sha256,sizeBytes:input.bytes.byteLength,name:input.name}),input.occurredAt]);
      results.push({id:row.id,projectId:input.projectId,category:input.category,artifactKind,name:input.name,mediaType:input.mediaType,
        sha256,sizeBytes:input.bytes.byteLength,provenance:input.provenance,createdAt:row.createdAt.toISOString(),downloadPath:`/api/projects/${input.projectId}/documents/${row.id}`});}
    await client.query('commit');
    return results;
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
};

export const uploadProjectDocument = async (database: Database, input: ProjectDocumentUpload): Promise<ProjectDocumentView> =>
  (await uploadProjectDocuments(database,[input]))[0]!;

export const listProjectDocuments = async (database: Database, actorId: string,
  projectId: string): Promise<readonly ProjectDocumentView[]> => {
  const result = await database.query<{id:string;projectId:string;kind:string;name:string;mediaType:string;sha256:string;
    sizeBytes:string|number;provenance:string;createdAt:Date}>(`select s.id,s.project_id as "projectId",s.kind,s.name,
      s.media_type as "mediaType",s.sha256,s.size_bytes as "sizeBytes",s.provenance,s.created_at as "createdAt"
      from project_source_artifacts s join project_memberships m on m.project_id=s.project_id
      where s.project_id=$1 and m.actor_id=$2 and m.active=true and s.kind like 'project_document_v1:%'
      order by s.created_at desc,s.id desc`, [projectId,actorId]);
  return result.rows.flatMap((row) => { const category = categoryOf(row.kind); return category === null ? [] : [{...row,
    artifactKind:row.kind,
    category,sizeBytes:Number(row.sizeBytes),createdAt:row.createdAt.toISOString(),
    downloadPath:`/api/projects/${projectId}/documents/${row.id}`}]; });
};

export const readProjectDocumentPayload = async (database: Database, actorId: string, projectId: string,
  documentId: string): Promise<Readonly<{name:string;mediaType:string;bytes:Buffer}> | null> => {
  const result = await database.query<{name:string;mediaType:string;bytes:Buffer}>(`select s.name,s.media_type as "mediaType",
    s.content_bytes as bytes from project_source_artifacts s join project_memberships m on m.project_id=s.project_id
    where s.id=$1 and s.project_id=$2 and m.actor_id=$3 and m.active=true and s.kind like 'project_document_v1:%'`,
  [documentId,projectId,actorId]);
  return result.rows[0] ?? null;
};

export const readActiveProjectDocumentSet = async (database: Database, actorId: string, projectId: string): Promise<Readonly<{
  configured: boolean; architecturePresent: boolean; fingerprint: string; documents: readonly ProjectDocumentView[];
}>> => {
  const all = await listProjectDocuments(database,actorId,projectId);
  const fixed = new Map<ProjectDocumentCategory,ProjectDocumentView>(); const supplemental:ProjectDocumentView[]=[];
  for(const document of all){if(document.category==='supplemental')supplemental.push(document);
    else if(!fixed.has(document.category))fixed.set(document.category,document);}
  const active=[...fixed.values(),...supplemental];
  const categories = new Set(active.map(({category}) => category));
  const configured = categories.has('combined') || (categories.has('requirements') && categories.has('passport'));
  const fingerprint = createHash('sha256').update(active.slice().sort((a,b)=>
    a.artifactKind.localeCompare(b.artifactKind)||a.sha256.localeCompare(b.sha256))
    .map(({artifactKind,sha256})=>`${artifactKind}:${sha256}`).join('\n')).digest('hex');
  return {configured,architecturePresent:categories.has('architecture'),fingerprint,documents:active};
};

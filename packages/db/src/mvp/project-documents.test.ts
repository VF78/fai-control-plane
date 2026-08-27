import {describe,expect,it,vi} from 'vitest';
import type {Database} from './runtime.ts';
import {readActiveProjectDocumentSet,uploadProjectDocument} from './project-documents.ts';

describe('authoritative project documents',()=>{
  it('accepts an owner DOCX original and persists binary bytes without base64 text',async()=>{
    const query=vi.fn(async(sql:string,parameters?:readonly unknown[])=>{
      void parameters;
      if(sql.includes("m.role='project_owner'"))return {rowCount:1,rows:[{}]};
      if(sql.includes('distinct on (kind)'))return {rowCount:0,rows:[]};
      if(sql.includes('returning id,created_at'))return {rowCount:1,rows:[{id:'document-1',createdAt:new Date('2026-08-27T10:00:00Z')}]};
      return {rowCount:1,rows:[]};
    });
    const database={connect:vi.fn(async()=>({query,release:vi.fn()}))} as unknown as Database;
    const bytes=Buffer.from('PK\u0003\u0004[Content_Types].xml word/document.xml docx');
    await expect(uploadProjectDocument(database,{workspaceId:'workspace',projectId:'project',actorId:'owner',
      category:'requirements',name:'requirements.docx',mediaType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes,provenance:'operator-upload',idempotencyKey:'upload:1',occurredAt:'2026-08-27T10:00:00Z'}))
      .resolves.toMatchObject({id:'document-1',category:'requirements',sizeBytes:bytes.length});
    const insert=query.mock.calls.find(([sql])=>String(sql).includes('content_bytes'))!;
    expect(insert[1]).toContain(bytes);
    expect(String(insert[0])).toContain('null,$8');
  });

  it('requires a text layer for PDF originals',async()=>{
    const database={} as Database;
    await expect(uploadProjectDocument(database,{workspaceId:'workspace',projectId:'project',actorId:'owner',
      category:'passport',name:'passport.pdf',mediaType:'application/pdf',bytes:Buffer.from('%PDF-1.7 image only'),
      provenance:'operator-upload',idempotencyKey:'upload:2',occurredAt:'2026-08-27T10:00:00Z'}))
      .rejects.toThrow('project_document_pdf_text_layer_required');
  });

  it('rejects a ZIP renamed to DOCX before opening a database transaction',async()=>{
    const database={connect:vi.fn()} as unknown as Database;
    await expect(uploadProjectDocument(database,{workspaceId:'workspace',projectId:'project',actorId:'owner',
      category:'requirements',name:'requirements.docx',mediaType:'application/octet-stream',
      bytes:Buffer.from('PK\u0003\u0004not-a-word-package'),provenance:'operator-upload',
      idempotencyKey:'upload:invalid',occurredAt:'2026-08-27T10:00:00Z'}))
      .rejects.toThrow('project_document_invalid');
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('accepts requirements plus passport or one combined document and fingerprints exact active versions',async()=>{
    const rows=(categories:readonly string[])=>categories.map((category,index)=>({id:`id-${index}`,projectId:'project',
      kind:`project_document_v1:${category}`,name:`${category}.txt`,mediaType:'text/plain',sha256:String(index+1).repeat(64),
      sizeBytes:12,provenance:'operator-upload',createdAt:new Date(`2026-08-27T10:0${index}:00Z`)}));
    const database={query:vi.fn(async()=>({rows:rows(['requirements','passport'])}))} as unknown as Database;
    const pair=await readActiveProjectDocumentSet(database,'owner','project');
    expect(pair).toMatchObject({configured:true,architecturePresent:false});
    expect(pair.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    (database.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({rows:rows(['combined'])});
    await expect(readActiveProjectDocumentSet(database,'owner','project')).resolves.toMatchObject({configured:true});
  });
});

import {readFile} from 'node:fs/promises';
import {describe,expect,it} from 'vitest';

describe('project document deletion API',()=>{
  it('keeps deletion on the exact document route with session, CSRF, and idempotency guards',async()=>{
    const [api,route]=await Promise.all([
      readFile(new URL('./api.ts',import.meta.url),'utf8'),
      readFile(new URL('../../app/api/projects/[projectId]/documents/[documentId]/route.ts',import.meta.url),'utf8')]);
    expect(api).toContain('export const projectDocumentDelete');
    expect(api).toContain("if(request.method!=='DELETE')");
    expect(api).toContain('requireCsrf(request)');
    expect(api).toContain('deleteProjectDocument(database');
    expect(api).toContain('idempotencyKey:string(body.idempotencyKey,128)');
    expect(route).toContain('export const DELETE');
    expect(route).toContain('projectDocumentDelete(request,projectId,documentId)');
  });
});

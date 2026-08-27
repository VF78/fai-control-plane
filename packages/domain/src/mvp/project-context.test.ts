import {describe, expect, it} from 'vitest';
import {parseProjectContextSnapshot, parseProjectContextSource, projectContextSnapshotVersion, projectContextSourceKind,
  serializeProjectContextSnapshot, serializeProjectContextSource} from './project-context.ts';

describe('project context snapshot', () => {
  const source = (id: string) => ({id,key:id,kind:projectContextSourceKind,version:'a'.repeat(64),
    provenance:'approved upload'} as const);

  it('validates a canonical logical source envelope', () => {
    expect(serializeProjectContextSource({contract:'fai.project-context-source.v1',key:'requirements',content:'Exact source'}))
      .toBe('{"contract":"fai.project-context-source.v1","key":"requirements","content":"Exact source"}');
  });

  it('uses normalized source IDs and keeps repository paths in provenance', () => {
    expect(parseProjectContextSource({contract:'fai.project-context-source.v1',key:'repo:agents',content:'Policy'}))
      .toMatchObject({key:'repo:agents'});
    expect(parseProjectContextSource({contract:'fai.project-context-source.v1',key:'repo:AGENTS.md',content:'Policy'}))
      .toBeNull();
  });

  it('normalizes source order and hashes deterministic content without time', () => {
    const left = serializeProjectContextSnapshot({contract:'fai.project-context.v1',sources:[source('b'),source('a')],content:'Bounded context'});
    const right = serializeProjectContextSnapshot({contract:'fai.project-context.v1',sources:[source('a'),source('b')],content:'Bounded context'});
    expect(left).toBe(right);
    expect(projectContextSnapshotVersion(left)).toMatch(/^[a-f0-9]{64}$/);
    expect(left).not.toContain('createdAt');
  });

  it('rejects duplicate sources and snapshots above 4000 UTF-8 bytes', () => {
    expect(parseProjectContextSnapshot({contract:'fai.project-context.v1',sources:[source('a'),source('a')],content:'x'})).toBeNull();
    expect(parseProjectContextSnapshot({contract:'fai.project-context.v1',sources:[source('a')],content:'я'.repeat(2_001)})).toBeNull();
  });

  it('fits the three canonical 600-byte slices together with their exact manifest', () => {
    const keys = ['repo:agents','repo:passport','composition:project-process-policy'];
    const sources = keys.map((key,index) => ({id:`00000000-0000-4000-8000-00000000000${index + 1}`,key,
      kind:projectContextSourceKind,version:String(index + 1).repeat(64),
      provenance:index < 2 ? `repo-file:docs/source-${index}@${'a'.repeat(40)}` : 'composition-file'} as const));
    const content = keys.map((key) => `# ${key}\n${'x'.repeat(600)}`).join('\n\n');
    const serialized = serializeProjectContextSnapshot({contract:'fai.project-context.v1',sources,content});
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(4_000);
  });
});

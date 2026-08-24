import {describe, expect, it} from 'vitest';
import {parseProjectContextSnapshot, projectContextSnapshotVersion, projectContextSourceKind,
  serializeProjectContextSnapshot, serializeProjectContextSource} from './project-context.ts';

describe('project context snapshot', () => {
  const source = (id: string) => ({id,key:id,kind:projectContextSourceKind,version:'a'.repeat(64),
    provenance:'approved upload'} as const);

  it('validates a canonical logical source envelope', () => {
    expect(serializeProjectContextSource({contract:'fai.project-context-source.v1',key:'requirements',content:'Exact source'}))
      .toBe('{"contract":"fai.project-context-source.v1","key":"requirements","content":"Exact source"}');
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
});

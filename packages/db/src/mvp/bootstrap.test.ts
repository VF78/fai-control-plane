import {readFile} from 'node:fs/promises';
import {describe,expect,it} from 'vitest';

describe('workspace bootstrap',()=>{
  it('contains no project, repository, process or Hermes seed',async()=>{
    const source=await readFile(new URL('./bootstrap.ts',import.meta.url),'utf8');
    for(const value of ['BOOTSTRAP_PROJECT_','BOOTSTRAP_REPOSITORY_','GITHUB_PROJECT_ID','GITHUB_BINDING_ID',
      'HERMES_TRACKER_OWNER_OPTION_ID','STATUS_DONE_ID','HERMES_TOKEN_FILE','insert into projects','insert into tracker_bindings'])
      expect(source).not.toContain(value);
  });
});

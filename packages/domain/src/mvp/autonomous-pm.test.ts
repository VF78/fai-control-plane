import {describe,expect,it} from 'vitest';
import {parseAutonomousPmResult,renderAutonomousPmRequest,validateAutonomousPmRequest} from './autonomous-pm.ts';

const request={contract:'fai.autonomous-pm-request.v1' as const,project:{id:'project',
  repositoryUrl:'https://github.com/VF78/control',trackerUrl:'https://github.com/users/VF78/projects/1'},
versions:{process:'a'.repeat(64),routing:'b'.repeat(64)},correlationId:'correlation',idempotencyKey:'key'};
describe('autonomous PM wire contract',()=>{
  it('contains only configured coordinates, versions and idempotency identity',()=>{
    expect(validateAutonomousPmRequest(request)).toBe(true);
    expect(JSON.parse(renderAutonomousPmRequest(request))).toEqual(request);
    const rendered=renderAutonomousPmRequest(request);
    for(const forbidden of ['documents','profile','chat','issues','dependencies','backlog'])expect(rendered).not.toContain(forbidden);
  });
  it('accepts no-eligible, blocker, or one bounded selected item only',()=>{
    expect(parseAutonomousPmResult(JSON.stringify({contract:'fai.autonomous-pm-result.v1',outcome:'no-eligible',
      reason:'empty'}))).toMatchObject({outcome:'no-eligible'});
    expect(parseAutonomousPmResult(JSON.stringify({contract:'fai.autonomous-pm-result.v1',outcome:'blocker',
      reason:'dependency cycle'}))).toMatchObject({outcome:'blocker'});
    expect(parseAutonomousPmResult(JSON.stringify({contract:'fai.autonomous-pm-result.v1',outcome:'selected',reason:'ready',
      selection:{itemId:'item',issueUrl:'https://github.com/VF78/control/issues/42',observedVersion:'v2'}})))
      .toMatchObject({outcome:'selected',selection:{itemId:'item'}});
    expect(parseAutonomousPmResult(JSON.stringify({contract:'fai.autonomous-pm-result.v1',outcome:'selected',reason:'bad'})))
      .toBeNull();
  });
});

import {expect, it, vi} from 'vitest';
import {updateAgentProfileCommand} from './agent-profile-commands';

const profileId = '11111111-1111-4111-8111-111111111111';
const request = new Request(`https://app.example/api/agent-profiles/${profileId}`, {
  method: 'POST',
  headers: {'content-type': 'application/x-www-form-urlencoded'},
  body: new URLSearchParams({
    _csrf: 'csrf', expectedVersion: '1', instructions: 'Keep a concise audit trail.', includeEvidence: 'true', enabled: 'true'
  })
});

it('returns profile updates to the active Agents workspace', async () => {
  const response = await updateAgentProfileCommand(request, profileId, {
    requireSession: vi.fn().mockResolvedValue({
      ok: true,
      session: {actorId: 'operator-1', csrfToken: 'csrf'},
      runtime: {config: {workspaceId: 'workspace-1'}},
      sessionToken: 'session'
    }) as never,
    getRuntime: vi.fn().mockResolvedValue({update: vi.fn().mockResolvedValue('updated')})
  });

  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe('https://app.example/agents');
});

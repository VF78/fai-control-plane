import {expect, it, vi} from 'vitest';

const command = vi.fn();
vi.mock('../../../../src/project-execution-dispatch-command', () => ({projectExecutionDispatchCommand: command}));

it('keeps the manager POST route on the bounded dispatch command', async () => {
  const response = new Response(null, {status: 202});
  command.mockResolvedValue(response);
  const {POST} = await import('./route');
  const request = new Request('https://control.test/api/project-execution/dispatch', {method: 'POST'});
  await expect(POST(request)).resolves.toBe(response);
  expect(command).toHaveBeenCalledWith(request);
});

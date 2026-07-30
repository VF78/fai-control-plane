import {agentRetirementCommand} from '../../../../../src/agent-retirement-command';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: {params: Promise<{id: string}>}
): Promise<Response> {
  const {id} = await context.params;
  return agentRetirementCommand(request, id);
}

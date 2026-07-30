import {updateAgentProfileCommand} from '../../../../src/agent-profile-commands';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: Readonly<{params: Promise<{id: string}>}>
): Promise<Response> {
  return updateAgentProfileCommand(request, (await context.params).id);
}

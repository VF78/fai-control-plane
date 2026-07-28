import {cancelAgentRunCommand} from '../../../../../src/agent-run-cancellation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  {params}: {params: Promise<{id: string}>}
): Promise<Response> {
  return cancelAgentRunCommand(request, (await params).id);
}

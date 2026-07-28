import {acceptAgentRunReceiptCommand} from '../../../../../src/agent-run-receipt-handoff';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  {params}: {params: Promise<{id: string}>}
): Promise<Response> {
  return acceptAgentRunReceiptCommand(request, (await params).id);
}

import {createCodingTaskPacketCommand} from '../../../../../src/coding-task-packet-commands';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  {params}: {params: Promise<{workItemId: string}>}
): Promise<Response> {
  return createCodingTaskPacketCommand(request, (await params).workItemId);
}

import {confirmTaskPacketCommand} from '../../../../../src/task-packet-confirmation-commands';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  {params}: {params: Promise<{id: string}>}
): Promise<Response> {
  return confirmTaskPacketCommand(request, (await params).id);
}

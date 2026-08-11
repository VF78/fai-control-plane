import {governedQaCommand} from '../../../../src/delivery-commands';

export async function POST(request: Request, {params}: {params: Promise<{workItemId: string}>}): Promise<Response> {
  return governedQaCommand(request, (await params).workItemId);
}

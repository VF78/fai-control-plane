import {revokeProjectShareCommand} from '../../../../../src/project-share-commands';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: {params: Promise<{shareId: string}>}
): Promise<Response> {
  const {shareId} = await context.params;
  return revokeProjectShareCommand(request, shareId);
}

import {setDesiredAccessCommand} from '../../../../../src/access-management-commands';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request, context: {params: Promise<{id: string}>}) {
  return setDesiredAccessCommand(request, (await context.params).id);
}

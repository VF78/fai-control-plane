import {setMembershipCommand} from '../../../../../src/access-management-commands';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request, context: {params: Promise<{id: string}>}) {
  return setMembershipCommand(request, (await context.params).id);
}

import {onboardActorCommand} from '../../../../src/access-management-commands';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  return onboardActorCommand(request);
}

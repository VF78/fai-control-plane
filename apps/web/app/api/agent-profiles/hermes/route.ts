import {updateHermesProfileCommand} from '../../../../src/hermes-profile-commands';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return updateHermesProfileCommand(request);
}

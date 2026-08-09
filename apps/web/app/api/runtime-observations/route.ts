import {runtimeObservationCommand} from '../../../src/runtime-observation-command';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return runtimeObservationCommand(request);
}

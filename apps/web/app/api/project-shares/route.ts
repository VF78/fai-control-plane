import {createProjectShareCommand} from '../../../src/project-share-commands';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return createProjectShareCommand(request);
}

import {createProjectCommand} from '../../../src/project-intake-commands';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  return createProjectCommand(request);
}

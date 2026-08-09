import {projectExecutionCommand} from '../../../src/project-execution-commands';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: Request): Promise<Response> {
  return projectExecutionCommand(request);
}

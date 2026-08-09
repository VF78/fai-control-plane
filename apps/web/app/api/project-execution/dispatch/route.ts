import {projectExecutionDispatchCommand} from '../../../../src/project-execution-dispatch-command';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: Request): Promise<Response> {
  return projectExecutionDispatchCommand(request);
}

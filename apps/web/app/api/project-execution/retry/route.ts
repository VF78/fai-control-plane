import {agentRunRetryContinuationCommand} from '../../../../src/agent-run-retry-continuation-command';

export async function POST(request: Request): Promise<Response> {
  return agentRunRetryContinuationCommand(request);
}

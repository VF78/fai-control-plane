import {projectOutcomeAcceptanceCommand} from '../../../../src/project-outcome-acceptance-command';

export async function POST(request: Request): Promise<Response> {
  return projectOutcomeAcceptanceCommand(request);
}

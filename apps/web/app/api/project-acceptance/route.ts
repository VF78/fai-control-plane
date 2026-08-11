import {projectAcceptanceCommand} from '../../../src/project-acceptance-command';

export async function POST(request: Request) {
  return projectAcceptanceCommand(request);
}

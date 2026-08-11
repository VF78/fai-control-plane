import {releaseEvidenceCommand} from '../../../src/release-evidence-command';

export async function POST(request: Request): Promise<Response> {
  return releaseEvidenceCommand(request);
}

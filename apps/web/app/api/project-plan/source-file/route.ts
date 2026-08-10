import {projectSourceFileCommand} from '../../../../src/project-source-file-commands';
export const dynamic = 'force-dynamic'; export const runtime = 'nodejs';
export async function POST(request: Request): Promise<Response> { return projectSourceFileCommand(request); }

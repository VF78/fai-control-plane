import {projectPlanCommand} from '../../../src/project-plan-commands';
export const dynamic = 'force-dynamic'; export const runtime = 'nodejs';
export async function POST(request: Request): Promise<Response> { return projectPlanCommand(request); }

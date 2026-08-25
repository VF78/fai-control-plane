import {projectAgentProfile} from '../../../../../src/mvp/api.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = (
  request: Request,
  {params}: Readonly<{params: Promise<{projectId: string}>}>
) => params.then(({projectId}) => projectAgentProfile(request, projectId));

export const POST = GET;

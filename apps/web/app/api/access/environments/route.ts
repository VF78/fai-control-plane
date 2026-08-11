import {environmentAccessCommand} from '../../../../src/environment-access-commands';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = (request: Request) => environmentAccessCommand(request);

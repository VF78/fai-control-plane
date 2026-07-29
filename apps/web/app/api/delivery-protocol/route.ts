import {deliveryProtocolCommand} from '../../../src/delivery-commands';
export const dynamic = 'force-dynamic'; export const runtime = 'nodejs';
export async function POST(request: Request): Promise<Response> { return deliveryProtocolCommand(request); }

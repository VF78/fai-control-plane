import {deliveryJourneyCommand} from '../../../../src/delivery-commands';
export const dynamic = 'force-dynamic'; export const runtime = 'nodejs';
export async function POST(request: Request, {params}: {params: Promise<{workItemId: string}>}): Promise<Response> { return deliveryJourneyCommand(request, (await params).workItemId); }

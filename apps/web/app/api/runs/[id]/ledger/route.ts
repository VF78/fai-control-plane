import {appendRunLedgerCommand} from '../../../../../src/cost-value-ledger-commands';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: {params: Promise<{id: string}>}
): Promise<Response> {
  const {id} = await context.params;
  return appendRunLedgerCommand(request, id);
}

import {mutateInstructionVersionCommand} from '../../../../src/instruction-management-commands';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  return mutateInstructionVersionCommand(request);
}

import {setConversationChannelCommand} from '../../../../src/conversation-management-commands';

export async function POST(request: Request): Promise<Response> {
  return setConversationChannelCommand(request);
}

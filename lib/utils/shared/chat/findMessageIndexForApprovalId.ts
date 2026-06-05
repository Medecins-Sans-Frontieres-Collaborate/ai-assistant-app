import { Conversation } from '@/types/chat';

import { entryToDisplayMessage } from './messageVersioning';

/**
 * Returns the index of the assistant message whose `consentRequests`
 * includes an approval prompt with this id, or null.
 */
export function findMessageIndexForApprovalId(
  conv: Conversation,
  approvalRequestId: string,
): number | null {
  if (!approvalRequestId) return null;

  for (let i = 0; i < conv.messages.length; i++) {
    const display = entryToDisplayMessage(conv.messages[i]);
    const requests = display.consentRequests;
    if (!requests || requests.length === 0) continue;
    for (const req of requests) {
      if (
        req.kind === 'approval' &&
        req.approval_request_id === approvalRequestId
      ) {
        return i;
      }
    }
  }
  return null;
}

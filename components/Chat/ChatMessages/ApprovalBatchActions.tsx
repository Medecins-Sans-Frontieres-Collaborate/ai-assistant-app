'use client';

import { IconChecks, IconX } from '@tabler/icons-react';
import { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import { isAlwaysConfirmTool } from '@/lib/utils/shared/chat/toolApprovalRules';

import type { ConsentRequest } from '@/types/chat';

import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';

interface ApprovalBatchActionsProps {
  requests: ConsentRequest[];
  /** Index of the assistant message that emitted these requests. */
  messageIndex?: number;
  /** Persisted outcomes from message metadata; decided ids are excluded. */
  approvalOutcomes?: Record<string, boolean>;
}

/**
 * One-click "Approve all" / "Deny all" for a native-MCP consent round that
 * paused on several tool calls at once. Renders only while TWO OR MORE
 * native approvals (server_id present) on the message are still undecided —
 * once a single request remains, its own card is the batch.
 *
 * Decisions are submitted sequentially through `submitApproval`, whose batch
 * gate records interim decisions without resuming; the last undecided
 * approval dispatches the whole batch in one resume. Foundry approvals (no
 * server_id) are excluded — they dispatch per-approval against server-side
 * thread state and don't batch.
 *
 * Always-confirm M365 write tools may participate: "Approve all" is an
 * explicit click on a visible batch and only emits once-approvals — it never
 * writes setAutoApprove or approval rules, so no auto-approve preference can
 * be created for them here.
 */
export const ApprovalBatchActions: FC<ApprovalBatchActionsProps> = ({
  requests,
  messageIndex,
  approvalOutcomes,
}) => {
  const t = useTranslations('chat.consent');
  const submittedApprovals = useChatStore((s) => s.submittedApprovals);
  const submittingApprovals = useChatStore((s) => s.submittingApprovals);
  const submitApproval = useChatStore((s) => s.submitApproval);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const selectedConversation = useConversationStore((s) =>
    s.selectedConversationId
      ? (s.conversations.find((c) => c.id === s.selectedConversationId) ?? null)
      : null,
  );
  const [batchRunning, setBatchRunning] = useState(false);

  const undecided = requests.filter(
    (r) =>
      r.kind === 'approval' &&
      !!r.approval_request_id &&
      !!r.server_id &&
      !submittedApprovals.has(r.approval_request_id) &&
      !submittingApprovals.has(r.approval_request_id) &&
      !(approvalOutcomes && r.approval_request_id in approvalOutcomes),
  );

  if (undecided.length < 2) return null;

  const disabled = isStreaming || batchRunning || !selectedConversation;

  // alwaysConfirm writes (M365 mail/calendar/tasks) are excluded from
  // batch APPROVAL — each needs its own card decision (and may carry
  // per-item edits the batch path can't see). Deny-all still covers them.
  const batchApprovable = undecided.filter(
    (req) => !isAlwaysConfirmTool(req.server_id, req.tool_name),
  );

  const decideAll = async (approve: boolean) => {
    if (disabled || !selectedConversation) return;
    setBatchRunning(true);
    try {
      for (const req of approve ? batchApprovable : undecided) {
        await submitApproval(
          req.approval_request_id!,
          approve,
          selectedConversation,
          messageIndex,
          'manual',
        );
      }
    } finally {
      setBatchRunning(false);
    }
  };

  return (
    <div className="my-2 flex flex-wrap items-center gap-2 border-l-2 border-blue-400/70 py-1.5 pl-3 not-prose dark:border-blue-500/60">
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {t('batchPendingHint', { count: undecided.length })}
      </span>
      {batchApprovable.length > 0 && (
        <button
          type="button"
          onClick={() => void decideAll(true)}
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600"
        >
          <IconChecks size={14} aria-hidden="true" />
          {t('approveAllButton')}
        </button>
      )}
      <button
        type="button"
        onClick={() => void decideAll(false)}
        disabled={disabled}
        className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
      >
        <IconX size={14} aria-hidden="true" />
        {t('denyAllButton')}
      </button>
    </div>
  );
};

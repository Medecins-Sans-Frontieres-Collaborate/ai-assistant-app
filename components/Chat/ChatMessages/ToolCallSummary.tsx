'use client';

import {
  IconAlertCircle,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconShieldCheck,
  IconTool,
} from '@tabler/icons-react';
import { FC, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { M365_BUILTIN_SERVER_ID } from '@/lib/services/m365/tools/toolCatalog';

import { formatToolArguments } from '@/lib/utils/shared/chat/formatToolArguments';
import { highlightJsonTokens } from '@/lib/utils/shared/jsonHighlight';

import type { ToolCallRecord } from '@/types/chat';

import { useConversationStore } from '@/client/stores/conversationStore';

/** The tier-1 withheld sentinel (mailReadTools renders it verbatim). */
const MAIL_WITHHELD_SENTINEL = 'WITHHELD: flagged by the phishing screen';

/**
 * The override affordance only works where a single message id is
 * recoverable from the call arguments (mail_get_message /
 * mail_create_reply_draft targets). Thread/search flags surface as text;
 * the model can be asked to fetch the specific message, whose record then
 * carries the affordance.
 */
function flaggedMailMessageId(call: ToolCallRecord): string | null {
  if (call.server_id !== M365_BUILTIN_SERVER_ID) return null;
  if (!call.name.startsWith('mail_')) return null;
  const haystack = `${call.output ?? ''}\n${call.error ?? ''}`;
  if (
    !haystack.includes(MAIL_WITHHELD_SENTINEL) &&
    !haystack.includes('flagged by the phishing screen')
  ) {
    return null;
  }
  try {
    const args = JSON.parse(call.arguments ?? '{}') as Record<string, unknown>;
    const id = args.messageId;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

interface ToolCallSummaryProps {
  toolCalls: ToolCallRecord[];
  /**
   * Approval source map keyed by approval_request_id. Used to label calls
   * as "auto-approved" when the user never had to click — without this we
   * couldn't distinguish a manual click from a silent auto-approve match.
   */
  approvalSources?: Record<string, 'manual' | 'auto-approved' | 'auto-denied'>;
}

/**
 * Retrospective summary of MCP tool calls that ran while generating an
 * assistant message. Renders below the markdown body as a collapsed strip
 * ("Used 3 tools") and expands to a per-call list with status, duration,
 * arguments, and any output or error.
 */
export const ToolCallSummary: FC<ToolCallSummaryProps> = ({
  toolCalls,
  approvalSources,
}) => {
  const t = useTranslations('chat.toolSummary');
  const failureCount = toolCalls.filter((c) => c.status === 'failed').length;
  // Auto-expand when something failed so the error rows are visible
  // without an extra click.
  const [expanded, setExpanded] = useState(failureCount > 0);

  if (toolCalls.length === 0) return null;

  return (
    <div className="my-3 max-w-prose not-prose">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-300 dark:hover:bg-gray-800"
        aria-expanded={expanded}
      >
        {expanded ? (
          <IconChevronDown size={12} aria-hidden="true" />
        ) : (
          <IconChevronRight size={12} aria-hidden="true" />
        )}
        <IconTool size={12} aria-hidden="true" />
        <span>
          {t('usedTools', { count: toolCalls.length })}
          {failureCount > 0 && (
            <span className="ml-1 text-red-600 dark:text-red-400">
              · {t('failedCount', { count: failureCount })}
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <ul className="mt-2 space-y-1.5 border-l-2 border-gray-200 pl-3 dark:border-gray-700">
          {toolCalls.map((call) => (
            <ToolCallRow
              key={call.id}
              call={call}
              source={
                call.approval_request_id
                  ? approvalSources?.[call.approval_request_id]
                  : undefined
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
};

interface ToolCallRowProps {
  call: ToolCallRecord;
  source?: 'manual' | 'auto-approved' | 'auto-denied';
}

const ToolCallRow: FC<ToolCallRowProps> = ({ call, source }) => {
  const t = useTranslations('chat.toolSummary');
  const failed = call.status === 'failed';
  // Code-interpreter records carry Python source in arguments ({ code })
  // and generated files. Render the code as code (not highlighted JSON)
  // and always show generated files — they're the deliverable, so they
  // must be visible without expanding the row.
  const isCodeInterpreter = call.name === 'code_interpreter';
  // Failed rows open by default so the error text shows without a click.
  // Code-interpreter rows too: the executed code is the transparency
  // record for any calculation, so expanding the strip must reveal it
  // without a second click per row.
  const [detailsOpen, setDetailsOpen] = useState(failed || isCodeInterpreter);
  const incomplete = call.status === 'incomplete';
  const succeeded = call.status === 'completed';

  const StatusIcon = failed
    ? IconAlertCircle
    : source === 'auto-approved'
      ? IconShieldCheck
      : IconCheck;
  const statusClass = failed
    ? 'text-red-600 dark:text-red-400'
    : succeeded
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-gray-500 dark:text-gray-400';

  const statusLabel = failed
    ? t('statusFailed')
    : incomplete
      ? t('statusIncomplete')
      : source === 'auto-approved'
        ? t('statusAutoApproved')
        : source === 'auto-denied'
          ? t('statusAutoDenied')
          : t('statusApproved');

  const interpreterCode = isCodeInterpreter
    ? parseInterpreterCode(call.arguments)
    : null;

  const prettyArgs = isCodeInterpreter
    ? null
    : formatToolArguments(call.arguments);

  const hasDetails =
    !!prettyArgs || !!interpreterCode || !!call.output || !!call.error;

  return (
    <li className="text-xs">
      <button
        type="button"
        onClick={() => hasDetails && setDetailsOpen((v) => !v)}
        disabled={!hasDetails}
        className="flex w-full items-center gap-2 rounded text-left text-gray-700 transition-colors dark:text-gray-300 disabled:cursor-default"
      >
        <StatusIcon
          size={12}
          className={`shrink-0 ${statusClass}`}
          aria-hidden="true"
        />
        <code className="font-mono text-amber-700 dark:text-amber-300">
          {call.name}
        </code>
        {call.server_label && (
          <span className="text-gray-500 dark:text-gray-400">
            {t('viaService', { service: call.server_label })}
          </span>
        )}
        <span className={`ml-auto pl-2 ${statusClass}`}>{statusLabel}</span>
        {typeof call.duration_ms === 'number' && (
          <span className="text-gray-400 dark:text-gray-500">
            · {formatDuration(call.duration_ms)}
          </span>
        )}
      </button>

      {detailsOpen && (
        <div className="mt-1 space-y-1 pl-5">
          {prettyArgs && (
            <pre className="max-h-32 max-w-full overflow-auto rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[0.7rem] leading-snug text-gray-700 dark:border-gray-700/60 dark:bg-gray-900/60 dark:text-gray-300">
              <code className="font-mono">
                {highlightJsonTokens(prettyArgs)}
              </code>
            </pre>
          )}
          {interpreterCode && (
            <div>
              <div className="mb-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {t('executedCode')}
              </div>
              <pre className="max-h-64 max-w-full overflow-auto rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[0.7rem] leading-snug text-gray-700 dark:border-gray-700/60 dark:bg-gray-900/60 dark:text-gray-300">
                <code className="font-mono">{interpreterCode}</code>
              </pre>
            </div>
          )}
          {call.output && (
            <div>
              {isCodeInterpreter && (
                <div className="mb-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  {t('codeOutput')}
                </div>
              )}
              <pre className="max-h-32 max-w-full overflow-auto rounded border border-emerald-200/60 bg-emerald-50 px-2 py-1 text-[0.7rem] leading-snug text-emerald-900 dark:border-emerald-700/40 dark:bg-emerald-900/15 dark:text-emerald-100">
                {call.output}
              </pre>
            </div>
          )}
          {call.error && (
            <pre className="max-h-32 max-w-full overflow-auto rounded border border-red-200/60 bg-red-50 px-2 py-1 text-[0.7rem] leading-snug text-red-900 dark:border-red-700/40 dark:bg-red-900/15 dark:text-red-100">
              {call.error}
            </pre>
          )}
          <FlaggedMailOverride call={call} />
        </div>
      )}

      {/* Generated files intentionally do NOT render here — they are the
          run's deliverable and render prominently on the message itself
          via GeneratedFilesPanel. */}
    </li>
  );
};

/**
 * Explicit, user-only override for a phishing-flagged mail body (fifth
 * pass): persists the message id on the conversation, from where it rides
 * every subsequent request payload — the executor honors ONLY that field,
 * so an injected email can never self-unlock.
 */
const FlaggedMailOverride: FC<{ call: ToolCallRecord }> = ({ call }) => {
  const t = useTranslations('chat.toolSummary');
  const selectedConversationId = useConversationStore(
    (s) => s.selectedConversationId,
  );
  const conversation = useConversationStore((s) =>
    s.conversations.find((c) => c.id === selectedConversationId),
  );
  const updateConversation = useConversationStore((s) => s.updateConversation);

  const messageId = flaggedMailMessageId(call);
  if (!messageId || !conversation) return null;

  const overridden =
    conversation.m365MailScreenOverrides?.includes(messageId) ?? false;

  if (overridden) {
    return (
      <p className="text-[0.7rem] text-amber-700 dark:text-amber-400">
        {t('mailFlagOverridden')}
      </p>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        updateConversation(conversation.id, {
          m365MailScreenOverrides: [
            ...(conversation.m365MailScreenOverrides ?? []),
            messageId,
          ].slice(0, 20),
        });
        toast(t('mailFlagOverrideToast'), { duration: 6000 });
      }}
      className="rounded-md border border-amber-300 px-2 py-0.5 text-[0.7rem] text-amber-800 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/20"
    >
      {t('mailFlagShowAnyway')}
    </button>
  );
};

/** Extracts the Python source from a code-interpreter record's arguments. */
function parseInterpreterCode(args: string | null): string | null {
  if (!args) return null;
  try {
    const parsed = JSON.parse(args) as { code?: unknown };
    return typeof parsed.code === 'string' && parsed.code ? parsed.code : null;
  } catch {
    return null;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

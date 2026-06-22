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

import { useTranslations } from 'next-intl';

import { formatToolArguments } from '@/lib/utils/shared/chat/formatToolArguments';
import { highlightJsonTokens } from '@/lib/utils/shared/jsonHighlight';

import type { ToolCallRecord } from '@/types/chat';

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
  // Failed rows open by default so the error text shows without a click.
  const [detailsOpen, setDetailsOpen] = useState(failed);
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

  const prettyArgs = formatToolArguments(call.arguments);

  const hasDetails = !!prettyArgs || !!call.output || !!call.error;

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
          {call.output && (
            <pre className="max-h-32 max-w-full overflow-auto rounded border border-emerald-200/60 bg-emerald-50 px-2 py-1 text-[0.7rem] leading-snug text-emerald-900 dark:border-emerald-700/40 dark:bg-emerald-900/15 dark:text-emerald-100">
              {call.output}
            </pre>
          )}
          {call.error && (
            <pre className="max-h-32 max-w-full overflow-auto rounded border border-red-200/60 bg-red-50 px-2 py-1 text-[0.7rem] leading-snug text-red-900 dark:border-red-700/40 dark:bg-red-900/15 dark:text-red-100">
              {call.error}
            </pre>
          )}
        </div>
      )}
    </li>
  );
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

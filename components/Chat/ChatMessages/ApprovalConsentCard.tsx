'use client';

import {
  IconCheck,
  IconChevronDown,
  IconLoader2,
  IconShieldCheck,
  IconX,
} from '@tabler/icons-react';
import { FC, useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { highlightJsonTokens } from '@/lib/utils/shared/jsonHighlight';
import { usePlatformModifier } from '@/lib/utils/shared/platform';

import type { ConsentRequest } from './ConsentCard';

import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';

interface ApprovalConsentCardProps {
  request: ConsentRequest & { kind: 'approval' };
  /** Index of the assistant message that emitted this request. */
  messageIndex?: number;
  /** Pre-recorded outcome from message metadata; survives reload. */
  persistedOutcome?: boolean;
}

/**
 * Consent card for MCP tool-approval prompts. Renders the function call,
 * approve/deny buttons (with a dropdown for "always" preferences), and a
 * keyboard shortcut. State is sourced from chatStore (in-memory) layered
 * on top of `persistedOutcome` (read from the source message metadata).
 *
 * Multiple simultaneous idle approval cards each register their own window
 * keydown listener — `Cmd/Ctrl-Enter` and `Esc` will fire on each. The
 * hint copy is intentionally non-singular ("approve · deny") so this
 * "approve all visible" behavior matches what the UI promises.
 */
export const ApprovalConsentCard: FC<ApprovalConsentCardProps> = ({
  request,
  messageIndex,
  persistedOutcome,
}) => {
  const t = useTranslations('chat.consent');
  const serverLabel = request.server_label?.trim() || null;
  const toolName = request.tool_name?.trim() || null;

  const submittedApprovals = useChatStore((s) => s.submittedApprovals);
  const submittingApprovals = useChatStore((s) => s.submittingApprovals);
  const failedApprovals = useChatStore((s) => s.failedApprovals);
  const submitApproval = useChatStore((s) => s.submitApproval);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const selectedConversation = useConversationStore((s) =>
    s.selectedConversationId
      ? (s.conversations.find((c) => c.id === s.selectedConversationId) ?? null)
      : null,
  );

  const modifierLabel = usePlatformModifier();

  const approvalId = request.approval_request_id;
  const inMemoryDecision =
    approvalId && submittedApprovals.has(approvalId)
      ? submittedApprovals.get(approvalId)
      : undefined;
  const resolvedDecision =
    inMemoryDecision !== undefined ? inMemoryDecision : persistedOutcome;
  const approvalState: 'idle' | 'submitting' | 'approved' | 'denied' =
    approvalId && submittingApprovals.has(approvalId)
      ? 'submitting'
      : resolvedDecision === true
        ? 'approved'
        : resolvedDecision === false
          ? 'denied'
          : 'idle';

  const handleApprovalClick = (approve: boolean) => {
    if (!approvalId || !selectedConversation) return;
    if (approvalState !== 'idle') return;
    void submitApproval(
      approvalId,
      approve,
      selectedConversation,
      messageIndex,
    );
  };

  // Approve dropdown ("once" / "this tool" / "all tools"). The menu uses
  // position: fixed (not absolute) because the chat scroll container has
  // overflow:hidden ancestors that would otherwise clip the popup.
  const [menuOpen, setMenuOpen] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(
    null,
  );
  const openMenu = () => {
    const rect = splitRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenuPos({ top: rect.bottom + 4, left: rect.left });
    setMenuOpen(true);
  };
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        splitRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
      setMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const onScroll = () => setMenuOpen(false);
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [menuOpen]);

  const handleApproveWithScope = (scope: 'once' | 'tool' | 'all') => {
    if (!approvalId || !selectedConversation) return;
    if (scope === 'tool' && toolName) {
      useConversationStore
        .getState()
        .setAutoApprove(selectedConversation.id, 'tool', toolName);
    } else if (scope === 'all') {
      useConversationStore
        .getState()
        .setAutoApprove(selectedConversation.id, 'all');
    }
    setMenuOpen(false);
    if (approvalState === 'idle') {
      void submitApproval(approvalId, true, selectedConversation, messageIndex);
    }
  };

  const autoApproveMatch =
    selectedConversation &&
    (selectedConversation.alwaysApproveAllTools ||
      (toolName &&
        selectedConversation.alwaysApproveTools?.includes(toolName)));
  useEffect(() => {
    if (!autoApproveMatch) return;
    if (approvalState !== 'idle') return;
    if (!approvalId || !selectedConversation) return;
    if (failedApprovals.has(approvalId)) return;
    void submitApproval(approvalId, true, selectedConversation, messageIndex);
  }, [
    autoApproveMatch,
    approvalState,
    approvalId,
    selectedConversation,
    submitApproval,
    messageIndex,
    failedApprovals,
  ]);

  // Keyboard shortcuts: Cmd/Ctrl-Enter approves, Esc denies. Listener
  // mounts only while this card is idle. Skipped when typing in form
  // controls (input/textarea/contentEditable).
  useEffect(() => {
    if (approvalState !== 'idle') return;
    if (!approvalId || !selectedConversation || isStreaming) return;

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void submitApproval(
          approvalId,
          true,
          selectedConversation,
          messageIndex,
        );
      } else if (e.key === 'Escape') {
        e.preventDefault();
        void submitApproval(
          approvalId,
          false,
          selectedConversation,
          messageIndex,
        );
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    approvalState,
    approvalId,
    selectedConversation,
    submitApproval,
    isStreaming,
    messageIndex,
  ]);

  const buttonsDisabled =
    approvalState !== 'idle' || isStreaming || !selectedConversation;

  const prettyArgs = (() => {
    const raw = request.tool_arguments;
    if (!raw || typeof raw !== 'string' || raw.trim() === '') return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || parsed === undefined) return null;
      return JSON.stringify(parsed, null, 2);
    } catch {
      return raw;
    }
  })();

  const titleNode = toolName
    ? t.rich('runToolTitle', {
        tool: toolName,
        code: (chunks) => (
          <code className="rounded bg-gray-200/70 px-1 py-0.5 font-mono text-[0.85em] text-gray-900 dark:bg-gray-800 dark:text-gray-100">
            {chunks}
          </code>
        ),
      })
    : t('runToolGeneric');

  return (
    <div className="my-3 flex max-w-prose items-start gap-2 border-l-2 border-blue-400/70 py-1.5 pl-3 not-prose dark:border-blue-500/60">
      <IconShieldCheck
        size={14}
        className="mt-[3px] shrink-0 text-blue-600 dark:text-blue-400"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug text-gray-900 dark:text-white">
          {titleNode}
          {serverLabel && (
            <span className="ml-1.5 text-xs text-gray-500 dark:text-gray-400">
              {t('viaService', { service: serverLabel })}
            </span>
          )}
        </p>

        {prettyArgs && toolName && (
          <pre className="mt-1.5 max-h-40 max-w-full overflow-auto rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs leading-snug text-gray-700 dark:border-gray-700/60 dark:bg-gray-900/60 dark:text-gray-300">
            <code className="font-mono">
              <span className="text-amber-700 dark:text-amber-300">
                {toolName}
              </span>
              {'('}
              {highlightJsonTokens(prettyArgs)}
              {')'}
            </code>
          </pre>
        )}

        <div className="mt-2" aria-live="polite" aria-atomic="true">
          {approvalState === 'idle' && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex isolate" ref={splitRef}>
                <button
                  type="button"
                  onClick={() => handleApproveWithScope('once')}
                  disabled={buttonsDisabled}
                  className="inline-flex items-center gap-1 rounded-l-md bg-blue-600 px-2.5 py-1 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600"
                >
                  <IconCheck size={14} aria-hidden="true" />
                  {t('approveButton')}
                </button>
                <button
                  type="button"
                  onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
                  disabled={buttonsDisabled}
                  aria-label={t('approveOptionsLabel')}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  className="inline-flex items-center rounded-r-md border-l border-blue-500/40 bg-blue-600 px-1.5 py-1 text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600"
                >
                  <IconChevronDown size={14} aria-hidden="true" />
                </button>
              </div>
              {menuOpen && menuPos && (
                <div
                  ref={menuRef}
                  role="menu"
                  style={{
                    position: 'fixed',
                    top: menuPos.top,
                    left: menuPos.left,
                  }}
                  className="z-50 min-w-[14rem] overflow-hidden rounded-md border border-gray-200 bg-white py-1 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-800"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => handleApproveWithScope('once')}
                    className="flex w-full items-center px-3 py-1.5 text-left text-gray-800 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    {t('approveOnce')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => handleApproveWithScope('tool')}
                    disabled={!toolName}
                    className="flex w-full items-center px-3 py-1.5 text-left text-gray-800 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    {t('alwaysApproveThisTool')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => handleApproveWithScope('all')}
                    className="flex w-full items-center px-3 py-1.5 text-left text-gray-800 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    {t('alwaysApproveAllTools')}
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => handleApprovalClick(false)}
                disabled={buttonsDisabled}
                className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                <IconX size={14} aria-hidden="true" />
                {t('denyButton')}
              </button>
              <span className="text-xs text-gray-400 dark:text-gray-500">
                {t('keyboardHint', { modifier: modifierLabel })}
              </span>
            </div>
          )}

          {approvalState === 'submitting' && (
            <p className="inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-300">
              <IconLoader2
                size={16}
                className="animate-spin"
                aria-hidden="true"
              />
              {t('submittingState')}
            </p>
          )}

          {approvalState === 'approved' && (
            <p className="inline-flex items-center gap-1.5 text-sm text-green-700 dark:text-green-400">
              <IconCheck size={14} aria-hidden="true" />
              {t('approvedState')}
            </p>
          )}

          {approvalState === 'denied' && (
            <p className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
              <IconX size={14} aria-hidden="true" />
              {t('deniedState')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

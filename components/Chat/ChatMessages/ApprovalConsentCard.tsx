'use client';

import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconListCheck,
  IconLoader2,
  IconPaperclip,
  IconShieldCheck,
  IconX,
} from '@tabler/icons-react';
import { useSession } from 'next-auth/react';
import { FC, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { M365_BUILTIN_SERVER_ID } from '@/lib/services/m365/tools/toolCatalog';

import { formatToolArguments } from '@/lib/utils/shared/chat/formatToolArguments';
import {
  evaluateToolApprovalRules,
  isAlwaysConfirmTool,
} from '@/lib/utils/shared/chat/toolApprovalRules';
import { highlightJsonTokens } from '@/lib/utils/shared/jsonHighlight';
import { usePlatformModifier } from '@/lib/utils/shared/platform';

import type { ConsentRequest } from './ConsentCard';

import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';

interface ApprovalConsentCardProps {
  request: ConsentRequest & { kind: 'approval' };
  /** Index of the assistant message that emitted this request. */
  messageIndex?: number;
  /** Pre-recorded outcome from message metadata; survives reload. */
  persistedOutcome?: boolean;
  /**
   * Pre-recorded source from message metadata; tells us whether the
   * approval was a manual click or an auto-approve match. When the
   * source is `'auto-approved'` the card hides itself — those calls
   * appear in the tool usage summary instead.
   */
  persistedSource?: 'manual' | 'auto-approved' | 'auto-denied';
}

/** Recipient/body fields parsed (loosely) from a mail tool's arguments. */
interface MailPayloadArgs {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  replyAll?: boolean;
  fileName?: string;
  draftId?: string;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((v): v is string => typeof v === 'string');
  return list.length > 0 ? list : undefined;
}

/**
 * Parses mail tool arguments for the mail-specific consent view. Returns
 * null on anything unparseable — the card then falls back to the generic
 * JSON rendering rather than showing a partial (and therefore misleading)
 * payload; the card is the security boundary for mail writes.
 */
function parseMailToolArguments(
  raw: string | null | undefined,
): MailPayloadArgs | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    return {
      to: stringArray(record.to),
      cc: stringArray(record.cc),
      bcc: stringArray(record.bcc),
      subject: typeof record.subject === 'string' ? record.subject : undefined,
      body: typeof record.body === 'string' ? record.body : undefined,
      replyAll: record.replyAll === true,
      fileName:
        typeof record.fileName === 'string' ? record.fileName : undefined,
      draftId: typeof record.draftId === 'string' ? record.draftId : undefined,
    };
  } catch {
    return null;
  }
}

function mailDomain(address: string | null | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return null;
  return address.slice(at + 1).toLowerCase();
}

const RecipientGroup: FC<{
  label: string;
  addresses: string[];
  ownDomain: string | null;
  externalLabel: string;
}> = ({ label, addresses, ownDomain, externalLabel }) => (
  <div className="flex flex-wrap items-baseline gap-1">
    <span className="w-7 shrink-0 text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
      {label}
    </span>
    {addresses.map((address, index) => {
      const domain = mailDomain(address);
      // Badge only when BOTH domains are known and differ — an unknown own
      // domain must produce no badges rather than wrong ones.
      const isExternal = !!ownDomain && !!domain && domain !== ownDomain;
      return (
        <span
          key={`${address}-${index}`}
          className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 font-mono text-[11px] text-gray-800 dark:bg-gray-800 dark:text-gray-200"
        >
          {address}
          {isExternal && (
            <span className="rounded-full bg-amber-100 px-1.5 py-px text-[10px] font-semibold uppercase text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">
              {externalLabel}
            </span>
          )}
        </span>
      );
    })}
  </div>
);

/**
 * Mail-specific consent payload (fifth pass): recipients grouped and
 * externally-badged, reply-all called out, and the FULL body rendered in a
 * scrollable block — an elided body would defeat the human gate that the
 * whole mail-write posture depends on.
 */
const MailToolPayload: FC<{ args: MailPayloadArgs }> = ({ args }) => {
  const t = useTranslations('m365.tools.consentCard');
  // Own mail domain from the signed-in session (the same source the rest of
  // the client uses); when it is unavailable the card simply shows no
  // external badges.
  const { data: sessionData } = useSession();
  const ownDomain = mailDomain(sessionData?.user?.mail);

  const groups: { key: string; label: string; addresses: string[] }[] = [
    { key: 'to', label: t('to'), addresses: args.to ?? [] },
    { key: 'cc', label: t('cc'), addresses: args.cc ?? [] },
    { key: 'bcc', label: t('bcc'), addresses: args.bcc ?? [] },
  ].filter((group) => group.addresses.length > 0);

  return (
    <div className="mt-1.5 space-y-1.5 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs dark:border-gray-700/60 dark:bg-gray-900/60">
      {args.replyAll && (
        <p className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-400">
          <IconAlertTriangle
            size={13}
            aria-hidden="true"
            className="shrink-0"
          />
          {t('replyAllCallout')}
        </p>
      )}
      {groups.map((group) => (
        <RecipientGroup
          key={group.key}
          label={group.label}
          addresses={group.addresses}
          ownDomain={ownDomain}
          externalLabel={t('external')}
        />
      ))}
      {args.subject !== undefined && (
        <p className="text-gray-900 dark:text-gray-100">
          <span className="mr-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t('subject')}
          </span>
          {args.subject}
        </p>
      )}
      {args.body !== undefined && (
        // Full body, scrollable — never elided (security boundary).
        <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded border border-gray-200 bg-white px-2 py-1.5 font-sans leading-snug text-gray-700 dark:border-gray-700/60 dark:bg-gray-950/60 dark:text-gray-300">
          {args.body}
        </pre>
      )}
      {args.fileName !== undefined && (
        <p className="flex items-center gap-1.5 text-gray-800 dark:text-gray-200">
          <IconPaperclip size={13} aria-hidden="true" className="shrink-0" />
          {t('fileLine', { name: args.fileName })}
        </p>
      )}
      {args.draftId !== undefined && (
        <p className="font-mono text-[11px] text-gray-500 dark:text-gray-400">
          {t('draftLine', { id: args.draftId })}
        </p>
      )}
    </div>
  );
};

/** Batch payload parsed (loosely) from a `tasks_create` call's arguments. */
interface TasksBatchArgs {
  /** Task titles, in proposal order. */
  tasks: string[];
  listName?: string;
  /** The full parsed object — the base for the rewritten arguments. */
  original: Record<string, unknown>;
}

/**
 * Parses a `tasks_create` batch for the per-item toggle view (sixth pass).
 * Returns null unless EVERY entry is a plain string: a partially understood
 * batch must fall back to the raw JSON rendering, because an item the card
 * can't display is an item the user would approve unseen.
 */
function parseTasksBatchArguments(
  raw: string | null | undefined,
): TasksBatchArgs | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const tasks = record.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) return null;
    if (!tasks.every((task) => typeof task === 'string')) return null;
    return {
      tasks: tasks as string[],
      listName:
        typeof record.listName === 'string' ? record.listName : undefined,
      original: record,
    };
  } catch {
    return null;
  }
}

/**
 * Batch consent payload: one checkbox per proposed task, all checked
 * initially. Unchecked items stay visible but struck through — the card
 * always shows the full proposal AND exactly what approving would create.
 */
const TasksBatchPayload: FC<{
  tasks: string[];
  listName?: string;
  uncheckedIndices: ReadonlySet<number>;
  onToggle: (index: number) => void;
  disabled: boolean;
}> = ({ tasks, listName, uncheckedIndices, onToggle, disabled }) => {
  const t = useTranslations('m365.tools');
  return (
    <div className="mt-1.5 space-y-1.5 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs dark:border-gray-700/60 dark:bg-gray-900/60">
      {listName && (
        <p className="flex items-center gap-1.5 text-gray-700 dark:text-gray-300">
          <IconListCheck size={13} aria-hidden="true" className="shrink-0" />
          <span className="font-medium">
            {t('consentCard.listLine', { name: listName })}
          </span>
        </p>
      )}
      <ul className="space-y-1">
        {tasks.map((task, index) => {
          const checked = !uncheckedIndices.has(index);
          return (
            <li key={`${index}-${task}`}>
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onToggle(index)}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer rounded border-gray-300 text-blue-600 disabled:cursor-not-allowed dark:border-gray-600"
                />
                <span
                  className={
                    checked
                      ? 'text-gray-900 dark:text-gray-100'
                      : 'text-gray-400 line-through dark:text-gray-500'
                  }
                >
                  {task}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-gray-500 dark:text-gray-400">
        {t('batchToggleHint')}
      </p>
    </div>
  );
};

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
  persistedSource,
}) => {
  const t = useTranslations('chat.consent');
  const tM365Tools = useTranslations('m365.tools');
  const serverLabel = request.server_label?.trim() || null;
  const toolName = request.tool_name?.trim() || null;
  // First-party M365 write tools confirm on EVERY call (B3): reject rules
  // still win, but approve rules and per-conversation "always approve"
  // preferences are ignored for them — no auto-approve, no "always" menu.
  const alwaysConfirm = isAlwaysConfirmTool(request.server_id, toolName);

  // Per-item toggles are v1-scoped to first-party `tasks_create`: it is the
  // only HOMOGENEOUS batch write in the catalog. Heterogeneous writes (a
  // draft, an event) stay separate cards — different decisions.
  const batch = useMemo(
    () =>
      request.server_id === M365_BUILTIN_SERVER_ID &&
      toolName === 'tasks_create'
        ? parseTasksBatchArguments(request.tool_arguments)
        : null,
    [request.server_id, request.tool_arguments, toolName],
  );
  const [uncheckedIndices, setUncheckedIndices] = useState<ReadonlySet<number>>(
    () => new Set<number>(),
  );
  const toggleTask = (index: number) =>
    setUncheckedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  const checkedTasks =
    batch?.tasks.filter((_, index) => !uncheckedIndices.has(index)) ?? [];
  const allTasksUnchecked = !!batch && checkedTasks.length === 0;
  // Only rewrite when the user actually removed something: an untouched
  // batch resumes with the model's original argument string, byte for byte.
  const modifiedArgumentsJson =
    batch && checkedTasks.length > 0 && checkedTasks.length < batch.tasks.length
      ? JSON.stringify({ ...batch.original, tasks: checkedTasks })
      : undefined;

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
  const toolApprovalRules = useSettingsStore((s) => s.toolApprovalRules);
  // Global (all-chats) policy for this tool. 'reject' beats every approval
  // source, including the conversation's own alwaysApprove* fields.
  const globalDecision = evaluateToolApprovalRules(
    toolApprovalRules,
    toolName,
    serverLabel,
  );

  const approvalId = request.approval_request_id;
  const inMemoryDecision =
    approvalId && submittedApprovals.has(approvalId)
      ? submittedApprovals.get(approvalId)
      : undefined;
  const resolvedDecision = inMemoryDecision ?? persistedOutcome;
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
      'manual',
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
  // Deny dropdown ("once" / "never, all chats") — same fixed-position
  // mechanics as the approve menu, for the same overflow reasons.
  const [denyMenuOpen, setDenyMenuOpen] = useState(false);
  const denySplitRef = useRef<HTMLDivElement>(null);
  const denyMenuRef = useRef<HTMLDivElement>(null);
  const [denyMenuPos, setDenyMenuPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const openDenyMenu = () => {
    const rect = denySplitRef.current?.getBoundingClientRect();
    if (!rect) return;
    setDenyMenuPos({ top: rect.bottom + 4, left: rect.left });
    setDenyMenuOpen(true);
  };
  useEffect(() => {
    if (!menuOpen && !denyMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        splitRef.current?.contains(target) ||
        menuRef.current?.contains(target) ||
        denySplitRef.current?.contains(target) ||
        denyMenuRef.current?.contains(target)
      ) {
        return;
      }
      setMenuOpen(false);
      setDenyMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        setDenyMenuOpen(false);
      }
    };
    const onScroll = () => {
      setMenuOpen(false);
      setDenyMenuOpen(false);
    };
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
  }, [menuOpen, denyMenuOpen]);

  const handleApproveWithScope = (
    scope: 'once' | 'tool' | 'all' | 'everywhere',
  ) => {
    if (!approvalId || !selectedConversation) return;
    // Always-confirm tools never persist an approval preference. The scope
    // menu is hidden for them, but this guard keeps the invariant even if a
    // non-'once' scope ever reached here.
    const effectiveScope = alwaysConfirm ? 'once' : scope;
    if (effectiveScope === 'tool' && toolName) {
      useConversationStore
        .getState()
        .setAutoApprove(selectedConversation.id, 'tool', toolName);
    } else if (effectiveScope === 'all') {
      useConversationStore
        .getState()
        .setAutoApprove(selectedConversation.id, 'all');
    } else if (effectiveScope === 'everywhere' && toolName) {
      useSettingsStore.getState().addToolApprovalRule({
        toolName,
        serverLabel: serverLabel ?? undefined,
        action: 'approve',
      });
    }
    setMenuOpen(false);
    // An all-unchecked batch would create nothing; the button is disabled,
    // and this guard keeps the menu items honest too.
    if (allTasksUnchecked) return;
    if (approvalState === 'idle') {
      void submitApproval(
        approvalId,
        true,
        selectedConversation,
        messageIndex,
        'manual',
        modifiedArgumentsJson,
      );
    }
  };

  const handleDenyEverywhere = () => {
    if (!approvalId || !selectedConversation || !toolName) return;
    useSettingsStore.getState().addToolApprovalRule({
      toolName,
      serverLabel: serverLabel ?? undefined,
      action: 'reject',
    });
    setDenyMenuOpen(false);
    if (approvalState === 'idle') {
      void submitApproval(
        approvalId,
        false,
        selectedConversation,
        messageIndex,
        'manual',
      );
    }
  };

  const autoApproveMatch =
    // Always-confirm tools are exempt from EVERY approval source — global
    // approve rules and per-conversation auto-approve alike. Reject rules
    // below still auto-deny them (reject wins, unchanged).
    !alwaysConfirm &&
    globalDecision !== 'reject' &&
    (globalDecision === 'approve' ||
      (selectedConversation &&
        (selectedConversation.alwaysApproveAllTools ||
          (toolName &&
            selectedConversation.alwaysApproveTools?.includes(toolName)))));
  const autoRejectMatch = globalDecision === 'reject';
  useEffect(() => {
    if (!autoApproveMatch && !autoRejectMatch) return;
    if (approvalState !== 'idle') return;
    if (!approvalId || !selectedConversation) return;
    if (failedApprovals.has(approvalId)) return;
    // Wait for the original stream to settle — submitApproval starts its
    // own stream and would clobber the live one.
    if (isStreaming) return;
    void submitApproval(
      approvalId,
      // Reject rules win: an explicit "never run this" is a safety decision.
      !autoRejectMatch,
      selectedConversation,
      messageIndex,
      autoRejectMatch ? 'auto-denied' : 'auto-approved',
    );
  }, [
    autoApproveMatch,
    autoRejectMatch,
    approvalState,
    approvalId,
    selectedConversation,
    submitApproval,
    messageIndex,
    failedApprovals,
    isStreaming,
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
        if (allTasksUnchecked) return;
        e.preventDefault();
        void submitApproval(
          approvalId,
          true,
          selectedConversation,
          messageIndex,
          undefined,
          modifiedArgumentsJson,
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
    allTasksUnchecked,
    modifiedArgumentsJson,
  ]);

  const buttonsDisabled =
    approvalState !== 'idle' || isStreaming || !selectedConversation;
  // Approve only: an empty batch has nothing to create, but DENY must stay
  // available — unchecking everything is not a way to cancel the request.
  const approveDisabled = buttonsDisabled || allTasksUnchecked;

  // Suppress display when the approval was resolved via auto-approve — the
  // tool usage summary below the message surfaces these instead. Hides both
  // the live flash during streaming AND historical cards in reloaded
  // conversations (where `persistedSource === 'auto-approved'`). Placed
  // after all hooks so hook order stays stable across renders.
  const isAutoApproved =
    persistedSource === 'auto-approved' ||
    (autoApproveMatch && approvalState !== 'denied');
  if (isAutoApproved) return null;

  const prettyArgs = formatToolArguments(request.tool_arguments);
  // Mail writes get a dedicated payload view (recipients, external badges,
  // full body) instead of raw JSON; unparseable arguments fall back to the
  // generic rendering below so nothing is ever silently hidden.
  const mailArgs =
    request.server_id === M365_BUILTIN_SERVER_ID &&
    !!toolName?.startsWith('mail_')
      ? parseMailToolArguments(request.tool_arguments)
      : null;

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

        {mailArgs && toolName ? (
          <MailToolPayload args={mailArgs} />
        ) : batch && toolName ? (
          <TasksBatchPayload
            tasks={batch.tasks}
            listName={batch.listName}
            uncheckedIndices={uncheckedIndices}
            onToggle={toggleTask}
            disabled={buttonsDisabled}
          />
        ) : (
          prettyArgs &&
          toolName && (
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
          )
        )}

        <div className="mt-2" aria-live="polite" aria-atomic="true">
          {approvalState === 'idle' && alwaysConfirm && (
            <p className="mb-1.5 text-xs text-gray-500 dark:text-gray-400">
              {tM365Tools('alwaysConfirmNote')}
            </p>
          )}
          {approvalState === 'idle' && allTasksUnchecked && (
            <p className="mb-1.5 text-xs text-amber-700 dark:text-amber-400">
              {tM365Tools('batchAllUnchecked')}
            </p>
          )}
          {approvalState === 'idle' && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex isolate" ref={splitRef}>
                <button
                  type="button"
                  onClick={() => handleApproveWithScope('once')}
                  disabled={approveDisabled}
                  className={`inline-flex items-center gap-1 ${
                    alwaysConfirm ? 'rounded-md' : 'rounded-l-md'
                  } bg-blue-600 px-2.5 py-1 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600`}
                >
                  <IconCheck size={14} aria-hidden="true" />
                  {t('approveButton')}
                </button>
                {/* Always-confirm tools get no scope menu: 'once' is the
                    only approval they can ever receive. */}
                {!alwaysConfirm && (
                  <button
                    type="button"
                    onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
                    disabled={approveDisabled}
                    aria-label={t('approveOptionsLabel')}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    className="inline-flex items-center rounded-r-md border-l border-blue-500/40 bg-blue-600 px-1.5 py-1 text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600"
                  >
                    <IconChevronDown size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
              {!alwaysConfirm && menuOpen && menuPos && (
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
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => handleApproveWithScope('everywhere')}
                    disabled={!toolName}
                    className="flex w-full items-center border-t border-gray-100 px-3 py-1.5 text-left text-gray-800 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    {t('alwaysApproveEverywhere')}
                  </button>
                </div>
              )}
              <div className="inline-flex isolate" ref={denySplitRef}>
                <button
                  type="button"
                  onClick={() => handleApprovalClick(false)}
                  disabled={buttonsDisabled}
                  className="inline-flex items-center gap-1 rounded-l-md border border-gray-300 bg-white px-2.5 py-1 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                  <IconX size={14} aria-hidden="true" />
                  {t('denyButton')}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    denyMenuOpen ? setDenyMenuOpen(false) : openDenyMenu()
                  }
                  disabled={buttonsDisabled}
                  aria-label={t('denyOptionsLabel')}
                  aria-haspopup="menu"
                  aria-expanded={denyMenuOpen}
                  className="inline-flex items-center rounded-r-md border border-l-0 border-gray-300 bg-white px-1.5 py-1 text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                  <IconChevronDown size={14} aria-hidden="true" />
                </button>
              </div>
              {denyMenuOpen && denyMenuPos && (
                <div
                  ref={denyMenuRef}
                  role="menu"
                  style={{
                    position: 'fixed',
                    top: denyMenuPos.top,
                    left: denyMenuPos.left,
                  }}
                  className="z-50 min-w-[14rem] overflow-hidden rounded-md border border-gray-200 bg-white py-1 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-800"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setDenyMenuOpen(false);
                      handleApprovalClick(false);
                    }}
                    className="flex w-full items-center px-3 py-1.5 text-left text-gray-800 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    {t('denyOnce')}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={handleDenyEverywhere}
                    disabled={!toolName}
                    className="flex w-full items-center px-3 py-1.5 text-left text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-900/20"
                  >
                    {t('neverAllowEverywhere')}
                  </button>
                </div>
              )}
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
              {autoRejectMatch && (
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  {t('deniedByRuleHint')}
                </span>
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

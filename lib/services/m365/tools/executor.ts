/**
 * In-process executor for the builtin Microsoft 365 toolset (fourth pass
 * B1/B2). The tool loop dispatches `builtin`-provenance servers here instead
 * of opening an MCP connection; everything else in the loop (naming,
 * consent, plan tracking, rounds, usage) is provider-agnostic.
 *
 * Auth: a delegated Graph token is minted per call with the tool's minimum
 * scope set (`getGraphAccessToken` via graphApi) — never persisted, never
 * client-relayed. Listing is consent-filtered: each distinct scope is
 * probed once per user (cached ~15 min) and tools missing any granted
 * scope are omitted, so the model never sees tools that can only fail.
 *
 * Failure posture: `callTool` NEVER throws — every failure returns an
 * isError result that becomes a TOOL_CALL_RECORD; Graph throttling (429)
 * maps to a retry-later message, never to a streamError.
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import {
  calendarCreateEvent,
  calendarGetSchedule,
  calendarListEvents,
} from '@/lib/services/m365/tools/calendarTools';
import {
  mailAwaitingMyReply,
  mailAwaitingTheirReply,
  mailCommitments,
  mailDeepSearch,
  mailDigest,
  mailThreadBrief,
} from '@/lib/services/m365/tools/mailCompositeTools';
import {
  mailAddDraftAttachment,
  mailCreateDraft,
  mailCreateReplyDraft,
  mailUpdateDraft,
} from '@/lib/services/m365/tools/mailDraftTools';
import {
  mailGetMessage,
  mailGetThread,
  mailSearch,
} from '@/lib/services/m365/tools/mailReadTools';
import {
  personLookup,
  personResolve,
} from '@/lib/services/m365/tools/peopleTools';
import { probeGrantedScopes } from '@/lib/services/m365/tools/scopeProbe';
import {
  M365ToolInputError,
  asRecord,
  truncateText,
} from '@/lib/services/m365/tools/shared';
import { tasksCreate, tasksList } from '@/lib/services/m365/tools/tasksTools';
import {
  channelMessages,
  channelsList,
  chatsSearch,
  teamsList,
} from '@/lib/services/m365/tools/teamsTools';
import {
  M365ToolSpec,
  M365_TOOLSET_INSTRUCTIONS,
  M365_TOOL_SPECS,
} from '@/lib/services/m365/tools/toolCatalog';

export interface M365ToolDefinitionLike {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * A policy/user-facing refusal whose message is already complete prose —
 * mapped VERBATIM into the tool result (no "request failed" prefix, no
 * 160-char clip), so flag reasons and configuration hints survive intact.
 */
export class M365ToolUserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'M365ToolUserFacingError';
  }
}

export interface M365ToolCallResult {
  /** Rendered result text (the tool loop truncates and records it). */
  resultText: string;
  isError: boolean;
}

export interface M365BuiltinExecutor {
  /** Consent-filtered tool listing (probe cached per user). */
  listTools(): Promise<M365ToolDefinitionLike[]>;
  /** Executes one tool. Never throws; failures are isError results. */
  callTool(
    toolName: string,
    args: unknown,
    callContext?: { emitActivity?: (detail: string) => void },
  ): Promise<M365ToolCallResult>;
  /** Connector-instructions text for the system addendum. */
  readonly instructions: string;
}

export interface CreateM365ToolExecutorOptions {
  /**
   * Per-key daily budget hook — receives the tool's budgetKey (or the
   * generic feature.m365.toolCallsPerDay); false means the limit is
   * exhausted and the call returns a friendly isError result.
   */
  consumeBudget?: (limitKey: string) => Promise<boolean>;
  /** Mail-screen override ids from the request payload (explicit UI action). */
  screenOverrideIds?: string[];
  /** Shared mailbox addresses the user configured (fifth pass tier 3). */
  sharedMailboxes?: string[];
}

/** Per-call context threaded to tool implementations. */
export interface M365ToolExecutionContext {
  /** Streams an AGENT_ACTIVITY progress line ("scanning 214 messages…"). */
  emitActivity?: (detail: string) => void;
  screenOverrideIds: ReadonlySet<string>;
  sharedMailboxes: readonly string[];
}

export function specByName(name: string): M365ToolSpec | undefined {
  return M365_TOOL_SPECS.find((spec) => spec.name === name);
}

type ToolImplementation = (
  req: NextRequest,
  session: Session,
  args: Record<string, unknown>,
  ctx: M365ToolExecutionContext,
) => Promise<string>;

const TOOL_IMPLEMENTATIONS: Record<string, ToolImplementation> = {
  calendar_list_events: calendarListEvents,
  calendar_get_schedule: calendarGetSchedule,
  calendar_create_event: calendarCreateEvent,
  person_resolve: personResolve,
  person_lookup: personLookup,
  tasks_list: tasksList,
  tasks_create: tasksCreate,
  chats_search: chatsSearch,
  teams_list: teamsList,
  channels_list: channelsList,
  channel_messages: channelMessages,
  mail_search: mailSearch,
  mail_get_message: mailGetMessage,
  mail_get_thread: mailGetThread,
  mail_create_draft: mailCreateDraft,
  mail_create_reply_draft: mailCreateReplyDraft,
  mail_update_draft: mailUpdateDraft,
  mail_add_draft_attachment: mailAddDraftAttachment,
  mail_deep_search: mailDeepSearch,
  mail_awaiting_my_reply: mailAwaitingMyReply,
  mail_awaiting_their_reply: mailAwaitingTheirReply,
  mail_digest: mailDigest,
  mail_thread_brief: mailThreadBrief,
  mail_commitments: mailCommitments,
};

const BUDGET_MESSAGE =
  'Daily Microsoft 365 tool limit reached — try again tomorrow.';
const THROTTLE_MESSAGE =
  'Microsoft 365 is throttling requests — try again in a minute.';

/**
 * Pre-dispatch shape check straight off the catalog inputSchema: required
 * keys present, declared primitive/array types sane. Tool implementations
 * do the semantic validation (date formats, email shapes) themselves.
 */
function validateArgsAgainstSpec(
  spec: M365ToolSpec,
  args: Record<string, unknown>,
): string | null {
  const required = (spec.inputSchema.required as string[] | undefined) ?? [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) {
      return `Missing required argument: ${key}`;
    }
  }
  const properties =
    (spec.inputSchema.properties as
      | Record<string, { type?: string }>
      | undefined) ?? {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const expected = properties[key]?.type;
    if (!expected) continue;
    const valid =
      expected === 'array'
        ? Array.isArray(value)
        : expected === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === expected;
    if (!valid) {
      return `Argument ${key} must be a ${expected}`;
    }
  }
  return null;
}

/**
 * Maps any thrown failure to concise user-readable text. M365Error is
 * detected structurally (name + kind) — a static graphApi import here would
 * drag next-auth into every consumer of the executor module graph.
 */
function mapFailureToText(error: unknown): string {
  if (error instanceof M365ToolInputError) {
    return `Invalid arguments: ${error.message}`;
  }
  if (error instanceof M365ToolUserFacingError) {
    return truncateText(error.message, 600);
  }
  const err = error as { name?: string; kind?: string; message?: string };
  const message = typeof err?.message === 'string' ? err.message : '';
  // graphFetch collapses HTTP status into the message — 429 bodies surface
  // as '429' / 'throttled' / 'TooManyRequests' text, so match on those.
  if (/429|throttl|TooManyRequests/i.test(message)) {
    return THROTTLE_MESSAGE;
  }
  if (err?.name === 'M365Error') {
    switch (err.kind) {
      case 'not_connected':
        return 'Microsoft 365 is not connected for this account.';
      case 'consent_missing':
        return 'Your organization has not granted access for this Microsoft 365 capability.';
      case 'not_found':
        return 'The requested Microsoft 365 item was not found.';
      case 'forbidden':
        return 'Access to this Microsoft 365 resource was denied.';
      default:
        break;
    }
  }
  return message
    ? `Microsoft 365 request failed: ${truncateText(message, 160)}`
    : 'Microsoft 365 request failed — please try again.';
}

export function createM365ToolExecutor(
  req: NextRequest,
  session: Session,
  options: CreateM365ToolExecutorOptions = {},
): M365BuiltinExecutor {
  return {
    instructions: M365_TOOLSET_INSTRUCTIONS,

    async listTools(): Promise<M365ToolDefinitionLike[]> {
      let granted: Set<string>;
      try {
        granted = await probeGrantedScopes(req, session);
      } catch {
        // Probe failure ⇒ empty listing; the loop reports the server label
        // unavailable rather than exposing tools that can only fail.
        return [];
      }
      return M365_TOOL_SPECS.filter((spec) =>
        spec.scopes.every((scope) => granted.has(scope)),
      ).map((spec) => ({
        name: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema,
      }));
    },

    async callTool(
      toolName: string,
      args: unknown,
      callContext: { emitActivity?: (detail: string) => void } = {},
    ): Promise<M365ToolCallResult> {
      const spec = specByName(toolName);
      if (!spec) {
        return { resultText: `Unknown tool: ${toolName}`, isError: true };
      }

      let record: Record<string, unknown>;
      try {
        record = asRecord(args);
      } catch (error) {
        return { resultText: mapFailureToText(error), isError: true };
      }
      const shapeError = validateArgsAgainstSpec(spec, record);
      if (shapeError) {
        return {
          resultText: `Invalid arguments: ${shapeError}`,
          isError: true,
        };
      }

      try {
        const budgetKey = spec.budgetKey ?? 'feature.m365.toolCallsPerDay';
        if (
          options.consumeBudget &&
          !(await options.consumeBudget(budgetKey))
        ) {
          return { resultText: BUDGET_MESSAGE, isError: true };
        }
        const ctx: M365ToolExecutionContext = {
          ...(callContext.emitActivity && {
            emitActivity: callContext.emitActivity,
          }),
          screenOverrideIds: new Set(options.screenOverrideIds ?? []),
          sharedMailboxes: options.sharedMailboxes ?? [],
        };
        const resultText = await TOOL_IMPLEMENTATIONS[toolName](
          req,
          session,
          record,
          ctx,
        );
        return { resultText, isError: false };
      } catch (error) {
        return { resultText: mapFailureToText(error), isError: true };
      }
    },
  };
}

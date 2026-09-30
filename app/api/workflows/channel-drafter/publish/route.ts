import { NextRequest } from 'next/server';

import {
  AgentAccessService,
  emitAccessAudit,
} from '@/lib/services/agentAccess/AgentAccessService';
import { PUBLISH_SOURCE } from '@/lib/services/agentAccess/types';
import { connectMcp } from '@/lib/services/mcp/McpClientService';
import { createConnectorResolver } from '@/lib/services/mcp/connectorResolution';
import { isHttpsPublicShapedUrl } from '@/lib/services/mcp/mcpUrlGuard';
import { RateLimiter } from '@/lib/services/shared/RateLimiter';
import { loadChannelSetsFor } from '@/lib/services/workflows/channelDrafter/channelSetService';
import { evaluatePublishAccess } from '@/lib/services/workflows/channelDrafter/publishAccess';
import { buildPublishArguments } from '@/lib/services/workflows/channelDrafter/publishArguments';
import {
  isWorkflowEnabled,
  workflowDisabledResponse,
} from '@/lib/services/workflows/policy/guard';

import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';
import {
  checkVersion,
  getSpecAdapter,
} from '@/lib/utils/shared/drafter/adapters';
import { isNumbered } from '@/lib/utils/shared/drafter/channels/channelProfiles';
import {
  DEFAULT_CHANNEL_SET_ID,
  publishRuleName,
} from '@/lib/utils/shared/drafter/channels/channelSets';
import { publishBlockers } from '@/lib/utils/shared/drafter/core/publishing';
import { renderedSegmentText } from '@/lib/utils/shared/drafter/core/segments';

import { Brief, DRAFTER_LIMITS, Version } from '@/types/drafter';

import { auth } from '@/auth';
import { resolveMcpServers } from '@/config/mcpCatalog';
import {
  HOOTSUITE_PUBLISHING,
  isPublishingConfigured,
} from '@/config/publishing';
import { createHash } from 'crypto';
import { z } from 'zod';

export const maxDuration = 60;

const limiter = RateLimiter.createScoped(6, 1);

/**
 * "Send to Hootsuite" (docs/CHANNEL_DRAFTER_DESIGN.md §11.1). Deliberately
 * small. Three independent things keep it dark by default: the tool is not
 * configured (config/publishing.ts), nobody has a `publish::` rule (default
 * deny), and a post must pass the publish gate.
 *
 * The OAuth token lives in the caller's browser vault and rides in the body,
 * as it does for /api/mcp/tools; it is never stored or logged here. The
 * gate and the access check are re-run from the request's own data: the
 * client's opinion of either is not trusted. Approval is client-side state
 * by design (drafts never leave the device), so "approved" is the caller's
 * own statement, made by someone an admin already allowed to publish.
 */

/** types/drafter.ts MediaAttachment; the ref is an internal upload only. */
const mediaSchema = z
  .object({
    id: z.string().min(1).max(40),
    ref: z
      .string()
      .max(120)
      .regex(/^\/api\/file\/[0-9a-f]{64}\.[a-zA-Z0-9]{1,4}$/),
    name: z.string().max(300),
    alt: z.string().max(DRAFTER_LIMITS.MAX_ALT_CHARS),
  })
  .strict();

const segmentSchema = z
  .object({
    id: z.string().max(40),
    text: z.string().max(6_000),
    usedItemIds: z.array(z.string().max(40)).max(60),
    // The client sends segments whole, images included. Refusing the field
    // outright made every post with an image a 400 with no explanation.
    media: z
      .array(mediaSchema)
      .max(DRAFTER_LIMITS.MAX_MEDIA_PER_SEGMENT)
      .optional(),
  })
  .strict();

const requestSchema = z.object({
  /** The rule set the channel belongs to; absent = the default set. */
  setId: z.string().min(1).max(64).optional(),
  channelId: z.string().min(1).max(64),
  version: z
    .object({
      segments: z.array(segmentSchema).min(1).max(30),
      briefDigest: z.string().max(40),
      approvalTexts: z.array(z.string().max(6_000)).max(30).nullable(),
      hasPendingSuggestions: z.boolean(),
      hasProposal: z.boolean(),
    })
    .strict(),
  // The brief is validated structurally only where the gate reads it.
  brief: z.object({
    keyMessage: z.string().max(600),
    callToAction: z.string().max(300).optional(),
    language: z.string().max(60),
    links: z
      .array(
        z.object({
          role: z.enum(['article', 'donation']),
          label: z.string().max(120),
          url: z.string().max(500),
        }),
      )
      .max(2),
    items: z
      .array(
        z.object({
          id: z.string().max(40),
          kind: z.enum(['quote', 'testimony', 'fact', 'figure', 'context']),
          text: z.string().max(1_200),
          verified: z.enum(['verbatim', 'user-asserted', 'unverified']),
          decision: z.enum(['included', 'excluded']).optional(),
          attribution: z
            .object({
              name: z.string().max(120),
              role: z.string().max(160).optional(),
            })
            .optional(),
        }),
      )
      .max(40),
  }),
  server: z
    .object({
      id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      name: z.string().min(1).max(100),
      catalogKey: z.string().max(64),
      authToken: z.string().max(8192).optional(),
    })
    .strict(),
});

type PublishRequest = z.infer<typeof requestSchema>;

function toBrief(input: PublishRequest['brief']): Brief {
  return {
    rev: 0,
    keyMessage: input.keyMessage,
    callToAction: input.callToAction,
    language: input.language,
    links: input.links,
    items: input.items.map((item) => ({ ...item, provenance: [] })),
  };
}

function toVersion(
  channelId: string,
  input: PublishRequest['version'],
): Version {
  return {
    specId: channelId,
    segments: input.segments,
    briefRev: 0,
    briefDigest: input.briefDigest,
    handEdited: false,
    history: [],
    ...(input.approvalTexts
      ? { approval: { at: '', texts: input.approvalTexts } }
      : {}),
    // Only their presence matters to the gate.
    ...(input.hasProposal
      ? { proposed: { segments: [], briefRev: 0, reason: '' } }
      : {}),
    ...(input.hasPendingSuggestions
      ? {
          edits: [
            {
              id: 'pending',
              segmentId: input.segments[0].id,
              criterion: 'revision',
              before: '',
              after: '',
              reason: '',
              severity: 'minor' as const,
              status: 'pending' as const,
            },
          ],
        }
      : {}),
  };
}

/**
 * Which channels this caller may send to, per set (`<set>/<channel>`).
 * Drives whether a button shows.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (
    !isPublishingConfigured() ||
    !(await isWorkflowEnabled('channel-drafter'))
  ) {
    return successResponse({ configured: false, channels: [] });
  }
  try {
    // Warms group membership and the rules snapshot as a side effect.
    const sets = await loadChannelSetsFor(request, session, 'invocation');
    const service = AgentAccessService.getInstance();
    const userMail = session.user.mail ?? undefined;
    const needsTarget = HOOTSUITE_PUBLISHING.targetArgument.trim() !== '';
    const channels = sets.flatMap((set) =>
      set.channels
        .filter((profile) => !needsTarget || !!profile.publishTarget)
        .map((profile) => publishRuleName(set.id, profile.id))
        .filter(
          (name) =>
            evaluatePublishAccess(
              (input) => service.evaluateAccess(input),
              userMail,
              name,
            ).allowed,
        ),
    );
    return successResponse({ configured: true, channels });
  } catch (error) {
    return handleApiError(error, 'Failed to read publishing access');
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!(await isWorkflowEnabled('channel-drafter'))) {
    return workflowDisabledResponse('channel-drafter');
  }
  if (!isPublishingConfigured()) return notFoundResponse('Resource');

  const userId = session.user.id ?? session.user.mail ?? 'unknown';
  if (!limiter.checkLimit(userId).allowed) {
    return errorResponse('Too many requests', 429, undefined, 'RATE_LIMITED');
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid publish request',
      parsed.error.issues.map((issue) => issue.path.join('.')).join(', '),
    );
  }
  const body = parsed.data;
  if (body.server.catalogKey !== HOOTSUITE_PUBLISHING.catalogKey) {
    return badRequestResponse('Posts can only be sent through Hootsuite');
  }

  try {
    const adapter = getSpecAdapter('channel');
    const setId = body.setId ?? DEFAULT_CHANNEL_SET_ID;
    const profile = (await loadChannelSetsFor(request, session, 'invocation'))
      .find((set) => set.id === setId)
      ?.channels.find((entry) => entry.id === body.channelId);
    // Unknown and not-permitted are one answer: nothing to probe.
    if (!adapter || !profile) return notFoundResponse('Channel');

    const service = AgentAccessService.getInstance();
    const userMail = session.user.mail ?? undefined;
    const ruleName = publishRuleName(setId, profile.id);
    const access = evaluatePublishAccess(
      (input) => service.evaluateAccess(input),
      userMail,
      ruleName,
    );
    // The decision goes through the access audit (console line plus the
    // queryable AgentAccess event), like every other invocation guard.
    emitAccessAudit({
      userMail,
      agentName: ruleName,
      source: PUBLISH_SOURCE,
      decision: access.allowed ? 'allow' : 'deny',
      reason: access.reason,
      user: session.user,
    });
    if (!access.allowed) {
      return forbiddenResponse('You may not send posts for this channel');
    }

    // A thread needs reply-chaining, which a general tool may not offer.
    if (body.version.segments.length > 1) {
      return errorResponse(
        'Threads cannot be sent yet; copy them post by post',
        409,
        undefined,
        'THREAD_NOT_SUPPORTED',
      );
    }

    // Images are not sent to Hootsuite. Posting the words without them
    // would publish something the author never approved, so the whole post
    // is refused, as the client already does.
    if (body.version.segments.some((segment) => segment.media?.length)) {
      return errorResponse(
        'Posts with images cannot be sent yet; copy the post and add the images in Hootsuite',
        409,
        undefined,
        'MEDIA_NOT_SUPPORTED',
      );
    }

    const brief = toBrief(body.brief);
    const version = toVersion(profile.id, body.version);
    const blockers = publishBlockers(
      version,
      brief,
      checkVersion(adapter, profile, version.segments, brief),
      { allowVouched: HOOTSUITE_PUBLISHING.allowVouched },
    );
    if (blockers.length > 0) {
      return errorResponse(
        'This post is not ready to send',
        409,
        blockers.join(','),
        'NOT_READY',
      );
    }

    const text = renderedSegmentText(version.segments, 0, isNumbered(profile));
    const args = buildPublishArguments(HOOTSUITE_PUBLISHING, text, profile);
    if (!args.ok) {
      return errorResponse(
        'This channel has no Hootsuite profile set',
        409,
        undefined,
        'NO_PUBLISH_TARGET',
      );
    }

    const [resolved] = resolveMcpServers([body.server], {
      allowCustom: false,
      isAllowedCustomUrl: isHttpsPublicShapedUrl,
      resolveConnector: await createConnectorResolver(session),
    });
    if (!resolved) return badRequestResponse('Unknown catalog entry');

    let connection;
    try {
      connection = await connectMcp(resolved);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Connection failed';
      return errorResponse(
        message,
        502,
        undefined,
        /\b(401|403)\b/.test(message) ? 'MCP_AUTH_FAILED' : 'MCP_UNREACHABLE',
      );
    }

    try {
      // The configured tool must really exist on the server we reached; a
      // renamed tool fails here, loudly, and never as a different action.
      const tools = await connection.listTools();
      if (!tools.some((tool) => tool.name === HOOTSUITE_PUBLISHING.toolName)) {
        return errorResponse(
          'The configured Hootsuite tool was not found',
          502,
          undefined,
          'PUBLISH_TOOL_MISSING',
        );
      }
      const result = await connection.callTool(
        HOOTSUITE_PUBLISHING.toolName,
        args.arguments,
      );
      // The text is never logged; its hash ties an audit line to a post.
      const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
      console.log(
        `[channel-drafter-publish] ${result.isError ? 'FAILED' : 'SENT'} channel=${sanitizeForLog(profile.id)} by=${sanitizeForLog(userMail ?? 'unknown')} rule=${sanitizeForLog(access.reason)} segments=${version.segments.length} textHash=${hash}`,
      );
      if (result.isError) {
        return errorResponse(
          'Hootsuite refused the post',
          502,
          result.text.slice(0, 500),
          'PUBLISH_REJECTED',
        );
      }
      return successResponse({ sent: true, textHash: hash });
    } finally {
      await connection.close();
    }
  } catch (error) {
    return handleApiError(error, 'Failed to send the post');
  }
}

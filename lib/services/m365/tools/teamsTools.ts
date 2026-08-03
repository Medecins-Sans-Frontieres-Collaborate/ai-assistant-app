/**
 * Teams tools (fourth pass B2): teams_list, channels_list,
 * channel_messages, chats_search. Message bodies arrive as HTML and are
 * tag-stripped before rendering; channel/chat content is
 * speaker-of-untrusted-content, entering the transcript as tool results
 * like any MCP output. graphApi is lazy-imported (see groupMembership.ts).
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import {
  M365ToolInputError,
  catalogScopes,
  clampNumber,
  formatGraphDateTime,
  isValidChannelId,
  optionalString,
  parseAsUtc,
  requireString,
  stripHtml,
  toDateTime,
  truncateText,
} from '@/lib/services/m365/tools/shared';

const MESSAGE_PREVIEW_LENGTH = 300;
// Newest-first channel pages; two pages of 50 bound the catch-up window.
const CHANNEL_PAGE_SIZE = 50;
const MAX_CHANNEL_PAGES = 2;

export async function teamsList(
  req: NextRequest,
  _session: Session,
  _args: Record<string, unknown>,
): Promise<string> {
  const { graphJson } = await import('@/lib/services/m365/graphApi');
  const data = await graphJson<{
    value?: { id?: string; displayName?: string; description?: string }[];
  }>(
    req,
    catalogScopes('teams_list'),
    '/me/joinedTeams?$select=id,displayName,description&$top=100',
  );
  const teams = (data.value ?? [])
    .filter((team): team is { id: string; displayName?: string } => !!team.id)
    .sort((a, b) =>
      (a.displayName ?? a.id).localeCompare(b.displayName ?? b.id),
    );
  if (teams.length === 0) return 'You are not a member of any teams.';
  return [
    `Your teams (${teams.length}):`,
    ...teams.map((team) => `- ${team.displayName ?? team.id} (id: ${team.id})`),
  ].join('\n');
}

export async function channelsList(
  req: NextRequest,
  _session: Session,
  args: Record<string, unknown>,
): Promise<string> {
  const teamId = requireString(args, 'teamId');
  const { graphJson, isValidGraphId } =
    await import('@/lib/services/m365/graphApi');
  if (!isValidGraphId(teamId)) {
    throw new M365ToolInputError('teamId is not a valid team id');
  }
  const data = await graphJson<{
    value?: { id?: string; displayName?: string; description?: string }[];
  }>(
    req,
    catalogScopes('channels_list'),
    `/teams/${encodeURIComponent(teamId)}/channels?$select=id,displayName,description`,
  );
  const channels = (data.value ?? []).filter(
    (channel): channel is { id: string; displayName?: string } => !!channel.id,
  );
  if (channels.length === 0) return 'This team has no visible channels.';
  return [
    `Channels (${channels.length}):`,
    ...channels.map(
      (channel) =>
        `- ${channel.displayName ?? '(unnamed)'} (id: ${channel.id})`,
    ),
  ].join('\n');
}

interface GraphChatMessage {
  messageType?: string;
  createdDateTime?: string;
  from?: {
    user?: { displayName?: string };
    emailAddress?: { name?: string; address?: string };
    application?: { displayName?: string };
  };
  body?: { content?: string };
}

function messageSender(message: GraphChatMessage): string {
  return (
    message.from?.user?.displayName ||
    message.from?.emailAddress?.name ||
    message.from?.emailAddress?.address ||
    message.from?.application?.displayName ||
    'Unknown'
  );
}

export async function channelMessages(
  req: NextRequest,
  _session: Session,
  args: Record<string, unknown>,
): Promise<string> {
  const teamId = requireString(args, 'teamId');
  const channelId = requireString(args, 'channelId');
  const sinceDate = optionalString(args, 'sinceDate');
  const maxMessages = clampNumber(args, 'maxMessages', 25, 50);

  const { graphJson, isValidGraphId } =
    await import('@/lib/services/m365/graphApi');
  if (!isValidGraphId(teamId)) {
    throw new M365ToolInputError('teamId is not a valid team id');
  }
  if (!isValidChannelId(channelId)) {
    throw new M365ToolInputError('channelId is not a valid channel id');
  }
  const sinceMs = sinceDate
    ? parseAsUtc(toDateTime(sinceDate, 'start')).getTime()
    : null;
  if (sinceMs !== null && Number.isNaN(sinceMs)) {
    throw new M365ToolInputError('sinceDate must be an ISO 8601 date');
  }

  const scopes = catalogScopes('channel_messages');
  // Channel messages support neither $filter-by-date nor $orderby — fetch
  // the newest page(s) and date-filter in code.
  let path: string | null =
    `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages?$top=${CHANNEL_PAGE_SIZE}`;
  const collected: GraphChatMessage[] = [];
  let pastSince = false;
  for (let page = 0; page < MAX_CHANNEL_PAGES && path && !pastSince; page++) {
    const data: { value?: GraphChatMessage[]; '@odata.nextLink'?: string } =
      await graphJson(req, scopes, path);
    for (const message of data.value ?? []) {
      if (
        sinceMs !== null &&
        message.createdDateTime &&
        Date.parse(message.createdDateTime) < sinceMs
      ) {
        // Newest-first: everything after this is older still.
        pastSince = true;
        break;
      }
      collected.push(message);
    }
    path = data['@odata.nextLink'] ?? null;
  }

  const rendered = collected
    .filter(
      (message) => !message.messageType || message.messageType === 'message',
    )
    .map((message) => ({
      time: message.createdDateTime ?? '',
      sender: messageSender(message),
      text: stripHtml(message.body?.content ?? ''),
    }))
    .filter((message) => message.text.length > 0);

  if (rendered.length === 0) {
    return sinceDate
      ? `No channel messages since ${sinceDate}.`
      : 'No recent channel messages.';
  }

  const capped = rendered.slice(0, maxMessages);
  // Chronological order reads better for catch-up digests.
  capped.reverse();
  const header =
    rendered.length > capped.length
      ? `Channel messages (showing ${capped.length} of ${rendered.length}${sinceDate ? ` since ${sinceDate}` : ''}):`
      : `Channel messages (${capped.length}${sinceDate ? ` since ${sinceDate}` : ''}):`;
  return [
    header,
    ...capped.map(
      (message) =>
        `- ${formatGraphDateTime(message.time)} — ${message.sender}: ${truncateText(message.text, MESSAGE_PREVIEW_LENGTH)}`,
    ),
  ].join('\n');
}

interface SearchHit {
  resource?: GraphChatMessage & {
    channelIdentity?: { teamId?: string; channelId?: string };
    chatId?: string;
  };
}

export async function chatsSearch(
  req: NextRequest,
  _session: Session,
  args: Record<string, unknown>,
): Promise<string> {
  const query = requireString(args, 'query');
  const maxResults = clampNumber(args, 'maxResults', 10, 25);

  const { graphJson } = await import('@/lib/services/m365/graphApi');
  const data = await graphJson<{
    value?: {
      hitsContainers?: { hits?: SearchHit[]; total?: number }[];
    }[];
  }>(req, catalogScopes('chats_search'), '/search/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        {
          entityTypes: ['chatMessage'],
          query: { queryString: query },
          size: maxResults,
        },
      ],
    }),
  });

  const container = data.value?.[0]?.hitsContainers?.[0];
  const hits = container?.hits ?? [];
  const total = container?.total ?? hits.length;
  if (hits.length === 0) {
    return `No chat messages matched "${truncateText(query, 80)}".`;
  }

  const lines = hits.map((hit) => {
    const resource = hit.resource ?? {};
    const context = resource.channelIdentity?.channelId
      ? ' [channel message]'
      : resource.chatId
        ? ' [chat]'
        : '';
    const text = truncateText(
      stripHtml(resource.body?.content ?? ''),
      MESSAGE_PREVIEW_LENGTH,
    );
    return `- ${formatGraphDateTime(resource.createdDateTime)} — ${messageSender(resource)}${context}: ${text || '(no text)'}`;
  });
  const header =
    total > hits.length
      ? `Chat messages matching "${query}" (showing ${hits.length} of ${total}):`
      : `Chat messages matching "${query}" (${hits.length}):`;
  return [header, ...lines].join('\n');
}

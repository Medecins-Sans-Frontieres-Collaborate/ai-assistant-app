'use client';

import { FC } from 'react';

import { ApprovalConsentCard } from './ApprovalConsentCard';
import { OAuthConsentCard } from './OAuthConsentCard';

export interface ConsentRequest {
  /** OAuth sign-in (user clicks link, returns and clicks Continue) or MCP tool approval. */
  kind: 'oauth' | 'approval';
  /** OAuth sign-in URL — only for kind: 'oauth'. */
  consent_url?: string;
  /** Approval request id — only for kind: 'approval'. */
  approval_request_id?: string;
  /** MCP server / connector identifier (e.g. "NetSuite"). May be null. */
  server_label?: string | null;
  /** Tool/function name being invoked — only for kind: 'approval'. */
  tool_name?: string | null;
  /** JSON-serialized arguments the agent will pass to the tool — display-only. */
  tool_arguments?: string | null;
}

interface ConsentCardProps {
  request: ConsentRequest;
  /** Index of the assistant message that emitted this consent request. */
  messageIndex?: number;
  /** Pre-recorded outcome from message metadata; survives reload. */
  persistedOutcome?: boolean;
}

/**
 * Renders a consent prompt surfaced by an MCP-enabled agent. Switches
 * between an OAuth flow (for sign-in to an upstream connector) and an
 * approval flow (for tool-call confirmation), each implemented in its
 * own component for cohesion.
 */
export const ConsentCard: FC<ConsentCardProps> = ({
  request,
  messageIndex,
  persistedOutcome,
}) => {
  if (request.kind === 'oauth' && request.consent_url) {
    return (
      <OAuthConsentCard
        request={
          request as ConsentRequest & {
            kind: 'oauth';
            consent_url: string;
          }
        }
        messageIndex={messageIndex}
      />
    );
  }
  if (request.kind === 'approval') {
    return (
      <ApprovalConsentCard
        request={request as ConsentRequest & { kind: 'approval' }}
        messageIndex={messageIndex}
        persistedOutcome={persistedOutcome}
      />
    );
  }
  return null;
};

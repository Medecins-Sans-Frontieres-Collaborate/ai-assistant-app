'use client';

import { useFlags } from 'launchdarkly-react-client-sdk';

/**
 * Whether the saved-structures library should be reachable.
 *
 * Structures back two independently-flagged surfaces, and the flags have
 * opposite polarity by design:
 *
 *  - `structuredDataExtraction` is fail-**open** (`!== false`) — extraction
 *    is broadly available and an LD outage should not remove it.
 *  - `conversationWorkflows` is fail-**closed** (`=== true`) — workflows are
 *    still rolling out and an outage must not launch them.
 *
 * The library is useful if *either* consumer is live, so this ORs them rather
 * than picking one. Hiding it whenever extraction is off would strand the
 * data workflow's "save as structure" output somewhere the user cannot reach.
 * See docs/LAUNCHDARKLY_FLAGS.md.
 */
export function useStructuresEnabled(): boolean {
  const { structuredDataExtraction, conversationWorkflows } = useFlags();
  const isLocalhost =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1');
  return (
    structuredDataExtraction !== false ||
    conversationWorkflows === true ||
    isLocalhost
  );
}

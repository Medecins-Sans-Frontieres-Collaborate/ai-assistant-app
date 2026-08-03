/**
 * Boot-time contract rehearsal for the STATIC org RAG agents. Admin-authored
 * agents are validated on every save; the file-based agents ride env
 * SEARCH_INDEX with no admission gate at all — this check closes that gap
 * without adding one (warn-only, fire-and-forget, never fatal): a broken or
 * missing index is announced at startup instead of being discovered as
 * silently-sourceless chat answers.
 */
import { validateOrgAgentIndex } from '@/lib/services/orgAgents/orgAgentSearchValidation';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { env } from '@/config/environment';
import { getOrganizationAgents } from '@/lib/organizationAgents';

export async function logStaticOrgAgentIndexWarnings(): Promise<void> {
  try {
    if (!env.SEARCH_ENDPOINT || !env.SEARCH_INDEX) return;
    const ragAgents = getOrganizationAgents().filter((a) => a.type === 'rag');
    if (ragAgents.length === 0) return;

    // Distinct (index, semanticConfig) pairs across the static agents —
    // per-agent overrides are honored, everything else rides the env pair.
    const pairs = new Map<string, { index: string; semanticConfig: string }>();
    for (const agent of ragAgents) {
      const index = agent.ragConfig?.searchIndex || env.SEARCH_INDEX;
      const semanticConfig = agent.ragConfig?.semanticConfig || '';
      pairs.set(`${index}::${semanticConfig}`, { index, semanticConfig });
    }

    for (const { index, semanticConfig } of pairs.values()) {
      const result = await validateOrgAgentIndex(index, semanticConfig);
      if (result.status === 'failed') {
        console.warn(
          `[org-agents] STATIC agents' index '${sanitizeForLog(index)}' failed the retrieval contract check — their knowledge answers will silently degrade: ${sanitizeForLog(result.error)}`,
        );
      } else {
        console.log(
          `[org-agents] static agent index '${sanitizeForLog(index)}' validated${
            result.documentCount !== undefined
              ? ` (${result.documentCount} docs)`
              : ''
          }`,
        );
      }
    }
  } catch (error) {
    console.warn(
      `[org-agents] static index startup check skipped: ${sanitizeForLog(error)}`,
    );
  }
}

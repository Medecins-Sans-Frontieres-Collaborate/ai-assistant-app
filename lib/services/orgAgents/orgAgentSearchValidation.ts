/**
 * Azure AI Search validation for admin-authored org RAG agents.
 *
 * The retrieval contract is dictated by RAGService.performSearch: it selects
 * `chunk, title, date, url, chunk_id`, runs a `kind: 'text'` vector query
 * against `text_vector` (which requires an INTEGRATED VECTORIZER on the
 * index — unlike the m365-agents index, which embeds app-side), and names a
 * semantic configuration. An index that merely exists is not enough; this
 * module proves the whole contract before an agent can serve:
 *
 *  1. the index exists on the org search endpoint,
 *  2. every field the query touches exists with the right shape,
 *  3. `text_vector`'s profile has a vectorizer,
 *  4. the semantic configuration exists,
 *  5. one real probe query (semantic + text-vector, top 1) succeeds,
 *  6. the document count is captured so "0 documents" is visible to admins.
 *
 * All calls use the app identity (DefaultAzureCredential) against
 * SEARCH_ENDPOINT — the same identity RAGService queries with, so a
 * validation pass here is a true rehearsal of chat-time retrieval.
 */
import { OrgAgentValidation } from '@/lib/services/agentAccess/types';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { env } from '@/config/environment';
import { DefaultAzureCredential } from '@azure/identity';

const SEARCH_API_VERSION = '2025-09-01';

export function orgSearchEndpoint(): string {
  const endpoint = env.SEARCH_ENDPOINT;
  if (!endpoint) {
    throw new Error('SEARCH_ENDPOINT is not configured');
  }
  return endpoint;
}

async function searchAuthHeader(): Promise<Record<string, string>> {
  const credential = new DefaultAzureCredential();
  const token = await credential.getToken('https://search.azure.com/.default');
  return { Authorization: `Bearer ${token.token}` };
}

/**
 * Names of the indexes on the org search endpoint. Powers the admin
 * editor's index dropdown — index names are picked, never typed, so a typo
 * is impossible rather than merely detected.
 */
export async function listSearchIndexNames(): Promise<string[]> {
  const headers = await searchAuthHeader();
  const response = await fetch(
    `${orgSearchEndpoint()}/indexes?api-version=${SEARCH_API_VERSION}&$select=name`,
    { headers },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Failed to list search indexes (${response.status}): ${body.slice(0, 300)}`,
    );
  }
  const json = (await response.json()) as { value?: Array<{ name?: string }> };
  return (json.value ?? [])
    .map((entry) => entry.name)
    .filter((name): name is string => typeof name === 'string' && name !== '')
    .sort();
}

interface IndexFieldDefinition {
  name?: string;
  type?: string;
  searchable?: boolean;
  retrievable?: boolean;
  vectorSearchProfile?: string;
}

interface IndexDefinition {
  fields?: IndexFieldDefinition[];
  semantic?: { configurations?: Array<{ name?: string }> };
  vectorSearch?: {
    profiles?: Array<{ name?: string; vectorizer?: string }>;
    vectorizers?: Array<{ name?: string }>;
  };
}

/** Fields RAGService selects — they must exist and be retrievable. */
const REQUIRED_SELECT_FIELDS = ['chunk', 'title', 'date', 'url', 'chunk_id'];

/**
 * Diffs an index definition against the RAGService retrieval contract.
 * Returns human-readable problems; empty means the definition is usable.
 */
export function ragContractProblems(
  definition: IndexDefinition,
  indexName: string,
  semanticConfig: string,
): string[] {
  const problems: string[] = [];
  const fields = new Map(
    (definition.fields ?? [])
      .filter((f): f is IndexFieldDefinition & { name: string } => !!f.name)
      .map((f) => [f.name, f]),
  );

  for (const name of REQUIRED_SELECT_FIELDS) {
    const field = fields.get(name);
    if (!field) {
      problems.push(`missing field '${name}'`);
    } else if (field.retrievable === false) {
      problems.push(`field '${name}' is not retrievable`);
    }
  }
  const chunk = fields.get('chunk');
  if (chunk && chunk.searchable === false) {
    problems.push(`field 'chunk' is not searchable`);
  }

  const vector = fields.get('text_vector');
  if (!vector) {
    problems.push(`missing vector field 'text_vector'`);
  } else if (vector.type !== 'Collection(Edm.Single)') {
    problems.push(
      `field 'text_vector' has type '${vector.type ?? 'unknown'}', expected 'Collection(Edm.Single)'`,
    );
  } else {
    // The chat-time query is kind:'text' — Azure embeds the query with the
    // index's own vectorizer, so the field's profile must reference one.
    const profile = (definition.vectorSearch?.profiles ?? []).find(
      (p) => p.name === vector.vectorSearchProfile,
    );
    if (!profile) {
      problems.push(`field 'text_vector' has no vector search profile`);
    } else if (!profile.vectorizer) {
      problems.push(
        `vector profile '${profile.name}' has no integrated vectorizer (required for text vector queries)`,
      );
    }
  }

  const wantedSemantic =
    semanticConfig || `${indexName}-semantic-configuration`;
  const semanticNames = (definition.semantic?.configurations ?? []).map(
    (c) => c.name,
  );
  if (!semanticNames.includes(wantedSemantic)) {
    problems.push(`missing semantic configuration '${wantedSemantic}'`);
  }

  return problems;
}

function failed(error: string): OrgAgentValidation {
  return {
    status: 'failed',
    checkedAt: new Date().toISOString(),
    error: error.slice(0, 500),
  };
}

/**
 * Full save-time validation: definition contract + live probe query +
 * document count. Never throws — any failure (including endpoint/auth
 * problems) lands in a `status: 'failed'` result the admin can read.
 */
export async function validateOrgAgentIndex(
  indexName: string,
  semanticConfig: string,
): Promise<OrgAgentValidation> {
  let endpoint: string;
  let headers: Record<string, string>;
  try {
    endpoint = orgSearchEndpoint();
    headers = await searchAuthHeader();
  } catch (error) {
    return failed(
      error instanceof Error ? error.message : 'Search endpoint unavailable',
    );
  }

  try {
    const definitionResponse = await fetch(
      `${endpoint}/indexes/${encodeURIComponent(indexName)}?api-version=${SEARCH_API_VERSION}`,
      { headers },
    );
    if (definitionResponse.status === 404) {
      return failed(`Index '${indexName}' does not exist on ${endpoint}`);
    }
    if (!definitionResponse.ok) {
      const body = await definitionResponse.text().catch(() => '');
      return failed(
        `Could not read index '${indexName}' (${definitionResponse.status}): ${body.slice(0, 200)}`,
      );
    }
    const definition = (await definitionResponse.json()) as IndexDefinition;
    const problems = ragContractProblems(definition, indexName, semanticConfig);
    if (problems.length > 0) {
      return failed(
        `Index '${indexName}' does not satisfy the retrieval contract: ${problems.join('; ')}`,
      );
    }

    // Live probe: the exact query shape chat-time retrieval uses. This is
    // the only check that catches a broken vectorizer credential or a
    // misconfigured semantic ranker — the definition alone cannot.
    const probeResponse = await fetch(
      `${endpoint}/indexes/${encodeURIComponent(indexName)}/docs/search?api-version=${SEARCH_API_VERSION}`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          search: 'validation probe',
          top: 1,
          queryType: 'semantic',
          semanticConfiguration:
            semanticConfig || `${indexName}-semantic-configuration`,
          vectorQueries: [
            {
              kind: 'text',
              text: 'validation probe',
              fields: 'text_vector',
              k: 1,
            },
          ],
        }),
      },
    );
    if (!probeResponse.ok) {
      const body = await probeResponse.text().catch(() => '');
      return failed(
        `Probe query against '${indexName}' failed (${probeResponse.status}): ${body.slice(0, 200)}`,
      );
    }

    let documentCount: number | undefined;
    try {
      const countResponse = await fetch(
        `${endpoint}/indexes/${encodeURIComponent(indexName)}/docs/$count?api-version=${SEARCH_API_VERSION}`,
        { headers },
      );
      if (countResponse.ok) {
        const raw = (await countResponse.text()).trim().replace(/^\uFEFF/, '');
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed >= 0) documentCount = parsed;
      }
    } catch {
      // Count is advisory; a probe-validated index stays valid without it.
    }

    return {
      status: 'ok',
      checkedAt: new Date().toISOString(),
      ...(documentCount !== undefined && { documentCount }),
    };
  } catch (error) {
    console.error(
      `[org-agents] index validation error for ${sanitizeForLog(indexName)}: ${sanitizeForLog(error)}`,
    );
    return failed(
      error instanceof Error ? error.message : 'Index validation failed',
    );
  }
}

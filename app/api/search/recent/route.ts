import { NextRequest, NextResponse } from 'next/server';

import { unauthorizedResponse } from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';
import { env } from '@/config/environment';
import { getOrganizationAgentById } from '@/lib/organizationAgents';
import { DefaultAzureCredential } from '@azure/identity';
import { SearchClient } from '@azure/search-documents';

// Simple in-memory cache with TTL
const cache = new Map<string, { data: RecentSourceData[]; expires: number }>();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

interface RecentDoc {
  title: string;
  date: string;
  url: string;
}

interface RecentSourceData {
  sourceName: string;
  sourceUrl: string;
  latestDoc: RecentDoc;
}

function getCached(key: string): RecentSourceData[] | null {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expires) {
    return entry.data;
  }
  // Clean up expired entry
  if (entry) cache.delete(key);
  return null;
}

const MAX_CACHE_SIZE = 100;

function setCache(key: string, data: RecentSourceData[]): void {
  if (cache.size >= MAX_CACHE_SIZE) {
    // Evict oldest entry (first key in insertion order)
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { data, expires: Date.now() + TTL_MS });
}

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return unauthorizedResponse();
    }

    const agentId = request.nextUrl.searchParams.get('agentId');

    if (!agentId) {
      return NextResponse.json(
        { error: 'agentId is required' },
        { status: 400 },
      );
    }

    // Verify agent exists and is a RAG agent
    const agent = getOrganizationAgentById(agentId);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }
    if (agent.type !== 'rag') {
      return NextResponse.json(
        { error: 'Agent is not a RAG agent' },
        { status: 400 },
      );
    }

    // Check cache first
    const cacheKey = `recent-${agentId}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return NextResponse.json({ sources: cached, cached: true });
    }

    // Get search config from environment
    const searchEndpoint = env.SEARCH_ENDPOINT;
    const searchIndex = env.SEARCH_INDEX;

    if (!searchEndpoint || !searchIndex) {
      return NextResponse.json(
        { error: 'Search configuration missing' },
        { status: 500 },
      );
    }

    // Create search client
    const searchClient = new SearchClient<RecentDoc>(
      searchEndpoint,
      searchIndex,
      new DefaultAzureCredential(),
    );

    // Query for recent documents, sorted by date descending
    const searchResults = await searchClient.search('*', {
      top: 50,
      orderBy: ['date desc'],
      select: ['title', 'date', 'url'],
    });

    // Group by source domain and get latest from each
    const sourceMap = new Map<string, RecentDoc>();
    const agentSources = agent.sources || [];

    for await (const result of searchResults.results) {
      const doc = result.document;
      if (!doc.url) continue;

      // Extract domain from URL
      let domain: string;
      try {
        domain = new URL(doc.url).hostname.replace('www.', '');
      } catch {
        continue;
      }

      // Only track if we haven't seen this source yet (first = most recent)
      if (!sourceMap.has(domain)) {
        sourceMap.set(domain, {
          title: doc.title,
          date: doc.date,
          url: doc.url,
        });
      }

      // Stop if we've found all configured sources
      if (agentSources.length > 0 && sourceMap.size >= agentSources.length) {
        break;
      }
    }

    // Build response matching agent's configured sources
    const recentSources: RecentSourceData[] = [];

    if (agentSources.length > 0) {
      // Match against configured sources
      for (const source of agentSources) {
        const sourceDomain = new URL(source.url).hostname.replace('www.', '');
        const latestDoc = sourceMap.get(sourceDomain);

        if (latestDoc) {
          recentSources.push({
            sourceName: source.name,
            sourceUrl: source.url,
            latestDoc,
          });
        }
      }
    } else {
      // No configured sources, just return what we found
      for (const [domain, doc] of sourceMap) {
        recentSources.push({
          sourceName: domain,
          sourceUrl: `https://${domain}`,
          latestDoc: doc,
        });
      }
    }

    // Sort by date descending
    recentSources.sort(
      (a, b) =>
        new Date(b.latestDoc.date).getTime() -
        new Date(a.latestDoc.date).getTime(),
    );

    // Cache the result
    setCache(cacheKey, recentSources);

    return NextResponse.json({ sources: recentSources, cached: false });
  } catch (error) {
    console.error('[API /search/recent] Error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch recent sources' },
      { status: 500 },
    );
  }
}

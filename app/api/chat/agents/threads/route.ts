import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/auth';
import { env } from '@/config/environment';
import { AgentsClient } from '@azure/ai-agents';
import { DefaultAzureCredential } from '@azure/identity';

const MAX_BATCH_SIZE = 500;
const PARALLELISM = 8;
const THREAD_ID_PATTERN = /^thread_[A-Za-z0-9_-]+$/;

type DeleteOutcome =
  | { threadId: string; status: 'deleted' }
  | { threadId: string; status: 'not_found' }
  | { threadId: string; status: 'failed'; error: string };

async function deleteOne(
  client: AgentsClient,
  threadId: string,
): Promise<DeleteOutcome> {
  try {
    const result = await client.threads.delete(threadId);
    if (result?.deleted === true) {
      return { threadId, status: 'deleted' };
    }
    return {
      threadId,
      status: 'failed',
      error: 'Azure returned deleted=false',
    };
  } catch (err) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    const code = (err as { code?: string })?.code;
    if (statusCode === 404 || code === 'NotFound') {
      // Already gone — that's the goal.
      return { threadId, status: 'not_found' };
    }
    return {
      threadId,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runInPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await worker(items[i]);
      }
    })(),
  );
  await Promise.all(workers);
  return results;
}

/**
 * Deletes Azure AI Foundry threads in bulk.
 * Called when the client deletes a conversation (one ID) or clears all (many).
 *
 * Always 200 on success; per-thread failures are surfaced in the response
 * payload so the client never blocks local deletion on Azure being reachable.
 * 404 from Azure is treated as success (already deleted is the goal state).
 *
 * DELETE /api/chat/agents/threads
 * Body: { threadIds: string[] }
 */
export async function DELETE(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const threadIds = (body as { threadIds?: unknown })?.threadIds;
    if (!Array.isArray(threadIds) || threadIds.length === 0) {
      return NextResponse.json(
        { error: 'threadIds must be a non-empty array' },
        { status: 400 },
      );
    }
    if (threadIds.length > MAX_BATCH_SIZE) {
      return NextResponse.json(
        {
          error: `threadIds exceeds max batch size of ${MAX_BATCH_SIZE}`,
        },
        { status: 400 },
      );
    }
    for (const id of threadIds) {
      if (typeof id !== 'string' || !THREAD_ID_PATTERN.test(id)) {
        return NextResponse.json(
          {
            error: 'Invalid threadId format',
            details: 'Each threadId must match pattern: thread_xxxxx',
          },
          { status: 400 },
        );
      }
    }
    const uniqueIds = Array.from(new Set(threadIds as string[]));

    const endpoint = env.AZURE_AI_FOUNDRY_ENDPOINT;
    if (!endpoint) {
      return NextResponse.json(
        {
          error: 'Azure AI Foundry endpoint not configured',
          details:
            'Server configuration error. Please contact your administrator.',
        },
        { status: 500 },
      );
    }

    const client = new AgentsClient(endpoint, new DefaultAzureCredential());

    const outcomes = await runInPool(uniqueIds, PARALLELISM, (id) =>
      deleteOne(client, id),
    );

    const deleted = outcomes.filter((o) => o.status === 'deleted').length;
    const notFound = outcomes.filter((o) => o.status === 'not_found').length;
    const failed = outcomes.filter(
      (o): o is Extract<DeleteOutcome, { status: 'failed' }> =>
        o.status === 'failed',
    );

    if (failed.length > 0) {
      console.warn(
        `[ThreadsRoute] Bulk delete completed with ${failed.length} failure(s)`,
        failed,
      );
    }

    return NextResponse.json({
      deleted,
      notFound,
      failed: failed.map((f) => ({ threadId: f.threadId, error: f.error })),
    });
  } catch (error: any) {
    console.error('[ThreadsRoute] Bulk delete error:', error);
    return NextResponse.json(
      {
        error: 'Server error',
        details:
          error?.message || 'An unexpected error occurred during cleanup.',
      },
      { status: 500 },
    );
  }
}

import { NextRequest } from 'next/server';

import { FileProcessingService } from '@/lib/services/chat/FileProcessingService';

import { auth } from '@/auth';

/**
 * Minimal placeholder endpoint for pre-processing files.
 * Accepts a single object { url } or an array of such objects, returns extracted text when cached.
 */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    const session = await auth();
    if (!session) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json();
    const items: Array<{ url: string }> = Array.isArray(body) ? body : [body];

    const fps = new FileProcessingService();
    const limit = 3;
    const queue: Promise<{
      url: string;
      content: string;
      processedAt: string;
    }>[] = [];

    const runOne = async (url: string) => {
      const [, path] = fps.getTempFilePath(url);
      await fps.downloadFilePreferCached(url, path, session.user);
      const buf = await fps.readFile(path);
      await fps.cleanupFile(path);
      return {
        url,
        content: buf.toString('utf-8'),
        processedAt: new Date().toISOString(),
      };
    };

    const results: { url: string; content: string; processedAt: string }[] = [];
    for (const item of items) {
      if (!item?.url) continue;
      if (queue.length >= limit) {
        const r = await Promise.race(queue);
        results.push(r);
      }
      const p = runOne(item.url).finally(() => {
        const i = queue.indexOf(p);
        if (i >= 0) queue.splice(i, 1);
      });
      queue.push(p);
    }
    results.push(...(await Promise.all(queue)));
    return new Response(JSON.stringify({ results }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid request' }), {
      headers: { 'Content-Type': 'application/json' },
      status: 400,
    });
  }
}

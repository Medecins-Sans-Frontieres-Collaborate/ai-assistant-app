import { NextRequest } from 'next/server';

/**
 * Minimal placeholder endpoint for pre-processing files.
 * Accepts a single object { url } or an array of such objects, returns empty results.
 */
export async function POST(req: NextRequest): Promise<Response> {
  try {
    const body = await req.json();
    const items = Array.isArray(body) ? body : [body];
    const results = items.map((item) => ({ url: item?.url, content: '' }));
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

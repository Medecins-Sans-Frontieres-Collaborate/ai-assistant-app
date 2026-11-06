/** Small bounded request bodies for global-admin auxiliary policy/probe operations. */
import { withAuxiliaryDeadline } from './deadline';

/** Read at most 32 KB within five seconds, decode UTF-8, and parse JSON; errors propagate as validation failures. */
export async function readAuxiliaryAdminBody(
  request: Request,
): Promise<unknown> {
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    throw new Error('Expected an application/json body');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing JSON body');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const deadline = Date.now() + 5000;
  try {
    for (;;) {
      const result = await withAuxiliaryDeadline(
        reader.read(),
        Math.max(1, deadline - Date.now()),
      );
      if (result.done) break;
      bytes += result.value.length;
      if (bytes > 32 * 1024)
        throw new RangeError('Auxiliary administration body exceeds 32 KB');
      chunks.push(result.value);
    }
    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(combined),
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

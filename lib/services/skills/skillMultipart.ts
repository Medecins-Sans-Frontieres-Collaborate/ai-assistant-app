import { SkillResourceError } from './skillFiles';
import { SKILL_LIMITS } from './types';

/** Reads multipart requests with an actual streamed byte ceiling before parsing. */
export async function readSkillMultipart(request: Request): Promise<FormData> {
  const limit = SKILL_LIMITS.maxBundleBytes + 1024 * 1024;
  if (Number(request.headers.get('content-length')) > limit)
    throw new SkillResourceError('Skill upload exceeds 21 MB');
  const reader = request.body?.getReader();
  if (!reader) throw new SkillResourceError('Upload body is missing');
  const deadline = AbortSignal.timeout(120_000);
  const signal = AbortSignal.any([request.signal, deadline]);
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const result = await reader.read();
      signal.throwIfAborted();
      if (result.done) break;
      length += result.value.length;
      if (length > limit) {
        await reader.cancel();
        throw new SkillResourceError('Skill upload exceeds 21 MB');
      }
      chunks.push(result.value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new Response(bytes, {
    headers: { 'Content-Type': request.headers.get('content-type') ?? '' },
  }).formData();
}

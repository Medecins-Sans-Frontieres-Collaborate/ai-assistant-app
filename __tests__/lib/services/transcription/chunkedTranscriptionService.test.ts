import { ChunkedTranscriptionService } from '@/lib/services/transcription/chunkedTranscriptionService';

import { describe, expect, it, vi } from 'vitest';

// Stub the Whisper client so instantiation doesn't require Azure env vars.
vi.mock('@/lib/services/transcription/whisperTranscriptionService', () => ({
  WhisperTranscriptionService: vi.fn().mockImplementation(function (this: any) {
    this.transcribe = vi.fn();
  }),
}));

// `combineTranscripts` is private but it's the one piece of logic worth
// pinning in isolation — the rest of the service talks to Whisper + fs
// and is covered by integration-style tests elsewhere.
type CombineAccess = {
  combineTranscripts: (transcripts: string[], total: number) => string;
};

describe('ChunkedTranscriptionService.combineTranscripts', () => {
  const svc = new ChunkedTranscriptionService() as unknown as CombineAccess;

  it('returns the single transcript verbatim for a one-chunk job', () => {
    expect(svc.combineTranscripts(['hello world'], 1)).toBe('hello world');
  });

  it('adds chunk markers for multi-chunk jobs', () => {
    const combined = svc.combineTranscripts(['a', 'b'], 2);
    expect(combined).toBe('[Chunk 1/2]\na\n\n[Chunk 2/2]\nb');
  });

  it('marks empty chunks as "no speech detected" so the transcript is not silent', () => {
    const combined = svc.combineTranscripts(['hello', '', 'world'], 3);
    expect(combined).toContain(
      '[Chunk 2/3]\n(no speech detected in this segment)',
    );
    expect(combined).toContain('[Chunk 1/3]\nhello');
    expect(combined).toContain('[Chunk 3/3]\nworld');
  });
});

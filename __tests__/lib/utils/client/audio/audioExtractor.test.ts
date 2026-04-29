import { extractAudioFromVideo } from '@/lib/utils/client/audio/audioExtractor';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Captures the singleton's progress listener so the test can drive
// FFmpeg-emitted events directly. The singleton in audioExtractor.ts only
// registers the listener once, so this captures it on the first call.
let progressListener: ((e: { progress: number }) => void) | undefined;

const ffmpegMock = {
  load: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  deleteFile: vi.fn().mockResolvedValue(undefined),
  exec: vi.fn(),
  on: vi.fn((event: string, cb: (e: { progress: number }) => void) => {
    if (event === 'progress') progressListener = cb;
  }),
};

vi.mock('@ffmpeg/ffmpeg', () => ({
  FFmpeg: class {
    load = ffmpegMock.load;
    writeFile = ffmpegMock.writeFile;
    readFile = ffmpegMock.readFile;
    deleteFile = ffmpegMock.deleteFile;
    exec = ffmpegMock.exec;
    on = ffmpegMock.on;
  },
}));

vi.mock('@ffmpeg/util', () => ({
  fetchFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  toBlobURL: vi.fn().mockResolvedValue('blob:fake'),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Lets queued microtasks advance so the next phase of an extraction body
// can run. setTimeout(0) is enough — we need the macrotask boundary so the
// queue's `then` resolves and B's body can start after A returns.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('extractAudioFromVideo — progress isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-attach the listener handler — vi.clearAllMocks() resets the
    // implementation of `on` but the captured listener variable persists.
    ffmpegMock.on.mockImplementation(
      (event: string, cb: (e: { progress: number }) => void) => {
        if (event === 'progress') progressListener = cb;
      },
    );
    ffmpegMock.load.mockResolvedValue(undefined);
    ffmpegMock.writeFile.mockResolvedValue(undefined);
    ffmpegMock.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
    ffmpegMock.deleteFile.mockResolvedValue(undefined);
  });

  it('routes FFmpeg progress events to the active caller across overlapping extractions', async () => {
    // Two pending exec promises — one for each extraction. The queue
    // serializes them, so B.exec only fires after A's body finishes.
    const aExec = deferred<void>();
    const bExec = deferred<void>();
    let execCalls = 0;
    ffmpegMock.exec.mockImplementation(() => {
      execCalls += 1;
      return execCalls === 1 ? aExec.promise : bExec.promise;
    });

    const aProgress = vi.fn();
    const bProgress = vi.fn();
    const aFile = new File([new Uint8Array([0, 1, 2])], 'a.mp4', {
      type: 'video/mp4',
    });
    const bFile = new File([new Uint8Array([0, 1, 2])], 'b.mp4', {
      type: 'video/mp4',
    });

    // Kick off both — B is queued behind A.
    const aPromise = extractAudioFromVideo(aFile, { onProgress: aProgress });
    const bPromise = extractAudioFromVideo(bFile, { onProgress: bProgress });

    // Let A's body run up to its `await ffmpeg.exec(...)`.
    await flush();

    // FFmpeg emits a progress event during A's exec.
    progressListener?.({ progress: 0.5 });

    // Resolve A's exec; A's body finishes and returns.
    aExec.resolve();
    await aPromise;

    // Now B's queued body runs up to its own `await ffmpeg.exec(...)`.
    await flush();

    progressListener?.({ progress: 0.7 });

    bExec.resolve();
    await bPromise;

    // Each callback received its own FFmpeg event, and only its own.
    expect(aProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'extracting', percent: 50 }),
    );
    expect(bProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'extracting', percent: 70 }),
    );
    expect(aProgress).not.toHaveBeenCalledWith(
      expect.objectContaining({ percent: 70 }),
    );
    expect(bProgress).not.toHaveBeenCalledWith(
      expect.objectContaining({ percent: 50 }),
    );
  });

  it('does not leak the previous caller’s onProgress when a second extraction starts after the first completes', async () => {
    ffmpegMock.exec.mockResolvedValue(undefined);

    const firstProgress = vi.fn();
    const file = new File([new Uint8Array([0, 1, 2])], 'first.mp4', {
      type: 'video/mp4',
    });
    await extractAudioFromVideo(file, { onProgress: firstProgress });

    // Second extraction with no onProgress. If `currentOnProgress` wasn't
    // cleared, a FFmpeg progress event would still call firstProgress.
    const secondFile = new File([new Uint8Array([3, 4, 5])], 'second.mp4', {
      type: 'video/mp4',
    });
    const secondPromise = extractAudioFromVideo(secondFile);
    await flush();

    firstProgress.mockClear();
    progressListener?.({ progress: 0.42 });

    await secondPromise;

    expect(firstProgress).not.toHaveBeenCalled();
  });
});

import {
  SAVE_ATTEMPTS,
  SAVE_RETRY_DELAY_MS,
  adoptRun,
  dropRunSession,
  findRunSession,
  openRunSession,
  resetRunSessions,
} from '@/client/services/workflows/nativeRunSession';
import {
  RunLockedError,
  RunMissingError,
  deleteRun,
  loadRunRecord,
  saveRunRecord,
  syncRun,
} from '@/client/services/workflows/nativeRunStorage';

import { FormattedDocumentRun } from '@/lib/utils/shared/translation/formattedDocument';
import {
  RUN_KEEP_ALIVE_INTERVAL_MS,
  RUN_SAVE_DELAY_MS,
} from '@/lib/utils/shared/translation/nativeRunStorage';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/services/workflows/nativeRunStorage', async (original) => ({
  ...(await original<
    typeof import('@/client/services/workflows/nativeRunStorage')
  >()),
  loadRunRecord: vi.fn(),
  saveRunRecord: vi.fn(),
  syncRun: vi.fn(),
  deleteRun: vi.fn(),
  // One file per render, named by the run's PDF.
  runFilesInUse: (run: { pdfUrl: string }) => [run.pdfUrl],
}));

const ACCESS = {
  runId: '11111111-2222-4333-8444-555555555555',
  backend: 'app' as const,
};
const run = (extra: Partial<FormattedDocumentRun> = {}) =>
  ({ pdfUrl: 'first.pdf', page: 1, ...extra }) as FormattedDocumentRun;
/** Lets promises settle without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetRunSessions();
  vi.mocked(saveRunRecord).mockResolvedValue(undefined);
  vi.mocked(syncRun).mockResolvedValue({});
  vi.mocked(deleteRun).mockResolvedValue(true);
});
afterEach(() => vi.useRealTimers());

describe('opening a run', () => {
  it('loads it once, however many places show it', async () => {
    vi.mocked(loadRunRecord).mockResolvedValue(run());
    const first = openRunSession(ACCESS);
    const second = openRunSession(ACCESS);
    expect(second).toBe(first);
    await settle();
    expect(loadRunRecord).toHaveBeenCalledTimes(1);
    expect(first.state.run).toEqual(run());
    // Looking at a run asks when it expires and extends nothing.
    expect(syncRun).toHaveBeenCalledWith(ACCESS, ['first.pdf'], false);
  });

  it('does not read back a run that was just made here', async () => {
    adoptRun(ACCESS, run());
    // A second place showing the run finds it in memory, saved or not.
    const session = openRunSession(ACCESS);
    expect(session.state.run).toEqual(run());
    await settle();
    expect(loadRunRecord).not.toHaveBeenCalled();
    expect(saveRunRecord).toHaveBeenCalledTimes(1);
  });

  it('says why a run cannot be shown', async () => {
    vi.mocked(loadRunRecord).mockRejectedValue(new RunMissingError());
    const missing = openRunSession(ACCESS);
    await settle();
    expect(missing.state.problem).toBe('missing');

    resetRunSessions();
    vi.mocked(loadRunRecord).mockRejectedValue(new RunLockedError('other-key'));
    const locked = openRunSession(ACCESS);
    await settle();
    expect(locked.state.problem).toBe('other-key');

    // Trying again clears the problem when storage answers.
    vi.mocked(loadRunRecord).mockResolvedValue(run());
    locked.load();
    await settle();
    expect(locked.state.problem).toBeNull();
    expect(locked.state.run).toEqual(run());
  });

  it('tells its subscribers of every change, and none after they leave', async () => {
    adoptRun(ACCESS, run());
    const session = openRunSession(ACCESS);
    const heard = vi.fn();
    const leave = session.subscribe(heard);
    session.update((current) => ({ ...current, page: 2 }));
    expect(heard).toHaveBeenCalledTimes(1);
    leave();
    session.update((current) => ({ ...current, page: 3 }));
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('saving a run', () => {
  async function opened() {
    adoptRun(ACCESS, run());
    await settle();
    vi.mocked(saveRunRecord).mockClear();
    vi.mocked(syncRun).mockClear();
    return findRunSession(ACCESS.runId)!;
  }

  it('saves a new run at once and keeps its files', async () => {
    adoptRun(ACCESS, run());
    await settle();
    expect(saveRunRecord).toHaveBeenCalledWith(ACCESS, run());
    expect(syncRun).toHaveBeenCalledWith(ACCESS, ['first.pdf']);
  });

  it('waits for a quiet moment before saving edits, then saves the last', async () => {
    const session = await opened();
    session.update((current) => ({ ...current, page: 2 }));
    session.update((current) => ({ ...current, page: 3 }));
    await vi.advanceTimersByTimeAsync(RUN_SAVE_DELAY_MS - 1);
    expect(saveRunRecord).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(saveRunRecord).toHaveBeenCalledTimes(1);
    expect(saveRunRecord).toHaveBeenCalledWith(ACCESS, run({ page: 3 }));
    // The files were kept alive moments ago: not again yet.
    expect(syncRun).not.toHaveBeenCalled();
  });

  it('saves at once, and clears leftovers, when the files changed', async () => {
    const session = await opened();
    session.update((current) => ({ ...current, pdfUrl: 'second.pdf' }));
    await settle();
    expect(saveRunRecord).toHaveBeenCalledTimes(1);
    expect(syncRun).toHaveBeenCalledWith(ACCESS, ['second.pdf']);
  });

  it('keeps the files alive again once the interval has passed, not before', async () => {
    const session = await opened();
    await vi.advanceTimersByTimeAsync(RUN_KEEP_ALIVE_INTERVAL_MS - 5000);
    session.update((current) => ({ ...current, page: 2 }));
    await vi.advanceTimersByTimeAsync(RUN_SAVE_DELAY_MS);
    expect(syncRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    session.update((current) => ({ ...current, page: 3 }));
    await vi.advanceTimersByTimeAsync(RUN_SAVE_DELAY_MS);
    expect(syncRun).toHaveBeenCalledTimes(1);
  });

  it('never has two saves of one run in flight', async () => {
    const session = await opened();
    let inFlight = 0;
    let most = 0;
    vi.mocked(saveRunRecord).mockImplementation(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 8000));
      inFlight -= 1;
    });
    session.update((current) => ({ ...current, page: 2 }));
    await vi.advanceTimersByTimeAsync(RUN_SAVE_DELAY_MS);
    // A second change is ready while the first save is still on its way.
    session.update((current) => ({ ...current, page: 3 }));
    await vi.advanceTimersByTimeAsync(RUN_SAVE_DELAY_MS);
    expect(saveRunRecord).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(most).toBe(1);
    expect(saveRunRecord).toHaveBeenCalledTimes(2);
    expect(saveRunRecord).toHaveBeenLastCalledWith(ACCESS, run({ page: 3 }));
  });

  it('saves what is pending when asked to flush', async () => {
    const session = await opened();
    session.update((current) => ({ ...current, page: 2 }));
    session.flush();
    await settle();
    expect(saveRunRecord).toHaveBeenCalledWith(ACCESS, run({ page: 2 }));
  });

  it('tries a failed save again, and gives up after a few attempts', async () => {
    const session = await opened();
    vi.mocked(saveRunRecord).mockRejectedValue(new Error('offline'));
    session.update((current) => ({ ...current, page: 2 }));
    await vi.advanceTimersByTimeAsync(RUN_SAVE_DELAY_MS);
    expect(session.state.saveFailed).toBe(true);
    await vi.advanceTimersByTimeAsync(SAVE_RETRY_DELAY_MS * SAVE_ATTEMPTS * 2);
    expect(saveRunRecord).toHaveBeenCalledTimes(SAVE_ATTEMPTS);

    // The next change starts over, and a save that lands clears the notice.
    vi.mocked(saveRunRecord).mockResolvedValue(undefined);
    session.update((current) => ({ ...current, page: 3 }));
    await vi.advanceTimersByTimeAsync(RUN_SAVE_DELAY_MS);
    expect(session.state.saveFailed).toBe(false);
    expect(session.state.run).toEqual(run({ page: 3 }));
  });

  it('reports the run as gone when its files disappeared under it', async () => {
    const session = await opened();
    vi.mocked(syncRun).mockRejectedValue(new RunMissingError());
    await session.keep();
    expect(session.state.problem).toBe('missing');
    expect(session.state.run).toBeUndefined();
    expect(session.state.keeping).toBe(false);
  });

  it('keeping touches the files now and reports the new expiry', async () => {
    const session = await opened();
    vi.mocked(syncRun).mockResolvedValue({ expiresAt: '2026-11-23T00:00:00Z' });
    await session.keep();
    expect(syncRun).toHaveBeenCalledWith(ACCESS, ['first.pdf']);
    expect(session.state.expiresAt).toBe('2026-11-23T00:00:00Z');
  });

  it('dropping a run stops its saves and can delete its files', async () => {
    const session = await opened();
    session.update((current) => ({ ...current, page: 2 }));
    dropRunSession(ACCESS, true);
    await vi.advanceTimersByTimeAsync(RUN_SAVE_DELAY_MS);
    expect(saveRunRecord).not.toHaveBeenCalled();
    expect(deleteRun).toHaveBeenCalledWith(ACCESS);
    expect(findRunSession(ACCESS.runId)).toBeUndefined();
  });
});

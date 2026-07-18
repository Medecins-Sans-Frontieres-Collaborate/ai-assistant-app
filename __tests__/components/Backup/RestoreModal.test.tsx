import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { saveMasterKey } from '@/client/services/backup/keystore';
import { restoreFromRemote } from '@/lib/services/backup/syncEngine';
import type { SyncResult } from '@/lib/services/backup/types';

import { RestoreModal } from '@/components/Backup/RestoreModal';

import { useBackupStore } from '@/client/stores/backupStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/services/backup/keystore', () => ({
  saveMasterKey: vi.fn(() => Promise.resolve()),
  resetBackupKeyCache: vi.fn(),
}));

vi.mock('@/lib/services/backup/syncEngine', () => ({
  restoreFromRemote: vi.fn(),
}));

vi.mock('@/lib/utils/app/backup/backupOps', () => ({
  buildBackupSyncDeps: vi.fn(() => ({ mocked: true })),
}));

// Pinned vector from the crypto slice: key bytes 0x00..0x1f → this code and
// keyId fingerprint.
const PINNED_CODE =
  '000G-40R4-0M30-E209-185G-R38E-1W81-24GK-2GAH-C5RR-34D1-P70X-3RFG-CC6W';
const PINNED_KEY_ID = '42d388eed7a82827';

function syncResult(partial: Partial<SyncResult>): SyncResult {
  return {
    status: 'ok',
    pushed: 0,
    pulled: 0,
    deleted: 0,
    conflictRetries: 0,
    ...partial,
  };
}

async function submitPinnedCode() {
  fireEvent.change(screen.getByLabelText('input.label'), {
    target: { value: PINNED_CODE },
  });
  const submit = screen.getByRole('button', { name: 'restore.submit' });
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);
}

describe('RestoreModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBackupStore.setState({
      remoteKeyId: PINNED_KEY_ID,
      remoteKeyEpoch: 3,
      remoteExists: true,
      enrollmentStatus: 'unset',
    });
  });

  it('prompt branch: shows body, input, and Skip wired to onSkip', () => {
    const onSkip = vi.fn();
    render(<RestoreModal isOpen onSkip={onSkip} onDone={vi.fn()} />);
    expect(screen.getByText('restore.promptBody')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'restore.skip' }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('dismissing the prompt (X) is a skip', () => {
    const onSkip = vi.fn();
    render(<RestoreModal isOpen onSkip={onSkip} onDone={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Close modal'));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('success branch: enrolls, restores, reports the count, Done closes', async () => {
    vi.mocked(restoreFromRemote).mockResolvedValue(
      syncResult({ status: 'ok', pulled: 7 }),
    );
    const onDone = vi.fn();
    render(<RestoreModal isOpen onSkip={vi.fn()} onDone={onDone} />);
    await submitPinnedCode();

    await waitFor(() =>
      expect(screen.getByText('restore.successBody')).toBeInTheDocument(),
    );
    expect(saveMasterKey).toHaveBeenCalledTimes(1);
    const state = useBackupStore.getState();
    expect(state.enrollmentStatus).toBe('enrolled');
    expect(state.localKeyId).toBe(PINNED_KEY_ID);
    expect(state.localKeyEpoch).toBe(3);

    fireEvent.click(screen.getByRole('button', { name: 'restore.close' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('decrypt-fail branch: checksum-valid code with wrong fingerprint never enrolls', async () => {
    useBackupStore.setState({ remoteKeyId: 'ffffffffffffffff' });
    render(<RestoreModal isOpen onSkip={vi.fn()} onDone={vi.fn()} />);
    await submitPinnedCode();

    await waitFor(() =>
      expect(screen.getByText('restore.wrongKey')).toBeInTheDocument(),
    );
    expect(saveMasterKey).not.toHaveBeenCalled();
    expect(restoreFromRemote).not.toHaveBeenCalled();
    expect(useBackupStore.getState().enrollmentStatus).toBe('unset');

    // "Try another key" returns to the prompt.
    fireEvent.click(screen.getByRole('button', { name: 'restore.tryAgain' }));
    expect(screen.getByText('restore.promptBody')).toBeInTheDocument();
  });

  it('decrypt-fail branch: engine key-out-of-date maps to the wrong-key copy', async () => {
    vi.mocked(restoreFromRemote).mockResolvedValue(
      syncResult({ status: 'key-out-of-date' }),
    );
    render(<RestoreModal isOpen onSkip={vi.fn()} onDone={vi.fn()} />);
    await submitPinnedCode();
    await waitFor(() =>
      expect(screen.getByText('restore.wrongKey')).toBeInTheDocument(),
    );
  });

  it('corrupt branch: a failed restore under the right key shows corrupt copy', async () => {
    vi.mocked(restoreFromRemote).mockResolvedValue(
      syncResult({
        status: 'error',
        error: 'integrity failure',
        errorCode: 'UNKNOWN',
      }),
    );
    render(<RestoreModal isOpen onSkip={vi.fn()} onDone={vi.fn()} />);
    await submitPinnedCode();
    await waitFor(() =>
      expect(screen.getByText('restore.corrupt')).toBeInTheDocument(),
    );
  });

  it('network-error branch when the remote status cannot be fetched', async () => {
    useBackupStore.setState({
      remoteKeyId: null,
      refreshRemoteStatus: vi.fn(() => Promise.resolve(null)),
    });
    render(<RestoreModal isOpen onSkip={vi.fn()} onDone={vi.fn()} />);
    await submitPinnedCode();
    await waitFor(() =>
      expect(screen.getByText('restore.networkError')).toBeInTheDocument(),
    );
    expect(saveMasterKey).not.toHaveBeenCalled();
  });
});

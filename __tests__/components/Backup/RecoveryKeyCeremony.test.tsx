import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { loadMasterKey } from '@/client/services/backup/keystore';

import { RecoveryKeyCeremony } from '@/components/Backup/RecoveryKeyCeremony';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/services/backup/keystore', () => ({
  loadMasterKey: vi.fn(),
}));

// Pinned vector from the crypto slice: key bytes 0x00..0x1f.
const PINNED_KEY = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
const PINNED_CODE =
  '000G-40R4-0M30-E209-185G-R38E-1W81-24GK-2GAH-C5RR-34D1-P70X-3RFG-CC6W';

const writeText = vi.fn(() => Promise.resolve());

describe('RecoveryKeyCeremony', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, { clipboard: { writeText } });
    // Blob-anchor download plumbing.
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function renderCreate(
    overrides: {
      onContinue?: () => void;
      onClose?: () => void;
    } = {},
  ) {
    const onContinue = overrides.onContinue ?? vi.fn();
    const onClose = overrides.onClose ?? vi.fn();
    render(
      <RecoveryKeyCeremony
        isOpen
        mode="create"
        masterKey={PINNED_KEY}
        onContinue={onContinue}
        onClose={onClose}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('recovery-code')).toHaveTextContent(
        PINNED_CODE,
      ),
    );
    return { onContinue, onClose };
  }

  it('renders the encoded recovery code for the supplied master key', async () => {
    await renderCreate();
  });

  it('enforces the save-gating sequence: copy/download → checkbox → continue', async () => {
    const { onContinue } = await renderCreate();

    const checkbox = screen.getByRole('checkbox');
    const continueButton = screen.getByRole('button', {
      name: 'ceremony.continue',
    });
    expect(checkbox).toBeDisabled();
    expect(continueButton).toBeDisabled();

    // Checkbox unlocks only after Copy (or Download).
    fireEvent.click(screen.getByRole('button', { name: 'ceremony.copy' }));
    await waitFor(() => expect(checkbox).toBeEnabled());
    expect(writeText).toHaveBeenCalledWith(PINNED_CODE);
    expect(continueButton).toBeDisabled();

    // Continue unlocks only after the checkbox is ticked.
    fireEvent.click(checkbox);
    expect(continueButton).toBeEnabled();
    fireEvent.click(continueButton);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('unlocks the checkbox via Download too, with the dated filename', async () => {
    let capturedDownload: string | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      capturedDownload = this.download;
    });
    await renderCreate();

    fireEvent.click(screen.getByRole('button', { name: 'ceremony.download' }));
    expect(capturedDownload).toMatch(
      /^chat-backup-recovery-key_\d{4}-\d{2}-\d{2}\.txt$/,
    );
    expect(screen.getByRole('checkbox')).toBeEnabled();
  });

  it('blocks ESC and shows no close button in create mode', async () => {
    const { onClose } = await renderCreate();

    expect(screen.queryByLabelText('Close modal')).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    // No cancel confirm opened either.
    expect(
      screen.queryByText('ceremony.cancelConfirmTitle'),
    ).not.toBeInTheDocument();
  });

  it('routes Cancel through a ConfirmDialog before closing', async () => {
    const { onClose } = await renderCreate();

    fireEvent.click(screen.getByRole('button', { name: 'ceremony.cancel' }));
    expect(screen.getByText('ceremony.cancelConfirmTitle')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    // Dismiss keeps the ceremony open.
    fireEvent.click(
      screen.getByRole('button', { name: 'ceremony.cancelConfirmDismiss' }),
    );
    expect(onClose).not.toHaveBeenCalled();

    // Confirm actually cancels.
    fireEvent.click(screen.getByRole('button', { name: 'ceremony.cancel' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'ceremony.cancelConfirmConfirm' }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('toggles the QR code', async () => {
    await renderCreate();
    expect(document.querySelector('svg path')).not.toBeNull(); // icons exist
    expect(screen.queryByRole('img')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'ceremony.showQr' }));
    expect(screen.getByRole('img')).toBeInTheDocument(); // QRCodeSVG has role="img"
    fireEvent.click(screen.getByRole('button', { name: 'ceremony.hideQr' }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('view mode loads the key from the keystore, skips gating, allows closing', async () => {
    vi.mocked(loadMasterKey).mockResolvedValue(new Uint8Array(PINNED_KEY));
    const onClose = vi.fn();
    const onContinue = vi.fn();
    render(
      <RecoveryKeyCeremony
        isOpen
        mode="view"
        masterKey={null}
        onContinue={onContinue}
        onClose={onClose}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('recovery-code')).toHaveTextContent(
        PINNED_CODE,
      ),
    );
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Close modal')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ceremony.done' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('view mode shows an error when the keystore has no key', async () => {
    vi.mocked(loadMasterKey).mockResolvedValue(null);
    render(
      <RecoveryKeyCeremony
        isOpen
        mode="view"
        masterKey={null}
        onContinue={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText('ceremony.loadError')).toBeInTheDocument(),
    );
  });
});

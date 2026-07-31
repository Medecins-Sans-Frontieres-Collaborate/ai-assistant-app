/**
 * Destination dialog for "Save to OneDrive": filename prefill + extension
 * re-append, remember-folder wiring into settingsStore, inline error
 * handling, and the never-stacked Change… hand-off to the folder picker.
 * Translations resolve to raw key names via the global next-intl mock.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { M365SavePayload } from '@/client/hooks/document/useM365Save';

import { saveToOneDrive } from '@/client/services/m365/m365Client';

import type { M365SaveDestination } from '@/types/m365';

import M365SaveDestinationModal from '@/components/Chat/ChatInput/M365SaveDestinationModal';

import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => ({}),
}));

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(() => 'toast-1'),
    dismiss: vi.fn(),
  }),
}));

vi.mock('@/client/services/m365/m365Client', () => {
  class M365ClientError extends Error {
    constructor(
      message: string,
      readonly code?: string,
    ) {
      super(message);
      this.name = 'M365ClientError';
    }
  }
  return {
    M365_SEARCH_DEBOUNCE_MS: 300,
    M365_SEARCH_MIN_CHARS: 2,
    M365ClientError,
    saveToOneDrive: vi.fn(),
  };
});

// The real picker drags in the whole browse stack; the dialog only needs its
// open/close/pick contract.
vi.mock('@/components/Chat/ChatInput/M365FilePickerModal', () => ({
  default: ({
    isOpen,
    onPickFolder,
  }: {
    isOpen: boolean;
    onPickFolder?: (destination: M365SaveDestination) => void;
  }) =>
    isOpen ? (
      <button
        type="button"
        onClick={() =>
          onPickFolder?.({
            driveId: 'd9',
            itemId: 'f9',
            name: 'Reports',
            pathLabel: 'SharePoint › Marketing › Reports',
          })
        }
      >
        stub-pick-folder
      </button>
    ) : null,
}));

const saveToOneDriveMock = vi.mocked(saveToOneDrive);

function payload(overrides: Partial<M365SavePayload> = {}): M365SavePayload {
  return {
    format: 'md',
    html: '',
    baseFileName: 'notes',
    markdownSource: '# hi',
    ...overrides,
  };
}

function renderDialog(props: { onClose?: () => void } = {}) {
  return render(
    <M365SaveDestinationModal
      isOpen
      onClose={props.onClose ?? vi.fn()}
      payload={payload()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({
    m365SaveDestination: null,
    m365SaveSkipPicker: false,
  });
  saveToOneDriveMock.mockResolvedValue({ name: 'notes.md' });
});

describe('M365SaveDestinationModal', () => {
  it('prefills and focuses the filename and shows the default destination', () => {
    renderDialog();
    const input = screen.getByLabelText('fileNameLabel');
    expect(input).toHaveValue('notes.md');
    expect(input).toHaveFocus();
    expect(screen.getByText('defaultFolderName')).toBeInTheDocument();
    expect(screen.getByText('defaultFolderPath')).toBeInTheDocument();
  });

  it('disables Save with helper text when the name is blank', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('fileNameLabel'), {
      target: { value: '   ' },
    });
    expect(screen.getByText('saveButton')).toBeDisabled();
    expect(screen.getByText('fileNameRequired')).toBeInTheDocument();
    expect(saveToOneDriveMock).not.toHaveBeenCalled();
  });

  it('re-appends the format extension when the typed name lacks one', async () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.change(screen.getByLabelText('fileNameLabel'), {
      target: { value: 'meeting notes' },
    });
    fireEvent.click(screen.getByText('saveButton'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(saveToOneDriveMock).toHaveBeenCalledWith(
      expect.any(Blob),
      'meeting notes.md',
      undefined,
    );
  });

  it('persists the remember toggle and picked destination on success', async () => {
    const onClose = vi.fn();
    renderDialog({ onClose });

    // Change… hides the dialog (state intact) and shows the picker instead.
    fireEvent.click(screen.getByText('changeFolder'));
    expect(screen.queryByText('dialogTitle')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('stub-pick-folder'));
    expect(screen.getByText('dialogTitle')).toBeInTheDocument();
    expect(screen.getByText('Reports')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('rememberFolder'));
    fireEvent.click(screen.getByText('saveButton'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(saveToOneDriveMock).toHaveBeenCalledWith(
      expect.any(Blob),
      'notes.md',
      { driveId: 'd9', parentId: 'f9' },
    );
    expect(useSettingsStore.getState().m365SaveDestination).toMatchObject({
      driveId: 'd9',
      itemId: 'f9',
    });
    expect(useSettingsStore.getState().m365SaveSkipPicker).toBe(true);
  });

  it.each([
    ['M365_NOT_FOUND', 'destinationMissing'],
    ['M365_FORBIDDEN', 'destinationForbidden'],
    ['M365_CONSENT_MISSING', 'consentMissing'],
    ['NETWORK', 'network'],
  ])('stays open with an inline error for %s', async (code, key) => {
    const { M365ClientError } =
      await import('@/client/services/m365/m365Client');
    saveToOneDriveMock.mockRejectedValue(new M365ClientError('boom', code));
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.click(screen.getByText('saveButton'));
    await screen.findByText(key);
    expect(onClose).not.toHaveBeenCalled();
    // Failure must not flip the preference to auto-save.
    expect(useSettingsStore.getState().m365SaveSkipPicker).toBe(false);
  });
});

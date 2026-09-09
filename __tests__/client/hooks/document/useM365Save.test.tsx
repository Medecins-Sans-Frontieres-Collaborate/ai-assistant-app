/**
 * Controller behavior of useM365Save: dialog-first by default, one-click
 * auto-save to the remembered destination once skip-picker is on, and the
 * Choose-folder recovery when that destination has gone stale.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import toast from 'react-hot-toast';

import { useM365Save } from '@/client/hooks/document/useM365Save';

import { saveToOneDrive } from '@/client/services/m365/m365Client';

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

vi.mock('@/components/Chat/ChatInput/M365SaveDestinationModal', () => ({
  default: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div>stub-save-dialog</div> : null,
}));

const saveToOneDriveMock = vi.mocked(saveToOneDrive);

function Harness() {
  const { save, dialog } = useM365Save();
  return (
    <div>
      <button
        type="button"
        onClick={() => void save('md', '', 'notes', '# hi')}
      >
        trigger-save
      </button>
      {dialog}
    </div>
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

describe('useM365Save', () => {
  it('opens the dialog instead of uploading while skip-picker is off', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('trigger-save'));
    await screen.findByText('stub-save-dialog');
    expect(saveToOneDriveMock).not.toHaveBeenCalled();
  });

  it('auto-saves to the remembered destination (null itemId omits parentId)', async () => {
    useSettingsStore.setState({
      m365SaveSkipPicker: true,
      m365SaveDestination: {
        driveId: 'd1',
        itemId: null,
        name: 'Documents',
        pathLabel: 'SharePoint › Marketing › Documents',
      },
    });
    render(<Harness />);
    fireEvent.click(screen.getByText('trigger-save'));
    await waitFor(() =>
      expect(saveToOneDriveMock).toHaveBeenCalledWith(
        expect.any(Blob),
        'notes.md',
        { driveId: 'd1' },
      ),
    );
    expect(screen.queryByText('stub-save-dialog')).not.toBeInTheDocument();
    expect(vi.mocked(toast.success)).toHaveBeenCalled();
  });

  it('recovers from a stale destination via the Choose-folder toast action', async () => {
    const { M365ClientError } =
      await import('@/client/services/m365/m365Client');
    useSettingsStore.setState({
      m365SaveSkipPicker: true,
      m365SaveDestination: {
        driveId: 'd1',
        itemId: 'gone',
        name: 'Old',
        pathLabel: 'OneDrive › Old',
      },
    });
    saveToOneDriveMock.mockRejectedValue(
      new M365ClientError('missing', 'M365_NOT_FOUND'),
    );
    render(<Harness />);
    fireEvent.click(screen.getByText('trigger-save'));
    const errorMock = vi.mocked(toast.error);
    await waitFor(() => expect(errorMock).toHaveBeenCalled());

    // The toast body carries the recovery action; render it and click.
    render(<div>{errorMock.mock.calls[0][0] as React.ReactElement}</div>);
    fireEvent.click(screen.getByText('chooseFolder'));
    await screen.findByText('stub-save-dialog');
  });
});

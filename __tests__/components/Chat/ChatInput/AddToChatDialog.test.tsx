// ───────────────────────────────────────────────────────────────────
// AddToChatDialog — the single "Add to chat" picker. Under test: which
// sources it lists and disables, where it opens, and what ticking
// OneDrive / SharePoint files allows. The hosted browsers (OneDrive, mail,
// meetings, link) are stubbed: they are covered by their own suites.
// ───────────────────────────────────────────────────────────────────
import { fireEvent, render, screen, within } from '@testing-library/react';

import type {
  AddIntent,
  AddToChatCapabilities,
} from '@/lib/utils/app/addToChat';

import type { M365DriveEntry } from '@/types/m365';

import AddToChatDialog from '@/components/Chat/ChatInput/AddToChatDialog';

import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const attachDriveItem = vi.fn();
vi.mock('@/client/hooks/chat/useM365Attachment', () => ({
  useM365Attachment: () => ({ attachDriveItem }),
}));

const toastError = vi.hoisted(() => vi.fn());
vi.mock('react-hot-toast', () => ({ default: { error: toastError } }));

const entry = (name: string): M365DriveEntry =>
  ({ driveId: 'd', itemId: name, name, isFolder: false }) as M365DriveEntry;

const DOCUMENT = entry('notes.docx');
const SECOND_DOCUMENT = entry('budget.docx');
const VIDEO = entry('call.mp4');
const LISTED = [DOCUMENT, SECOND_DOCUMENT, VIDEO];

// Stand-in for the OneDrive browser: one tick box and one row button per
// file, wired to the hosted-selection contract the real body honours.
vi.mock('@/components/Chat/ChatInput/M365FilePickerModal', () => ({
  M365FilePickerBody: ({
    acceptExtensions,
    hosted,
  }: {
    acceptExtensions?: readonly string[];
    hosted: {
      selected: Map<string, M365DriveEntry>;
      onChange: (next: Map<string, M365DriveEntry>) => void;
      onActivate: (entry: M365DriveEntry) => void;
    };
  }) => (
    <div
      data-testid="onedrive-pane"
      data-accept={acceptExtensions?.join(',') ?? 'any'}
    >
      {LISTED.map((item) => {
        const key = `${item.driveId}/${item.itemId}`;
        return (
          <div key={key}>
            <input
              type="checkbox"
              aria-label={`tick ${item.name}`}
              checked={hosted.selected.has(key)}
              onChange={() => {
                const next = new Map(hosted.selected);
                if (next.has(key)) next.delete(key);
                else next.set(key, item);
                hosted.onChange(next);
              }}
            />
            <button type="button" onClick={() => hosted.onActivate(item)}>
              {`open ${item.name}`}
            </button>
          </div>
        );
      })}
    </div>
  ),
}));
vi.mock('@/components/Chat/ChatInput/M365MailImportModal', () => ({
  M365MailImportBody: () => <div data-testid="mail-pane" />,
}));
vi.mock('@/components/Chat/ChatInput/M365MeetingImportModal', () => ({
  M365MeetingImportBody: () => <div data-testid="meetings-pane" />,
}));
vi.mock('@/components/Chat/ChatInput/UrlAttachModal', () => ({
  UrlAttachForm: () => <div data-testid="link-pane" />,
}));

const EVERYTHING: AddToChatCapabilities = {
  camera: true,
  m365Files: true,
  m365Mail: true,
  m365Meetings: true,
  m365Translation: true,
};

const handlers = {
  onClose: vi.fn(),
  onBrowseDevice: vi.fn(),
  onDeviceFiles: vi.fn(),
  onOpenCamera: vi.fn(),
  onTranslateDriveItem: vi.fn(),
  onImportTranscript: vi.fn(),
};

function open(
  initialIntent: AddIntent = 'attach',
  capabilities: AddToChatCapabilities = EVERYTHING,
) {
  return render(
    <AddToChatDialog
      isOpen
      initialIntent={initialIntent}
      capabilities={capabilities}
      {...handlers}
    />,
  );
}

const sourceButton = (id: string) =>
  document.querySelector(`[data-source-id="${id}"]`) as HTMLButtonElement;

const sourceIds = () =>
  Array.from(document.querySelectorAll('[data-source-id]')).map((node) =>
    node.getAttribute('data-source-id'),
  );

const thenOption = (intent: AddIntent) =>
  within(screen.getByRole('radiogroup')).getByText(
    `selection.intents.${intent}`,
  ) as HTMLButtonElement;

describe('AddToChatDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ addToChatLastSource: null });
  });

  it('renders nothing while closed', () => {
    render(
      <AddToChatDialog
        isOpen={false}
        initialIntent="attach"
        capabilities={EVERYTHING}
        {...handlers}
      />,
    );
    expect(screen.queryByTestId('add-to-chat')).not.toBeInTheDocument();
  });

  describe('sources', () => {
    it('lists every source the person has, device first', () => {
      open();
      expect(sourceIds()).toEqual([
        'device',
        'link',
        'camera',
        'onedrive',
        'mail',
        'meetings',
      ]);
      expect(screen.getByText('microsoft365')).toBeInTheDocument();
    });

    it('lists a single Microsoft 365 source on its own switch', () => {
      open('attach', {
        camera: false,
        m365Files: false,
        m365Mail: true,
        m365Meetings: false,
        m365Translation: false,
      });
      expect(sourceIds()).toEqual(['device', 'link', 'mail']);
    });

    it('opens on this device the first time, with a Browse button', () => {
      open();
      expect(sourceButton('device')).toHaveAttribute('aria-current', 'true');
      fireEvent.click(screen.getByText('device.browse'));
      expect(handlers.onBrowseDevice).toHaveBeenCalledWith('attach');
      // Stays open: cancelling the system dialog must come back here.
      expect(handlers.onClose).not.toHaveBeenCalled();
    });

    it('reopens on the source used last time, and remembers a change', () => {
      useSettingsStore.setState({ addToChatLastSource: 'mail' });
      open();
      expect(screen.getByTestId('mail-pane')).toBeInTheDocument();

      fireEvent.click(sourceButton('meetings'));
      expect(screen.getByTestId('meetings-pane')).toBeInTheDocument();
      expect(useSettingsStore.getState().addToChatLastSource).toBe('meetings');
    });

    it('ignores a remembered source that cannot serve the intent', () => {
      useSettingsStore.setState({ addToChatLastSource: 'mail' });
      open('translate');
      expect(sourceButton('device')).toHaveAttribute('aria-current', 'true');
    });

    it('starts the camera and closes instead of showing a pane', () => {
      open();
      fireEvent.click(sourceButton('camera'));
      expect(handlers.onOpenCamera).toHaveBeenCalledTimes(1);
      expect(handlers.onClose).toHaveBeenCalledTimes(1);
      expect(useSettingsStore.getState().addToChatLastSource).toBeNull();
    });
  });

  describe('opened for one job', () => {
    it('for translating: titles itself, and disables what cannot be translated', () => {
      open('translate');
      expect(screen.getByText('titleTranslate')).toBeInTheDocument();
      expect(sourceButton('device')).toBeEnabled();
      expect(sourceButton('onedrive')).toBeEnabled();
      for (const id of ['link', 'camera', 'mail', 'meetings']) {
        expect(sourceButton(id)).toBeDisabled();
      }
      fireEvent.click(screen.getByText('device.browse'));
      expect(handlers.onBrowseDevice).toHaveBeenCalledWith('translate');
    });

    it('for transcribing: keeps meetings, and narrows OneDrive to audio and video', () => {
      open('transcribe');
      expect(screen.getByText('titleTranscribe')).toBeInTheDocument();
      expect(sourceButton('meetings')).toBeEnabled();
      for (const id of ['link', 'camera', 'mail']) {
        expect(sourceButton(id)).toBeDisabled();
      }
      fireEvent.click(sourceButton('onedrive'));
      const accept = screen.getByTestId('onedrive-pane').dataset.accept ?? '';
      expect(accept.split(',')).toContain('mp4');
      expect(accept.split(',')).not.toContain('docx');
    });

    it('for attaching: accepts any OneDrive file', () => {
      open();
      fireEvent.click(sourceButton('onedrive'));
      expect(screen.getByTestId('onedrive-pane').dataset.accept).toBe('any');
    });
  });

  describe('ticking OneDrive files', () => {
    const openOneDrive = (intent: AddIntent = 'attach') => {
      open(intent);
      fireEvent.click(sourceButton('onedrive'));
    };

    it('shows no "Then" control until something is ticked', () => {
      openOneDrive();
      expect(
        screen.queryByTestId('add-to-chat-selection'),
      ).not.toBeInTheDocument();
    });

    it('one document: Attach is chosen, Translate offered, Transcribe not', () => {
      openOneDrive();
      fireEvent.click(screen.getByLabelText('tick notes.docx'));

      expect(thenOption('attach')).toHaveAttribute('aria-checked', 'true');
      expect(thenOption('translate')).toBeEnabled();
      expect(thenOption('transcribe')).toBeDisabled();

      fireEvent.click(screen.getByText('selection.confirm.attach'));
      expect(attachDriveItem).toHaveBeenCalledWith(DOCUMENT);
      expect(handlers.onTranslateDriveItem).not.toHaveBeenCalled();
      expect(handlers.onClose).toHaveBeenCalledTimes(1);
    });

    it('choosing Translate hands the document to the translation form', () => {
      openOneDrive();
      fireEvent.click(screen.getByLabelText('tick notes.docx'));
      fireEvent.click(thenOption('translate'));

      expect(screen.getByText('titleTranslate')).toBeInTheDocument();
      fireEvent.click(screen.getByText('selection.confirm.translate'));
      expect(handlers.onTranslateDriveItem).toHaveBeenCalledWith(DOCUMENT);
      expect(attachDriveItem).not.toHaveBeenCalled();
      expect(handlers.onClose).toHaveBeenCalledTimes(1);
    });

    it('two documents: Translate is no longer offered, and both attach', () => {
      openOneDrive();
      fireEvent.click(screen.getByLabelText('tick notes.docx'));
      fireEvent.click(screen.getByLabelText('tick budget.docx'));

      expect(thenOption('translate')).toBeDisabled();
      fireEvent.click(screen.getByText('selection.confirm.attach'));
      expect(attachDriveItem).toHaveBeenCalledTimes(2);
    });

    it('while translating, a second tick replaces the first', () => {
      openOneDrive('translate');
      fireEvent.click(screen.getByLabelText('tick notes.docx'));
      fireEvent.click(screen.getByLabelText('tick budget.docx'));

      expect(screen.getByLabelText('tick notes.docx')).not.toBeChecked();
      expect(screen.getByLabelText('tick budget.docx')).toBeChecked();
      fireEvent.click(screen.getByText('selection.confirm.translate'));
      expect(handlers.onTranslateDriveItem).toHaveBeenCalledWith(
        SECOND_DOCUMENT,
      );
    });

    it('a video: Transcribe is offered, Translate is not', () => {
      openOneDrive();
      fireEvent.click(screen.getByLabelText('tick call.mp4'));

      expect(thenOption('transcribe')).toBeEnabled();
      expect(thenOption('translate')).toBeDisabled();
      fireEvent.click(thenOption('transcribe'));
      // Attaching audio or video is how it gets transcribed.
      fireEvent.click(screen.getByText('selection.confirm.transcribe'));
      expect(attachDriveItem).toHaveBeenCalledWith(VIDEO);
    });

    it('Clear empties the selection and hides the control', () => {
      openOneDrive();
      fireEvent.click(screen.getByLabelText('tick notes.docx'));
      fireEvent.click(screen.getByText('clearSelection'));
      expect(
        screen.queryByTestId('add-to-chat-selection'),
      ).not.toBeInTheDocument();
    });

    it('leaves out an action the person can never use', () => {
      open('attach', { ...EVERYTHING, m365Translation: false });
      fireEvent.click(sourceButton('onedrive'));
      fireEvent.click(screen.getByLabelText('tick notes.docx'));
      expect(
        within(screen.getByRole('radiogroup')).queryByText(
          'selection.intents.translate',
        ),
      ).not.toBeInTheDocument();
    });

    it('clicking a row with nothing ticked acts on that file at once', () => {
      openOneDrive();
      fireEvent.click(screen.getByText('open notes.docx'));
      expect(attachDriveItem).toHaveBeenCalledWith(DOCUMENT);
      expect(handlers.onClose).toHaveBeenCalledTimes(1);
    });

    it('clicking a row while translating opens the translation form', () => {
      openOneDrive('translate');
      fireEvent.click(screen.getByText('open notes.docx'));
      expect(handlers.onTranslateDriveItem).toHaveBeenCalledWith(DOCUMENT);
      expect(attachDriveItem).not.toHaveBeenCalled();
    });
  });

  describe('dropped and pasted files', () => {
    const file = (name: string, type = '') => new File(['x'], name, { type });
    const drop = (files: File[]) =>
      fireEvent.drop(screen.getByTestId('add-to-chat'), {
        dataTransfer: { files, types: ['Files'] },
      });

    it('hands dropped files over with the intent and closes', () => {
      open();
      const files = [file('a.docx'), file('b.png')];
      drop(files);
      expect(handlers.onDeviceFiles).toHaveBeenCalledWith(files, 'attach');
      expect(handlers.onClose).toHaveBeenCalledTimes(1);
    });

    it('narrows a drop to what the intent can take', () => {
      open('transcribe');
      const video = file('call.mp4');
      drop([file('a.docx'), video]);
      expect(handlers.onDeviceFiles).toHaveBeenCalledWith(
        [video],
        'transcribe',
      );
    });

    it('refuses a drop with nothing usable, and stays open', () => {
      open('translate');
      drop([file('call.mp4')]);
      expect(handlers.onDeviceFiles).not.toHaveBeenCalled();
      expect(handlers.onClose).not.toHaveBeenCalled();
      expect(toastError).toHaveBeenCalledWith('device.rejected');
    });

    it('ignores a drag that carries no files', () => {
      open();
      fireEvent.drop(screen.getByTestId('add-to-chat'), {
        dataTransfer: { files: [], types: ['text/plain'] },
      });
      expect(handlers.onDeviceFiles).not.toHaveBeenCalled();
      expect(toastError).not.toHaveBeenCalled();
    });

    it('takes pasted files, and leaves pasted text alone', () => {
      open();
      const image = file('shot.png', 'image/png');
      fireEvent.paste(screen.getByTestId('add-to-chat'), {
        clipboardData: { files: [] },
      });
      expect(handlers.onDeviceFiles).not.toHaveBeenCalled();

      fireEvent.paste(screen.getByTestId('add-to-chat'), {
        clipboardData: { files: [image] },
      });
      expect(handlers.onDeviceFiles).toHaveBeenCalledWith([image], 'attach');
    });
  });

  describe('hosted by another surface', () => {
    const onDriveItem = vi.fn();
    const host = {
      title: 'Upload a document',
      sources: ['device', 'onedrive'] as const,
      extensions: ['pdf', 'docx'],
      deviceHint: 'PDF or Word',
      confirmLabel: 'Use this document',
      onDriveItem,
    };
    const openHosted = () =>
      render(
        <AddToChatDialog
          isOpen
          initialIntent="attach"
          capabilities={EVERYTHING}
          onClose={handlers.onClose}
          onBrowseDevice={handlers.onBrowseDevice}
          onDeviceFiles={handlers.onDeviceFiles}
          host={host}
        />,
      );

    it("shows the host's title, hint and sources only", () => {
      openHosted();
      expect(screen.getByText('Upload a document')).toBeInTheDocument();
      expect(screen.getByText('PDF or Word')).toBeInTheDocument();
      expect(sourceIds()).toEqual(['device', 'onedrive']);
    });

    it('does not land on a remembered source the host does not take', () => {
      useSettingsStore.setState({ addToChatLastSource: 'mail' });
      openHosted();
      expect(screen.getByTestId('add-to-chat-device')).toBeInTheDocument();
    });

    it("lands on OneDrive when that was used last, showing the host's file types", () => {
      useSettingsStore.setState({ addToChatLastSource: 'onedrive' });
      openHosted();
      expect(screen.getByTestId('onedrive-pane')).toHaveAttribute(
        'data-accept',
        'pdf,docx',
      );
    });

    it('hands one ticked file to the host and attaches nothing to the chat', () => {
      openHosted();
      fireEvent.click(sourceButton('onedrive'));
      fireEvent.click(screen.getByLabelText('tick notes.docx'));
      // A second tick replaces the first: the host takes one file.
      fireEvent.click(screen.getByLabelText('tick budget.docx'));
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
      fireEvent.click(
        screen.getByRole('button', { name: 'Use this document' }),
      );
      expect(onDriveItem).toHaveBeenCalledTimes(1);
      expect(onDriveItem).toHaveBeenCalledWith(SECOND_DOCUMENT);
      expect(attachDriveItem).not.toHaveBeenCalled();
      expect(handlers.onClose).toHaveBeenCalled();
    });

    it('hands an opened file straight to the host', () => {
      openHosted();
      fireEvent.click(sourceButton('onedrive'));
      fireEvent.click(screen.getByRole('button', { name: 'open notes.docx' }));
      expect(onDriveItem).toHaveBeenCalledWith(DOCUMENT);
      expect(attachDriveItem).not.toHaveBeenCalled();
    });

    it("takes a dropped file of the host's types and refuses any other", () => {
      openHosted();
      const pdf = new File(['x'], 'a.pdf');
      const drop = (files: File[]) =>
        fireEvent.drop(screen.getByTestId('add-to-chat'), {
          dataTransfer: { files, types: ['Files'] },
        });
      drop([new File(['x'], 'a.mp4')]);
      expect(handlers.onDeviceFiles).not.toHaveBeenCalled();
      expect(toastError).toHaveBeenCalledTimes(1);
      drop([new File(['x'], 'b.mp4'), pdf, new File(['x'], 'c.docx')]);
      expect(handlers.onDeviceFiles).toHaveBeenCalledWith([pdf], 'attach');
    });
  });
});

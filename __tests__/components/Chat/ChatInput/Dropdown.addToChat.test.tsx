// ───────────────────────────────────────────────────────────────────
// Dropdown (`+` menu) — how the Add and Do rows change with Microsoft 365:
// switched off, available but not connected, and connected. Without a
// Microsoft 365 source the rows go straight to the system file dialog; with
// one they open the "Add to chat" picker for the right job. The picker and
// the other dialogs are stubbed — only the menu's wiring is under test.
// ───────────────────────────────────────────────────────────────────
import { fireEvent, render, screen } from '@testing-library/react';

import type { AddToChatCapabilities } from '@/lib/utils/app/addToChat';

import Dropdown from '@/components/Chat/ChatInput/Dropdown';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { useUIStore } from '@/client/stores/uiStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/hooks/conversation/useConversations', () => ({
  useConversations: () => ({
    selectedConversation: { id: 'conv-1', messages: [] },
    updateConversation: vi.fn(),
  }),
}));
vi.mock('launchdarkly-react-client-sdk', () => ({ useFlags: () => ({}) }));

const NO_FLAGS = {
  filesEnabled: false,
  mailEnabled: false,
  translationEnabled: false,
  meetingsEnabled: false,
  playbooksEnabled: false,
  toolsEnabled: false,
  digestEnabled: false,
};
const ALL_FLAGS = {
  ...NO_FLAGS,
  filesEnabled: true,
  mailEnabled: true,
  translationEnabled: true,
  meetingsEnabled: true,
};
const environment = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  camera: false,
}));
vi.mock('@/client/hooks/useM365Enabled', () => ({
  useM365Enabled: () => environment.flags,
}));
vi.mock('@/client/hooks/ui/useCameraSupport', () => ({
  useCameraSupport: () => environment.camera,
}));
vi.mock('@/client/hooks/ui/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@/components/Chat/ChatInput/ChatInputFile', () => ({
  useEffectiveDocumentsPerMessage: () => undefined,
}));
vi.mock('@/client/hooks/settings/useAgentToolGates', () => {
  const open = { blocked: false, exhausted: false, low: false };
  return {
    useAgentToolGates: () => ({
      hideWebSearch: false,
      hideCodeInterpreter: false,
    }),
    useToolLimitGates: () => ({
      webSearch: open,
      codeInterpreter: open,
      mcp: open,
      m365: open,
      enforce: false,
    }),
  };
});

const Nothing = vi.hoisted(() => () => null);
// The picker stub reports what it was opened with.
vi.mock('@/components/Chat/ChatInput/AddToChatDialog', () => ({
  default: ({
    isOpen,
    initialIntent,
    capabilities,
  }: {
    isOpen: boolean;
    initialIntent: string;
    capabilities: AddToChatCapabilities;
  }) =>
    isOpen ? (
      <div
        data-testid="picker"
        data-intent={initialIntent}
        data-capabilities={JSON.stringify(capabilities)}
      />
    ) : null,
}));
vi.mock('@/components/Chat/ChatInput/ChatInputDocumentTranslate', () => ({
  default: Nothing,
}));
vi.mock('@/components/Chat/ChatInput/ChatInputImage', () => ({
  default: Nothing,
}));
vi.mock('@/components/Chat/ChatInput/ChatInputImageCapture', () => ({
  default: Nothing,
}));
vi.mock('@/components/Chat/ChatInput/ChatInputTranslate', () => ({
  default: Nothing,
}));
vi.mock('@/components/Chat/ChatInput/UrlAttachModal', () => ({
  default: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="link-modal" /> : null,
}));
vi.mock('@/components/UI/Modal', () => ({ default: Nothing }));
vi.mock('@/components/Chat/DocumentTranslationViewer', () => ({
  formatTranslationReference: () => '',
  formatPendingTranslationReference: () => '',
}));

const row = (id: string) =>
  document.querySelector(`[data-item-id="${id}"]`) as HTMLButtonElement | null;

/** The hidden file input whose accept list contains `marker`. */
const fileInput = (marker: string) =>
  Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
  ).find((input) => input.accept.includes(marker));

const onCameraClick = vi.fn();

function openMenu() {
  render(
    <Dropdown onCameraClick={onCameraClick} tones={[]} handleSend={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole('button', { expanded: false }));
}

const REMOVED_ROWS = [
  'attach-m365',
  'attach-m365-mail',
  'translateM365Document',
  'attachMeeting',
  'aiTools',
];

describe('Dropdown — Add and Do rows across Microsoft 365 states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    environment.flags = NO_FLAGS;
    environment.camera = false;
    useSettingsStore.setState({
      m365Connected: false,
      pinnedToolIds: [],
      hiddenToolIds: [],
      revealedToolIds: [],
      toolUsageCounts: {},
    });
    useUIStore.setState({
      isSettingsOpen: false,
      settingsInitialSection: null,
    });
  });

  describe('switched off for the organisation', () => {
    it('lists the device sources as direct rows and nothing about Microsoft 365', () => {
      environment.camera = true;
      openMenu();

      expect(row('attach')).toHaveTextContent('menu.filesOrPhotos');
      expect(row('attach')).toHaveTextContent('menu.fromThisDevice');
      expect(row('attach-link')).not.toBeNull();
      expect(row('camera')).not.toBeNull();
      expect(row('connect-m365')).toBeNull();
      for (const id of REMOVED_ROWS) expect(row(id)).toBeNull();
    });

    it('leaves the camera row out on a device without one', () => {
      openMenu();
      expect(row('camera')).toBeNull();
    });

    it('goes straight to the system file dialog for each job', () => {
      openMenu();
      const attachInput = fileInput('image/*')!;
      const attachClick = vi.spyOn(attachInput, 'click');
      fireEvent.click(row('attach')!);
      expect(attachClick).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('picker')).not.toBeInTheDocument();
    });

    it('opens the right system dialog for transcribing and translating', () => {
      openMenu();
      // The attach input accepts audio too; the transcribe input is the one
      // that does not accept images.
      const transcribeInput = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
      ).find(
        (input) =>
          input.accept.includes('audio/*') && !input.accept.includes('image/*'),
      )!;
      const transcribeClick = vi.spyOn(transcribeInput, 'click');
      fireEvent.click(row('transcribe')!);
      expect(transcribeClick).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole('button', { expanded: false }));
      const translateInput = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
      ).find((input) => !input.accept.includes('audio/*'))!;
      const translateClick = vi.spyOn(translateInput, 'click');
      fireEvent.click(row('translateDocument')!);
      expect(translateClick).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('picker')).not.toBeInTheDocument();
    });

    it('opens the link dialog and the camera from their own rows', () => {
      environment.camera = true;
      openMenu();
      fireEvent.click(row('attach-link')!);
      expect(screen.getByTestId('link-modal')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { expanded: false }));
      fireEvent.click(row('camera')!);
      expect(onCameraClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('available but not connected', () => {
    beforeEach(() => {
      environment.flags = ALL_FLAGS;
    });

    it('keeps the direct rows and adds one row that leads to connecting', () => {
      openMenu();
      expect(row('attach')).toHaveTextContent('menu.filesOrPhotos');
      expect(row('attach-link')).not.toBeNull();
      expect(row('connect-m365')).toHaveTextContent('menu.connect');

      fireEvent.click(row('connect-m365')!);
      expect(useUIStore.getState().isSettingsOpen).toBe(true);
      expect(useUIStore.getState().settingsInitialSection).toBe('CONNECTIONS');
    });

    it('still uses the system dialog, not the picker', () => {
      openMenu();
      fireEvent.click(row('translateDocument')!);
      expect(screen.queryByTestId('picker')).not.toBeInTheDocument();
    });

    it('offers no connect row when Settings has no Connections pane for it', () => {
      // Only the files and mail features have a place to connect.
      environment.flags = { ...NO_FLAGS, meetingsEnabled: true };
      openMenu();
      expect(row('connect-m365')).toBeNull();
    });
  });

  describe('connected', () => {
    beforeEach(() => {
      environment.flags = ALL_FLAGS;
      environment.camera = true;
      useSettingsStore.setState({ m365Connected: true });
    });

    it('folds every source into one Add to chat row', () => {
      openMenu();
      expect(row('attach')).toHaveTextContent('title');
      expect(row('attach')).toHaveTextContent('menu.addToChatNote');
      for (const id of ['attach-link', 'camera', 'connect-m365']) {
        expect(row(id)).toBeNull();
      }
      for (const id of REMOVED_ROWS) expect(row(id)).toBeNull();
    });

    it.each([
      ['attach', 'attach'],
      ['translateDocument', 'translate'],
      ['transcribe', 'transcribe'],
    ])('the %s row opens the picker for "%s"', (rowId, intent) => {
      openMenu();
      fireEvent.click(row(rowId)!);
      expect(screen.getByTestId('picker')).toHaveAttribute(
        'data-intent',
        intent,
      );
    });

    it('tells the picker what this person can add from', () => {
      openMenu();
      fireEvent.click(row('attach')!);
      expect(
        JSON.parse(screen.getByTestId('picker').dataset.capabilities!),
      ).toEqual({
        camera: true,
        m365Files: true,
        m365Mail: true,
        m365Meetings: true,
        m365Translation: true,
      });
    });

    it('decides per job: mail alone gives attaching a picker, not translating', () => {
      environment.flags = { ...NO_FLAGS, mailEnabled: true };
      openMenu();
      expect(row('attach')).toHaveTextContent('title');

      fireEvent.click(row('translateDocument')!);
      expect(screen.queryByTestId('picker')).not.toBeInTheDocument();
    });

    it('finds the Add to chat row when searching for a source inside it', () => {
      openMenu();
      fireEvent.change(screen.getByRole('searchbox'), {
        target: { value: 'meetings.menuLabel' },
      });
      expect(row('attach')).not.toBeNull();
      expect(row('transcribe')).toBeNull();
    });
  });

  it('groups the rows as Add, Do, In this chat', () => {
    openMenu();
    // Group names are not drawn (grouping is by order and a hairline); they
    // are the groups' accessible names.
    const labels = ['categoryAdd', 'categoryDo', 'categoryChat'].map((key) =>
      screen.getByRole('group', { name: `dropdown.${key}` }),
    );
    for (let i = 1; i < labels.length; i += 1) {
      expect(
        labels[i - 1].compareDocumentPosition(labels[i]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    // The switches sit flat in "In this chat", with no parent to expand.
    expect(row('search')).not.toBeNull();
    expect(row('codeInterpreter')).not.toBeNull();
  });
});

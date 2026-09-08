// ───────────────────────────────────────────────────────────────────
// Dropdown (`+` menu) — admin usage-limit gates (§7.4). A blocked feature
// renders its row disabled with a lock and a reason; the persisted
// composer force reads as unchecked without being rewritten; budget
// annotations ride the row; everything is unchanged when the gates are
// open. Heavy neighbours (modals, LD, M365) are stubbed — only the menu
// rows are under test.
// ───────────────────────────────────────────────────────────────────
import { fireEvent, render, screen } from '@testing-library/react';

import type { Conversation } from '@/types/chat';
import { InterpreterMode } from '@/types/interpreterMode';
import { SearchMode } from '@/types/searchMode';

import Dropdown from '@/components/Chat/ChatInput/Dropdown';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateConversation = vi.fn();
let selectedConversation: Partial<Conversation> | null;

vi.mock('@/client/hooks/conversation/useConversations', () => ({
  useConversations: () => ({ selectedConversation, updateConversation }),
}));

vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => ({}),
}));

vi.mock('@/client/hooks/useM365Enabled', () => ({
  useM365Enabled: () => ({
    filesEnabled: false,
    mailEnabled: false,
    translationEnabled: false,
    meetingsEnabled: false,
    playbooksEnabled: false,
    toolsEnabled: false,
  }),
}));

vi.mock('@/client/hooks/ui/useCameraSupport', () => ({
  useCameraSupport: () => false,
}));
vi.mock('@/client/hooks/ui/useIsMobile', () => ({
  useIsMobile: () => false,
}));

// Dialogs the menu can open — none are exercised here. Hoisted so the
// factories below (themselves hoisted) can see it.
const Nothing = vi.hoisted(() => () => null);
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
vi.mock('@/components/Chat/ChatInput/M365MeetingImportModal', () => ({
  default: Nothing,
}));
vi.mock('@/components/Chat/ChatInput/M365FilePickerModal', () => ({
  default: Nothing,
}));
vi.mock('@/components/Chat/ChatInput/M365MailImportModal', () => ({
  default: Nothing,
}));
vi.mock('@/components/Chat/ChatInput/UrlAttachModal', () => ({
  default: Nothing,
}));
vi.mock('@/components/UI/Modal', () => ({ default: Nothing }));
vi.mock('@/components/Chat/DocumentTranslationViewer', () => ({
  formatTranslationReference: () => '',
  formatPendingTranslationReference: () => '',
}));

type Gate = {
  blocked: boolean;
  exhausted: boolean;
  low: boolean;
  budget?: { remaining: number; limit?: number };
};
const openGate: Gate = { blocked: false, exhausted: false, low: false };
const toolLimits = vi.hoisted(() => ({
  current: {
    webSearch: { blocked: false, exhausted: false, low: false } as {
      blocked: boolean;
      exhausted: boolean;
      low: boolean;
      budget?: { remaining: number; limit?: number };
    },
    codeInterpreter: { blocked: false, exhausted: false, low: false } as {
      blocked: boolean;
      exhausted: boolean;
      low: boolean;
      budget?: { remaining: number; limit?: number };
    },
    mcp: { blocked: false, exhausted: false, low: false },
    m365: { blocked: false, exhausted: false, low: false },
    enforce: false,
  },
}));
vi.mock('@/client/hooks/settings/useAgentToolGates', () => ({
  useAgentToolGates: () => ({
    hideWebSearch: false,
    hideCodeInterpreter: false,
  }),
  useToolLimitGates: () => toolLimits.current,
}));

const row = (id: string) =>
  document.querySelector(`[data-item-id="${id}"]`) as HTMLButtonElement | null;

function openMenu() {
  render(<Dropdown onCameraClick={vi.fn()} tones={[]} handleSend={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { expanded: false }));
}

function expand(parentId: string) {
  const parent = row(parentId);
  expect(parent).not.toBeNull();
  fireEvent.click(parent!);
}

describe('Dropdown — usage-limit gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectedConversation = { id: 'conv-1' };
    toolLimits.current = {
      webSearch: openGate,
      codeInterpreter: openGate,
      mcp: openGate,
      m365: openGate,
      enforce: false,
    };
    useChatInputStore.setState({
      searchMode: SearchMode.ALWAYS,
      interpreterMode: InterpreterMode.ALWAYS,
    });
    useSettingsStore.setState({
      mcpServers: [
        { id: 's1', name: 'GitHub', enabled: true, authMode: 'none' },
      ] as unknown as ReturnType<
        typeof useSettingsStore.getState
      >['mcpServers'],
      m365Connected: false,
      pinnedToolIds: [],
      hiddenToolIds: [],
      revealedToolIds: [],
      toolUsageCounts: {},
    });
  });

  it('a blocked web search renders locked and unchecked without rewriting the composer force', () => {
    toolLimits.current = {
      ...toolLimits.current,
      enforce: true,
      webSearch: { blocked: true, exhausted: false, low: false },
    };
    openMenu();
    expand('aiTools');

    const search = row('search');
    expect(search).toBeDisabled();
    expect(search).toHaveAttribute('aria-checked', 'false');
    expect(search).toHaveAttribute('title', 'blocked');
    expect(screen.getByTestId('dropdown-lock-search')).toBeInTheDocument();
    // The sibling toggle is untouched.
    const interpreter = row('codeInterpreter');
    expect(interpreter).toBeEnabled();
    expect(interpreter).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('dropdown-lock-codeInterpreter')).toBeNull();

    fireEvent.click(search!);
    expect(useChatInputStore.getState().searchMode).toBe(SearchMode.ALWAYS);
  });

  it('a blocked interpreter locks its row', () => {
    toolLimits.current = {
      ...toolLimits.current,
      enforce: true,
      codeInterpreter: { blocked: true, exhausted: false, low: false },
    };
    openMenu();
    expand('aiTools');

    expect(row('codeInterpreter')).toBeDisabled();
    expect(
      screen.getByTestId('dropdown-lock-codeInterpreter'),
    ).toBeInTheDocument();
    expect(row('search')).toBeEnabled();
    expect(useChatInputStore.getState().interpreterMode).toBe(
      InterpreterMode.ALWAYS,
    );
  });

  it('budget annotations ride the row and leave the toggle usable', () => {
    toolLimits.current = {
      ...toolLimits.current,
      enforce: true,
      webSearch: {
        blocked: false,
        exhausted: false,
        low: true,
        budget: { remaining: 1, limit: 10 },
      },
      codeInterpreter: {
        blocked: false,
        exhausted: true,
        low: false,
        budget: { remaining: 0, limit: 5 },
      },
    };
    openMenu();
    expand('aiTools');

    expect(screen.getByText('remaining')).toBeInTheDocument();
    expect(screen.getByText('exhausted')).toBeInTheDocument();
    expect(row('search')).toBeEnabled();
    expect(row('codeInterpreter')).toBeEnabled();
    expect(screen.queryByTestId('dropdown-lock-search')).toBeNull();

    // Exhausted, not blocked: the toggle still works (the server degrades).
    fireEvent.click(row('codeInterpreter')!);
    expect(useChatInputStore.getState().interpreterMode).toBe(
      InterpreterMode.OFF,
    );
  });

  it('a blocked MCP gate locks every connector child and notes it on the parent', () => {
    toolLimits.current = {
      ...toolLimits.current,
      enforce: true,
      mcp: { blocked: true, exhausted: false, low: false },
      m365: { blocked: true, exhausted: false, low: false },
    };
    openMenu();
    expand('focusConnector');

    const connector = row('connector-s1');
    expect(connector).toBeDisabled();
    expect(connector).toHaveAttribute('aria-checked', 'false');
    expect(
      screen.getByTestId('dropdown-lock-connector-s1'),
    ).toBeInTheDocument();
    // The parent keeps expanding (so the reason is discoverable) and carries
    // the reason as its note; the manage row stays live.
    expect(row('focusConnector')).toBeEnabled();
    expect(screen.getByText('blocked')).toBeInTheDocument();
    expect(row('connector-manage')).toBeEnabled();

    fireEvent.click(connector!);
    expect(updateConversation).not.toHaveBeenCalled();
    expect(
      useSettingsStore.getState().mcpServers.find((s) => s.id === 's1')
        ?.enabled,
    ).toBe(true);
  });

  it("fails open: with the gates open the rows are exactly today's UI", () => {
    openMenu();
    expand('aiTools');
    expand('focusConnector');

    expect(row('search')).toBeEnabled();
    expect(row('search')).toHaveAttribute('aria-checked', 'true');
    expect(row('codeInterpreter')).toBeEnabled();
    expect(row('connector-s1')).toBeEnabled();
    expect(row('connector-s1')).toHaveAttribute('aria-checked', 'true');
    expect(
      document.querySelector('[data-testid^="dropdown-lock-"]'),
    ).toBeNull();
    for (const key of ['blocked', 'remaining', 'exhausted']) {
      expect(screen.queryByText(key)).toBeNull();
    }

    fireEvent.click(row('search')!);
    expect(useChatInputStore.getState().searchMode).toBe(SearchMode.OFF);
  });
});

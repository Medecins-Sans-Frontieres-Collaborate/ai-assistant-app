// ───────────────────────────────────────────────────────────────────
// ToolModeControls — the capabilities tray's TOOLS group. Successor to the
// model picker's SearchModeSection/InterpreterModeSection tests
// (ModelSelect.toggle.test.tsx): search & interpreter as one
// Off / Auto / Always control each, plus the Privacy/Azure-AI routing
// choice on agent-capable models.
// ───────────────────────────────────────────────────────────────────
import { fireEvent, render, screen } from '@testing-library/react';

import type { Conversation } from '@/types/chat';
import { InterpreterMode } from '@/types/interpreterMode';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { ToolModeControls } from '@/components/Chat/ChatInput/ToolModeControls';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateConversation = vi.fn();
let selectedConversation: Partial<Conversation> | null;

vi.mock('@/client/hooks/conversation/useConversations', () => ({
  useConversations: () => ({
    selectedConversation,
    updateConversation,
  }),
}));

const setDefaultSearchMode = vi.fn();
const setDefaultInterpreterMode = vi.fn();

vi.mock('@/client/hooks/settings/useSettings', () => ({
  useSettings: () => ({
    defaultInterpreterMode: 'intelligent',
    setDefaultSearchMode,
    setDefaultInterpreterMode,
  }),
}));

let gates = { hideWebSearch: false, hideCodeInterpreter: false };

// Admin usage-limit gates (§7.4). Open by default so the pre-existing suites
// exercise today's UI; the limits suite below flips them per test.
const openGate = { blocked: false, exhausted: false, low: false };
let toolLimits = {
  webSearch: openGate as {
    blocked: boolean;
    exhausted: boolean;
    low: boolean;
    budget?: { remaining: number; limit?: number; resetAt?: string };
  },
  codeInterpreter: openGate as {
    blocked: boolean;
    exhausted: boolean;
    low: boolean;
    budget?: { remaining: number; limit?: number; resetAt?: string };
  },
  mcp: openGate,
  m365: openGate,
  enforce: false,
};

vi.mock('@/client/hooks/settings/useAgentToolGates', () => ({
  useAgentToolGates: () => gates,
  useToolLimitGates: () => toolLimits,
}));

/** The row div containing a labelled control group. */
function rowFor(label: string): HTMLElement {
  const row = screen.getByText(label).closest('div');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

describe('ToolModeControls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gates = { hideWebSearch: false, hideCodeInterpreter: false };
    toolLimits = {
      webSearch: openGate,
      codeInterpreter: openGate,
      mcp: openGate,
      m365: openGate,
      enforce: false,
    };
    // DeepSeek has no agentId → no Privacy/Azure-AI routing choice.
    selectedConversation = {
      id: 'conv-1',
      model: OpenAIModels[OpenAIModelID.DEEPSEEK_V3_1],
    };
    useChatInputStore.setState({
      searchMode: SearchMode.OFF,
      interpreterMode: InterpreterMode.OFF,
    });
  });

  it('renders both rows with Off/Auto/Always segments', () => {
    render(<ToolModeControls />);

    expect(screen.getByText('Web search')).toBeInTheDocument();
    expect(screen.getByText('Code interpreter')).toBeInTheDocument();
    expect(screen.getAllByText('Off')).toHaveLength(2);
    expect(screen.getAllByText('Auto')).toHaveLength(2);
    expect(screen.getAllByText('Always')).toHaveLength(2);
  });

  it('Off writes the conversation default, the global default, and the composer state', () => {
    selectedConversation = {
      ...selectedConversation,
      defaultSearchMode: SearchMode.INTELLIGENT,
    };
    render(<ToolModeControls />);

    const searchRow = rowFor('Web search');
    fireEvent.click(
      Array.from(searchRow.querySelectorAll('button')).find(
        (b) => b.textContent === 'Off',
      )!,
    );

    expect(updateConversation).toHaveBeenCalledWith('conv-1', {
      defaultSearchMode: SearchMode.OFF,
    });
    expect(setDefaultSearchMode).toHaveBeenCalledWith(SearchMode.OFF);
    expect(useChatInputStore.getState().searchMode).toBe(SearchMode.OFF);
  });

  it('Always only forces the composer state — the conversation default is untouched', () => {
    render(<ToolModeControls />);

    const searchRow = rowFor('Web search');
    fireEvent.click(
      Array.from(searchRow.querySelectorAll('button')).find(
        (b) => b.textContent === 'Always',
      )!,
    );

    expect(useChatInputStore.getState().searchMode).toBe(SearchMode.ALWAYS);
    expect(updateConversation).not.toHaveBeenCalled();
    expect(setDefaultSearchMode).not.toHaveBeenCalled();
  });

  it('interpreter Off mirrors the search semantics', () => {
    render(<ToolModeControls />);

    const row = rowFor('Code interpreter');
    fireEvent.click(
      Array.from(row.querySelectorAll('button')).find(
        (b) => b.textContent === 'Off',
      )!,
    );

    expect(updateConversation).toHaveBeenCalledWith('conv-1', {
      defaultInterpreterMode: InterpreterMode.OFF,
    });
    expect(setDefaultInterpreterMode).toHaveBeenCalledWith(InterpreterMode.OFF);
    expect(useChatInputStore.getState().interpreterMode).toBe(
      InterpreterMode.OFF,
    );
  });

  it('non-agent models get no routing choice', () => {
    render(<ToolModeControls />);

    expect(screen.queryByText('Privacy')).toBeNull();
    expect(screen.queryByText('Azure AI')).toBeNull();
  });

  it('agent-capable models expose Privacy/Azure-AI routing and the privacy note', () => {
    selectedConversation = {
      id: 'conv-1',
      model: OpenAIModels[OpenAIModelID.GPT_4_1],
      defaultSearchMode: SearchMode.INTELLIGENT,
    };
    render(<ToolModeControls />);

    fireEvent.click(screen.getByText('Azure AI'));

    expect(updateConversation).toHaveBeenCalledWith('conv-1', {
      defaultSearchMode: SearchMode.AGENT,
    });
    expect(setDefaultSearchMode).toHaveBeenCalledWith(SearchMode.AGENT);
  });

  it('AGENT routing shows the data-retention note', () => {
    selectedConversation = {
      id: 'conv-1',
      model: OpenAIModels[OpenAIModelID.GPT_4_1],
      defaultSearchMode: SearchMode.AGENT,
    };
    render(<ToolModeControls />);

    expect(
      screen.getByText(/Azure AI Foundry, which may retain them/),
    ).toBeInTheDocument();
  });

  it('routing is hidden while search is Off', () => {
    selectedConversation = {
      id: 'conv-1',
      model: OpenAIModels[OpenAIModelID.GPT_4_1],
      defaultSearchMode: SearchMode.OFF,
    };
    render(<ToolModeControls />);

    expect(screen.queryByText('Privacy')).toBeNull();
  });

  it('agent gates hide their row, and hiding both renders nothing', () => {
    gates = { hideWebSearch: true, hideCodeInterpreter: false };
    const { rerender, container } = render(<ToolModeControls />);
    expect(screen.queryByText('Web search')).toBeNull();
    expect(screen.getByText('Code interpreter')).toBeInTheDocument();

    gates = { hideWebSearch: true, hideCodeInterpreter: true };
    rerender(<ToolModeControls />);
    expect(container).toBeEmptyDOMElement();
  });
});

// ───────────────────────────────────────────────────────────────────
// Admin usage limits (docs/LIMITS_USER_FACING_UX.md §7.4): a blocked
// feature LOCKS its row (disabled, lock icon, reason) and reads as Off
// without rewriting any stored preference; day budgets annotate the row.
// The jsdom next-intl mock returns the bare key for namespaces it does
// not know, so copy is asserted as 'blocked' / 'remaining' / 'exhausted'.
// ───────────────────────────────────────────────────────────────────
describe('ToolModeControls — usage-limit gates', () => {
  const segmentButtons = (label: string) =>
    Array.from(rowFor(label).querySelectorAll('button')).filter((b) =>
      ['Off', 'Auto', 'Always'].includes(b.textContent ?? ''),
    );

  beforeEach(() => {
    vi.clearAllMocks();
    gates = { hideWebSearch: false, hideCodeInterpreter: false };
    toolLimits = {
      webSearch: openGate,
      codeInterpreter: openGate,
      mcp: openGate,
      m365: openGate,
      enforce: false,
    };
    selectedConversation = {
      id: 'conv-1',
      model: OpenAIModels[OpenAIModelID.DEEPSEEK_V3_1],
      defaultSearchMode: SearchMode.INTELLIGENT,
    };
    useChatInputStore.setState({
      searchMode: SearchMode.ALWAYS,
      interpreterMode: InterpreterMode.ALWAYS,
    });
  });

  it('a blocked web search renders disabled with a lock and reads as Off', () => {
    toolLimits = {
      ...toolLimits,
      enforce: true,
      webSearch: { blocked: true, exhausted: false, low: false },
    };
    render(<ToolModeControls />);

    const buttons = segmentButtons('Web search');
    expect(buttons).toHaveLength(3);
    buttons.forEach((b) => expect(b).toBeDisabled());
    // Effective state is Off even though the composer force is ALWAYS...
    expect(buttons.find((b) => b.textContent === 'Off')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('tool-lock-webSearch')).toHaveAttribute(
      'aria-label',
      'blocked',
    );
    // ...and nothing was rewritten.
    expect(useChatInputStore.getState().searchMode).toBe(SearchMode.ALWAYS);
    expect(updateConversation).not.toHaveBeenCalled();
    expect(setDefaultSearchMode).not.toHaveBeenCalled();

    // Clicking a disabled segment is inert.
    fireEvent.click(buttons.find((b) => b.textContent === 'Always')!);
    expect(updateConversation).not.toHaveBeenCalled();
  });

  it('a blocked interpreter locks its row while search stays live', () => {
    toolLimits = {
      ...toolLimits,
      enforce: true,
      codeInterpreter: { blocked: true, exhausted: false, low: false },
    };
    render(<ToolModeControls />);

    segmentButtons('Code interpreter').forEach((b) => expect(b).toBeDisabled());
    expect(screen.getByTestId('tool-lock-codeInterpreter')).toBeInTheDocument();
    segmentButtons('Web search').forEach((b) => expect(b).toBeEnabled());
    expect(screen.queryByTestId('tool-lock-webSearch')).toBeNull();
    expect(useChatInputStore.getState().interpreterMode).toBe(
      InterpreterMode.ALWAYS,
    );
  });

  it('a low budget annotates the row and keeps the toggle enabled', () => {
    toolLimits = {
      ...toolLimits,
      enforce: true,
      webSearch: {
        blocked: false,
        exhausted: false,
        low: true,
        budget: { remaining: 2, limit: 20 },
      },
    };
    render(<ToolModeControls />);

    expect(screen.getByText('remaining')).toBeInTheDocument();
    segmentButtons('Web search').forEach((b) => expect(b).toBeEnabled());
    expect(screen.queryByTestId('tool-lock-webSearch')).toBeNull();
  });

  it('an exhausted budget notes that the model answers without the tool — toggle still enabled', () => {
    toolLimits = {
      ...toolLimits,
      enforce: true,
      codeInterpreter: {
        blocked: false,
        exhausted: true,
        low: false,
        budget: { remaining: 0, limit: 5 },
      },
    };
    render(<ToolModeControls />);

    expect(screen.getByText('exhausted')).toBeInTheDocument();
    const buttons = segmentButtons('Code interpreter');
    buttons.forEach((b) => expect(b).toBeEnabled());
    // Still switchable: the server degrades, it does not refuse.
    fireEvent.click(buttons.find((b) => b.textContent === 'Off')!);
    expect(updateConversation).toHaveBeenCalledWith('conv-1', {
      defaultInterpreterMode: InterpreterMode.OFF,
    });
  });

  it('an exhausted budget with a known resetAt uses the countdown copy instead of the bare notice', () => {
    // The mock t() falls back to the raw key for a namespace it does not
    // carry, so the two variants are distinguishable by which literal key
    // renders — this only proves resetAt is threaded through, not the copy.
    toolLimits = {
      ...toolLimits,
      enforce: true,
      webSearch: {
        blocked: false,
        exhausted: true,
        low: false,
        budget: {
          remaining: 0,
          limit: 20,
          resetAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
        },
      },
    };
    render(<ToolModeControls />);

    expect(screen.getByText('exhaustedResets')).toBeInTheDocument();
    expect(screen.queryByText('exhausted')).toBeNull();
  });

  it('fails open: with every gate open nothing about the row changes', () => {
    render(<ToolModeControls />);

    segmentButtons('Web search').forEach((b) => expect(b).toBeEnabled());
    expect(
      segmentButtons('Web search').find((b) => b.textContent === 'Always'),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('tool-lock-webSearch')).toBeNull();
    for (const key of ['blocked', 'remaining', 'exhausted']) {
      expect(screen.queryByText(key)).toBeNull();
    }
  });

  it('an agent gate still wins: a hidden row is not rendered locked', () => {
    gates = { hideWebSearch: true, hideCodeInterpreter: false };
    toolLimits = {
      ...toolLimits,
      enforce: true,
      webSearch: { blocked: true, exhausted: false, low: false },
    };
    render(<ToolModeControls />);

    expect(screen.queryByText('Web search')).toBeNull();
    expect(screen.queryByTestId('tool-lock-webSearch')).toBeNull();
  });
});

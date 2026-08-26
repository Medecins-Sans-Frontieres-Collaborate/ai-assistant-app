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

vi.mock('@/client/hooks/settings/useAgentToolGates', () => ({
  useAgentToolGates: () => gates,
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

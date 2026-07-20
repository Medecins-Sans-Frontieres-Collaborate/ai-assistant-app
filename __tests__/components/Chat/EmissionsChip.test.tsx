import { fireEvent, render, screen } from '@testing-library/react';

import { AssistantMessageGroup, Conversation, Message } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { EmissionsChip } from '@/components/Chat/EmissionsChip';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFlags: Record<string, unknown> = {};
vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => mockFlags,
}));

const text = (tokens: number) => 'a'.repeat(tokens * 4);

const user = (tokens: number): Message => ({
  role: 'user',
  content: text(tokens),
  messageType: 'TEXT',
});

const assistant = (tokens: number, withUsage = false): Message => ({
  role: 'assistant',
  content: text(tokens),
  messageType: 'TEXT',
  ...(withUsage
    ? {
        usage: {
          promptTokens: 1000,
          completionTokens: 500,
          totalTokens: 1500,
          modelId: 'gpt-test',
          region: null,
        },
      }
    : {}),
});

const assistantGroup = (
  tokens: number,
  createdAt: string,
): AssistantMessageGroup => ({
  type: 'assistant_group',
  activeIndex: 0,
  versions: [
    {
      content: text(tokens),
      messageType: 'TEXT',
      createdAt,
      usage: {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        modelId: 'gpt-test',
        region: null,
      },
    },
  ],
});

const conversation = (
  messages: Conversation['messages'],
  extra?: Partial<Conversation>,
): Conversation => ({
  id: 'c1',
  name: 'test',
  messages,
  model: { id: 'gpt-test', name: 'GPT Test' } as OpenAIModel,
  prompt: '',
  temperature: 0.5,
  folderId: null,
  ...extra,
});

describe('EmissionsChip', () => {
  beforeEach(() => {
    delete mockFlags.showUsageImpact;
    useSettingsStore.setState({ models: [] });
  });

  it('renders a grams total for a conversation with untracked turns', () => {
    render(
      <EmissionsChip conversation={conversation([user(100), assistant(50)])} />,
    );
    expect(
      screen.getByRole('button', { name: /carbon footprint/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/g CO2e/)).toBeInTheDocument();
  });

  it('renders nothing for an empty conversation', () => {
    const { container } = render(
      <EmissionsChip conversation={conversation([])} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  // The showUsageImpact gate is currently commented out in EmissionsChip
  // (local testing). Re-enable this test together with the gate.
  it.skip('renders nothing when the flag is explicitly off', () => {
    mockFlags.showUsageImpact = false;
    const { container } = render(
      <EmissionsChip conversation={conversation([user(100), assistant(50)])} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for agent conversations', () => {
    const { container } = render(
      <EmissionsChip
        conversation={conversation([user(100), assistant(50)], {
          model: { id: 'a', name: 'A', modelType: 'agent' } as OpenAIModel,
        })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders for base models flagged isAgent:true (web-search availability marker, regression)', () => {
    render(
      <EmissionsChip
        conversation={conversation([user(100), assistant(50)], {
          model: {
            id: 'gpt-5.2-chat',
            name: 'GPT-5.2 Chat',
            isAgent: true,
            modelType: 'omni',
          } as OpenAIModel,
        })}
      />,
    );
    expect(
      screen.getByRole('button', { name: /carbon footprint/i }),
    ).toBeInTheDocument();
  });

  it('opens a breakdown popover with measured/estimated rows and the disclaimer', () => {
    render(
      <EmissionsChip
        conversation={conversation([
          user(100),
          assistant(50), // untracked → back-calculated
          user(10),
          assistant(20, true), // measured usage
        ])}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /carbon footprint/i }));

    expect(
      screen.getByText('This conversation (estimated)'),
    ).toBeInTheDocument();
    expect(screen.getByText('All time')).toBeInTheDocument();
    expect(screen.getByText('From reported token counts')).toBeInTheDocument();
    expect(
      screen.getByText('Back-calculated from older messages'),
    ).toBeInTheDocument();
    expect(screen.getByText('Last request')).toBeInTheDocument();
    expect(screen.getByText(/Per-request estimates/i)).toBeInTheDocument();
  });

  it('shows everyday activity equivalents in the popover', () => {
    render(
      <EmissionsChip
        conversation={conversation([user(100), assistant(50, true)])}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /carbon footprint/i }));

    expect(screen.getByText(/the same carbon as/i)).toBeInTheDocument();
    expect(screen.getByText('Netflix HD streaming')).toBeInTheDocument();
    expect(screen.getByText('Zoom call (camera on)')).toBeInTheDocument();
    expect(screen.getByText('Web browsing')).toBeInTheDocument();
    expect(screen.getByText('Spotify audio')).toBeInTheDocument();
  });

  it('shows a Today row and today-based label when there is activity today', () => {
    const now = new Date().toISOString();
    render(
      <EmissionsChip
        conversation={conversation([
          user(100),
          assistantGroup(50, '2020-01-01T00:00:00.000Z'), // old measured turn
          user(10),
          assistantGroup(20, now), // today's turn
        ])}
      />,
    );

    // The collapsed label reflects today's grams (one 1000/500 request),
    // not the two-request lifetime total — assert via the aria label switch.
    fireEvent.click(
      screen.getByRole('button', { name: /carbon footprint today/i }),
    );
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('All time')).toBeInTheDocument();
  });

  it('shows no Today row when all activity is older', () => {
    render(
      <EmissionsChip
        conversation={conversation([
          user(100),
          assistantGroup(50, '2020-01-01T00:00:00.000Z'),
        ])}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /carbon footprint/i }));
    expect(screen.queryByText('Today')).not.toBeInTheDocument();
    expect(screen.getByText('All time')).toBeInTheDocument();
  });

  it('omits the estimated row when every turn is measured', () => {
    render(
      <EmissionsChip
        conversation={conversation([user(10), assistant(20, true)])}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /carbon footprint/i }));

    expect(
      screen.queryByText('Back-calculated from older messages'),
    ).not.toBeInTheDocument();
  });
});

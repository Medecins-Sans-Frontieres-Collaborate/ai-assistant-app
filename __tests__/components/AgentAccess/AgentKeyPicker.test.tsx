import { fireEvent, render, screen } from '@testing-library/react';

import { AgentKeyPicker } from '@/components/AgentAccess/AgentKeyPicker';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockHook = vi.hoisted(() => ({ useDelegatableAgents: vi.fn() }));
vi.mock('@/client/hooks/useDelegatableAgents', () => mockHook);

const groups = [
  {
    id: 'promptAgents',
    unavailable: false,
    options: [
      {
        canonicalKey: 'prompt-agent::pa-1',
        displayName: 'Travel Advisor',
        detail: 'pa-1',
      },
    ],
  },
  {
    id: 'm365Agents',
    unavailable: false,
    options: [
      {
        canonicalKey: 'm365-agent::m365-0123456789ab',
        displayName: 'HR Handbook',
        detail: 'm365-0123456789ab',
      },
    ],
  },
];

beforeEach(() => {
  mockHook.useDelegatableAgents.mockReturnValue({
    groups,
    nameByKey: new Map(
      groups.flatMap((g) =>
        g.options.map((o) => [o.canonicalKey, o.displayName]),
      ),
    ),
  });
});

describe('AgentKeyPicker', () => {
  it('suggests matching agents with their group and adds the picked key', () => {
    const onChange = vi.fn();
    render(<AgentKeyPicker value={[]} onChange={onChange} id="keys" />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'hand' } });
    const option = screen.getByRole('option', { name: /HR Handbook/ });
    expect(option).toHaveTextContent('Microsoft 365 agents');
    expect(screen.queryByRole('option', { name: /Travel Advisor/ })).toBeNull();
    fireEvent.mouseDown(option);
    expect(onChange).toHaveBeenCalledWith(['m365-agent::m365-0123456789ab']);
  });

  it('keeps free text: Enter adds an unlisted key as typed', () => {
    const onChange = vi.fn();
    render(
      <AgentKeyPicker value={['prompt-agent::pa-1']} onChange={onChange} />,
    );
    // Selected keys render as named chips with a remove action.
    expect(screen.getByText('Travel Advisor')).toBeInTheDocument();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'org-agent::custom_thing' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith([
      'prompt-agent::pa-1',
      'org-agent::custom_thing',
    ]);
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove Travel Advisor' }),
    );
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});

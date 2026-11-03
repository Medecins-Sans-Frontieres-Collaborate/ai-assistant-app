/**
 * client/hooks/useGroupNames.ts — the shared, provider-free group name cache.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { FC } from 'react';

import {
  clearGroupNamesForTests,
  collectClientGroupIds,
  formatGroupLabel,
  rememberGroupName,
  seedGroupNames,
  useGroupNames,
} from '@/client/hooks/useGroupNames';

import { lookupEntraGroups } from '@/client/services/m365/m365Client';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/services/m365/m365Client', () => ({
  lookupEntraGroups: vi.fn(),
}));

const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const G3 = '33333333-3333-4333-8333-333333333333';

const Names: FC<{ ids: string[]; testId: string }> = ({ ids, testId }) => {
  const names = useGroupNames(ids);
  return (
    <div data-testid={testId}>
      {ids.map((id) => names[id] ?? `?${id.slice(0, 4)}`).join('|')}
    </div>
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  clearGroupNamesForTests();
  vi.mocked(lookupEntraGroups).mockResolvedValue([]);
});

describe('useGroupNames', () => {
  it('renders seeded names synchronously and never asks the server for them', async () => {
    seedGroupNames({ [G1]: 'Health' });
    render(<Names ids={[G1]} testId="a" />);
    expect(screen.getByTestId('a').textContent).toBe('Health');
    await act(async () => {
      await Promise.resolve();
    });
    expect(lookupEntraGroups).not.toHaveBeenCalled();
  });

  it('resolves unknown ids for every mounted consumer with ONE batched request', async () => {
    vi.mocked(lookupEntraGroups).mockResolvedValue([
      { id: G2, name: 'Two' },
      { id: G3.toUpperCase(), name: 'Three' },
    ]);
    render(
      <>
        <Names ids={[G2]} testId="a" />
        <Names ids={[G2, G3]} testId="b" />
      </>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('b').textContent).toBe('Two|Three'),
    );
    expect(screen.getByTestId('a').textContent).toBe('Two');
    expect(lookupEntraGroups).toHaveBeenCalledTimes(1);
    expect(vi.mocked(lookupEntraGroups).mock.calls[0][0]).toEqual([G2, G3]);
  });

  it('does not re-ask for an id the directory did not answer, and a later remembered name shows up everywhere', async () => {
    render(<Names ids={[G1]} testId="a" />);
    await waitFor(() => expect(lookupEntraGroups).toHaveBeenCalledTimes(1));
    render(<Names ids={[G1]} testId="b" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(lookupEntraGroups).toHaveBeenCalledTimes(1);

    act(() => rememberGroupName(G1, 'One'));
    expect(screen.getByTestId('a').textContent).toBe('One');
    expect(screen.getByTestId('b').textContent).toBe('One');
  });

  it('a failed lookup leaves ids as ids and does not retry on the next mount within the minute', async () => {
    vi.mocked(lookupEntraGroups).mockRejectedValue(new Error('down'));
    render(<Names ids={[G1]} testId="a" />);
    await waitFor(() => expect(lookupEntraGroups).toHaveBeenCalledTimes(1));
    render(<Names ids={[G1]} testId="b" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(lookupEntraGroups).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('b').textContent).toBe(`?${G1.slice(0, 4)}`);
  });
});

describe('helpers', () => {
  it('collectClientGroupIds takes group-scoped overrides, group predicates and grants, lowercased and distinct', () => {
    expect(
      collectClientGroupIds({
        overrides: [
          { scope: 'group', targets: [G1.toUpperCase()] },
          { scope: 'user', targets: ['a@x.org'] },
        ],
        jurisdictions: [[{ scope: 'group', targets: [G1, G2] }]],
        grants: [G3],
      }),
    ).toEqual([G1, G2, G3]);
  });

  it('formatGroupLabel shows the name with an id prefix, or the bare id', () => {
    expect(formatGroupLabel(G1, 'Health')).toBe('Health (11111111…)');
    expect(formatGroupLabel(G1, undefined)).toBe(G1);
  });
});

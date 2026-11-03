import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import type { AdminSkillEntry } from '@/client/hooks/settings/useSkillsAdmin';

import { SkillDocuments } from '@/components/Admin/Skills/SkillDocuments';

import '@testing-library/jest-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const entry: AdminSkillEntry = {
  canonicalKey: 'skill::gdpr',
  etag: '"v1"',
  builtin: false,
  overridden: false,
  skill: {
    id: 'gdpr',
    version: 1,
    name: 'GDPR',
    description: 'Privacy',
    instructions: 'Cite policy',
    activation: 'auto',
    applyToAgents: false,
    updatedAt: '',
    documents: [
      {
        fileId: '11111111-1111-1111-1111-111111111111',
        filename: 'policy.md',
        resourcePath: 'references/policy.md',
        sizeBytes: 5,
        indexStatus: 'pending',
        nextChunk: 0,
      },
    ],
  },
};
describe('admin skill documents', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it('resumes a durable job and stops requesting steps when complete', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { pending: false, busy: false },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const refresh = vi.fn(async () => undefined);
    render(<SkillDocuments entry={entry} refresh={refresh} />);
    fireEvent.click(screen.getByRole('button', { name: /resume/ }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe(
      '/api/agent-access/skills/gdpr/index?retry=true',
    );
  });
  it('removes using the displayed manifest ETag and refreshes after a conflict', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'Skill changed; reload and retry' }),
          { status: 409 },
        ),
      );
    vi.stubGlobal('fetch', fetch);
    const refresh = vi.fn(async () => undefined);
    render(<SkillDocuments entry={entry} refresh={refresh} />);
    fireEvent.click(screen.getByRole('button', { name: /remove.*policy.md/ }));
    await screen.findByRole('alert');
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: 'DELETE',
      headers: { 'if-match': '"v1"' },
    });
    expect(refresh).toHaveBeenCalled();
  });
  it('does not delete a persistent source if the administrator cancels confirmation', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SkillDocuments entry={entry} refresh={async () => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /remove.*policy.md/ }));
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires a saved customization before adding resources to a compiled built-in', () => {
    render(
      <SkillDocuments
        entry={{ ...entry, etag: null, builtin: true }}
        refresh={async () => undefined}
      />,
    );
    expect(screen.getByText(/saveFirst/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/upload/)).not.toBeInTheDocument();
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { ModelSourceForm } from '@/components/Chat/ModelSources/ModelSourceForm';

import { ModelSource, useSettingsStore } from '@/client/stores/settingsStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable LaunchDarkly flags — empty by default (so `agentSourceBrowse` is
// undefined and treated as enabled, i.e. browse discovery available). Individual
// tests flip `agentSourceBrowse` to false to assert the prod manual-only path.
const mockFlags: Record<string, unknown> = {};
vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => mockFlags,
}));

interface TreeFixture {
  subscriptions?: unknown[];
  failedSubscriptions?: unknown[];
  truncated?: boolean;
}

/**
 * Routes the tree-discovery /api/agents/browse?level=tree call (and the
 * connection-check /api/models/sources call) to canned responses by URL.
 */
function stubTreeFetch(routes: { tree?: TreeFixture; models?: unknown[] }) {
  const fn = vi.fn((url: string) => {
    let body: Record<string, unknown> = {};
    if (url.includes('level=tree')) {
      body = {
        subscriptions: [],
        failedSubscriptions: [],
        truncated: false,
        ...routes.tree,
      };
    } else if (url.includes('/api/models/sources?')) {
      // Echo the requested path back so the form's path-match succeeds.
      const sources = new URL(url, 'http://localhost').searchParams.get(
        'sources',
      );
      body = { sources: [{ path: sources, models: routes.models ?? [] }] };
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body),
    } as Response);
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const account = (name: string, resourceGroup: string, location?: string) => ({
  name,
  resourceGroup,
  location,
  projects: [{ name: 'default' }],
});
const subscription = (id: string, name: string, accounts: unknown[]) => ({
  id,
  name,
  accounts,
});

const TWO_ACCOUNT_TREE: TreeFixture = {
  subscriptions: [
    subscription('sub-1', 'Sub One', [
      account('acct-1', 'rg-1', 'westeurope'),
      account('acct-2', 'rg-1'),
    ]),
  ],
};

const MODELS = [
  {
    id: 'byom-hash1-gpt-5-2',
    name: 'GPT-5.2',
    deploymentName: 'gpt-5-2',
    provider: 'openai',
    isCustomSourceModel: true,
  },
  {
    id: 'byom-hash1-my-mistral',
    name: 'my-mistral',
    deploymentName: 'my-mistral',
    provider: 'mistral',
    isCustomSourceModel: true,
  },
];

const ACCT_1_PATH =
  '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.CognitiveServices/accounts/acct-1';

/** Selects the acct-1 row and advances to the model-selection step. */
async function advanceToStep2() {
  const row = await screen.findByRole('radio', { name: /acct-1/ });
  fireEvent.click(row);
  fireEvent.change(screen.getByPlaceholderText('e.g. My Team Sandbox'), {
    target: { value: 'My Source' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  // Step 2 renders the auto-add toggle once validation resolves.
  await screen.findByText('Automatically add new models');
}

describe('ModelSourceForm', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset flags between tests (default: browse enabled).
    for (const k of Object.keys(mockFlags)) delete mockFlags[k];
    useSettingsStore.setState({ customModelSources: [] });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetches the pruned tree and renders accounts grouped by subscription', async () => {
    const fetchFn = stubTreeFetch({ tree: TWO_ACCOUNT_TREE });

    render(<ModelSourceForm onSave={vi.fn()} onClose={vi.fn()} />);

    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith(
        expect.stringContaining('level=tree'),
      ),
    );
    expect(await screen.findByText('Sub One')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /acct-1/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /acct-2/ })).toBeInTheDocument();
  });

  it('shows inline name error and a selection banner when advancing an empty browse form', async () => {
    stubTreeFetch({ tree: TWO_ACCOUNT_TREE });
    const onSave = vi.fn();

    render(<ModelSourceForm onSave={onSave} onClose={vi.fn()} />);

    const next = await screen.findByRole('button', { name: 'Next' });
    fireEvent.click(next);

    expect(
      await screen.findByText('Source name is required'),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('e.g. My Team Sandbox'), {
      target: { value: 'My Source' },
    });
    fireEvent.click(next);
    expect(
      await screen.findByText('Select an account from the list.'),
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('advances to model selection with all deployments checked, and saves exclusions', async () => {
    stubTreeFetch({ tree: TWO_ACCOUNT_TREE, models: MODELS });
    const onSave = vi.fn();

    render(<ModelSourceForm onSave={onSave} onClose={vi.fn()} />);
    await advanceToStep2();

    // Deployment count from the validation call is surfaced.
    expect(
      screen.getByText('Connected — 2 model deployment(s) found'),
    ).toBeInTheDocument();

    const gpt = screen.getByRole('checkbox', { name: /GPT-5.2/ });
    const mistral = screen.getByRole('checkbox', { name: /my-mistral/ });
    expect(gpt).toBeChecked();
    expect(mistral).toBeChecked();

    fireEvent.click(gpt);
    fireEvent.click(screen.getByRole('button', { name: /Connect/ }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'My Source',
        resourcePath: ACCT_1_PATH,
        autoAddNewModels: true,
        excludedModelNames: ['gpt-5-2'],
        selectedModelNames: [],
      }),
    );
  });

  it('saves an explicit allow-list when auto-add is turned off', async () => {
    stubTreeFetch({ tree: TWO_ACCOUNT_TREE, models: MODELS });
    const onSave = vi.fn();

    render(<ModelSourceForm onSave={onSave} onClose={vi.fn()} />);
    await advanceToStep2();

    fireEvent.click(screen.getByRole('checkbox', { name: /my-mistral/ }));
    fireEvent.click(
      screen.getByRole('checkbox', { name: /Automatically add new models/ }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Connect/ }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        autoAddNewModels: false,
        excludedModelNames: [],
        selectedModelNames: ['gpt-5-2'],
      }),
    );
  });

  it('pre-unchecks persisted exclusions when editing an existing source', async () => {
    stubTreeFetch({ tree: TWO_ACCOUNT_TREE, models: MODELS });

    render(
      <ModelSourceForm
        onSave={vi.fn()}
        onClose={vi.fn()}
        existingSource={{
          id: 'src-1',
          name: 'Existing',
          resourcePath: ACCT_1_PATH,
          createdAt: '2026-01-01T00:00:00.000Z',
          autoAddNewModels: true,
          excludedModelNames: ['my-mistral'],
          selectedModelNames: [],
        }}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await screen.findByText('Automatically add new models');

    expect(screen.getByRole('checkbox', { name: /GPT-5.2/ })).toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: /my-mistral/ }),
    ).not.toBeChecked();
  });

  it('blocks connecting an account that is already registered as a source', async () => {
    const fetchFn = stubTreeFetch({ tree: TWO_ACCOUNT_TREE, models: MODELS });
    // Existing source stored with a project-suffixed path: the dedupe must
    // compare stripped ACCOUNT paths, not raw strings.
    const existing: ModelSource = {
      id: 'src-other',
      name: 'Team Sandbox',
      resourcePath: `${ACCT_1_PATH}/projects/default`,
      createdAt: '2026-01-01T00:00:00.000Z',
      autoAddNewModels: true,
      excludedModelNames: [],
      selectedModelNames: [],
    };
    useSettingsStore.setState({ customModelSources: [existing] });
    const onSave = vi.fn();

    render(<ModelSourceForm onSave={onSave} onClose={vi.fn()} />);

    const row = await screen.findByRole('radio', { name: /acct-1/ });
    fireEvent.click(row);
    fireEvent.change(screen.getByPlaceholderText('e.g. My Team Sandbox'), {
      target: { value: 'Duplicate' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(
      await screen.findByText(
        'This account is already connected as "Team Sandbox".',
      ),
    ).toBeInTheDocument();
    // Blocked before the connection check — no discovery call, no save.
    expect(fetchFn).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/models/sources'),
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it('still allows saving when editing the source that owns the account', async () => {
    stubTreeFetch({ tree: TWO_ACCOUNT_TREE, models: MODELS });
    const existing: ModelSource = {
      id: 'src-1',
      name: 'Existing',
      resourcePath: ACCT_1_PATH,
      createdAt: '2026-01-01T00:00:00.000Z',
      autoAddNewModels: true,
      excludedModelNames: [],
      selectedModelNames: [],
    };
    useSettingsStore.setState({ customModelSources: [existing] });
    const onSave = vi.fn();

    render(
      <ModelSourceForm
        onSave={onSave}
        onClose={vi.fn()}
        existingSource={existing}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    // The self-match is exempt from the dedupe: step 2 is reached and saving
    // works.
    await screen.findByText('Automatically add new models');
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'src-1', resourcePath: ACCT_1_PATH }),
    );
  });

  it('hides browse and never calls /api/agents/browse when agentSourceBrowse is false (prod)', async () => {
    mockFlags.agentSourceBrowse = false;
    const fetchFn = stubTreeFetch({ models: MODELS });

    render(<ModelSourceForm onSave={vi.fn()} onClose={vi.fn()} />);

    // Manual entry is forced: the subscription-id input is rendered immediately.
    expect(
      await screen.findByPlaceholderText(
        'e49ac66c-c18d-4586-b132-8f201de8f2c2',
      ),
    ).toBeInTheDocument();
    // No browse toggle in either direction.
    expect(
      screen.queryByRole('button', { name: 'Enter manually' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Browse resources' }),
    ).not.toBeInTheDocument();
    // Crucially, no Azure-resource discovery call is made.
    expect(fetchFn).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/agents/browse'),
    );
  });

  it('still reaches model selection via manual entry when the flag is off', async () => {
    mockFlags.agentSourceBrowse = false;
    stubTreeFetch({ models: MODELS });
    const onSave = vi.fn();

    render(<ModelSourceForm onSave={onSave} onClose={vi.fn()} />);

    fireEvent.change(
      await screen.findByPlaceholderText(
        'e49ac66c-c18d-4586-b132-8f201de8f2c2',
      ),
      { target: { value: 'sub-9' } },
    );
    fireEvent.change(screen.getByPlaceholderText('rg-my-foundry'), {
      target: { value: 'rg-9' },
    });
    fireEvent.change(screen.getByPlaceholderText('my-foundry-account'), {
      target: { value: 'acct-9' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    // The step-2 model picker is not flag-gated.
    await screen.findByText('Automatically add new models');
    expect(screen.getByRole('checkbox', { name: /GPT-5.2/ })).toBeChecked();
  });
});

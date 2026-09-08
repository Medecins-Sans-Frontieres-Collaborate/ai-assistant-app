// ───────────────────────────────────────────────────────────────────
// useToolLimitGates — admin usage-limit gates for the composer's tool
// controls (docs/LIMITS_USER_FACING_UX.md §7.4). Built on WP-B's
// useLimitGates, which is stubbed here so the derivation is tested alone.
// ───────────────────────────────────────────────────────────────────
import { renderHook } from '@testing-library/react';

import {
  CODE_INTERPRETER_ENABLED_KEY,
  CODE_INTERPRETER_RUNS_KEY,
  M365_TOOL_CALLS_KEY,
  MCP_ENABLED_KEY,
  WEB_SEARCH_CALLS_KEY,
  WEB_SEARCH_ENABLED_KEY,
  deriveToolLimitGate,
  getToolLimitGatesSnapshot,
  useToolLimitGates,
} from '@/client/hooks/settings/useAgentToolGates';

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Remaining = { remaining: number; limit?: number; resetAt?: string };

const limitGates = vi.hoisted(() => ({
  enforce: false,
  blocked: new Set<string>(),
  remaining: new Map<string, Remaining>(),
}));

vi.mock('@/client/hooks/settings/useMyLimits', () => ({
  useLimitGates: () => ({
    enforce: limitGates.enforce,
    isFeatureBlocked: (key: string) =>
      limitGates.enforce && limitGates.blocked.has(key),
    featureRemaining: (key: string) =>
      limitGates.enforce ? limitGates.remaining.get(key) : undefined,
  }),
}));

// The agent-gate half of the module pulls conversation + agent hooks; keep
// them inert so importing the module does not need providers.
vi.mock('@/client/hooks/conversation/useConversations', () => ({
  useConversations: () => ({ selectedConversation: null }),
}));
vi.mock('@/client/hooks/settings/useAvailableAgents', () => ({
  useAvailableAgents: () => ({ agents: [] }),
  findAttachedAgent: () => undefined,
}));

describe('deriveToolLimitGate', () => {
  it('without a budget only the block matters', () => {
    expect(deriveToolLimitGate(true)).toEqual({
      blocked: true,
      exhausted: false,
      low: false,
    });
    expect(deriveToolLimitGate(false)).toEqual({
      blocked: false,
      exhausted: false,
      low: false,
    });
  });

  it('low = at or under 10 % of the cap, never less than one', () => {
    expect(deriveToolLimitGate(false, { remaining: 2, limit: 20 }).low).toBe(
      true,
    );
    expect(deriveToolLimitGate(false, { remaining: 3, limit: 20 }).low).toBe(
      false,
    );
    // ceil(0.5) = 1 → the last use of a 5/day cap counts as low.
    expect(deriveToolLimitGate(false, { remaining: 1, limit: 5 }).low).toBe(
      true,
    );
    expect(deriveToolLimitGate(false, { remaining: 2, limit: 5 }).low).toBe(
      false,
    );
  });

  it('without a known cap only the last unit is low', () => {
    expect(deriveToolLimitGate(false, { remaining: 1 }).low).toBe(true);
    expect(deriveToolLimitGate(false, { remaining: 2 }).low).toBe(false);
  });

  it('zero remaining is exhausted, not low, and keeps the budget', () => {
    const budget = { remaining: 0, limit: 20, resetAt: '2026-09-09T00:00:00Z' };
    expect(deriveToolLimitGate(false, budget)).toEqual({
      blocked: false,
      budget,
      exhausted: true,
      low: false,
    });
  });
});

describe('useToolLimitGates', () => {
  beforeEach(() => {
    limitGates.enforce = false;
    limitGates.blocked = new Set();
    limitGates.remaining = new Map();
  });

  it('fails open when not enforced, even with blocked rows present', () => {
    limitGates.blocked = new Set([WEB_SEARCH_ENABLED_KEY, MCP_ENABLED_KEY]);
    limitGates.remaining = new Map([[WEB_SEARCH_CALLS_KEY, { remaining: 0 }]]);
    const { result } = renderHook(() => useToolLimitGates());

    expect(result.current.enforce).toBe(false);
    expect(result.current.webSearch).toEqual({
      blocked: false,
      exhausted: false,
      low: false,
    });
    expect(result.current.mcp.blocked).toBe(false);
    expect(result.current.m365.blocked).toBe(false);
  });

  it('maps each feature key to its gate and budget', () => {
    limitGates.enforce = true;
    limitGates.blocked = new Set([
      WEB_SEARCH_ENABLED_KEY,
      CODE_INTERPRETER_ENABLED_KEY,
    ]);
    limitGates.remaining = new Map([
      [CODE_INTERPRETER_RUNS_KEY, { remaining: 0, limit: 5 }],
      [M365_TOOL_CALLS_KEY, { remaining: 10, limit: 200 }],
    ]);
    const { result } = renderHook(() => useToolLimitGates());

    expect(result.current.enforce).toBe(true);
    expect(result.current.webSearch.blocked).toBe(true);
    expect(result.current.codeInterpreter).toMatchObject({
      blocked: true,
      exhausted: true,
      low: false,
    });
    expect(result.current.mcp.blocked).toBe(false);
    expect(result.current.m365).toMatchObject({
      blocked: false,
      low: true,
      budget: { remaining: 10, limit: 200 },
    });
  });

  it('an MCP block covers the builtin Microsoft 365 toolset as well', () => {
    // The builtin toolset rides the same mcpServers list the middleware
    // gates on, so locking connectors must lock it too.
    limitGates.enforce = true;
    limitGates.blocked = new Set([MCP_ENABLED_KEY]);
    const { result } = renderHook(() => useToolLimitGates());

    expect(result.current.mcp.blocked).toBe(true);
    expect(result.current.m365.blocked).toBe(true);
    expect(result.current.webSearch.blocked).toBe(false);
  });

  it('mirrors the latest derivation into the non-React snapshot', () => {
    limitGates.enforce = true;
    limitGates.blocked = new Set([WEB_SEARCH_ENABLED_KEY]);
    const { rerender, unmount } = renderHook(() => useToolLimitGates());

    expect(getToolLimitGatesSnapshot().webSearch.blocked).toBe(true);

    limitGates.blocked = new Set();
    rerender();
    expect(getToolLimitGatesSnapshot().webSearch.blocked).toBe(false);
    unmount();
  });
});

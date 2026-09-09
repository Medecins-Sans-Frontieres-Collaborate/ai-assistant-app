import {
  RETRY_NUDGE,
  buildPlanSystemAddendum,
  isEmptyToolResult,
  sanitizeMcpPlan,
  stepIndexForTool,
} from '@/lib/services/mcp/mcpPlan';

import { McpPlan } from '@/types/mcp';

import { describe, expect, it } from 'vitest';

const plan: McpPlan = {
  steps: [
    { description: 'Identify the user and their orgs', tools: ['get_me'] },
    {
      description: 'Search open PRs assigned for review',
      tools: ['search_pull_requests', 'list_pull_requests'],
    },
    { description: 'Summarize findings', tools: [] },
  ],
  currentStep: 0,
};

describe('buildPlanSystemAddendum', () => {
  it('renders numbered steps with live progress markers and the retry rule', () => {
    const addendum = buildPlanSystemAddendum(plan);

    expect(addendum).toContain('## Tool Plan for This Turn (step 1 of 3)');
    expect(addendum).toContain(
      '1. [CURRENT] Identify the user and their orgs (tools: get_me)',
    );
    expect(addendum).toContain(
      '2. [pending] Search open PRs assigned for review (tools: search_pull_requests, list_pull_requests)',
    );
    expect(addendum).toContain('3. [pending] Summarize findings');
    expect(addendum).toContain('retry it ONCE');
    // Not on the final step yet — no stop directive
    expect(addendum).not.toContain('FINAL step');
  });

  it('marks completed steps and directs the model to stop after the final step', () => {
    const lastStep: McpPlan = { ...plan, currentStep: 2 };
    const addendum = buildPlanSystemAddendum(lastStep);

    expect(addendum).toContain('(step 3 of 3)');
    expect(addendum).toContain('1. [done]');
    expect(addendum).toContain('2. [done]');
    expect(addendum).toContain('3. [CURRENT] Summarize findings');
    expect(addendum).toContain('FINAL step');
    expect(addendum).toContain('STOP calling tools');
  });
});

describe('stepIndexForTool', () => {
  it('finds the earliest step at or after currentStep', () => {
    expect(stepIndexForTool(plan, 'get_me')).toBe(0);
    expect(stepIndexForTool(plan, 'search_pull_requests')).toBe(1);
  });

  it('never rewinds: an earlier-step tool keeps the current step', () => {
    const advanced: McpPlan = { ...plan, currentStep: 1 };
    expect(stepIndexForTool(advanced, 'get_me')).toBe(1);
  });

  it('returns null for tools no step recommends', () => {
    expect(stepIndexForTool(plan, 'delete_repo')).toBeNull();
  });
});

describe('isEmptyToolResult', () => {
  it('classifies errors and unambiguously empty shapes', () => {
    expect(isEmptyToolResult('Tool failed: boom', true)).toBe(true);
    expect(isEmptyToolResult('', false)).toBe(true);
    expect(isEmptyToolResult('(empty result)', false)).toBe(true);
    expect(isEmptyToolResult('[]', false)).toBe(true);
    expect(isEmptyToolResult('{}', false)).toBe(true);
    expect(isEmptyToolResult('{"items": [], "results": []}', false)).toBe(true);
  });

  it('never flags legitimate answers', () => {
    expect(isEmptyToolResult('No PRs are assigned to you.', false)).toBe(false);
    expect(isEmptyToolResult('{"items": [{"id": 1}]}', false)).toBe(false);
    expect(isEmptyToolResult('{"count": 0}', false)).toBe(false);
    expect(isEmptyToolResult('0', false)).toBe(false);
  });
});

describe('sanitizeMcpPlan', () => {
  it('accepts a valid echoed plan, preserving progress and retry state', () => {
    const echoed = {
      steps: [
        { description: 'a', tools: ['x'], retried: true },
        { description: 'b', tools: [] },
      ],
      currentStep: 1,
    };
    expect(sanitizeMcpPlan(echoed)).toEqual({
      steps: [
        { description: 'a', tools: ['x'], retried: true },
        { description: 'b', tools: [] },
      ],
      currentStep: 1,
    });
  });

  it('clamps out-of-range currentStep and drops malformed steps', () => {
    const result = sanitizeMcpPlan({
      steps: [
        { description: 'ok', tools: ['x'] },
        { description: '', tools: [] },
        { notAStep: true },
      ],
      currentStep: 99,
    });
    expect(result).toEqual({
      steps: [{ description: 'ok', tools: ['x'] }],
      currentStep: 0,
    });
  });

  it('returns null for garbage', () => {
    expect(sanitizeMcpPlan(null)).toBeNull();
    expect(sanitizeMcpPlan('plan')).toBeNull();
    expect(sanitizeMcpPlan({ steps: 'nope' })).toBeNull();
    expect(sanitizeMcpPlan({ steps: [] })).toBeNull();
  });
});

describe('RETRY_NUDGE', () => {
  it('tells the model to retry once with adjusted arguments', () => {
    expect(RETRY_NUDGE).toContain('ONCE');
    expect(RETRY_NUDGE).toContain('adjusted arguments');
  });
});

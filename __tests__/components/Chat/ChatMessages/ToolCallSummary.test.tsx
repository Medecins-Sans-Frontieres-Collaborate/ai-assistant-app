import { fireEvent, render, screen } from '@testing-library/react';

import type { ToolCallRecord } from '@/types/chat';

import { ToolCallSummary } from '@/components/Chat/ChatMessages/ToolCallSummary';

import '@testing-library/jest-dom';
import { describe, expect, it } from 'vitest';

function makeCall(overrides?: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 'call-1',
    name: 'search_tasks',
    server_label: 'Asana',
    arguments: JSON.stringify({ query: 'roadmap' }),
    status: 'completed',
    output: 'result text',
    error: null,
    ...overrides,
  } as ToolCallRecord;
}

function makeInterpreterCall(
  overrides?: Partial<ToolCallRecord>,
): ToolCallRecord {
  return makeCall({
    id: 'ci-1',
    name: 'code_interpreter',
    server_label: 'Code Interpreter (gpt-5.2)',
    arguments: JSON.stringify({ code: 'total = sum([1, 2, 3])\nprint(total)' }),
    output: '6',
    ...overrides,
  });
}

describe('ToolCallSummary', () => {
  it('renders nothing when there are no tool calls', () => {
    const { container } = render(<ToolCallSummary toolCalls={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('starts collapsed for successful runs', () => {
    render(<ToolCallSummary toolCalls={[makeInterpreterCall()]} />);

    expect(
      screen.queryByText('total = sum([1, 2, 3])', { exact: false }),
    ).not.toBeInTheDocument();
  });

  describe('code interpreter transparency', () => {
    it('reveals the executed code with one expand of the strip', () => {
      render(<ToolCallSummary toolCalls={[makeInterpreterCall()]} />);

      // Single click on the "Used 1 tool" strip — the interpreter row
      // must open by default, no second per-row click required.
      fireEvent.click(screen.getByRole('button', { name: /used/i }));

      expect(
        screen.getByText('total = sum([1, 2, 3])', { exact: false }),
      ).toBeInTheDocument();
      expect(screen.getByText('Executed code')).toBeInTheDocument();
    });

    it('labels the run output panel', () => {
      render(<ToolCallSummary toolCalls={[makeInterpreterCall()]} />);

      fireEvent.click(screen.getByRole('button', { name: /used/i }));

      expect(screen.getByText('Output')).toBeInTheDocument();
      expect(screen.getByText('6')).toBeInTheDocument();
    });

    it('renders the code as plain source, not highlighted JSON arguments', () => {
      render(<ToolCallSummary toolCalls={[makeInterpreterCall()]} />);

      fireEvent.click(screen.getByRole('button', { name: /used/i }));

      // The raw arguments JSON wrapper must not leak into the panel.
      expect(
        screen.queryByText('"code"', { exact: false }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText('print(total)', { exact: false }),
      ).toBeInTheDocument();
    });

    it('omits the code panel when arguments carry no code', () => {
      render(
        <ToolCallSummary
          toolCalls={[makeInterpreterCall({ arguments: JSON.stringify({}) })]}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /used/i }));

      expect(screen.queryByText('Executed code')).not.toBeInTheDocument();
    });
  });

  describe('MCP tool rows (unchanged behavior)', () => {
    it('keeps rows collapsed until clicked and shows no code/output labels', () => {
      render(<ToolCallSummary toolCalls={[makeCall()]} />);

      fireEvent.click(screen.getByRole('button', { name: /used/i }));

      // Row details stay closed after only the strip expand.
      expect(screen.queryByText('result text')).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('search_tasks'));

      expect(screen.getByText('result text')).toBeInTheDocument();
      expect(screen.queryByText('Executed code')).not.toBeInTheDocument();
      expect(screen.queryByText('Output')).not.toBeInTheDocument();
    });
  });

  describe('failed runs', () => {
    it('auto-expands strip and row so the error is visible without clicks', () => {
      render(
        <ToolCallSummary
          toolCalls={[
            makeInterpreterCall({
              status: 'failed',
              output: null,
              error: 'NameError: undefined variable',
            }),
          ]}
        />,
      );

      expect(
        screen.getByText('NameError: undefined variable'),
      ).toBeInTheDocument();
      expect(screen.getByText('Executed code')).toBeInTheDocument();
    });
  });
});

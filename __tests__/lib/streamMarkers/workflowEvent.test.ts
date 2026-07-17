import {
  WORKFLOW_EVENT_CLOSE,
  WORKFLOW_EVENT_OPEN,
  emitWorkflowEvent,
  extractWorkflowEvents,
  scanStreamEvents,
  stripIncompleteStreamMarkers,
} from '@/lib/streamMarkers';
import { describe, expect, it } from 'vitest';

const payload = {
  workflow: 'translation' as const,
  type: 'analysis',
  data: { trickyTerms: [] },
};

describe('WORKFLOW_EVENT stream marker', () => {
  it('round-trips through emit + extract', () => {
    const content = `before${emitWorkflowEvent(payload)}after`;
    const { events, cleaned } = extractWorkflowEvents(content);

    expect(events).toEqual([payload]);
    expect(cleaned).not.toContain(WORKFLOW_EVENT_OPEN);
    expect(cleaned).toContain('before');
    expect(cleaned).toContain('after');
  });

  it('is lifted out of display text by scanStreamEvents', () => {
    const content = `hello ${emitWorkflowEvent(payload)}world`;
    const { events, displayDelta, nextIndex } = scanStreamEvents(content, 0);

    expect(events).toEqual([{ type: 'workflow_event', payload }]);
    expect(displayDelta).toContain('hello');
    expect(displayDelta).toContain('world');
    expect(displayDelta).not.toContain('WORKFLOW_EVENT');
    expect(nextIndex).toBe(content.length);
  });

  it('holds back an incomplete marker for the next scan', () => {
    const full = emitWorkflowEvent(payload);
    const partial = full.slice(0, full.indexOf(WORKFLOW_EVENT_CLOSE) + 4);
    const { events, nextIndex } = scanStreamEvents(partial, 0);

    expect(events).toEqual([]);
    // Cursor parked at the marker start so the completed marker parses later.
    expect(nextIndex).toBe(partial.indexOf(WORKFLOW_EVENT_OPEN));
  });

  it('drops malformed payloads without leaking marker text', () => {
    const content = `${WORKFLOW_EVENT_OPEN}{not json}${WORKFLOW_EVENT_CLOSE}`;
    const { events, displayDelta } = scanStreamEvents(content, 0);

    expect(events).toEqual([]);
    expect(displayDelta).toBe('');
  });

  it('rejects payloads with unknown workflow names', () => {
    const content = `${WORKFLOW_EVENT_OPEN}${JSON.stringify({
      workflow: 'spreadsheet',
      type: 'x',
      data: null,
    })}${WORKFLOW_EVENT_CLOSE}`;
    const { events } = extractWorkflowEvents(content);
    expect(events).toEqual([]);
  });

  it('is hidden while partially streamed', () => {
    const full = emitWorkflowEvent(payload);
    const partial = `visible text${full.slice(0, 30)}`;
    // The emitter prepends "\n\n" before the open tag; only the marker
    // itself is held back, matching the other marker kinds.
    expect(stripIncompleteStreamMarkers(partial)).toBe('visible text\n\n');
  });
});

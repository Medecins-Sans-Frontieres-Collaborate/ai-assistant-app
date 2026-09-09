import { StreamParser } from '@/lib/utils/shared/chat/streamParser';

import { emitToolCallRecord } from '@/lib/streamMarkers';
import { describe, expect, it } from 'vitest';

/**
 * Code-interpreter runs travel as TOOL_CALL_RECORD markers with a
 * `generated_files` array (charts/exports persisted to blob storage). The
 * parser must surface the files on the record — dropping them would hide
 * the run's deliverable from the UI — and keep the marker out of the
 * rendered text.
 */

function feed(parser: StreamParser, text: string) {
  parser.processChunk(new TextEncoder().encode(text));
}

const generatedFiles = [
  {
    url: '/api/file/a'.padEnd(75, '0') + '.png',
    filename: 'chart.png',
    mime_type: 'image/png',
    is_image: true,
  },
  {
    url: '/api/file/b'.padEnd(75, '1') + '.csv',
    filename: 'result.csv',
    mime_type: 'text/csv',
    is_image: false,
  },
];

const interpreterMarker = emitToolCallRecord({
  id: 'code-interpreter-1',
  name: 'code_interpreter',
  server_label: 'Code Interpreter',
  arguments: JSON.stringify({ code: 'print("hi")' }),
  status: 'completed',
  output: 'hi',
  error: null,
  duration_ms: 1500,
  generated_files: generatedFiles,
});

describe('StreamParser code-interpreter records', () => {
  it('surfaces generated_files on the tool-call record', () => {
    const parser = new StreamParser();
    feed(parser, interpreterMarker);
    feed(parser, 'The mean is 42.');

    const records = parser.getToolCallRecords();
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe('code_interpreter');
    expect(records[0].generated_files).toEqual(generatedFiles);
  });

  it('keeps the marker out of the rendered text', () => {
    const parser = new StreamParser();
    feed(parser, interpreterMarker);
    feed(parser, 'The mean is 42.');

    // The marker's blank-line padding may remain (markdown collapses it);
    // the wire format itself must never leak.
    const finalText = parser.finalize();
    expect(finalText).not.toContain('TOOL_CALL_RECORD');
    expect(finalText).not.toContain('generated_files');
    expect(finalText.trim()).toBe('The mean is 42.');
  });

  it('omits generated_files when the record has none', () => {
    const parser = new StreamParser();
    feed(
      parser,
      emitToolCallRecord({
        id: 'code-interpreter-2',
        name: 'code_interpreter',
        server_label: 'Code Interpreter',
        arguments: null,
        status: 'failed',
        output: null,
        error: 'Code execution failed',
        duration_ms: 900,
      }),
    );

    const records = parser.getToolCallRecords();
    expect(records).toHaveLength(1);
    expect(records[0].generated_files).toBeUndefined();
    expect(records[0].status).toBe('failed');
  });
});

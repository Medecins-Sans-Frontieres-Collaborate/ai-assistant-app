import { normalizeHttpDependency } from '@/lib/services/observability/httpStatusTraceExporter';

import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';

describe('HTTP dependency success classification', () => {
  it.each([400, 401, 403, 404, 422, 429, 500])(
    'marks outgoing HTTP %s failed without mutating the original span',
    (code) => {
      const span = {
        kind: SpanKind.CLIENT,
        status: { code: SpanStatusCode.UNSET },
        attributes: { 'http.response.status_code': code },
        spanContext: () => 'context',
      };
      const result = normalizeHttpDependency(span);
      expect(result.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
      expect(result.spanContext()).toBe('context');
    },
  );
  it('does not classify inbound client validation errors or HTTP 200s as service failures', () => {
    const span = {
      kind: SpanKind.SERVER,
      status: { code: SpanStatusCode.UNSET },
      attributes: { 'http.response.status_code': 400 },
    };
    expect(normalizeHttpDependency(span)).toBe(span);
    expect(
      normalizeHttpDependency({
        ...span,
        kind: SpanKind.CLIENT,
        attributes: { 'http.status_code': 200 },
      }).status.code,
    ).toBe(SpanStatusCode.UNSET);
  });
});

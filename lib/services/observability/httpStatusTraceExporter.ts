/** Classify outgoing HTTP failures before Azure Monitor derives dependency Success. */
import { AzureMonitorTraceExporter } from '@azure/monitor-opentelemetry-exporter';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';

/** Return an unmodified span, or a prototype-preserving copy with failed client HTTP status. */
export function normalizeHttpDependency<
  T extends {
    kind: number;
    status: { code: number };
    attributes: Readonly<Record<string, unknown>>;
  },
>(span: T): T {
  const code = Number(
    span.attributes['http.response.status_code'] ??
      span.attributes['http.status_code'],
  );
  if (
    span.kind !== SpanKind.CLIENT ||
    code < 400 ||
    code >= 600 ||
    !Number.isFinite(code) ||
    span.status.code === SpanStatusCode.ERROR
  )
    return span;
  const copy = Object.create(span) as T;
  Object.defineProperty(copy, 'status', {
    value: { code: SpanStatusCode.ERROR, message: `HTTP ${code}` },
    enumerable: true,
  });
  return copy;
}

/** Azure Monitor exporter that does not mark 4xx HTTP dependencies as successful. */
export class HttpStatusAzureTraceExporter extends AzureMonitorTraceExporter {
  /** Normalize client failures without mutating the SDK's original readable spans. */
  export(
    spans: Parameters<AzureMonitorTraceExporter['export']>[0],
    callback: Parameters<AzureMonitorTraceExporter['export']>[1],
  ): Promise<void> {
    return super.export(spans.map(normalizeHttpDependency), callback);
  }
}

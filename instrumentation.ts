/**
 * Next.js 16 Instrumentation with OpenTelemetry
 *
 * This file is automatically loaded by Next.js to set up observability.
 * Exports telemetry data to Azure Monitor Application Insights.
 *
 * @see https://nextjs.org/docs/app/guides/open-telemetry
 */

export async function register() {
  // Only run on Node.js runtime (not Edge)
  // Edge Runtime doesn't support OpenTelemetry NodeSDK
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Reclaim local disk from chunked transcription: ffmpeg chunk dirs under
    // /tmp/chunked-transcription/ are produced and consumed by an in-process
    // pipeline, so after a restart every one of them is orphaned. Job STATE
    // needs no startup reconciliation anymore — it lives in blob storage and
    // interrupted jobs are lazily failed at poll time (STALE_JOB_MS in
    // chunkedJobStore), which is also the only approach that is correct with
    // multiple replicas (this replica restarting must not fail jobs still
    // running elsewhere).
    try {
      const { sweepOrphanedChunkDirs } =
        await import('@/lib/services/transcription/chunkedJobStore');
      sweepOrphanedChunkDirs();
    } catch (err) {
      console.warn(
        '[Instrumentation] Could not sweep orphaned transcription chunk dirs:',
        err,
      );
    }

    // Surface access-control misconfigurations at boot. The enable flag and
    // the admin roster are independent by design (see startupWarnings.ts),
    // which makes "I set the admins and nothing happened" an easy trap —
    // so say so rather than let it be discovered by absence.
    await (
      await import('@/lib/services/agentAccess/startupWarnings')
    ).logAccessControlStartupWarnings();

    // Same rationale for usage limits, plus one they have and access control
    // does not: observe mode is silent by design, so a policy that is enabled
    // but not enforcing has no symptom at all unless we announce it.
    await (
      await import('@/lib/services/limits/startupWarnings')
    ).logLimitsStartupWarnings();

    // Rehearse the static org RAG agents' search index against the retrieval
    // contract (admin-authored agents are validated on save; the file-based
    // ones have no other admission gate). Fire-and-forget: one Search
    // round-trip that must never block or fail boot.
    try {
      void (
        await import('@/lib/services/orgAgents/startupIndexCheck')
      ).logStaticOrgAgentIndexWarnings();
    } catch (err) {
      console.warn(
        '[Instrumentation] Static org-agent index check skipped:',
        err,
      );
    }

    // Skip OpenTelemetry in development unless explicitly enabled.
    // OTel's request body cloning conflicts with routes that read request.text().
    // Set ENABLE_OTEL=true to enable telemetry in development for testing.
    if (
      process.env.NODE_ENV === 'development' &&
      process.env.ENABLE_OTEL !== 'true'
    ) {
      console.log(
        '[OpenTelemetry] Disabled in development (set ENABLE_OTEL=true to enable)',
      );
      return;
    }

    const { registerOTel } = await import('@vercel/otel');
    const { AzureMonitorTraceExporter, AzureMonitorMetricExporter } =
      await import('@azure/monitor-opentelemetry-exporter');
    const { PeriodicExportingMetricReader } =
      await import('@opentelemetry/sdk-metrics');

    const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

    if (!connectionString) {
      console.warn(
        '[OpenTelemetry] APPLICATIONINSIGHTS_CONNECTION_STRING not set - telemetry disabled',
      );
      return;
    }

    console.log('[OpenTelemetry] Initializing with Azure Monitor...');

    try {
      registerOTel({
        serviceName: process.env.NEXT_PUBLIC_ENV
          ? `msf-ai-assistant-${process.env.NEXT_PUBLIC_ENV}`
          : 'msf-ai-assistant',
        traceExporter: new AzureMonitorTraceExporter({
          connectionString,
        }),
        metricReaders: [
          new PeriodicExportingMetricReader({
            exporter: new AzureMonitorMetricExporter({
              connectionString,
            }),
            exportIntervalMillis: 60000, // Export metrics every 60 seconds
          }),
        ],
      });

      console.log(
        '[OpenTelemetry] Successfully initialized with traces and metrics',
      );
    } catch (error) {
      console.error('[OpenTelemetry] Failed to initialize:', error);
    }
  }
}

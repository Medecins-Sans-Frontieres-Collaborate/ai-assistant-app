/**
 * Health Check Types
 *
 * Type definitions for the tiered health check system.
 * Supports liveness, readiness, and deep health checks for Azure service dependencies.
 */

/**
 * Overall health status of the application.
 * - 'healthy': All checks pass
 * - 'degraded': Some non-critical checks fail
 * - 'unhealthy': Critical checks fail
 */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/**
 * Status of an individual service check.
 * - 'pass': Check succeeded
 * - 'fail': Check failed
 * - 'skip': Check was skipped (e.g., service not configured)
 */
export type CheckStatus = 'pass' | 'fail' | 'skip';

/**
 * Health check tier level.
 * - 'live': Basic liveness check (just returns OK)
 * - 'ready': Critical services only (OpenAI, Search)
 * - 'deep': All Azure services including non-critical
 */
export type CheckLevel = 'live' | 'ready' | 'deep';

/**
 * Result of a single service health check.
 */
export interface ServiceCheck {
  /** Whether the check passed, failed, or was skipped */
  status: CheckStatus;
  /** Response time in milliseconds (only present if check ran) */
  latencyMs?: number;
  /** Error or informational message */
  message?: string;
}

/**
 * Complete health check response.
 */
export interface HealthCheckResult {
  /** Overall health status based on check results */
  status: HealthStatus;
  /** ISO 8601 timestamp of when the check was performed */
  timestamp: string;
  /** The level of check that was performed */
  level: CheckLevel;
  /** Individual service check results (omitted for 'live' level) */
  checks?: Record<string, ServiceCheck>;
}

/**
 * Configuration for a health check.
 */
export interface HealthCheckConfig {
  /** Timeout in milliseconds for each check (default: 3000) */
  timeoutMs?: number;
  /** Whether this service is critical for readiness */
  isCritical?: boolean;
}

/**
 * Names of services that can be health checked.
 */
export type ServiceName =
  | 'azureOpenAI'
  | 'azureSearch'
  | 'azureBlobStorage'
  | 'azureBlobStorageEU'
  | 'azureSpeechWhisper'
  | 'ffmpeg';

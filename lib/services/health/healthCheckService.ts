/**
 * Health Check Service
 *
 * Singleton service that validates Azure service dependencies.
 * Supports tiered health checks: liveness, readiness, and deep checks.
 */
import {
  CheckLevel,
  CheckStatus,
  HealthCheckResult,
  HealthStatus,
  ServiceCheck,
  ServiceName,
} from './types';

import { env } from '@/config/environment';
import { DefaultAzureCredential } from '@azure/identity';
import { SearchClient, SearchIndexClient } from '@azure/search-documents';
import { BlobServiceClient } from '@azure/storage-blob';

/** Default timeout for each health check in milliseconds */
const DEFAULT_TIMEOUT_MS = 3000;

/** Cache duration in milliseconds */
const CACHE_DURATION_MS = 5000;

/**
 * Cached health check result with timestamp.
 */
interface CachedResult {
  result: HealthCheckResult;
  timestamp: number;
}

/**
 * HealthCheckService provides tiered health checks for Azure services.
 *
 * Follows the singleton pattern consistent with ServiceContainer.
 * Results are briefly cached (5s) to prevent service hammering.
 *
 * @example
 * ```typescript
 * const healthService = HealthCheckService.getInstance();
 * const result = await healthService.check('ready');
 * ```
 */
export class HealthCheckService {
  private static instance: HealthCheckService | null = null;

  /** Cached results by check level */
  private cache: Map<CheckLevel, CachedResult> = new Map();

  /** Azure credential for service authentication */
  private credential: DefaultAzureCredential;

  private constructor() {
    this.credential = new DefaultAzureCredential();
  }

  /**
   * Gets the singleton instance of HealthCheckService.
   *
   * @returns The singleton HealthCheckService instance
   */
  public static getInstance(): HealthCheckService {
    if (!HealthCheckService.instance) {
      HealthCheckService.instance = new HealthCheckService();
    }
    return HealthCheckService.instance;
  }

  /**
   * Resets the singleton instance.
   * Only use this for testing purposes.
   */
  public static reset(): void {
    HealthCheckService.instance = null;
  }

  /**
   * Performs a health check at the specified level.
   *
   * @param level - The check level: 'live', 'ready', or 'deep'
   * @returns Health check result with status and individual check results
   */
  public async check(level: CheckLevel): Promise<HealthCheckResult> {
    // For liveness, just return OK immediately
    if (level === 'live') {
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        level: 'live',
      };
    }

    // Check cache
    const cached = this.cache.get(level);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION_MS) {
      return cached.result;
    }

    // Determine which services to check
    const servicesToCheck: ServiceName[] =
      level === 'ready'
        ? ['azureOpenAI', 'azureSearch']
        : [
            'azureOpenAI',
            'azureSearch',
            'azureBlobStorage',
            'azureBlobStorageEU',
            'azureSpeechWhisper',
          ];

    // Run all checks in parallel with timeouts
    const checkPromises = servicesToCheck.map(async (service) => {
      const check = await this.runCheckWithTimeout(service);
      return { service, check };
    });

    const results = await Promise.allSettled(checkPromises);

    // Build the checks record
    const checks: Record<string, ServiceCheck> = {};
    let hasCriticalFailure = false;
    let hasNonCriticalFailure = false;

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { service, check } = result.value;
        checks[service] = check;

        if (check.status === 'fail') {
          const isCritical =
            service === 'azureOpenAI' || service === 'azureSearch';
          if (isCritical) {
            hasCriticalFailure = true;
          } else {
            hasNonCriticalFailure = true;
          }
        }
      } else {
        // Promise.allSettled rejection shouldn't happen with our implementation,
        // but handle it gracefully
        console.error(
          '[HealthCheckService] Unexpected check failure:',
          result.reason,
        );
      }
    }

    // Determine overall status
    let status: HealthStatus;
    if (hasCriticalFailure) {
      status = 'unhealthy';
    } else if (hasNonCriticalFailure) {
      status = 'degraded';
    } else {
      status = 'healthy';
    }

    const healthResult: HealthCheckResult = {
      status,
      timestamp: new Date().toISOString(),
      level,
      checks,
    };

    // Cache the result
    this.cache.set(level, {
      result: healthResult,
      timestamp: Date.now(),
    });

    return healthResult;
  }

  /**
   * Runs a service check with a timeout.
   *
   * @param service - The service to check
   * @returns The check result
   */
  private async runCheckWithTimeout(
    service: ServiceName,
  ): Promise<ServiceCheck> {
    const startTime = Date.now();

    try {
      const checkPromise = this.runCheck(service);
      const timeoutPromise = new Promise<ServiceCheck>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), DEFAULT_TIMEOUT_MS),
      );

      const result = await Promise.race([checkPromise, timeoutPromise]);
      return result;
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      const message =
        error instanceof Error
          ? error.message === 'timeout'
            ? 'timeout'
            : error.message
          : 'unknown error';

      return {
        status: 'fail',
        latencyMs,
        message,
      };
    }
  }

  /**
   * Runs the actual service check.
   *
   * @param service - The service to check
   * @returns The check result
   */
  private async runCheck(service: ServiceName): Promise<ServiceCheck> {
    switch (service) {
      case 'azureOpenAI':
        return this.checkAzureOpenAI();
      case 'azureSearch':
        return this.checkAzureSearch();
      case 'azureBlobStorage':
        return this.checkAzureBlobStorage();
      case 'azureBlobStorageEU':
        return this.checkAzureBlobStorageEU();
      case 'azureSpeechWhisper':
        return this.checkAzureSpeechWhisper();
      default:
        return { status: 'skip', message: 'unknown service' };
    }
  }

  /**
   * Checks Azure OpenAI service availability.
   * Uses the models.list() endpoint which is fast and consumes no tokens.
   */
  private async checkAzureOpenAI(): Promise<ServiceCheck> {
    const startTime = Date.now();
    const endpoint = env.AZURE_OPENAI_ENDPOINT;

    if (!endpoint) {
      return { status: 'skip', message: 'endpoint not configured' };
    }

    try {
      // Use a lightweight API call to check connectivity
      // The deployments endpoint is available and doesn't consume tokens
      const url = `${endpoint}/openai/deployments?api-version=2024-02-15-preview`;
      const token = await this.credential.getToken(
        'https://cognitiveservices.azure.com/.default',
      );

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token.token}`,
        },
      });

      const latencyMs = Date.now() - startTime;

      if (response.ok) {
        return { status: 'pass', latencyMs };
      } else {
        return {
          status: 'fail',
          latencyMs,
          message: `HTTP ${response.status}`,
        };
      }
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      return {
        status: 'fail',
        latencyMs,
        message: error instanceof Error ? error.message : 'unknown error',
      };
    }
  }

  /**
   * Checks Azure Search service availability.
   * Uses getServiceStatistics() for a lightweight check.
   */
  private async checkAzureSearch(): Promise<ServiceCheck> {
    const startTime = Date.now();
    const endpoint = env.SEARCH_ENDPOINT;
    const indexName = env.SEARCH_INDEX;

    if (!endpoint) {
      return { status: 'skip', message: 'endpoint not configured' };
    }

    try {
      // Use SearchIndexClient to get service statistics (doesn't require an index)
      const indexClient = new SearchIndexClient(endpoint, this.credential);
      await indexClient.getServiceStatistics();

      const latencyMs = Date.now() - startTime;
      return { status: 'pass', latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      return {
        status: 'fail',
        latencyMs,
        message: error instanceof Error ? error.message : 'unknown error',
      };
    }
  }

  /**
   * Checks Azure Blob Storage availability.
   * Uses containerClient.exists() for a lightweight check.
   */
  private async checkAzureBlobStorage(): Promise<ServiceCheck> {
    return this.checkBlobAccount(
      env.AZURE_BLOB_STORAGE_NAME,
      env.AZURE_BLOB_STORAGE_CONTAINER ||
        env.AZURE_BLOB_STORAGE_IMAGE_CONTAINER,
    );
  }

  /**
   * Checks the EU regional blob storage account (`AZURE_BLOB_STORAGE_NAME_EU`).
   *
   * EU users' uploads are routed to this account; it lives in a different
   * region than the app's VNet and is reachable only via a private endpoint.
   * A half-applied infra change (missing private endpoint / firewall rule /
   * RBAC) makes it unreachable and surfaces to users as upload 500s — this
   * check turns that into an observable readiness failure instead. Skips
   * cleanly when no EU account is configured (single-region deployments).
   */
  private async checkAzureBlobStorageEU(): Promise<ServiceCheck> {
    return this.checkBlobAccount(
      env.AZURE_BLOB_STORAGE_NAME_EU,
      env.AZURE_BLOB_STORAGE_CONTAINER ||
        env.AZURE_BLOB_STORAGE_IMAGE_CONTAINER,
    );
  }

  /**
   * Verifies a blob storage account is reachable and authorized by doing a
   * lightweight `containerClient.exists()` against it with managed identity —
   * the same credential and code path the upload route uses, so a firewall or
   * RBAC problem shows up here exactly as it would on a real upload.
   */
  private async checkBlobAccount(
    storageAccountName: string | undefined,
    containerName: string | undefined,
  ): Promise<ServiceCheck> {
    const startTime = Date.now();

    if (!storageAccountName) {
      return { status: 'skip', message: 'storage account not configured' };
    }

    if (!containerName) {
      return { status: 'skip', message: 'container not configured' };
    }

    try {
      const blobServiceClient = new BlobServiceClient(
        `https://${storageAccountName}.blob.core.windows.net`,
        this.credential,
      );
      const containerClient =
        blobServiceClient.getContainerClient(containerName);
      await containerClient.exists();

      const latencyMs = Date.now() - startTime;
      return { status: 'pass', latencyMs };
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      return {
        status: 'fail',
        latencyMs,
        message: error instanceof Error ? error.message : 'unknown error',
      };
    }
  }

  /**
   * Checks Azure Speech (Whisper) service availability.
   * Uses a HEAD request to verify the endpoint is reachable.
   */
  private async checkAzureSpeechWhisper(): Promise<ServiceCheck> {
    const startTime = Date.now();
    const endpoint = env.AZURE_OPENAI_ENDPOINT;

    if (!endpoint) {
      return { status: 'skip', message: 'endpoint not configured' };
    }

    try {
      // Check the whisper deployment endpoint
      const url = `${endpoint}/openai/deployments/whisper?api-version=2024-02-15-preview`;
      const token = await this.credential.getToken(
        'https://cognitiveservices.azure.com/.default',
      );

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token.token}`,
        },
      });

      const latencyMs = Date.now() - startTime;

      if (response.ok) {
        return { status: 'pass', latencyMs };
      } else if (response.status === 404) {
        // Whisper deployment might not exist, which is OK
        return { status: 'skip', latencyMs, message: 'deployment not found' };
      } else {
        return {
          status: 'fail',
          latencyMs,
          message: `HTTP ${response.status}`,
        };
      }
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      return {
        status: 'fail',
        latencyMs,
        message: error instanceof Error ? error.message : 'unknown error',
      };
    }
  }
}

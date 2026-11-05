/** Policy, authoritative inventory, shared execution, and admin readiness orchestration. */
import { ModelDiscoveryService } from '@/lib/services/models/ModelDiscoveryService';

import { AuxiliaryModelExecutor } from './AuxiliaryModelExecutor';
import { auxiliaryAccount, auxiliaryEnvironment } from './bindings';
import { auxiliaryProbeRequest, matchesAuxiliarySchema } from './probes';
import { resolveAuxiliaryCandidate } from './resolution';
import {
  type AuxiliaryState,
  claimAuxiliaryProbe,
  persistAuxiliaryState,
  readAuxiliaryPolicy,
  readAuxiliaryState,
} from './store';
import {
  AUXILIARY_BINDINGS,
  AUXILIARY_LIMITS,
  AUXILIARY_PURPOSES,
  AUXILIARY_REGIONS,
  type AuxiliaryAdminReport,
  type AuxiliaryAssignments,
  AuxiliaryAssignmentsSchema,
  type AuxiliaryBinding,
  type AuxiliaryCandidate,
  type AuxiliaryInventory,
  type AuxiliaryObservation,
  type AuxiliaryOperation,
  type AuxiliaryPolicy,
  type AuxiliaryRegion,
  PURPOSE_OPERATIONS,
  referenceKey,
} from './types';

import { env } from '@/config/environment';
import { DefaultAzureCredential } from '@azure/identity';
import { createHash } from 'crypto';
import type OpenAI from 'openai';

/** Explicit approved bootstrap deployments; every entry must still pass live regional inventory. */
export function auxiliaryBootstrap(
  legacyAssessor?: string,
): AuxiliaryAssignments {
  if (env.AUXILIARY_MODEL_BOOTSTRAP)
    return AuxiliaryAssignmentsSchema.parse(
      JSON.parse(env.AUXILIARY_MODEL_BOOTSTRAP),
    );
  const references = (accountBinding: AuxiliaryBinding, names: string[]) =>
    names.map((deploymentName) => ({ accountBinding, deploymentName }));
  const us = auxiliaryAccount('US').configured ? 'US' : 'default';
  return {
    routing: {
      EU: references('EU', ['gpt-5.4-mini', 'gpt-4.1']),
      US: references(us, ['gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-4.1']),
    },
    searchAssessment: {
      EU: references('EU', [
        ...new Set([
          legacyAssessor ?? 'Mistral-Large-3',
          'gpt-5.4-mini',
          'gpt-4.1',
        ]),
      ]),
      US: references(us, [
        ...new Set([
          legacyAssessor ?? 'Mistral-Large-3',
          'gpt-5.4-nano',
          'gpt-5.4-mini',
        ]),
      ]),
    },
  };
}

/** Environment-local singleton owned by ServiceContainer, using its exact provider clients. */
export class AuxiliaryModelService {
  readonly executor: AuxiliaryModelExecutor;
  private credential = new DefaultAzureCredential();
  private policy: AuxiliaryPolicy | null = null;
  private etag: string | null = null;
  private policyAt = 0;
  private configUnavailable = false;
  private policyInFlight?: Promise<void>;
  private inventory: AuxiliaryInventory[] = [];
  private inventoryAt = 0;
  private inventoryInFlight?: Promise<AuxiliaryInventory[]>;
  private state: AuxiliaryState = { observations: [], history: [] };
  private stateAt = 0;
  private pending = new Map<string, AuxiliaryObservation>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private maintenanceTimer?: ReturnType<typeof setInterval>;

  constructor(
    private clientFor: (binding: AuxiliaryBinding) => OpenAI | undefined,
    private legacyAssessor?: () => string,
  ) {
    this.executor = new AuxiliaryModelExecutor({
      environment: auxiliaryEnvironment(),
      resolve: (operation, region) => this.resolve(operation, region),
      client: (candidate) => this.clientFor(candidate.reference.accountBinding),
      observe: (entry) => this.observe(entry),
    });
  }

  /** Invalidate policy/cooldowns following an administrator's CAS write. */
  invalidate(): void {
    this.policyAt = 0;
    this.executor.resetCooldowns();
  }

  /** Stop process-local timers; used when resetting ServiceContainer in tests. */
  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
  }

  private startMaintenance(): void {
    if (this.maintenanceTimer || env.NODE_ENV === 'test') return;
    this.maintenanceTimer = setInterval(() => {
      void this.report(true).catch(() =>
        console.warn('[auxiliary] Background readiness refresh failed'),
      );
    }, AUXILIARY_LIMITS.refreshMs);
    this.maintenanceTimer.unref();
  }

  private async loadPolicy(refresh = false): Promise<void> {
    if (!refresh && this.policyAt && Date.now() - this.policyAt < 60_000)
      return;
    if (!this.policyInFlight)
      this.policyInFlight = (async () => {
        try {
          const result = await readAuxiliaryPolicy();
          this.policy = result?.policy ?? null;
          this.etag = result?.etag ?? null;
          this.policyAt = Date.now();
          this.configUnavailable = false;
        } catch {
          this.configUnavailable = true;
          console.warn('[auxiliary] Policy storage unavailable');
        }
      })().finally(() => {
        this.policyInFlight = undefined;
      });
    await this.policyInFlight;
  }

  private effective(): AuxiliaryAssignments {
    if (
      this.configUnavailable &&
      this.policyAt &&
      Date.now() - this.policyAt > AUXILIARY_LIMITS.policyMaxAgeMs
    )
      return {
        routing: { EU: [], US: [] },
        searchAssessment: { EU: [], US: [] },
      };
    return (
      this.policy?.assignments ?? auxiliaryBootstrap(this.legacyAssessor?.())
    );
  }
  private revision(): string {
    return (
      this.etag ??
      `bootstrap:${createHash('sha256').update(JSON.stringify(this.effective())).digest('hex').slice(0, 16)}`
    );
  }

  /** Read trusted account inventory, preserving bounded last-known-good observations during outages. */
  async inventories(refresh = false): Promise<AuxiliaryInventory[]> {
    if (
      !refresh &&
      this.inventoryAt &&
      Date.now() - this.inventoryAt < AUXILIARY_LIMITS.refreshMs
    )
      return this.inventory;
    if (!this.inventoryInFlight)
      this.inventoryInFlight = (async () => {
        const accounts = AUXILIARY_BINDINGS.map(auxiliaryAccount);
        let token: string | undefined;
        try {
          token = (
            await this.credential.getToken(
              'https://management.azure.com/.default',
            )
          ).token;
        } catch {
          /* Report unavailable, never infer an empty deployment list. */
        }
        const next = await Promise.all(
          accounts.map(async (account): Promise<AuxiliaryInventory> => {
            if (!account.configured || !account.resourcePath)
              return {
                account,
                models: [],
                status: 'unavailable',
                retirementAvailable: false,
                error: account.error,
              };
            if (!token) {
              const previous = this.inventory.find(
                (entry) =>
                  entry.account.resourcePath === account.resourcePath &&
                  entry.account.endpoint === account.endpoint,
              );
              return {
                ...previous,
                account,
                models: previous?.models ?? [],
                retirementAvailable: previous?.retirementAvailable ?? false,
                status: previous?.fetchedAt ? 'stale' : 'unavailable',
                error: 'credential_unavailable',
              };
            }
            const observation =
              await ModelDiscoveryService.getInstance().observeDeployments(
                token,
                account.resourcePath,
                refresh,
              );
            return { ...observation, account };
          }),
        );
        this.inventory = next;
        this.inventoryAt = Date.now();
        return next;
      })().finally(() => {
        this.inventoryInFlight = undefined;
      });
    return this.inventoryInFlight;
  }

  private async loadState(): Promise<void> {
    if (this.stateAt && Date.now() - this.stateAt < AUXILIARY_LIMITS.refreshMs)
      return;
    try {
      const read = await readAuxiliaryState();
      const local = this.state.observations;
      this.state = {
        ...read,
        observations: [...read.observations, ...local]
          .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))
          .slice(0, 200),
      };
      this.stateAt = Date.now();
    } catch {
      console.warn('[auxiliary] Readiness observation storage unavailable');
    }
  }

  /** Resolve only approved, inventory-eligible candidates, deduplicating identical physical targets. */
  async resolve(
    operation: AuxiliaryOperation,
    region: AuxiliaryRegion,
  ): Promise<{ candidates: AuxiliaryCandidate[]; revision: string }> {
    this.startMaintenance();
    await Promise.all([
      this.loadPolicy(),
      this.inventories(),
      this.loadState(),
    ]);
    const purpose = operation === 'assessment' ? 'searchAssessment' : 'routing';
    const entries = this.effective()[purpose][region];
    const seen = new Set<string>();
    const candidates: AuxiliaryCandidate[] = [];
    for (let priority = 0; priority < entries.length; priority++) {
      const reference = entries[priority];
      const resolved = resolveAuxiliaryCandidate(
        reference,
        this.inventory.find(
          (entry) => entry.account.binding === reference.accountBinding,
        ),
        region,
        this.state.observations,
      );
      if (!resolved.candidate || seen.has(resolved.candidate.fingerprint))
        continue;
      seen.add(resolved.candidate.fingerprint);
      candidates.push({ ...resolved.candidate, priority });
    }
    // Move away before retirement only when the next operation/version is proven compatible.
    if (
      candidates[0]?.deployment.retiresAt &&
      Date.parse(candidates[0].deployment.retiresAt) - Date.now() <
        7 * 86400_000
    ) {
      const successor = candidates.findIndex(
        (candidate, index) =>
          index > 0 && this.compatible(candidate.fingerprint, operation),
      );
      if (successor > 0) candidates.unshift(...candidates.splice(successor, 1));
    }
    return { candidates, revision: this.revision() };
  }

  private compatible(
    fingerprint: string,
    operation: AuxiliaryOperation,
  ): boolean {
    const newest = this.state.observations
      .filter(
        (entry) =>
          entry.fingerprint === fingerprint && entry.operation === operation,
      )
      .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
    return (
      !!newest?.success &&
      Date.now() - Date.parse(newest.checkedAt) < AUXILIARY_LIMITS.probeFreshMs
    );
  }

  /** Validate a configured or proposed deployment with fixed app-credential probes. Never falls back. */
  async probe(
    reference: import('./types').AuxiliaryReference,
    purpose: import('./types').AuxiliaryPurpose,
    region: AuxiliaryRegion,
  ): Promise<AuxiliaryAdminReport> {
    await this.report(true);
    const resolved = resolveAuxiliaryCandidate(
      reference,
      this.inventory.find(
        (entry) => entry.account.binding === reference.accountBinding,
      ),
      region,
      this.state.observations,
    );
    if (!resolved.candidate)
      throw new Error(`Probe target ineligible: ${resolved.status.reason}`);
    if (
      !(await claimAuxiliaryProbe(
        `${referenceKey(reference)}:${purpose}`,
        AUXILIARY_LIMITS.probeIntervalMs,
      ))
    )
      throw new Error('PROBE_RATE_LIMIT');
    for (const operation of PURPOSE_OPERATIONS[purpose]) {
      const params = await auxiliaryProbeRequest(operation);
      const schema =
        params.response_format?.type === 'json_schema'
          ? params.response_format.json_schema.schema
          : undefined;
      try {
        await this.executor.execute(
          params,
          (response) => {
            try {
              const value = JSON.parse(
                response.choices[0]?.message.content ?? 'null',
              );
              return schema && matchesAuxiliarySchema(value, schema)
                ? true
                : undefined;
            } catch {
              return undefined;
            }
          },
          {
            operation,
            region,
            candidates: [resolved.candidate],
            source: 'probe',
            timeoutMs: AUXILIARY_LIMITS.routingMs,
          },
        );
      } catch {
        /* Failure is a persisted readiness observation, not a failed UI transport. */
      }
    }
    await this.flush();
    return this.report();
  }

  private observe(entry: AuxiliaryObservation): void {
    const key = `${entry.key}:${entry.operation}:${entry.fingerprint}:${entry.source}`;
    this.state.observations = [
      entry,
      ...this.state.observations.filter(
        (old) =>
          `${old.key}:${old.operation}:${old.fingerprint}:${old.source}` !==
          key,
      ),
    ].slice(0, 200);
    this.pending.set(key, entry);
    if (!entry.success)
      console.warn(
        `[auxiliary] operation=${entry.operation} target=${entry.key} failure=${entry.reason} httpStatus=${entry.httpStatus ?? 0}`,
      );
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        void this.flush();
      }, 1000);
      this.flushTimer.unref();
    }
  }

  /** Persist queued bounded observations without awaiting them on the inference path. */
  async flush(): Promise<void> {
    const entries = [...this.pending.values()];
    this.pending.clear();
    if (!entries.length) return;
    try {
      await persistAuxiliaryState(entries);
    } catch {
      console.warn('[auxiliary] Readiness observation persistence failed');
    }
  }

  /** Authoritative admin/readiness report. Refresh is read-only and does not run paid probes. */
  async report(refresh = false): Promise<AuxiliaryAdminReport> {
    this.startMaintenance();
    await Promise.all([
      this.loadPolicy(refresh),
      this.inventories(refresh),
      this.loadState(),
    ]);
    const effective = this.effective();
    const chains: AuxiliaryAdminReport['chains'] = [];
    for (const purpose of AUXILIARY_PURPOSES)
      for (const region of AUXILIARY_REGIONS) {
        const candidates = effective[purpose][region].map(
          (reference) =>
            resolveAuxiliaryCandidate(
              reference,
              this.inventory.find(
                (entry) => entry.account.binding === reference.accountBinding,
              ),
              region,
              this.state.observations,
            ).status,
        );
        const usable = candidates.filter((entry) => entry.eligible);
        const ready = usable.find(
          (entry) =>
            entry.fingerprint &&
            PURPOSE_OPERATIONS[purpose].every((operation) =>
              this.compatible(entry.fingerprint!, operation),
            ),
        );
        chains.push({
          purpose,
          region,
          candidates,
          redundancy: new Set(usable.map((entry) => entry.fingerprint)).size,
          state: this.configUnavailable
            ? 'check_unavailable'
            : !usable.length
              ? candidates.some(
                  (entry) => entry.reason === 'inventory_unavailable',
                )
                ? 'check_unavailable'
                : 'unavailable'
              : ready
                ? candidates.indexOf(ready) > 0
                  ? 'fallback'
                  : 'ready'
                : 'unverified',
        });
      }
    const choices = Object.fromEntries(
      AUXILIARY_REGIONS.map((region) => [
        region,
        this.inventory.flatMap((inventory) =>
          inventory.models.map(
            (deployment) =>
              resolveAuxiliaryCandidate(
                {
                  accountBinding: inventory.account.binding,
                  deploymentName: deployment.deploymentName,
                },
                inventory,
                region,
                this.state.observations,
              ).status,
          ),
        ),
      ]),
    ) as AuxiliaryAdminReport['choices'];
    return {
      environment: auxiliaryEnvironment(),
      policy: this.policy,
      etag: this.etag,
      configUnavailable: this.configUnavailable,
      defaults: auxiliaryBootstrap(this.legacyAssessor?.()),
      effective,
      revision: this.revision(),
      checkedAt: new Date().toISOString(),
      inventory: this.inventory,
      choices,
      observations: this.state.observations,
      chains,
      history: this.state.history,
    };
  }
}

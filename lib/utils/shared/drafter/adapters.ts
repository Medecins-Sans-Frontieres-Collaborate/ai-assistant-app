/**
 * Composition root for the drafter: the one place that knows which kinds of
 * spec exist. The core (`./core`) never imports this or `./channels`.
 */
import {
  CheckFinding,
  runChecks,
} from '@/lib/utils/shared/review/deterministicChecks';

import { Brief, Segment, VersionSpec } from '@/types/drafter';

import { channelAdapter } from './channels/channelAdapter';
import { SpecAdapter } from './core/adapter';
import { CORE_VERSION_CHECKS, buildCheckCtx } from './core/checks';

const ADAPTERS: ReadonlyArray<SpecAdapter<VersionSpec>> = [
  channelAdapter as unknown as SpecAdapter<VersionSpec>,
];

export function getSpecAdapter(
  kind: unknown,
): SpecAdapter<VersionSpec> | undefined {
  return typeof kind === 'string'
    ? ADAPTERS.find((adapter) => adapter.kind === kind)
    : undefined;
}

/** Core checks plus the adapter's, over one version. */
export function checkVersion(
  adapter: SpecAdapter<VersionSpec>,
  spec: VersionSpec,
  segments: Segment[],
  brief: Brief,
): CheckFinding[] {
  const ctx = buildCheckCtx(spec, segments, brief);
  return [
    ...runChecks(CORE_VERSION_CHECKS, ctx),
    ...runChecks(adapter.checks(spec), ctx),
  ];
}

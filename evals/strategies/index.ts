/**
 * Strategy registry. Add a file, export it here, and it becomes selectable
 * via EVAL_STRATEGIES=a,b,c. Bump STRATEGY_VERSION when a strategy's prompt
 * text changes so cached goal/candidate runs are invalidated.
 */
import type { Strategy } from '../lib/types';
import { baseline } from './baseline';
import { compact } from './compact';
import { planThenAnswer } from './planThenAnswer';
import { scaffolded } from './scaffolded';

export const STRATEGY_VERSION = '1';

export const STRATEGIES: Record<string, Strategy> = Object.fromEntries(
  [baseline, compact, scaffolded, planThenAnswer].map((s) => [s.id, s]),
);

export function getStrategy(id: string): Strategy {
  const s = STRATEGIES[id];
  if (!s)
    throw new Error(
      `Unknown strategy "${id}". Known: ${Object.keys(STRATEGIES).join(', ')}`,
    );
  return s;
}

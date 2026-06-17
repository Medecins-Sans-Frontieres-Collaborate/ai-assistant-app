import { stringHash } from '@/lib/utils/shared/stringHash';

const AGENT_COLORS = [
  'oklch(0.78 0.08 25)', // dusty coral
  'oklch(0.82 0.08 90)', // soft amber
  'oklch(0.78 0.08 155)', // sage
  'oklch(0.76 0.08 220)', // dusty blue
  'oklch(0.74 0.09 285)', // lavender
  'oklch(0.78 0.09 340)', // dusty rose
] as const;

/**
 * Deterministically picks a color for an agent based on its name. Same name always
 * returns the same color, so an agent's identity is stable across sessions and
 * different agents in the same list visually differentiate.
 */
export function colorForAgent(name: string): string {
  return AGENT_COLORS[Math.abs(stringHash(name)) % AGENT_COLORS.length];
}

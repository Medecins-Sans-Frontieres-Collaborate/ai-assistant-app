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
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length];
}

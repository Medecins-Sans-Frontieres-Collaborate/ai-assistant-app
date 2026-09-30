/**
 * Teaching a voice in passing. When the user accepts what an instruction
 * produced ("shorter sentences, no exclamation marks") on ONE target, that
 * instruction is evidence about how they want that target to sound. Offering
 * to keep it is how voices improve with use.
 *
 * Deliberately not a model call: the user's own words are appended as a
 * rule, so what is added is exactly what they see.
 */
import { DraftSetState, Version } from '@/types/drafter';

export const LEARNED_HEADING = 'Learned from revisions';
const MAX_RULE_CHARS = 300;
const MAX_VOICE_RULES_CHARS = 30_000;

function normalized(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** The instruction as one rule line. */
export function ruleLine(instruction: string): string {
  return `- ${instruction.replace(/\s+/gu, ' ').trim().slice(0, MAX_RULE_CHARS)}`;
}

/**
 * `voiceRules` with the instruction added under a "Learned from revisions"
 * heading. Returns the input unchanged when the rule is already there or
 * there is no room, so a caller can tell nothing happened.
 */
export function appendVoiceRule(
  voiceRules: string,
  instruction: string,
): string {
  const line = ruleLine(instruction);
  if (line === '- ') return voiceRules;
  if (normalized(voiceRules).includes(normalized(line.slice(2)))) {
    return voiceRules;
  }
  const base = voiceRules.trimEnd();
  const next = base.includes(LEARNED_HEADING)
    ? `${base}\n${line}`
    : `${base}${base ? '\n\n' : ''}${LEARNED_HEADING}:\n${line}`;
  return next.length > MAX_VOICE_RULES_CHARS ? voiceRules : next;
}

/** Instructions whose suggestions the user accepted on this version. */
function acceptedInstructions(version: Version | undefined): string[] {
  const seen = new Set<string>();
  for (const edit of version?.edits ?? []) {
    if (edit.status === 'accepted' && edit.instruction?.trim()) {
      seen.add(edit.instruction.trim());
    }
  }
  return [...seen];
}

/**
 * The instruction worth offering to this version's voice, if any: accepted
 * here, given a voice to add it to, not already offered, and accepted on NO
 * other version. An instruction that went to several targets says something
 * about the message, not about how one target should sound.
 */
export function teachableInstruction(
  state: DraftSetState,
  specId: string,
): string | null {
  const version = state.versions[specId];
  if (!version?.toneRef) return null;
  const offered = new Set(version.taught ?? []);
  for (const instruction of acceptedInstructions(version)) {
    if (offered.has(instruction)) continue;
    const elsewhere = state.specIds.some(
      (other) =>
        other !== specId &&
        acceptedInstructions(state.versions[other]).includes(instruction),
    );
    if (!elsewhere) return instruction;
  }
  return null;
}

/** Records that an instruction was offered, so it is offered only once. */
export function markTaught(version: Version, instruction: string): Version {
  const taught = version.taught ?? [];
  if (taught.includes(instruction)) return version;
  return { ...version, taught: [...taught, instruction].slice(-20) };
}

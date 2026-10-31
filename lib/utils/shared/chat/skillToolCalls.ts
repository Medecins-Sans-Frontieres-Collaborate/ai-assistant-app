/**
 * Skill-use records in a message's tool-call list (docs/SKILLS_DESIGN.md
 * §10). The server reports skill activity through the same TOOL_CALL_RECORD
 * channel as MCP tools — `use_skills` from SkillEnricher, `skill_references`
 * from SkillReferenceEnricher, `load_skill` / `search_skill_documents` from
 * the agent tool loop — all under the "Skills" server label. The chat UI
 * renders those as their own chip, not as "Used N tools", so this module
 * owns the partition and the parsing of the record text into typed lines.
 *
 * Shared (client + server safe): no imports beyond types.
 */
import type { ToolCallRecord } from '@/types/chat';

/** `buildSkillServer().label` and the enrichers' `server_label`. */
export const SKILL_TOOL_SERVER_LABEL = 'Skills';
/** `SKILL_SERVER_ID` in lib/services/skills/skillTools.ts (duplicated: that module is server-only). */
export const SKILL_TOOL_SERVER_ID = 'builtin-skills';

/** Record names the skill subsystem emits; an MCP connector labelled "Skills" is not one. */
const SKILL_RECORD_NAMES = new Set([
  'use_skills',
  'skill_references',
  'load_skill',
  'search_skill_documents',
]);

export function isSkillToolCall(call: ToolCallRecord): boolean {
  if (call.server_id === SKILL_TOOL_SERVER_ID) return true;
  if (call.server_label !== SKILL_TOOL_SERVER_LABEL) return false;
  // Foundry agent preloads are reported as "load_skill (requested)".
  const baseName = call.name.split(' ')[0];
  return SKILL_RECORD_NAMES.has(baseName);
}

export function partitionSkillToolCalls(calls: readonly ToolCallRecord[]): {
  skillCalls: ToolCallRecord[];
  otherCalls: ToolCallRecord[];
} {
  const skillCalls: ToolCallRecord[] = [];
  const otherCalls: ToolCallRecord[] = [];
  for (const call of calls) {
    (isSkillToolCall(call) ? skillCalls : otherCalls).push(call);
  }
  return { skillCalls, otherCalls };
}

export type SkillUsageVia = 'requested' | 'auto' | 'pinned';
/** How the body of a requested skill was chosen on regeneration (§5.7). */
export type SkillUsageVersion = 'original' | 'updated';

export type SkillUsageLine =
  /** A skill delivered into the prompt and how it got there. */
  | {
      kind: 'skill';
      name: string;
      via: SkillUsageVia;
      version?: SkillUsageVersion;
    }
  /** A routed match the user must approve before it applies (§5.5). */
  | { kind: 'consent'; name: string }
  /** An explicitly requested id that did not resolve (unknown, hidden, off). */
  | { kind: 'unavailable'; id: string }
  /** Reference passages retrieved for the active skills' documents. */
  | { kind: 'references'; count: number; unavailable: boolean }
  /** An agent loaded a skill through the read-only tool. */
  | { kind: 'agentLoad'; name: string; failed: boolean }
  /** An agent searched skill documents through the read-only tool. */
  | { kind: 'agentSearch'; failed: boolean }
  /** Any other reported text (degraded routing, document notices). */
  | { kind: 'note'; text: string };

const SKILL_LINE_RE =
  /^(.+?) \((requested|auto|pinned)(?:, (as originally run|updated since))?\)$/;
const CONSENT_LINE_RE = /^(.+?) \(needs approval\)$/;
const UNAVAILABLE_LINE_RE = /^(.+?) \(unavailable\)$/;
const REFERENCES_RE = /^(\d+) reference passages? retrieved\.?$/;

function parseArguments(call: ToolCallRecord): Record<string, unknown> {
  if (!call.arguments) return {};
  try {
    const parsed = JSON.parse(call.arguments) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Typed lines for the chip, in record order. Unknown shapes degrade to notes. */
export function summarizeSkillToolCalls(
  calls: readonly ToolCallRecord[],
): SkillUsageLine[] {
  const lines: SkillUsageLine[] = [];
  for (const call of calls) {
    const failed = call.status === 'failed';
    if (call.name === 'use_skills') {
      for (const raw of (call.output ?? '').split('\n')) {
        const text = raw.trim();
        if (!text) continue;
        const skill = SKILL_LINE_RE.exec(text);
        if (skill) {
          lines.push({
            kind: 'skill',
            name: skill[1],
            via: skill[2] as SkillUsageVia,
            ...(skill[3]
              ? {
                  version:
                    skill[3] === 'as originally run' ? 'original' : 'updated',
                }
              : {}),
          });
          continue;
        }
        const consent = CONSENT_LINE_RE.exec(text);
        if (consent) {
          lines.push({ kind: 'consent', name: consent[1] });
          continue;
        }
        const unavailable = UNAVAILABLE_LINE_RE.exec(text);
        if (unavailable) {
          lines.push({ kind: 'unavailable', id: unavailable[1] });
          continue;
        }
        lines.push({ kind: 'note', text });
      }
      if (!call.output && call.error)
        lines.push({ kind: 'note', text: call.error });
      continue;
    }
    if (call.name === 'skill_references') {
      const match = REFERENCES_RE.exec((call.output ?? '').trim());
      lines.push({
        kind: 'references',
        count: match ? Number(match[1]) : 0,
        unavailable: call.status !== 'completed',
      });
      continue;
    }
    if (call.name.startsWith('load_skill')) {
      const args = parseArguments(call);
      const id = args.skillId ?? args.id ?? args.skill;
      const name =
        typeof id === 'string' && id
          ? id
          : (call.output ?? call.error ?? call.name).split('\n')[0].trim();
      // Foundry preloads of user-requested skills are reported as
      // "load_skill (requested)": the user chose them, not the model.
      if (
        call.name === 'load_skill (requested)' &&
        call.status === 'completed'
      ) {
        lines.push({ kind: 'skill', name, via: 'requested' });
        continue;
      }
      lines.push({
        kind: 'agentLoad',
        name,
        failed: failed || call.status === 'incomplete',
      });
      continue;
    }
    if (call.name === 'search_skill_documents') {
      lines.push({ kind: 'agentSearch', failed });
      continue;
    }
    const text = (call.output ?? call.error ?? call.name).trim();
    if (text) lines.push({ kind: 'note', text });
  }
  return lines;
}

/** Whether any record reports a problem worth flagging on the chip. */
export function skillUsageHasIssue(calls: readonly ToolCallRecord[]): boolean {
  return calls.some((call) => call.status !== 'completed');
}

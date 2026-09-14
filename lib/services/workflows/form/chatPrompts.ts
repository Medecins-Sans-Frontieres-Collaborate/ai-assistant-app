import { FillSourceRecord, FormDocument } from '@/types/formFill';

import { coverageOf, fieldStatus } from './status';
import { formatValue } from './validation';

/**
 * Rail-chat grounding for the form workspace: a digest of the ledger
 * (template, statuses, gaps, open questions) the assistant answers over.
 * Read-only by design — filling happens through the Fill run and the
 * review queue, the single write path.
 */

const VALUE_PREVIEW_CHARS = 240;

export function buildLedgerDigest(options: {
  document: FormDocument;
  sources: FillSourceRecord[];
}): string {
  const { document, sources } = options;
  const template = document.template;
  const coverage = coverageOf(document);
  const lines: string[] = [
    `Form: ${template.name}`,
    template.description ? `About: ${template.description}` : '',
    `Document language: ${document.language}`,
    `Coverage: ${coverage.filled + coverage.confirmed} filled, ${coverage.partial} partial, ${coverage.empty} not addressed, ${coverage.notApplicable} N/A (of ${coverage.total}); required addressed ${coverage.requiredAddressed}/${coverage.requiredTotal}`,
    '',
    'Sources:',
    ...(sources.length === 0
      ? ['  (none yet)']
      : sources.map(
          (s) =>
            `  - [${s.id}] ${s.kind}: ${s.name}${s.language ? ` (${s.language})` : ''}${s.error ? ' — failed to fetch' : ''}`,
        )),
    '',
    'Fields:',
  ];
  for (const section of template.sections) {
    const fields = template.fields.filter((f) => f.sectionId === section.id);
    if (fields.length === 0) continue;
    lines.push(`## ${section.heading}`);
    for (const field of fields) {
      const fill = document.fields[field.id];
      const { status, issues } = fieldStatus(field, fill);
      const value = formatValue(fill?.value).replace(/\s+/g, ' ');
      const parts = [
        `  - ${field.label} [${field.id}] (${field.type}${field.required ? ', required' : ''}) — ${status}`,
      ];
      if (value && status !== 'empty') {
        parts.push(
          `    value: ${value.length > VALUE_PREVIEW_CHARS ? `${value.slice(0, VALUE_PREVIEW_CHARS)}…` : value}`,
        );
      }
      if (fill?.gaps) parts.push(`    gaps: ${fill.gaps}`);
      if (issues.length > 0) {
        parts.push(`    issues: ${issues.map((i) => i.code).join(', ')}`);
      }
      lines.push(...parts);
    }
  }
  const open = document.questions.filter((q) => q.status === 'open');
  if (open.length > 0) {
    lines.push('', 'Open questions to the user:');
    for (const q of open) lines.push(`  - ${q.text}`);
  }
  return lines.filter((l) => l !== undefined).join('\n');
}

export function buildFormChatSystemPrompt(): string {
  return [
    'You are helping a user fill in a form. You have a digest of the form: its fields, their current status (empty, partial, filled, confirmed, not_applicable), values, gaps and the sources provided.',
    'Answer questions about what is filled, what is missing and why, and what material would help. When the user gives you information in chat, acknowledge it and tell them it will be used the next time they run Fill — you cannot write into fields yourself.',
    'Never invent values. Refer to fields by their labels. Keep answers short and concrete.',
  ].join('\n');
}

export function buildFormChatUserPrompt(
  digest: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
  return `<<<LEDGER\n${digest}\nLEDGER>>>\n\nConversation so far:\n\n${transcript}\n\nAssistant:`;
}

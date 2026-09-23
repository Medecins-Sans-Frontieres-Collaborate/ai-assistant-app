import {
  FillNote,
  FillSourceRecord,
  FormDocument,
  FormField,
} from '@/types/formFill';

import { fieldStatus } from './status';
import { FieldIssue, formatValue } from './validation';

/**
 * The provenance document (docs/DOCUMENT_FILL_ASSESSMENT.md §7d): a
 * separate, downloadable record that sources every claim. Generated
 * client-side from the ledger — nothing here is produced by a model call.
 * Strings are passed in so the document can be written in the UI locale.
 */

export interface ProvenanceStrings {
  title: string;
  generatedAt: string;
  template: string;
  language: string;
  runs: string;
  runLine: (
    at: string,
    model: string,
    fields: number,
    sources: number,
  ) => string;
  sources: string;
  noSources: string;
  sourceLine: (source: FillSourceRecord) => string;
  fields: string;
  status: Record<string, string>;
  confidence: string;
  issues: string;
  issueText: (issue: FieldIssue) => string;
  gaps: string;
  supportedBy: string;
  /** Appended to an excerpt the server could not find in its source. */
  excerptNotFound?: string;
  unsourced: string;
  generalKnowledge: string;
  lockedByAdmin: string;
  fromNote: string;
  openQuestions: string;
  noOpenQuestions: string;
  notApplicableFields: string;
  none: string;
  value: string;
  empty: string;
}

function sourceLabel(
  id: string,
  sources: FillSourceRecord[],
  notes: FillNote[],
  strings: ProvenanceStrings,
): string {
  const source = sources.find((s) => s.id === id);
  if (source) return source.name;
  const note = notes.find((n) => n.sourceId === id);
  if (note) return strings.fromNote;
  return id;
}

function fieldBlock(
  field: FormField,
  document: FormDocument,
  sources: FillSourceRecord[],
  notes: FillNote[],
  strings: ProvenanceStrings,
): string[] {
  const fill = document.fields[field.id];
  const { status, issues } = fieldStatus(field, fill);
  const lines: string[] = [`### ${field.label}`];
  lines.push(
    `- **${strings.status.label}:** ${strings.status[status] ?? status}`,
  );
  if (status !== 'empty' && status !== 'not_applicable') {
    const text = formatValue(fill?.value);
    lines.push(`- **${strings.value}:** ${text.includes('\n') ? '' : text}`);
    if (text.includes('\n')) {
      lines.push('', '> ' + text.split('\n').join('\n> '), '');
    }
  } else if (status === 'empty') {
    lines.push(`- **${strings.value}:** _${strings.empty}_`);
  }
  if (fill?.confidence && status !== 'empty') {
    lines.push(`- **${strings.confidence}:** ${fill.confidence}`);
  }
  if (issues.length > 0) {
    lines.push(
      `- **${strings.issues}:** ${issues.map(strings.issueText).join('; ')}`,
    );
  }
  if (fill?.gaps) lines.push(`- **${strings.gaps}:** ${fill.gaps}`);
  if (field.admin?.locked) {
    lines.push(`- ${strings.lockedByAdmin}`);
  } else if (fill && status !== 'empty' && status !== 'not_applicable') {
    if (fill.provenance.length > 0) {
      lines.push(`- **${strings.supportedBy}:**`);
      for (const p of fill.provenance) {
        const label = sourceLabel(p.sourceId, sources, notes, strings);
        const flag =
          p.verified === false && strings.excerptNotFound
            ? ` (${strings.excerptNotFound})`
            : '';
        lines.push(`  - ${label}: "${p.excerpt.replace(/\s+/g, ' ')}"${flag}`);
      }
    } else if (fill.generalKnowledge) {
      lines.push(`- ${strings.generalKnowledge}`);
    } else {
      lines.push(`- ${strings.unsourced}`);
    }
  }
  lines.push('');
  return lines;
}

export function buildProvenanceMarkdown(options: {
  document: FormDocument;
  sources: FillSourceRecord[];
  notes: FillNote[];
  strings: ProvenanceStrings;
  now?: Date;
}): string {
  const { document, sources, notes, strings } = options;
  const now = options.now ?? new Date();
  const template = document.template;
  const lines: string[] = [
    `# ${strings.title}: ${template.name}`,
    '',
    `- **${strings.generatedAt}:** ${now.toISOString()}`,
    `- **${strings.template}:** ${template.name}${template.origin === 'admin' ? ' (admin)' : ''}`,
    `- **${strings.language}:** ${document.language}`,
    '',
    `## ${strings.runs}`,
    '',
  ];
  if (document.runs.length === 0) lines.push(`_${strings.none}_`, '');
  for (const run of document.runs) {
    lines.push(
      `- ${strings.runLine(run.at, run.modelId ?? '—', run.fieldIds.length, run.sourceIds.length)}`,
    );
  }
  lines.push('', `## ${strings.sources}`, '');
  if (sources.length === 0) lines.push(`_${strings.noSources}_`);
  for (const source of sources) lines.push(`- ${strings.sourceLine(source)}`);
  lines.push('', `## ${strings.fields}`, '');
  for (const section of template.sections) {
    const fields = template.fields.filter((f) => f.sectionId === section.id);
    if (fields.length === 0) continue;
    lines.push(`## ${section.heading}`, '');
    for (const field of fields) {
      lines.push(...fieldBlock(field, document, sources, notes, strings));
    }
  }
  const open = document.questions.filter((q) => q.status === 'open');
  lines.push(`## ${strings.openQuestions}`, '');
  if (open.length === 0) lines.push(`_${strings.noOpenQuestions}_`);
  for (const q of open) lines.push(`- ${q.text}`);
  const na = template.fields.filter(
    (f) => document.fields[f.id]?.decision === 'not_applicable',
  );
  lines.push('', `## ${strings.notApplicableFields}`, '');
  if (na.length === 0) lines.push(`_${strings.none}_`);
  for (const f of na) lines.push(`- ${f.label}`);
  return lines.join('\n').trim() + '\n';
}

/** Machine-readable twin of the provenance document. */
export function buildProvenanceJson(options: {
  document: FormDocument;
  sources: FillSourceRecord[];
  notes: FillNote[];
  now?: Date;
}): Record<string, unknown> {
  const { document, sources, notes } = options;
  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    template: {
      id: document.template.id,
      name: document.template.name,
      origin: document.template.origin,
    },
    language: document.language,
    runs: document.runs,
    sources,
    fields: document.template.fields.map((field) => {
      const fill = document.fields[field.id];
      const { status, issues } = fieldStatus(field, fill);
      return {
        id: field.id,
        label: field.label,
        sectionId: field.sectionId,
        status,
        value: fill?.value ?? null,
        confidence: fill?.confidence,
        gaps: fill?.gaps,
        issues,
        provenance: fill?.provenance ?? [],
        generalKnowledge: fill?.generalKnowledge ?? false,
        locked: field.admin?.locked ?? false,
      };
    }),
    questions: document.questions,
    notes: notes.map((n) => ({
      id: n.id,
      sourceId: n.sourceId,
      createdAt: n.createdAt,
    })),
  };
}

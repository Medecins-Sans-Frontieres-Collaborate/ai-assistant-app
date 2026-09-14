import { FormDocument, FormField } from '@/types/formFill';

import { fieldStatus } from './status';
import { formatValue, isListType } from './validation';

/**
 * Rendered-output projection: the template `layout` with `{{field:<id>}}`
 * slots substituted by ledger values → markdown. Pure and client-safe; the
 * markdown then goes through the existing markdownToHtml → export path.
 */

export interface RenderOptions {
  /** How an empty slot renders. `placeholder` = "[Label]"; `blank` = nothing. */
  emptyAs?: 'placeholder' | 'blank';
  /** Text for N/A fields; default "N/A". */
  notApplicableText?: string;
  /**
   * Wrap each substituted value so a preview can style it by status. The
   * default is plain substitution (exports).
   */
  wrap?: (
    field: FormField,
    text: string,
    status: ReturnType<typeof fieldStatus>['status'],
  ) => string;
}

const SLOT = /\{\{field:([a-z][a-z0-9_]{0,39})\}\}/g;

function listMarkdown(items: string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

/**
 * The markdown a value renders as, given its field type. A list in an
 * INLINE slot ("**Goals:** {{field:goals}}") cannot be a bullet list — that
 * would break the line it sits on — so it joins with "; " there.
 */
export function valueMarkdown(
  field: FormField,
  value: unknown,
  context: 'block' | 'inline' = 'block',
): string {
  if (Array.isArray(value)) {
    return isListType(field.type) && context === 'block'
      ? listMarkdown(value.map(String))
      : value.map(String).join(context === 'inline' ? '; ' : ', ');
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return formatValue(value as string | number | null);
}

export function renderLayout(
  document: FormDocument,
  options: RenderOptions = {},
): string {
  const byId = new Map(document.template.fields.map((f) => [f.id, f]));
  const emptyAs = options.emptyAs ?? 'placeholder';
  const na = options.notApplicableText ?? 'N/A';
  const layout = document.template.layout;
  return layout.replace(SLOT, (match, id: string, offset: number) => {
    const field = byId.get(id);
    if (!field) return match;
    const fill = document.fields[id];
    const { status } = fieldStatus(field, fill);
    const atLineStart = offset === 0 || layout[offset - 1] === '\n';
    let text: string;
    if (status === 'not_applicable') text = na;
    else if (status === 'empty') {
      text = emptyAs === 'blank' ? '' : `[${field.label}]`;
    } else {
      text = valueMarkdown(
        field,
        fill?.value,
        atLineStart ? 'block' : 'inline',
      );
    }
    return options.wrap ? options.wrap(field, text, status) : text;
  });
}

/** Plain values keyed by field id, for the in-place fillers. */
export function valuesForFill(document: FormDocument): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of document.template.fields) {
    const fill = document.fields[field.id];
    const { status } = fieldStatus(field, fill);
    if (status === 'empty') continue;
    if (status === 'not_applicable') {
      out[field.id] = field.type === 'boolean' ? '' : 'N/A';
      continue;
    }
    out[field.id] = Array.isArray(fill?.value)
      ? fill.value.map(String).join('\n')
      : formatValue(fill?.value);
  }
  return out;
}

/** Safe file base name from a template name. */
export function exportBaseName(name: string): string {
  const base = name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
  return base || 'form';
}

'use client';

import { useEffect, useMemo, useState } from 'react';

import { renderLayout } from '@/lib/services/workflows/form/render';

import {
  markdownToHtml,
  sanitizeHtml,
} from '@/lib/utils/shared/document/formatConverter';

import { FillStatus, FormDocument } from '@/types/formFill';

interface DocumentPreviewProps {
  document: FormDocument;
  selectedFieldId: string | null;
  onSelectField: (fieldId: string) => void;
}

const STATUS_CLASS: Record<FillStatus, string> = {
  empty: 'form-slot-empty',
  partial: 'form-slot-partial',
  filled: 'form-slot-filled',
  confirmed: 'form-slot-filled',
  not_applicable: 'form-slot-na',
};

/**
 * Slot tokens survive markdown + sanitization as plain text; the slot
 * markup is inserted AFTER sanitization, from this component only. Values
 * therefore never pass through the markdown parser (no `[x](url)` links,
 * no raw HTML from a fill), and a layout — model output from untrusted
 * material, or admin-authored — cannot spoof a slot: any `id`, `class` or
 * `<img>` the layout itself carried is stripped before tokens are expanded.
 * The separator is U+2063 (invisible), which no layout text will contain.
 */
const SEP = '⁣';
const TOKEN_PREFIX = `${SEP}FORMSLOT${SEP}`;
const TOKEN_RE = new RegExp(
  `${SEP}FORMSLOT${SEP}([a-z][a-z0-9_]{0,39})${SEP}`,
  'g',
);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** DOMPurify output is well-formed, so attribute/tag regexes are reliable here. */
function hardenLayoutHtml(html: string): string {
  return html
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/\s(?:id|class)="[^"]*"/gi, '');
}

/**
 * The rendered document: layout + values, each slot styled by status and
 * clickable to select the field. Read-only — editing happens in the field
 * detail, the one write path. Rendered through the same markdown →
 * sanitized HTML path the exports use, so what the user previews is what
 * they export (minus the slot chrome).
 */
export function DocumentPreview({
  document,
  selectedFieldId,
  onSelectField,
}: DocumentPreviewProps) {
  const { markdown, values } = useMemo(() => {
    const byId = new Map<string, { text: string; status: FillStatus }>();
    const md = renderLayout(document, {
      emptyAs: 'placeholder',
      wrap: (field, text, status) => {
        byId.set(field.id, { text, status });
        return `${TOKEN_PREFIX}${field.id}${SEP}`;
      },
    });
    return { markdown: md, values: byId };
  }, [document]);

  const [html, setHtml] = useState('');
  useEffect(() => {
    let cancelled = false;
    sanitizeHtml(markdownToHtml(markdown)).then((safe) => {
      if (cancelled) return;
      const expanded = hardenLayoutHtml(safe).replace(
        TOKEN_RE,
        (_match, id: string) => {
          const value = values.get(id);
          if (!value) return '';
          const cls = STATUS_CLASS[value.status];
          const selected = id === selectedFieldId ? ' form-slot-selected' : '';
          const body = escapeHtml(value.text || ' ')
            .split('\n')
            .join('<br>');
          return `<span class="form-slot ${cls}${selected}" id="form-slot-${id}">${body}</span>`;
        },
      );
      setHtml(expanded);
    });
    return () => {
      cancelled = true;
    };
  }, [markdown, values, selectedFieldId]);

  return (
    <div
      className="form-preview prose prose-sm h-full max-w-none overflow-y-auto px-6 py-4 dark:prose-invert"
      onClick={(e) => {
        const target = (e.target as HTMLElement).closest('[id^="form-slot-"]');
        const id = target?.id.slice('form-slot-'.length);
        if (id && values.has(id)) onSelectField(id);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

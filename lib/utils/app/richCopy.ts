/**
 * Rich clipboard support for text selected inside rendered chat messages.
 *
 * A native browser copy already carries a text/html flavor, but it has two
 * problems: UI chrome that lives inside the message DOM (code-block and
 * table toolbar buttons, citation tooltips) is copied along with the
 * content, and Streamdown renders code blocks as one <span> per line with
 * no newline characters, so code pastes as a single run-on line. The
 * text/plain flavor is worse — list structure degrades to unmarked,
 * indented lines and code loses its line breaks entirely.
 *
 * `handleRichCopy` rewrites both flavors from the live selection: HTML is
 * cleaned (chrome stripped, code newlines restored) so word processors keep
 * bold/lists/tables, and plain text is serialized with `- ` bullets,
 * `1.` numbering, tab-separated table cells and real code line breaks so
 * plain-text-only targets keep the structure too.
 */

/** UI elements that live inside message DOM but are not message content. */
const STRIP_SELECTOR = [
  'button',
  '[data-open-editor]',
  '.citation-tooltip',
  '[data-streamdown="code-block-copy-button"]',
  '[data-streamdown="code-block-download-button"]',
].join(', ');

/**
 * Streamdown emits one <span> per code line with no newline text between
 * them; flatten each code block back to plain text with real line breaks.
 */
function normalizeCodeBlocks(root: HTMLElement): void {
  root.querySelectorAll('pre code').forEach((code) => {
    const lineSpans = code.querySelectorAll(':scope > span');
    if (lineSpans.length === 0) return;
    const text = Array.from(lineSpans)
      .map((span) => span.textContent ?? '')
      .join('\n');
    code.textContent = text;
  });
}

function cloneSelection(selection: Selection): HTMLElement {
  const container = document.createElement('div');
  for (let i = 0; i < selection.rangeCount; i++) {
    container.appendChild(selection.getRangeAt(i).cloneContents());
  }
  container.querySelectorAll(STRIP_SELECTOR).forEach((el) => el.remove());
  // React leaks the mdast `node` prop as node="[object Object]" on some
  // elements; scrub it so the exported HTML is clean.
  container.querySelectorAll('[node]').forEach((el) => {
    el.removeAttribute('node');
  });
  normalizeCodeBlocks(container);
  return container;
}

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'ul',
  'ol',
  'table',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
]);

function serializeChildren(node: Node): string {
  let out = '';
  node.childNodes.forEach((child) => {
    out += serializeNode(child);
  });
  return out;
}

function serializeTable(table: Element): string {
  const rows: string[] = [];
  table.querySelectorAll(':scope tr').forEach((tr) => {
    const cells = Array.from(tr.querySelectorAll(':scope > td, :scope > th'));
    rows.push(
      cells
        .map((cell) => serializeChildren(cell).replace(/\s+/g, ' ').trim())
        .join('\t'),
    );
  });
  return `${rows.join('\n')}\n\n`;
}

function serializeList(listEl: Element, depth: number): string {
  const ordered = listEl.tagName === 'OL';
  let ordinal = ordered ? 1 : null;
  let out = '';
  listEl.childNodes.forEach((child) => {
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const el = child as Element;
    if (el.tagName !== 'LI') return;
    const marker = ordinal !== null ? `${ordinal}.` : '-';
    if (ordinal !== null) ordinal += 1;

    // Serialize the item's inline content and any nested lists separately,
    // so nested bullets land on their own indented lines below the item.
    let inline = '';
    let nested = '';
    el.childNodes.forEach((itemChild) => {
      if (
        itemChild.nodeType === Node.ELEMENT_NODE &&
        ((itemChild as Element).tagName === 'UL' ||
          (itemChild as Element).tagName === 'OL')
      ) {
        nested += serializeList(itemChild as Element, depth + 1);
      } else {
        inline += serializeNode(itemChild);
      }
    });
    const indent = '  '.repeat(depth);
    out += `${indent}${marker} ${inline.replace(/\s+/g, ' ').trim()}\n`;
    out += nested;
  });
  return depth === 0 ? `${out}\n` : out;
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? '';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  switch (tag) {
    case 'br':
      return '\n';
    case 'hr':
      return '\n';
    case 'pre':
      return `${(el.textContent ?? '').replace(/\n+$/, '')}\n\n`;
    case 'ul':
    case 'ol':
      return serializeList(el, 0);
    case 'table':
      return serializeTable(el);
    case 'p':
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return `${serializeChildren(el).trim()}\n\n`;
    case 'blockquote':
      return `${serializeChildren(el).trim()}\n\n`;
    default:
      return serializeChildren(el) + (BLOCK_TAGS.has(tag) ? '\n\n' : '');
  }
}

/** Serializes cleaned message DOM to structured plain text. */
export function toPlainText(root: HTMLElement): string {
  return serializeNode(root)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Builds both clipboard flavors from the current selection, or null when
 * the selection is empty (caller should fall back to the default copy).
 */
export function selectionClipboardPayload(
  selection: Selection | null,
): { html: string; text: string } | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  const cleaned = cloneSelection(selection);
  if (!cleaned.textContent?.trim()) return null;
  return { html: cleaned.innerHTML, text: toPlainText(cleaned) };
}

/**
 * Copy-event handler for rendered message containers. Leaves copies from
 * text inputs and empty selections to the browser default.
 */
export function handleRichCopy(
  event: Pick<ClipboardEvent, 'clipboardData' | 'preventDefault'> & {
    target: EventTarget | null;
  },
): void {
  const target = event.target;
  if (target instanceof HTMLElement && target.closest('textarea, input')) {
    return;
  }
  try {
    const payload = selectionClipboardPayload(window.getSelection());
    if (!payload || !event.clipboardData) return;
    event.clipboardData.setData('text/html', payload.html);
    event.clipboardData.setData('text/plain', payload.text);
    event.preventDefault();
  } catch {
    // Fall back to the browser's default copy on any failure.
  }
}

import { diffWords } from '@/lib/utils/shared/review/editApplication';
import {
  locateEdits,
  resolvePreviewText,
  touchedSpanIds,
} from '@/lib/utils/shared/review/editLocation';

import { Extension } from '@tiptap/core';
import { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface PreviewEdit {
  id: string;
  before: string;
  after: string;
}

export interface EditPreviewState {
  edits: readonly PreviewEdit[];
  /** The edit being previewed — hovered card, or the pinned span. */
  activeId: string | null;
  /** The clicked edit; React floats the accept/reject bar at the cursor. */
  pinnedId: string | null;
  /**
   * A decorated span was clicked (null when dismissed). The originating
   * event travels with it so the caller can place the action bar where the
   * user actually clicked rather than at the end of the span.
   */
  onPin: ((id: string | null, event?: MouseEvent) => void) | null;
  /**
   * A transaction is about to change text INSIDE one or more suggestion
   * spans (docs/REVIEW_EDIT_UNFREEZE_DESIGN.md §6a). Return true to let it
   * through — the caller records the casualties — or false to veto it, so
   * the caller can explain first. Null when the workspace has frozen the
   * editor instead and no gate is needed.
   *
   * Called synchronously from inside ProseMirror's dispatch, so it must
   * decide from state it already holds; it cannot wait on a dialog.
   */
  onOverwrite: ((ids: string[]) => boolean) | null;
}

/** A located edit in ProseMirror coordinates. */
interface PreviewSpan {
  id: string;
  from: number;
  to: number;
}

interface PluginState {
  value: EditPreviewState;
  decorations: DecorationSet;
  spans: PreviewSpan[];
}

export const editPreviewKey = new PluginKey<PluginState>('editPreview');

const EMPTY: EditPreviewState = {
  edits: [],
  activeId: null,
  pinnedId: null,
  onPin: null,
  onOverwrite: null,
};

/**
 * Transaction meta that exempts a programmatic rewrite from the overwrite
 * gate — an applied edit or a scoped revision is not the user typing over a
 * suggestion. Tiptap's own `setContent(…, { emitUpdate: false })` marks its
 * transactions `preventUpdate`, which the gate honours for the same reason.
 */
export const editPreviewBypassMeta = 'editPreviewBypass';

/**
 * The ranges of the ORIGINAL document a transaction replaces, one per step.
 * A later step's positions are in the intermediate document it applied to,
 * so each is mapped back through the inverse of the steps before it.
 */
function replacedRanges(tr: Transaction): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  tr.steps.forEach((step, index) => {
    const back = tr.mapping.slice(0, index).invert();
    step.getMap().forEach((oldStart, oldEnd) => {
      ranges.push({ from: back.map(oldStart, -1), to: back.map(oldEnd, 1) });
    });
  });
  return ranges;
}

/**
 * Flattens the doc to plain text alongside a string-offset → PM-position
 * map, so an edit's `before` (a markdown substring) can be found by what
 * the reader actually sees. Blocks are joined with a single newline; a
 * `before` that spans a paragraph break therefore won't match, and that
 * edit simply goes unhighlighted rather than being mislocated.
 */
function flatten(doc: PMNode): { text: string; positions: number[] } {
  let text = '';
  const positions: number[] = [];

  doc.descendants((node, pos) => {
    if (node.isText) {
      const value = node.text ?? '';
      for (let i = 0; i < value.length; i++) positions.push(pos + i);
      text += value;
      return false;
    }
    if (node.isBlock && text.length > 0 && !text.endsWith('\n')) {
      text += '\n';
      positions.push(pos);
    }
    return true;
  });

  // Sentinel so an end offset at the very end of the doc still maps.
  positions.push(doc.content.size);
  return { text, positions };
}

function buildPreview(
  doc: PMNode,
  state: EditPreviewState,
): { decorations: DecorationSet; spans: PreviewSpan[] } {
  const empty = { decorations: DecorationSet.empty, spans: [] };
  const pending = state.edits.filter((edit) => edit.before);
  if (pending.length === 0) return empty;

  const { text, positions } = flatten(doc);
  if (!text) return empty;

  const searchable = pending
    .map((edit) => {
      const resolved = resolvePreviewText(text, edit.before, edit.after);
      return resolved ? { id: edit.id, ...resolved } : null;
    })
    .filter((edit): edit is PreviewEdit => edit !== null);

  const byId = new Map(searchable.map((edit) => [edit.id, edit]));
  const decorations: Decoration[] = [];
  const spans: PreviewSpan[] = [];

  for (const location of locateEdits(text, searchable)) {
    const edit = byId.get(location.id)!;
    const from = positions[location.start];
    const to = positions[location.end];
    if (from === undefined || to === undefined) continue;

    spans.push({ id: location.id, from, to });

    if (location.id !== state.activeId) {
      decorations.push(
        Decoration.inline(from, to, { class: 'edit-suggestion-mark' }),
      );
      continue;
    }

    // Active: replay the card's word diff in place — deletions struck
    // through where they stand, insertions injected as widgets so the
    // document itself is never mutated to preview it.
    decorations.push(
      Decoration.inline(from, to, { class: 'edit-suggestion-active' }),
    );

    let offset = location.start;
    for (const [index, part] of diffWords(
      text.slice(location.start, location.end),
      edit.after,
    ).entries()) {
      if (part.kind === 'ins') {
        const at = positions[offset];
        if (at === undefined) continue;
        decorations.push(
          Decoration.widget(
            at,
            () => {
              const el = document.createElement('ins');
              el.className = 'edit-suggestion-ins';
              el.textContent = part.text;
              // Never part of the document: not editable, not copied.
              el.contentEditable = 'false';
              return el;
            },
            { side: 1, key: `${edit.id}:ins:${index}`, ignoreSelection: true },
          ),
        );
        continue;
      }
      const next = offset + part.text.length;
      if (part.kind === 'del') {
        const start = positions[offset];
        const end = positions[next];
        if (start !== undefined && end !== undefined) {
          decorations.push(
            Decoration.inline(start, end, { class: 'edit-suggestion-del' }),
          );
        }
      }
      offset = next;
    }
  }

  return { decorations: DecorationSet.create(doc, decorations), spans };
}

/**
 * Paints pending review edits onto the document: a quiet resting marker on
 * every suggestion's target span and a full inline diff on the active one.
 * Purely decorative — no transaction ever changes the doc. Clicking a span
 * reports the hit (with its event) so React can float accept/reject at the
 * cursor.
 *
 * Driven from React by dispatching `editPreviewKey` meta (see the
 * `previewEdits` / `activeEditId` props on RichTextEditor).
 */
export const EditPreview = Extension.create({
  name: 'editPreview',

  addProseMirrorPlugins() {
    return [
      new Plugin<PluginState>({
        key: editPreviewKey,
        state: {
          init: (_config, editorState) => ({
            value: EMPTY,
            ...buildPreview(editorState.doc, EMPTY),
          }),
          // Rebuild only when the preview changes or the doc does; a bare
          // selection change must not re-flatten the whole document.
          apply: (tr, previous, _old, newState) => {
            const meta = tr.getMeta(editPreviewKey) as
              | EditPreviewState
              | undefined;
            if (!meta && !tr.docChanged) return previous;
            const value = meta ?? previous.value;
            return { value, ...buildPreview(newState.doc, value) };
          },
        },
        // The overwrite gate. Runs against the PRE-transaction state, whose
        // spans describe where the suggestions currently sit; the caller's
        // answer decides whether the change lands.
        filterTransaction(tr, editorState) {
          if (!tr.docChanged) return true;
          if (
            tr.getMeta('preventUpdate') ||
            tr.getMeta(editPreviewBypassMeta)
          ) {
            return true;
          }
          const plugin = editPreviewKey.getState(editorState);
          const gate = plugin?.value.onOverwrite;
          if (!gate || !plugin || plugin.spans.length === 0) return true;
          const touched = touchedSpanIds(plugin.spans, replacedRanges(tr));
          return touched.length === 0 ? true : gate(touched);
        },
        props: {
          decorations(editorState) {
            return editPreviewKey.getState(editorState)?.decorations;
          },
          // Clicking a marked span pins it (and re-clicking dismisses),
          // so a change can be decided from the document itself.
          handleClick(view, pos, event) {
            const state = editPreviewKey.getState(view.state);
            if (!state?.value.onPin) return false;
            const hit = state.spans.find(
              (span) => pos >= span.from && pos <= span.to,
            );
            if (!hit) {
              if (state.value.pinnedId) {
                state.value.onPin(null);
                return true;
              }
              return false;
            }
            state.value.onPin(
              state.value.pinnedId === hit.id ? null : hit.id,
              event,
            );
            return true;
          },
        },
      }),
    ];
  },
});

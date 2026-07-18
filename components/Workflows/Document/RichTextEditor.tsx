'use client';

import { EditorContent, useEditor } from '@tiptap/react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

import { useTranslations } from 'next-intl';

import '@/components/DocumentEditor/editor.css';

import type { PinPoint } from '../Shared/Review/EditQuickActions';
import {
  EditPreview,
  type PreviewEdit,
  editPreviewKey,
} from './EditPreviewExtension';

import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { Table } from '@tiptap/extension-table';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableRow } from '@tiptap/extension-table-row';
import { Underline } from '@tiptap/extension-underline';
import StarterKit from '@tiptap/starter-kit';
import { common, createLowlight } from 'lowlight';

const lowlight = createLowlight(common);

const NO_EDITS: readonly PreviewEdit[] = [];

/** An active (non-collapsed) selection in the editor. */
export interface EditorSelection {
  text: string;
  from: number;
  to: number;
}

/** Imperative surface for selection-scoped operations. */
export interface RichTextEditorHandle {
  /** Replaces the given range with HTML and returns the new doc HTML. */
  replaceRange: (from: number, to: number, html: string) => string | null;
  getHTML: () => string | null;
}

interface RichTextEditorProps {
  /** Canonical HTML content. External changes replace the editor content. */
  contentHtml: string;
  onChange: (html: string) => void;
  editable?: boolean;
  placeholderHtml?: string;
  /** Reports the active selection (null when collapsed/empty). */
  onSelectionUpdate?: (selection: EditorSelection | null) => void;
  /** Pending review edits to mark in the text (decorations only). */
  previewEdits?: readonly PreviewEdit[];
  /** The edit being previewed — its span shows the full inline diff. */
  activeEditId?: string | null;
  /** The clicked edit; its span carries inline accept/reject. */
  pinnedEditId?: string | null;
  /** A marked span was clicked (null when dismissed). */
  onPinEdit?: (id: string | null) => void;
  /**
   * Accept/reject UI for the pinned edit, floated at the click point. Takes
   * the position so the workspace stays out of the editor's coordinate space.
   */
  renderQuickActions?: (position: PinPoint) => React.ReactNode;
}

/**
 * Controlled Tiptap editor with the same extension set as the artifact
 * DocumentEditor, but driven by props instead of the singleton
 * artifactStore — so it can be mounted per workflow conversation. The
 * artifact editor is intentionally left untouched.
 */
export const RichTextEditor = forwardRef<
  RichTextEditorHandle,
  RichTextEditorProps
>(function RichTextEditor(
  {
    contentHtml,
    onChange,
    editable = true,
    placeholderHtml,
    onSelectionUpdate,
    previewEdits = NO_EDITS,
    activeEditId = null,
    pinnedEditId = null,
    onPinEdit,
    renderQuickActions,
  },
  ref,
) {
  const t = useTranslations();

  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinPoint, setPinPoint] = useState<PinPoint | null>(null);

  // The point belongs to the pin; losing one must lose the other.
  useEffect(() => {
    if (!pinnedEditId) setPinPoint(null);
  }, [pinnedEditId]);

  /**
   * Records where in the scrolled content the click landed, so the action
   * bar can be laid out against it and scroll along with the text.
   */
  const handlePin = useCallback(
    (id: string | null, event?: MouseEvent) => {
      const container = scrollRef.current;
      if (id && event && container) {
        const rect = container.getBoundingClientRect();
        // Clamp to the pane only once it has a real width, or an
        // unlaid-out container would pin everything to x=0.
        const width = container.clientWidth;
        const maxX = width > 60 ? width - 56 : Infinity;
        setPinPoint({
          x: Math.min(
            event.clientX - rect.left + container.scrollLeft + 4,
            maxX,
          ),
          y: event.clientY - rect.top + container.scrollTop,
        });
      }
      onPinEdit?.(id);
    },
    [onPinEdit],
  );

  const editor = useEditor({
    immediatelyRender: false, // Disable SSR to avoid hydration mismatches
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      CodeBlockLowlight.configure({ lowlight }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Underline,
      EditPreview,
    ],
    content: contentHtml || placeholderHtml || '',
    editable,
    editorProps: {
      attributes: {
        class:
          'prose prose-sm sm:prose max-w-none focus:outline-none dark:prose-invert',
      },
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML());
    },
    onSelectionUpdate: ({ editor }) => {
      if (!onSelectionUpdate) return;
      const { from, to } = editor.state.selection;
      if (from === to) {
        onSelectionUpdate(null);
        return;
      }
      const text = editor.state.doc.textBetween(from, to, '\n');
      onSelectionUpdate(text.trim() ? { text, from, to } : null);
    },
  });

  useImperativeHandle(
    ref,
    () => ({
      replaceRange: (from, to, html) => {
        if (!editor) return null;
        editor.chain().focus().insertContentAt({ from, to }, html).run();
        return editor.getHTML();
      },
      getHTML: () => editor?.getHTML() ?? null,
    }),
    [editor],
  );

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable);
  }, [editor, editable]);

  // Push the preview into the decoration plugin. A meta-only transaction
  // leaves the document untouched, so this never enters the undo history
  // and never fires onUpdate.
  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(
      editor.state.tr.setMeta(editPreviewKey, {
        edits: previewEdits,
        activeId: activeEditId,
        pinnedId: pinnedEditId,
        onPin: onPinEdit ? handlePin : null,
      }),
    );
    // Decorations land synchronously with the dispatch, so the previewed
    // span is already in the DOM — bring it into view, since the card can
    // sit pages away from the text it refers to.
    if (activeEditId) {
      editor.view.dom
        .querySelector('.edit-suggestion-active')
        ?.scrollIntoView({ block: 'nearest' });
    }
  }, [editor, previewEdits, activeEditId, pinnedEditId, onPinEdit, handlePin]);

  // Apply external content changes (streaming revisions, state rehydration)
  // without clobbering the user's in-progress typing: only reset when the
  // incoming HTML differs from what the editor already has.
  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    if (contentHtml && contentHtml !== current) {
      editor.commands.setContent(contentHtml);
    }
  }, [editor, contentHtml]);

  if (!editor) return null;

  const toolbarButton = (isActive: boolean) =>
    `rounded px-2.5 py-1 text-sm transition-colors ${
      isActive
        ? 'bg-blue-600 text-white'
        : 'bg-gray-100 text-gray-900 hover:bg-gray-200 dark:bg-surface-dark-elevated dark:text-gray-100 dark:hover:bg-gray-700'
    }`;

  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
      <div className="flex flex-wrap gap-1 border-b border-gray-200 bg-gray-50 p-2 dark:border-gray-700 dark:bg-surface-dark-recessed">
        <button
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={toolbarButton(editor.isActive('bold'))}
          title={t('artifact.toolbar.bold')}
          aria-label={t('artifact.toolbar.bold')}
          aria-pressed={editor.isActive('bold')}
          disabled={!editable}
        >
          <strong>B</strong>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={toolbarButton(editor.isActive('italic'))}
          title={t('artifact.toolbar.italic')}
          aria-label={t('artifact.toolbar.italic')}
          aria-pressed={editor.isActive('italic')}
          disabled={!editable}
        >
          <em>I</em>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          className={toolbarButton(editor.isActive('underline'))}
          title={t('artifact.toolbar.underline')}
          aria-label={t('artifact.toolbar.underline')}
          aria-pressed={editor.isActive('underline')}
          disabled={!editable}
        >
          <u>U</u>
        </button>

        <div className="mx-1 h-6 w-px bg-gray-300 dark:bg-gray-600" />

        {([1, 2, 3] as const).map((level) => (
          <button
            key={level}
            onClick={() =>
              editor.chain().focus().toggleHeading({ level }).run()
            }
            className={toolbarButton(editor.isActive('heading', { level }))}
            title={t(`artifact.toolbar.heading${level}`)}
            aria-label={t(`artifact.toolbar.heading${level}`)}
            aria-pressed={editor.isActive('heading', { level })}
            disabled={!editable}
          >
            H{level}
          </button>
        ))}

        <div className="mx-1 h-6 w-px bg-gray-300 dark:bg-gray-600" />

        <button
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className={toolbarButton(editor.isActive('bulletList'))}
          title={t('artifact.toolbar.bulletList')}
          aria-label={t('artifact.toolbar.bulletList')}
          aria-pressed={editor.isActive('bulletList')}
          disabled={!editable}
        >
          •
        </button>
        <button
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          className={toolbarButton(editor.isActive('orderedList'))}
          title={t('artifact.toolbar.numberedList')}
          aria-label={t('artifact.toolbar.numberedList')}
          aria-pressed={editor.isActive('orderedList')}
          disabled={!editable}
        >
          1.
        </button>
        <button
          onClick={() =>
            editor
              .chain()
              .focus()
              .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
              .run()
          }
          className={toolbarButton(false)}
          title={t('artifact.toolbar.insertTable')}
          aria-label={t('artifact.toolbar.insertTable')}
          disabled={!editable}
        >
          {t('artifact.toolbar.table')}
        </button>

        <div className="mx-1 h-6 w-px bg-gray-300 dark:bg-gray-600" />

        <button
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editable || !editor.can().undo()}
          className={`${toolbarButton(false)} disabled:cursor-not-allowed disabled:opacity-30`}
          title={t('artifact.toolbar.undo')}
          aria-label={t('artifact.toolbar.undo')}
        >
          ↶
        </button>
        <button
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editable || !editor.can().redo()}
          className={`${toolbarButton(false)} disabled:cursor-not-allowed disabled:opacity-30`}
          title={t('artifact.toolbar.redo')}
          aria-label={t('artifact.toolbar.redo')}
        >
          ↷
        </button>
      </div>

      {/* `relative` so the pinned action bar is positioned against the
          scrolled content and travels with it. */}
      <div
        ref={scrollRef}
        className="relative min-w-0 flex-1 overflow-y-auto overflow-x-hidden bg-white p-4 dark:bg-surface-dark"
      >
        <EditorContent editor={editor} />
        {pinnedEditId && pinPoint && renderQuickActions?.(pinPoint)}
      </div>
    </div>
  );
});

'use client';

import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect } from 'react';

import { useTranslations } from 'next-intl';

import './editor.css';

import { useArtifactStore } from '@/client/stores/artifactStore';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { Table } from '@tiptap/extension-table';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableRow } from '@tiptap/extension-table-row';
import { Underline } from '@tiptap/extension-underline';
import StarterKit from '@tiptap/starter-kit';
import { common, createLowlight } from 'lowlight';

interface DocumentEditorProps {
  theme?: 'light' | 'dark';
}

// Create lowlight instance with common languages
const lowlight = createLowlight(common);

export default function DocumentEditor({
  theme = 'light',
}: DocumentEditorProps) {
  const t = useTranslations();
  const { modifiedCode, setModifiedCode, fileName } = useArtifactStore();

  const editor = useEditor({
    immediatelyRender: false, // Disable SSR to avoid hydration mismatches
    extensions: [
      StarterKit.configure({
        codeBlock: false, // We'll use CodeBlockLowlight instead
      }),
      CodeBlockLowlight.configure({
        lowlight,
      }),
      Table.configure({
        resizable: true,
      }),
      TableRow,
      TableHeader,
      TableCell,
      Underline,
    ],
    content: modifiedCode || `<p>${t('artifact.startWriting')}</p>`,
    editorProps: {
      attributes: {
        class: `prose prose-sm sm:prose lg:prose-lg xl:prose-xl max-w-none focus:outline-none ${
          theme === 'dark' ? 'prose-invert' : ''
        }`,
      },
    },
    onUpdate: ({ editor }) => {
      // Update store with HTML content
      const html = editor.getHTML();
      setModifiedCode(html);
    },
  });

  // Auto-convert non-HTML content on mount (e.g., from localStorage persistence)
  useEffect(() => {
    const convertContent = async () => {
      if (modifiedCode && editor) {
        const trimmed = modifiedCode.trim();
        // Check if content is NOT HTML
        if (!trimmed.startsWith('<')) {
          const { autoConvertToHtml } =
            await import('@/lib/utils/shared/document/formatConverter');
          const converted = await autoConvertToHtml(modifiedCode, fileName);
          setModifiedCode(converted);
        }
      }
    };

    convertContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]); // Only run when editor is ready (once)

  // Update editor content when modifiedCode changes externally
  useEffect(() => {
    if (editor && modifiedCode !== undefined) {
      const currentContent = editor.getHTML();
      if (currentContent !== modifiedCode) {
        editor.commands.setContent(modifiedCode);
      }
    }
  }, [editor, modifiedCode]);

  if (!editor) {
    return null;
  }

  return (
    <div className="h-full w-full flex flex-col overflow-hidden min-w-0">
      {/* Toolbar */}
      <div className="flex flex-wrap gap-1 p-2 border-b border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800">
        {/* Text Formatting */}
        <button
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={`px-3 py-1 text-sm rounded transition-colors ${
            editor.isActive('bold')
              ? 'bg-blue-500 text-white'
              : 'bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600'
          }`}
          title={t('artifact.toolbar.bold')}
        >
          <strong>B</strong>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={`px-3 py-1 text-sm rounded transition-colors ${
            editor.isActive('italic')
              ? 'bg-blue-500 text-white'
              : 'bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600'
          }`}
          title={t('artifact.toolbar.italic')}
        >
          <em>I</em>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          className={`px-3 py-1 text-sm rounded transition-colors ${
            editor.isActive('underline')
              ? 'bg-blue-500 text-white'
              : 'bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600'
          }`}
          title={t('artifact.toolbar.underline')}
        >
          <u>U</u>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleStrike().run()}
          className={`px-3 py-1 text-sm rounded transition-colors ${
            editor.isActive('strike')
              ? 'bg-blue-500 text-white'
              : 'bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600'
          }`}
          title={t('artifact.toolbar.strikethrough')}
        >
          <s>S</s>
        </button>

        <div className="w-px h-6 bg-neutral-300 dark:bg-neutral-600 mx-1" />

        {/* Headings */}
        <button
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 1 }).run()
          }
          className={`px-3 py-1 text-sm rounded transition-colors ${
            editor.isActive('heading', { level: 1 })
              ? 'bg-blue-500 text-white'
              : 'bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600'
          }`}
          title={t('artifact.toolbar.heading1')}
        >
          H1
        </button>
        <button
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 2 }).run()
          }
          className={`px-3 py-1 text-sm rounded transition-colors ${
            editor.isActive('heading', { level: 2 })
              ? 'bg-blue-500 text-white'
              : 'bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600'
          }`}
          title={t('artifact.toolbar.heading2')}
        >
          H2
        </button>
        <button
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 3 }).run()
          }
          className={`px-3 py-1 text-sm rounded transition-colors ${
            editor.isActive('heading', { level: 3 })
              ? 'bg-blue-500 text-white'
              : 'bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600'
          }`}
          title={t('artifact.toolbar.heading3')}
        >
          H3
        </button>

        <div className="w-px h-6 bg-neutral-300 dark:bg-neutral-600 mx-1" />

        {/* Lists */}
        <button
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className={`px-3 py-1 text-sm rounded transition-colors ${
            editor.isActive('bulletList')
              ? 'bg-blue-500 text-white'
              : 'bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600'
          }`}
          title={t('artifact.toolbar.bulletList')}
        >
          •
        </button>
        <button
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          className={`px-3 py-1 text-sm rounded transition-colors ${
            editor.isActive('orderedList')
              ? 'bg-blue-500 text-white'
              : 'bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600'
          }`}
          title={t('artifact.toolbar.numberedList')}
        >
          1.
        </button>

        <div className="w-px h-6 bg-neutral-300 dark:bg-neutral-600 mx-1" />

        {/* Code & Quote */}
        <button
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          className={`px-3 py-1 text-sm rounded transition-colors ${
            editor.isActive('codeBlock')
              ? 'bg-blue-500 text-white'
              : 'bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600'
          }`}
          title={t('artifact.toolbar.codeBlock')}
        >
          {'</>'}
        </button>
        <button
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          className={`px-3 py-1 text-sm rounded transition-colors ${
            editor.isActive('blockquote')
              ? 'bg-blue-500 text-white'
              : 'bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600'
          }`}
          title={t('artifact.toolbar.quote')}
        >
          "
        </button>

        <div className="w-px h-6 bg-neutral-300 dark:bg-neutral-600 mx-1" />

        {/* Table */}
        <button
          onClick={() =>
            editor
              .chain()
              .focus()
              .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
              .run()
          }
          className="px-3 py-1 text-sm rounded transition-colors bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600"
          title={t('artifact.toolbar.insertTable')}
        >
          {t('artifact.toolbar.table')}
        </button>

        <div className="w-px h-6 bg-neutral-300 dark:bg-neutral-600 mx-1" />

        {/* Undo/Redo */}
        <button
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}
          className="px-3 py-1 text-sm rounded transition-colors bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600 disabled:opacity-30 disabled:cursor-not-allowed"
          title={t('artifact.toolbar.undo')}
        >
          ↶
        </button>
        <button
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()}
          className="px-3 py-1 text-sm rounded transition-colors bg-neutral-200 dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 hover:bg-neutral-300 dark:hover:bg-neutral-600 disabled:opacity-30 disabled:cursor-not-allowed"
          title={t('artifact.toolbar.redo')}
        >
          ↷
        </button>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden bg-white dark:bg-neutral-900 min-w-0">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

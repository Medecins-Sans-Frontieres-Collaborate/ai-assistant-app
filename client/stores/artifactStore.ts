'use client';

import {
  htmlToMarkdown,
  htmlToPlainText,
} from '@/lib/utils/document/exportUtils';

import { create } from 'zustand';

type EditorMode = 'code' | 'document';
type SourceFormat = 'md' | 'markdown' | 'txt' | 'html' | 'htm' | 'pdf' | null;

interface ArtifactStore {
  // State
  originalCode: string;
  modifiedCode: string; // Current content (format depends on mode: raw source in code mode, HTML in document mode)
  language: string;
  fileName: string;
  isLoading: boolean;
  error: string | null;
  isEditorOpen: boolean; // Track if editor is visible
  isArtifactOpen: boolean; // Track if artifact overlay is visible
  editorMode: EditorMode; // Track whether we're in code or document mode
  sourceFormat: SourceFormat; // Format of the source content (md, txt, html, etc.) - determines conversion behavior

  // Actions
  setModifiedCode: (code: string) => void;
  setLanguage: (language: string) => void;
  setFileName: (fileName: string) => void;
  setIsLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
  clearError: () => void;
  resetEditor: () => void;
  downloadFile: () => void;
  setIsEditorOpen: (isOpen: boolean) => void;
  setEditorMode: (mode: EditorMode) => void;
  openArtifact: (code: string, language?: string, fileName?: string) => void;
  openDocument: (
    content: string,
    sourceFormat: SourceFormat,
    fileName?: string,
    initialMode?: EditorMode,
  ) => void;
  closeArtifact: () => void;
  getArtifactContext: () => Promise<{
    fileName: string;
    language: string;
    code: string;
  } | null>; // Get artifact metadata for including in messages
  canSwitchToDocumentMode: () => boolean; // Check if current file can switch to document mode
}

export const useArtifactStore = create<ArtifactStore>()((set, get) => ({
  // Initial state
  originalCode: '',
  modifiedCode: '',
  language: 'typescript',
  fileName: 'untitled.ts',
  isLoading: false,
  error: null,
  isEditorOpen: false,
  isArtifactOpen: false,
  editorMode: 'code',
  sourceFormat: null,

  // Actions
  setModifiedCode: (code) => {
    // User edits update immediately
    set({
      modifiedCode: code,
      originalCode: code,
    });
  },

  setLanguage: (language) => {
    const { fileName } = get();

    // Auto-update fileName if it's still using default naming
    // Check if current fileName is "untitled.*"
    const isDefaultName = fileName.startsWith('untitled.');

    if (isDefaultName) {
      // Get appropriate extension for the language
      const extensionMap: Record<string, string> = {
        typescript: 'ts',
        javascript: 'js',
        python: 'py',
        java: 'java',
        csharp: 'cs',
        go: 'go',
        rust: 'rs',
        cpp: 'cpp',
        c: 'c',
        html: 'html',
        css: 'css',
        json: 'json',
        markdown: 'md',
        sql: 'sql',
        shell: 'sh',
        yaml: 'yaml',
        plaintext: 'txt',
      };

      const ext = extensionMap[language] || 'txt';
      set({ language, fileName: `untitled.${ext}` });
    } else {
      set({ language });
    }
  },

  setFileName: (fileName) => {
    // Auto-detect language from file extension
    const ext = fileName.split('.').pop()?.toLowerCase();
    const languageMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      py: 'python',
      java: 'java',
      cs: 'csharp',
      go: 'go',
      rs: 'rust',
      cpp: 'cpp',
      c: 'c',
      html: 'html',
      css: 'css',
      json: 'json',
      md: 'markdown',
      sql: 'sql',
      sh: 'shell',
      yml: 'yaml',
      yaml: 'yaml',
    };

    const detectedLanguage = ext
      ? languageMap[ext] || 'plaintext'
      : 'plaintext';

    set({
      fileName,
      language: detectedLanguage,
    });
  },

  setIsLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set({ error }),

  clearError: () => set({ error: null }),

  resetEditor: () =>
    set({
      originalCode: '',
      modifiedCode: '',
      language: 'typescript',
      fileName: 'untitled.ts',
      isLoading: false,
      error: null,
    }),

  downloadFile: () => {
    const { modifiedCode, fileName } = get();

    // Create a blob from the code content
    const blob = new Blob([modifiedCode], {
      type: 'text/plain;charset=utf-8',
    });

    // Create a download link
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;

    // Trigger download
    document.body.appendChild(link);
    link.click();

    // Cleanup
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  },

  setIsEditorOpen: (isOpen) => set({ isEditorOpen: isOpen }),

  setEditorMode: (mode) => {
    const { sourceFormat, modifiedCode, editorMode: currentMode } = get();

    // If no sourceFormat, can't convert - just switch mode
    if (!sourceFormat) {
      set({ editorMode: mode });
      return;
    }

    // Import conversion utilities
    import('@/lib/utils/document/formatConverter').then(({ convertToHtml }) => {
      import('@/lib/utils/document/exportUtils').then(
        async ({ htmlToMarkdown, htmlToPlainText }) => {
          let convertedContent = modifiedCode;

          // Convert between formats when switching modes
          if (mode === 'document' && currentMode === 'code') {
            // Code → Document: Convert source format to HTML
            convertedContent = await convertToHtml(modifiedCode, sourceFormat);
          } else if (mode === 'code' && currentMode === 'document') {
            // Document → Code: Convert HTML back to source format
            if (sourceFormat === 'md' || sourceFormat === 'markdown') {
              convertedContent = htmlToMarkdown(modifiedCode);
            } else if (sourceFormat === 'txt') {
              convertedContent = await htmlToPlainText(modifiedCode);
            } else if (sourceFormat === 'html' || sourceFormat === 'htm') {
              // HTML stays as-is
              convertedContent = modifiedCode;
            }
          }

          set({
            editorMode: mode,
            modifiedCode: convertedContent,
            originalCode: convertedContent,
          });
        },
      );
    });
  },

  openArtifact: (code, language = 'typescript', fileName?) => {
    // Auto-generate fileName based on language if not provided
    const extensionMap: Record<string, string> = {
      typescript: 'ts',
      javascript: 'js',
      python: 'py',
      java: 'java',
      csharp: 'cs',
      go: 'go',
      rust: 'rs',
      cpp: 'cpp',
      c: 'c',
      html: 'html',
      css: 'css',
      json: 'json',
      markdown: 'md',
      sql: 'sql',
      shell: 'sh',
      bash: 'sh',
      powershell: 'ps1',
      yaml: 'yaml',
      tsx: 'tsx',
      jsx: 'jsx',
      plaintext: 'txt',
    };

    const ext = extensionMap[language] || 'txt';
    const defaultFileName = `untitled.${ext}`;

    // Opening a new artifact replaces the current one
    set({
      originalCode: code,
      modifiedCode: code,
      language,
      fileName: fileName || defaultFileName,
      isArtifactOpen: true,
      isEditorOpen: true,
      editorMode: 'code',
      sourceFormat: null, // Pure code files don't have a document format
    });
  },

  openDocument: (content, sourceFormat, fileName?, initialMode = 'code') => {
    const defaultFileName = fileName || 'untitled.html';

    // Detect language for code mode based on source format
    const languageMap: Record<string, string> = {
      md: 'markdown',
      markdown: 'markdown',
      txt: 'plaintext',
      html: 'html',
      htm: 'html',
    };
    const language = sourceFormat
      ? languageMap[sourceFormat] || 'plaintext'
      : 'html';

    // If starting in document mode, convert to HTML first
    if (initialMode === 'document' && sourceFormat) {
      import('@/lib/utils/document/formatConverter').then(
        async ({ convertToHtml }) => {
          const htmlContent = await convertToHtml(content, sourceFormat);
          set({
            originalCode: htmlContent,
            modifiedCode: htmlContent,
            language,
            fileName: defaultFileName,
            isArtifactOpen: true,
            isEditorOpen: true,
            editorMode: 'document',
            sourceFormat,
          });
        },
      );
    } else {
      // Start in code mode with raw source content
      set({
        originalCode: content,
        modifiedCode: content,
        language,
        fileName: defaultFileName,
        isArtifactOpen: true,
        isEditorOpen: true,
        editorMode: 'code',
        sourceFormat,
      });
    }
  },

  closeArtifact: () => {
    set({
      isArtifactOpen: false,
      isEditorOpen: false,
    });
  },

  getArtifactContext: async () => {
    const state = get();

    // Check if editor is open AND has content (not just isArtifactOpen)
    // This ensures we include context whenever the editor is visible with code
    if (!state.isEditorOpen || !state.modifiedCode) {
      return null;
    }

    let codeToSend = state.modifiedCode;

    // If in document mode, convert HTML back to original format
    // This ensures chat receives content in the format user expects (markdown, text, etc.)
    if (state.editorMode === 'document' && state.sourceFormat) {
      if (state.sourceFormat === 'md' || state.sourceFormat === 'markdown') {
        codeToSend = htmlToMarkdown(state.modifiedCode);
        console.log(
          '[ArtifactStore] Converted HTML to Markdown for chat context',
        );
      } else if (state.sourceFormat === 'txt') {
        codeToSend = await htmlToPlainText(state.modifiedCode);
        console.log(
          '[ArtifactStore] Converted HTML to plain text for chat context',
        );
      } else if (
        state.sourceFormat === 'html' ||
        state.sourceFormat === 'htm'
      ) {
        // HTML stays as-is
        codeToSend = state.modifiedCode;
        console.log('[ArtifactStore] Keeping HTML format for chat context');
      }
    }

    // Return artifact metadata for including in messages
    return {
      fileName: state.fileName,
      language: state.language,
      code: codeToSend,
    };
  },

  canSwitchToDocumentMode: () => {
    const { fileName, sourceFormat } = get();

    // Only document-capable files can switch to document mode
    // These are: markdown, txt, html files
    const ext = fileName.split('.').pop()?.toLowerCase();
    const documentExtensions = ['md', 'markdown', 'txt', 'html', 'htm'];

    return (
      documentExtensions.includes(ext || '') ||
      (sourceFormat !== null &&
        ['md', 'markdown', 'txt', 'html', 'htm'].includes(sourceFormat))
    );
  },
}));

'use client';

import { Editor, loader } from '@monaco-editor/react';
import { IconLoader2 } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useArtifactStore } from '@/client/stores/artifactStore';

// Configure Monaco to load from local node_modules instead of CDN
if (typeof window !== 'undefined') {
  loader.config({
    paths: {
      vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.54.0/min/vs',
    },
  });
}

interface CodeEditorProps {
  theme?: 'light' | 'dark';
}

export default function CodeEditor({ theme = 'light' }: CodeEditorProps) {
  const t = useTranslations();
  const { modifiedCode, language, setModifiedCode } = useArtifactStore();

  const [isLoading, setIsLoading] = useState(true);
  const editorRef = useRef<any>(null);

  const handleEditorDidMount = (editor: any) => {
    editorRef.current = editor;
    setIsLoading(false);
  };

  // Update editor content when modifiedCode or language changes
  useEffect(() => {
    if (editorRef.current && modifiedCode !== undefined) {
      const currentValue = editorRef.current.getValue();
      if (currentValue !== modifiedCode) {
        editorRef.current.setValue(modifiedCode);
      }
    }
  }, [modifiedCode]);

  // Update editor language model when language changes
  useEffect(() => {
    if (editorRef.current && language) {
      const model = editorRef.current.getModel();
      if (model) {
        const currentLanguage = model.getLanguageId();
        if (currentLanguage !== language) {
          window.monaco?.editor.setModelLanguage(model, language);
        }
      }
    }
  }, [language]);

  // Use vs-dark for dark theme, vs for light theme
  const monacoTheme = theme === 'dark' ? 'vs-dark' : 'vs';

  // Show placeholder when editor is empty
  const showPlaceholder = !modifiedCode;

  return (
    <div className="h-full w-full flex flex-col relative overflow-hidden min-w-0">
      {showPlaceholder && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
          <div className="text-center text-neutral-400 dark:text-neutral-500">
            <p className="text-lg mb-2">
              {t('artifact.codeEditor.startTyping')}
            </p>
            <p className="text-sm">{t('artifact.codeEditor.codeWillSync')}</p>
          </div>
        </div>
      )}

      {/* Wrapper to contain Monaco and prevent ResizeObserver loops */}
      <div className="flex-1 relative min-h-0">
        <div className="absolute inset-0">
          <Editor
            height="100%"
            width="100%"
            defaultLanguage={language}
            defaultValue={modifiedCode || t('artifact.codeEditor.startCoding')}
            theme={monacoTheme}
            onMount={handleEditorDidMount}
            onChange={(value) => {
              if (value !== undefined) {
                setModifiedCode(value);
              }
            }}
            loading={
              <div className="flex items-center justify-center h-full w-full bg-white dark:bg-neutral-900">
                <IconLoader2
                  size={24}
                  className="animate-spin text-neutral-900 dark:text-neutral-100"
                />
              </div>
            }
            options={{
              minimap: { enabled: false },
              fontSize: 14,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              automaticLayout: true,
              tabSize: 2,
              insertSpaces: true,
              formatOnPaste: true,
              formatOnType: true,
              suggestOnTriggerCharacters: true,
              quickSuggestions: true,
              folding: true,
              foldingStrategy: 'indentation',
              showFoldingControls: 'always',
            }}
          />
        </div>
      </div>
    </div>
  );
}

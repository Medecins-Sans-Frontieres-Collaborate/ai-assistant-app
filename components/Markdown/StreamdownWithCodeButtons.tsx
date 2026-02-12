'use client';

import React, { useEffect, useRef } from 'react';

import { useTranslations } from 'next-intl';

import { useArtifactStore } from '@/client/stores/artifactStore';

interface CodeBlockWrapperProps {
  children: React.ReactNode;
}

/**
 * Generic wrapper that adds "Open in editor" buttons to code blocks
 * Works with any markdown renderer (Streamdown, etc.)
 */
export const StreamdownWithCodeButtons: React.FC<CodeBlockWrapperProps> = ({
  children,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { openArtifact } = useArtifactStore();
  const t = useTranslations();
  const openInEditorText = t('codeBlock.openInEditor');

  useEffect(() => {
    if (!containerRef.current) return;

    const addButtons = () => {
      if (!containerRef.current) return;

      // Find all Streamdown code block containers
      const codeBlocks = containerRef.current.querySelectorAll(
        '[data-streamdown="code-block"]',
      );

      codeBlocks.forEach((codeBlock) => {
        const header = codeBlock.querySelector(
          '[data-streamdown="code-block-header"]',
        );
        const pre = codeBlock.querySelector('pre');
        const code = pre?.querySelector('code');

        if (!header || !code) return;

        // Check if button already added
        if (header.querySelector('[data-open-editor]')) return;

        // Get language from data attribute
        const language = codeBlock.getAttribute('data-language') || 'plaintext';

        // Extract code text with proper line breaks
        // Streamdown wraps each line in a span, so we need to join them with newlines
        const lineSpans = code.querySelectorAll(':scope > span');
        const codeText =
          lineSpans.length > 0
            ? Array.from(lineSpans)
                .map((span) => span.textContent || '')
                .join('\n')
            : code.textContent || '';

        // Create button
        const button = document.createElement('button');
        button.setAttribute('data-open-editor', 'true');
        button.className =
          'flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/30 rounded transition-colors';
        button.title = openInEditorText;
        button.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="16 18 22 12 16 6"></polyline>
            <polyline points="8 6 2 12 8 18"></polyline>
          </svg>
          <span>${openInEditorText}</span>
        `;
        button.onclick = (e) => {
          e.preventDefault();
          openArtifact(codeText, language);
        };

        // Find the button container (the div with flex items-center gap-2)
        const buttonContainer = header.querySelector(
          'div.flex.items-center.gap-2',
        );
        if (buttonContainer) {
          buttonContainer.appendChild(button);
        } else {
          // Fallback: append directly to header
          header.appendChild(button);
        }
      });
    };

    // Run immediately for any existing code blocks
    addButtons();

    // Fallback: also try after a tiny delay in case Streamdown hasn't rendered yet
    const timeoutId = setTimeout(addButtons, 50);

    // Watch for new code blocks being added (for streaming)
    const observer = new MutationObserver(() => {
      // Just run addButtons on any mutation - it's smart enough to skip duplicates
      addButtons();
    });

    observer.observe(containerRef.current, {
      childList: true,
      subtree: true,
    });

    return () => {
      clearTimeout(timeoutId);
      observer.disconnect();
    };
  }, [children, openArtifact, openInEditorText]);

  return <div ref={containerRef}>{children}</div>;
};

import { RenderOptions, render as rtlRender } from '@testing-library/react';
import React, { ReactElement } from 'react';

import { NextIntlClientProvider } from 'next-intl';

// Mock messages for testing
const mockMessages = {
  chat: {
    imageContent: 'Image Content',
    fullSizePreview: 'Full size preview',
    fileContent: 'File',
    downloadFile: 'Download file',
    unknownFileType: 'Unknown file type',
    sendMessage: 'Send message',
    stopGeneration: 'Stop generation',
    changePlaybackSpeed: 'Change playback speed',
    searchFeatures: 'Search features',
    clearSearch: 'Clear search',
    pdf: {
      info: 'PDF files are automatically processed',
    },
  },
  // fileUpload keys at root level (component calls t('fileUpload.xxx'))
  fileUpload: {
    uploading: 'Uploading',
    failed: 'Failed',
    remove: 'Remove',
    removeFile: 'Remove file',
    attachment: 'attachment',
    attachments: 'attachments',
    extractingAudio: 'Extracting audio...',
    queuedForTranscription: 'Queued for transcription',
    transcribing: 'Transcribing...',
    transcribed: 'Transcribed',
    transcriptionFailed: 'Transcription failed',
    extractedFromSmaller: 'Extracted from {percent}% smaller',
    textExtraction: 'Text extraction',
    opening: 'Opening...',
    openInEditor: 'Open in Editor',
    failedToUpload: 'Failed to upload',
    fileNotAvailable: 'File not available',
    failedToOpenInEditor: 'Failed to open in editor',
  },
  // transcription keys at root level
  transcription: {
    transcribesOnSend: 'Transcribes on send',
    addInstructions: 'Add instructions',
    instructionsPlaceholder: 'Add context or instructions...',
    languages: {
      autoDetect: 'Auto-detect',
    },
  },
  ui: {
    close: 'Close',
    cancel: 'Cancel',
    confirm: 'Confirm',
    save: 'Save',
    delete: 'Delete',
    edit: 'Edit',
    modal: {
      close: 'Close modal',
      closeModal: 'Close modal',
    },
  },
  common: {
    speed: 'Speed',
    normal: 'Normal',
    variable: 'Variable',
    variables: 'Variables',
    insertVariable: 'Insert variable',
    noVariablesFound: 'No variables found',
    search: 'Search',
    searchPlaceholder: 'Search...',
    close: 'Close',
    closeModal: 'Close modal',
    remove: 'Remove',
  },
  submit: {
    send: 'Send',
    sendMessage: 'Send message',
    stop: 'Stop',
    stopGenerating: 'Stop generating',
    stopGeneration: 'Stop generation',
  },
  audio: {
    speed: 'Speed',
    playbackSpeed: 'Playback speed',
    changePlaybackSpeed: 'Change playback speed',
  },
  search: {
    placeholder: 'Search...',
    searchPlaceholder: 'Search features',
    searchFeatures: 'Search features',
    clear: 'Clear search',
    clearSearch: 'Clear search',
  },
  remove: 'Remove',
  imageContent: 'Image Content',
  variableModal: {
    fillInstructions: 'Fill in the variables below to customize your prompt',
    optional: 'Optional',
    required: 'Required',
    default: 'Default:',
    defaultPlaceholder: '{defaultValue} (default)',
    enterValue: 'Enter value for {key}...',
    cancel: 'Cancel',
    apply: 'Apply',
  },
};

interface CustomRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  locale?: string;
  messages?: typeof mockMessages;
}

/**
 * Custom render function that wraps components with NextIntlClientProvider
 */
function customRender(
  ui: ReactElement,
  {
    locale = 'en',
    messages = mockMessages,
    ...renderOptions
  }: CustomRenderOptions = {},
) {
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <NextIntlClientProvider locale={locale} messages={messages}>
        {children}
      </NextIntlClientProvider>
    );
  }

  return rtlRender(ui, { wrapper: Wrapper, ...renderOptions });
}

// Re-export everything from testing library
export * from '@testing-library/react';

// Override render method
export { customRender as render };

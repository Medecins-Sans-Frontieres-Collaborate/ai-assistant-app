import React from 'react';

import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';

// Mock next-auth to prevent module resolution errors in test environment
vi.mock('next-auth', () => ({
  default: () => ({
    handlers: { GET: vi.fn(), POST: vi.fn() },
    signIn: vi.fn(),
    signOut: vi.fn(),
    auth: vi.fn(),
  }),
  getServerSession: vi.fn(),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: null,
    status: 'unauthenticated',
  }),
  signIn: vi.fn(),
  signOut: vi.fn(),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock CSS imports
vi.mock('katex/dist/katex.min.css', () => ({}));

// Mock next-intl for component tests with common translations.
// This provides a global mock that looks up translations from a messages object.
const mockMessages: Record<string, unknown> = {
  common: {
    close: 'Close',
    closeModal: 'Close modal',
    remove: 'Remove',
    speed: 'Speed',
    normal: 'Normal',
    variable: 'Variable',
    variables: 'Variables',
    search: 'Search',
    beta: 'Beta',
  },
  chat: {
    fullSizePreview: 'Full size preview',
    imageContent: 'Image Content',
    thinking: 'Thinking...',
    viewReasoningProcess: 'View reasoning process',
    expandThinking: 'Expand thinking',
    collapseThinking: 'Collapse thinking',
    sendMessage: 'Send message',
    stopGeneration: 'Stop generation',
    clearSearch: 'Clear search',
    searchFeatures: 'Search features',
    changePlaybackSpeed: 'Change playback speed',
    failedToLoadImage: 'Failed to load image',
    loadingImage: 'Loading image...',
    download: 'Download',
    openAsDocument: 'Open as Document',
    openInCodeEditor: 'Open in Code Editor',
    failedToOpenCodeEditor:
      'Failed to open file in code editor. Please try again.',
    failedToOpenDocEditor:
      'Failed to open file in document editor. Please try again.',
    imageAlt: 'Image {number}',
  },
  fileUpload: {
    attachment: 'attachment',
    attachments: 'attachments',
    uploading: 'Uploading',
    failed: 'Failed',
    remove: 'Remove',
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
  transcription: {
    transcribesOnSend: 'Transcribes on send',
    addInstructions: 'Add instructions',
    instructionsPlaceholder: 'Add context or instructions...',
    languages: {
      autoDetect: 'Auto-detect',
    },
  },
  artifact: {
    startWriting: 'Start writing...',
    document: 'Document',
    switchToCodeEditor: 'Switch to Code Editor',
    switchToDocumentEditor: 'Switch to Document Editor',
    exportDocument: 'Export Document',
    close: 'Close',
    closeEditor: 'Close editor',
    closeCodeEditor: 'Close code editor',
    download: 'Download',
    fileDownloaded: 'File downloaded',
    failedToDownload: 'Failed to download',
    fileIncludedWithMessage: 'File and edits included with message',
    editsNotSaved:
      'Edits are not saved. Send via message or download to save any edits.',
    noContentToExport: 'No content to export',
    exportedAsHtml: 'Exported as HTML',
    exportedAsMarkdown: 'Exported as Markdown',
    exportedAsText: 'Exported as Text',
    exportedAsPdf: 'Exported as PDF',
    exportedAsDocx: 'Exported as DOCX',
    generatingPdf: 'Generating PDF...',
    generatingDocx: 'Generating DOCX...',
    failedToExportAs: 'Failed to export as {format}',
    formatMarkdown: 'Markdown (.md)',
    formatHtml: 'HTML (.html)',
    formatDocx: 'Word (.docx)',
    formatText: 'Plain Text (.txt)',
    formatPdf: 'PDF (.pdf)',
    toolbar: {
      bold: 'Bold',
      italic: 'Italic',
      underline: 'Underline',
      strikethrough: 'Strikethrough',
      heading1: 'Heading 1',
      heading2: 'Heading 2',
      heading3: 'Heading 3',
      bulletList: 'Bullet List',
      numberedList: 'Numbered List',
      codeBlock: 'Code Block',
      quote: 'Quote',
      insertTable: 'Insert Table',
      table: 'Table',
      undo: 'Undo',
      redo: 'Redo',
    },
    codeEditor: {
      startTyping: 'Start typing or ask AI to generate code',
      codeWillSync: 'Code will automatically sync from chat messages',
      startCoding: '// Start coding...',
    },
  },
  ui: {
    close: 'Close',
    cancel: 'Cancel',
    confirm: 'Confirm',
    modal: {
      close: 'Close modal',
      closeModal: 'Close modal',
    },
  },
  modelSelect: {
    tabs: {
      models: 'Models',
      agents: 'Agents',
    },
    sections: {
      baseModels: 'Base Models',
    },
    agents: {
      advancedFeatureBadge: 'Advanced Feature',
      description:
        'Create and manage custom AI agents with specialized capabilities.',
      createNewAgent: 'Create New Custom Agent',
      noAgentsTitle: 'No Custom Agents Yet',
      noAgentsDescription: 'Create your first custom agent.',
    },
    searchMode: {
      title: 'Search Mode',
      subtitle: 'Will use web search when needed',
      routingLabel: 'Search Routing',
      whatsDifference: "What's the difference?",
      privacyFocused: 'Privacy-Focused',
      privacyFocusedDescription: 'Search without external data access',
      azureAgentMode: 'Azure AI Agent Mode',
      azureAgentModeDescription: 'Use AI Foundry for enhanced search',
      privacyInfoTitle: 'Important Privacy Information',
      privacyInfoDescription:
        'Your full conversation will be sent to Azure AI Foundry agent',
      learnMoreDataStorage: 'Learn more about data storage',
      privacyEnabled: 'Privacy-focused search enabled',
      learnPrivacy: 'Learn about privacy',
      label: 'Search Mode',
      description: 'Enable web search capabilities',
      privacy: 'Privacy Mode',
      aiFoundry: 'AI Foundry Mode',
      privacyDescription: 'Search without external access',
      aiFoundryDescription: 'Use AI Foundry for enhanced search',
    },
    advancedOptions: {
      title: 'Advanced Options',
      temperature: 'Temperature',
      fixedTemperatureNote:
        'This model uses fixed temperature values for consistent performance',
      reasoningEffort: 'Reasoning Effort',
      minimal: 'Minimal',
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      verbosity: 'Verbosity',
    },
    temperature: {
      label: 'Temperature',
      notSupported: 'Temperature control not supported for this model',
    },
    details: {
      knowledgeCutoff: 'Knowledge Cutoff',
    },
    header: {
      backToModels: 'Back to Models',
      knowledgeCutoffLabel: 'Knowledge cutoff:',
    },
    knowledgeCutoff: {
      realtime: 'Real-time (web search)',
    },
    modelTypes: {
      reasoning: 'reasoning',
      omni: 'omni',
      agent: 'agent',
      foundational: 'foundational',
    },
    close: 'Close',
  },
  emptyState: {
    suggestedPrompts: {
      createDiagrams: {
        title: 'Create Diagrams',
        prompt: 'Show me how you can create diagrams and flowcharts.',
      },
      draftContent: {
        title: 'Draft Professional Content',
        prompt: 'I need help writing professional documents.',
      },
      analyzeInformation: {
        title: 'Analyze Information',
        prompt: 'How can you help me analyze data or information?',
      },
      planOrganize: {
        title: 'Plan & Organize',
        prompt: 'Can you help me plan projects or organize work?',
      },
      brainstormIdeas: {
        title: 'Brainstorm Ideas',
        prompt: 'I want to brainstorm solutions to a problem.',
      },
      buildPresentations: {
        title: 'Build Presentations',
        prompt: 'How can you help me create presentations?',
      },
      workWithCode: {
        title: 'Work with Code',
        prompt: 'Can you help with coding or scripts?',
      },
      decisionSupport: {
        title: 'Decision Support',
        prompt: 'I need to make a decision.',
      },
      summarizeSynthesize: {
        title: 'Summarize & Synthesize',
        prompt: 'How do you help with summarizing?',
      },
    },
  },
  audio: {
    speed: 'Speed',
    playbackSpeed: 'Playback speed',
    changePlaybackSpeed: 'Change playback speed',
  },
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

/**
 * Resolves a dot-notation key from a nested object.
 * Example: 'artifact.toolbar.bold' => 'Bold'
 */
function getNestedValue(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const parts = key.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (
      current &&
      typeof current === 'object' &&
      part in (current as Record<string, unknown>)
    ) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof current === 'string' ? current : undefined;
}

vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    const translate = (
      key: string,
      params?: Record<string, string | number>,
    ) => {
      // Prepend namespace if provided
      const fullKey = namespace ? `${namespace}.${key}` : key;
      let value = getNestedValue(mockMessages, fullKey) ?? key;
      if (params) {
        // Handle interpolation: "Hello {name}" with {name: "World"} => "Hello World"
        value = Object.entries(params).reduce(
          (str, [k, v]) => str.replace(`{${k}}`, String(v)),
          value,
        );
      }
      return value;
    };
    // Add has method to check if translation key exists
    translate.has = (key: string) => {
      const fullKey = namespace ? `${namespace}.${key}` : key;
      return getNestedValue(mockMessages, fullKey) !== undefined;
    };
    // Add rich method for rich text translations
    translate.rich = (key: string) => {
      const fullKey = namespace ? `${namespace}.${key}` : key;
      return getNestedValue(mockMessages, fullKey) ?? key;
    };
    return translate;
  },
  useLocale: () => 'en',
  useMessages: () => mockMessages,
  useNow: () => new Date(),
  useTimeZone: () => 'UTC',
  useFormatter: () => ({
    dateTime: () => '',
    number: () => '',
    relativeTime: () => '',
  }),
  NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}));

// Mock localStorage for Zustand persist middleware in jsdom environment
// jsdom has localStorage but it may not be fully compatible with Zustand's persist middleware
const localStorageMock = {
  store: {} as Record<string, string>,
  getItem(key: string) {
    return this.store[key] ?? null;
  },
  setItem(key: string, value: string) {
    this.store[key] = value;
  },
  removeItem(key: string) {
    delete this.store[key];
  },
  clear() {
    this.store = {};
  },
  get length() {
    return Object.keys(this.store).length;
  },
  key(index: number) {
    return Object.keys(this.store)[index] ?? null;
  },
};

Object.defineProperty(global, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

// Example setup code
beforeAll(() => {
  console.log('Setting up before JSDom env tests');
});

afterAll(() => {
  console.log('Cleaning up after tests');
});

beforeEach(() => {
  // Clear localStorage before each test
  localStorageMock.clear();
});

afterEach(() => {});

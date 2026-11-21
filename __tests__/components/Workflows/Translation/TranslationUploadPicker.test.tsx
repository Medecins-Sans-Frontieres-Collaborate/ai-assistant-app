// "Upload document" in the translation workspace: straight to the system
// file dialog without OneDrive / SharePoint, the chat's picker with it.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { M365ClientError } from '@/client/services/m365/m365Client';

import { Conversation } from '@/types/chat';
import type { M365DriveEntry } from '@/types/m365';
import { TranslationWorkflowState } from '@/types/workflow';

import { TranslationWorkspace } from '@/components/Workflows/Translation/TranslationWorkspace';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/hooks/workflows/useWorkflowStream', () => ({
  useWorkflowStream: () => ({ runWorkflowStream: vi.fn() }),
}));
vi.mock('@/client/services/workflows/workflowTitle', () => ({
  nameWorkflowConversation: vi.fn(),
}));
vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
}));

const downloadDriveItem = vi.hoisted(() => vi.fn());
vi.mock('@/client/services/m365/m365Client', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/client/services/m365/m365Client')
  >()),
  downloadDriveItem,
}));

const NOTES: M365DriveEntry = {
  driveId: 'drive',
  itemId: 'item',
  name: 'notes.txt',
  isFolder: false,
};

// Stand-in for the OneDrive browser: one button that opens a file.
vi.mock('@/components/Chat/ChatInput/M365FilePickerModal', () => ({
  M365FilePickerBody: ({
    acceptExtensions,
    hosted,
  }: {
    acceptExtensions?: readonly string[];
    hosted: { onActivate: (entry: M365DriveEntry) => void };
  }) => (
    <div data-testid="onedrive-pane" data-accept={acceptExtensions?.join(',')}>
      <button type="button" onClick={() => hosted.onActivate(NOTES)}>
        open notes.txt
      </button>
    </div>
  ),
}));

function workflowState(): TranslationWorkflowState {
  return useConversationStore.getState().conversations[0]
    .workflowState as TranslationWorkflowState;
}

function mountWorkspace() {
  const state: TranslationWorkflowState = {
    kind: 'translation',
    sourceText: '',
    targetLanguage: { id: 'es', label: 'Spanish' },
    mode: 'agentic',
    rounds: [],
    updatedAt: new Date().toISOString(),
  };
  useConversationStore.setState({
    conversations: [
      {
        id: 'upload',
        name: 'Upload',
        messages: [],
        model: {
          id: 'gpt-4',
          name: 'GPT-4',
          maxLength: 4000,
          tokenLimit: 4000,
        },
        prompt: '',
        temperature: 0.5,
        folderId: null,
        conversationType: 'translation',
        workflowState: state,
      } as unknown as Conversation,
    ],
    selectedConversationId: 'upload',
    folders: [],
    searchTerm: '',
    isLoaded: true,
  });
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TranslationWorkspace conversationId="upload" />
    </QueryClientProvider>,
  );
}

// jsdom's Blob has no `text()`, which the workspace uses to read a plain
// text file in the browser; FileReader is what jsdom does have.
function readBlobText(this: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(this);
  });
}

const uploadButton = () =>
  screen.getByRole('button', { name: 'translation.uploadDocument' });

describe('translation workspace: where a document is uploaded from', () => {
  let inputClick: ReturnType<typeof vi.spyOn>;
  const hadBlobText = typeof Blob.prototype.text === 'function';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ data: { guides: [] } }))),
    );
    inputClick = vi
      .spyOn(HTMLInputElement.prototype, 'click')
      .mockImplementation(() => undefined);
    useSettingsStore.setState({ addToChatLastSource: null });
    if (!hadBlobText) Blob.prototype.text = readBlobText;
  });

  afterEach(() => {
    if (!hadBlobText) {
      delete (Blob.prototype as Partial<Blob>).text;
    }
    inputClick.mockRestore();
    vi.unstubAllGlobals();
  });

  it('goes straight to the system dialog when Microsoft 365 is not connected', () => {
    useSettingsStore.setState({ m365Connected: false });
    mountWorkspace();
    fireEvent.click(uploadButton());
    expect(inputClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('add-to-chat')).not.toBeInTheDocument();
  });

  it('opens the picker with this device and OneDrive when it is connected', () => {
    useSettingsStore.setState({ m365Connected: true });
    mountWorkspace();
    fireEvent.click(uploadButton());
    expect(inputClick).not.toHaveBeenCalled();
    expect(screen.getByTestId('add-to-chat')).toBeInTheDocument();
    expect(
      Array.from(document.querySelectorAll('[data-source-id]')).map((node) =>
        node.getAttribute('data-source-id'),
      ),
    ).toEqual(['device', 'onedrive']);
    // The device pane still reaches the system dialog.
    fireEvent.click(screen.getByRole('button', { name: 'device.browse' }));
    expect(inputClick).toHaveBeenCalledTimes(1);
  });

  it('loads a OneDrive file as the source and closes the picker', async () => {
    useSettingsStore.setState({ m365Connected: true });
    downloadDriveItem.mockResolvedValue({
      blob: new Blob(['Bonjour tout le monde'], { type: 'text/plain' }),
      name: 'notes.txt',
    });
    mountWorkspace();
    fireEvent.click(uploadButton());
    fireEvent.click(document.querySelector('[data-source-id="onedrive"]')!);
    // The file browser is limited to what the workspace can read.
    expect(screen.getByTestId('onedrive-pane')).toHaveAttribute(
      'data-accept',
      'pdf,doc,docx,txt,md,xml,ppt,pptx',
    );
    fireEvent.click(screen.getByRole('button', { name: 'open notes.txt' }));
    expect(downloadDriveItem).toHaveBeenCalledWith('drive', 'item');
    await waitFor(() =>
      expect(workflowState().sourceText).toBe('Bonjour tout le monde'),
    );
    expect(screen.queryByTestId('add-to-chat')).not.toBeInTheDocument();
  });

  it('says why a OneDrive file could not be fetched and loads nothing', async () => {
    useSettingsStore.setState({ m365Connected: true });
    downloadDriveItem.mockRejectedValue(
      new M365ClientError('too big', 'FILE_TOO_LARGE'),
    );
    mountWorkspace();
    fireEvent.click(uploadButton());
    fireEvent.click(document.querySelector('[data-source-id="onedrive"]')!);
    fireEvent.click(screen.getByRole('button', { name: 'open notes.txt' }));
    expect(await screen.findByText(/notes\.txt: errors\./)).toBeInTheDocument();
    expect(workflowState().sourceText).toBe('');
  });
});

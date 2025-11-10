import { useCallback, useState } from 'react';

import { OpenAIModel, OpenAIModelID } from '@/types/openai';
import { Prompt } from '@/types/prompt';

interface UsePromptSavingProps {
  models: OpenAIModel[];
  defaultModelId?: OpenAIModelID | string;
  addPrompt: (prompt: Prompt) => void;
}

// Counter to ensure unique IDs even when Date.now() returns the same value
let idCounter = 0;

/**
 * Custom hook to manage prompt saving modal state and logic
 * Handles opening modal, saving prompts, and resetting state
 */
export function usePromptSaving({
  models,
  defaultModelId,
  addPrompt,
}: UsePromptSavingProps) {
  const [isSavePromptModalOpen, setIsSavePromptModalOpen] = useState(false);
  const [savePromptContent, setSavePromptContent] = useState('');
  const [savePromptName, setSavePromptName] = useState('');
  const [savePromptDescription, setSavePromptDescription] = useState('');

  const handleOpenSavePromptModal = useCallback((content: string) => {
    setSavePromptContent(content);
    const timestamp = new Date().toLocaleString();
    setSavePromptName(`Saved prompt - ${timestamp}`);
    setSavePromptDescription('Saved from message');
    setIsSavePromptModalOpen(true);
  }, []);

  const handleSavePrompt = useCallback(
    (name: string, description: string, content: string) => {
      const defaultModel =
        models.find((m) => m.id === defaultModelId) || models[0];

      // Generate unique ID using timestamp and counter
      idCounter += 1;
      const newPrompt = {
        id: `prompt-${Date.now()}-${idCounter}`,
        name: name || 'Untitled prompt',
        description: description,
        content: content,
        model: defaultModel,
        folderId: null,
      };

      addPrompt(newPrompt);
      setIsSavePromptModalOpen(false);

      // Reset fields
      setSavePromptName('');
      setSavePromptDescription('');
      setSavePromptContent('');
    },
    [models, defaultModelId, addPrompt],
  );

  const handleCloseSavePromptModal = useCallback(() => {
    setIsSavePromptModalOpen(false);
  }, []);

  return {
    isSavePromptModalOpen,
    savePromptContent,
    savePromptName,
    savePromptDescription,
    handleOpenSavePromptModal,
    handleSavePrompt,
    handleCloseSavePromptModal,
  };
}

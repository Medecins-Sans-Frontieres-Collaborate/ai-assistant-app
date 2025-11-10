import { useState } from 'react';

import { CustomAgent } from '@/client/stores/settingsStore';

/**
 * Custom hook to manage UI state for ModelSelect component
 * Centralizes state management for cleaner component code
 */
export function useModelSelectState(isSelectedModelAgent: boolean) {
  const [activeTab, setActiveTab] = useState<'models' | 'agents'>(
    isSelectedModelAgent ? 'agents' : 'models',
  );
  const [showAgentForm, setShowAgentForm] = useState(false);
  const [editingAgent, setEditingAgent] = useState<CustomAgent | undefined>();
  const [showModelAdvanced, setShowModelAdvanced] = useState(false);
  const [mobileView, setMobileView] = useState<'list' | 'details'>('list');
  const [showAgentWarning, setShowAgentWarning] = useState(false);

  const openAgentForm = (agent?: CustomAgent) => {
    setEditingAgent(agent);
    setShowAgentForm(true);
  };

  const closeAgentForm = () => {
    setShowAgentForm(false);
    setEditingAgent(undefined);
  };

  return {
    // Tab state
    activeTab,
    setActiveTab,

    // Agent form state
    showAgentForm,
    setShowAgentForm,
    editingAgent,
    setEditingAgent,
    openAgentForm,
    closeAgentForm,

    // Advanced settings state
    showModelAdvanced,
    setShowModelAdvanced,

    // Mobile view state
    mobileView,
    setMobileView,

    // Warning state
    showAgentWarning,
    setShowAgentWarning,
  };
}

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
  // Root-namespace key (messages/en.json has a top-level "close").
  close: 'Close',
  peopleSuggest: {
    listLabel: 'Suggestions from your organization',
    searching: 'Searching your organization…',
    noMatches: 'No directory matches — you can enter the address manually',
  },
  common: {
    cancel: 'Cancel',
    undo: 'Undo',
    close: 'Close',
    closeModal: 'Close modal',
    remove: 'Remove',
    speed: 'Speed',
    normal: 'Normal',
    variable: 'Variable',
    variables: 'Variables',
    search: 'Search',
    beta: 'Beta',
    tryAgain: 'Try again',
  },
  admin: {
    title: 'Admin',
    openSettings: 'Open settings',
    areaNavLabel: 'Admin areas',
  },
  chat: {
    attachedFileExpired:
      'An attached file is no longer available — uploaded files are stored for a limited time. It has been removed from this conversation. Try again without it, or upload the file again.',
    repeatedFailureNotice:
      'This keeps failing — the conversation may have become corrupted. Starting a fresh conversation usually fixes this.',
    startNewConversation: 'Start a new conversation',
    downloadDebugInfo: 'Download debug info',
    includeMessageText: 'Include message text',
    toolSummary: {
      usedTools: 'Used {count} tools',
      failedCount: '{count} failed',
      statusApproved: 'Approved',
      statusAutoApproved: 'Auto-approved',
      statusAutoDenied: 'Auto-denied',
      statusFailed: 'Failed',
      statusIncomplete: 'Incomplete',
      viaService: 'via {service}',
      downloadFile: 'Download',
      executedCode: 'Executed code',
      codeOutput: 'Output',
    },
    interimSearch: {
      title: 'Headlines found — deep search still running',
      hint: 'The deep Bing search can take up to 90 seconds. Answer now from the {count} headlines already found, or wait for the merged result.',
      summarizeNow: 'Summarize from headlines now',
      sourcesCount: '{count} sources',
      showAll: 'Show all {count} sources',
      showFewer: 'Show fewer',
    },
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
    downloadResponse: 'Download response',
    sources: 'Sources',
    openAsDocument: 'Open as Document',
    openInCodeEditor: 'Open in Code Editor',
    failedToOpenCodeEditor:
      'Failed to open file in code editor. Please try again.',
    failedToOpenDocEditor:
      'Failed to open file in document editor. Please try again.',
    imageAlt: 'Image {number}',
    consent: {
      batchPendingHint: '{count} tool requests pending',
      approveAllButton: 'Approve all',
      denyAllButton: 'Deny all',
      runToolTitle: 'Run <code>{tool}</code>?',
      runToolGeneric: 'Run this tool?',
      viaService: 'via {service}',
      approveButton: 'Approve',
      approveOptionsLabel: 'Approve options',
      approveOnce: 'Approve once',
      alwaysApproveThisTool: 'Always approve this tool',
      alwaysApproveAllTools: 'Always approve all tools',
      alwaysApproveEverywhere: 'Always approve this tool — in every chat',
      denyButton: 'Deny',
      denyOptionsLabel: 'Deny options',
      denyOnce: 'Deny once',
      neverAllowEverywhere: 'Never allow this tool — in every chat',
      deniedByRuleHint:
        'Blocked by your rule — manage in Settings → Connectors.',
      keyboardHint: '{modifier}+⏎ approve · esc deny',
      submittingState: 'Submitting your decision',
      approvedState: 'Approved — agent resumed',
      deniedState: 'Denied',
    },
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
  table: {
    copyTable: 'Copy table',
    downloadTable: 'Download table',
    copyMarkdown: 'Markdown',
    copyCsv: 'CSV',
    copyTsv: 'TSV',
    formatCsv: 'CSV (.csv)',
    exportedAsCsv: 'Exported as CSV',
    copyFailed: 'Failed to copy table',
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
  agentsTab: {
    emptyState: {
      title: 'No regional / organization agents available',
      description: 'Connect a Foundry project below to discover its agents.',
    },
  },
  connectorPin: {
    toggleLabel: 'Manage connector tools',
    menuLabel: 'Connectors',
    menuLabelCount: 'Connectors ({count} active)',
    tooltip:
      'See which connector tools are active, switch them off for this chat or everywhere, or focus on one.',
    toggleServerInChat: 'Use {name} in this chat',
    globalToggleTitle:
      'Turn {name} on or off everywhere (same as Settings → Connectors)',
    globalOn: 'Global on',
    globalOff: 'Global off',
    chatToggleHint:
      'Checkboxes control this chat only; the global button matches Settings → Connectors. Every active connector adds its tools to each message — more tokens and slower responses.',
    trayLabel: 'Connector tools',
    trayTitle: 'Connector tools for this chat',
    toggleServer: 'Enable {name}',
    needsReconnect: 'Reconnect in Settings',
    focusAction: 'Focus',
    focusedChip: 'Focused',
    pinnedHint: 'Only tools from {name} will be used in this conversation.',
    staleHint:
      'The focused connector is disconnected or disabled — reconnect it in Settings → Connectors, or remove the focus. Until then all active tools are used.',
    costHint:
      "Every active connector adds its tools to each message you send — more tokens and slower responses. Switch off what you're not using.",
    noEligibleConnectors:
      'No connectors configured. Connect one in Settings → Connectors first.',
    unknownConnector: 'Removed connector',
    unpin: 'Remove focus',
    dismiss: 'Close',
    badgeCount: '{count} tools',
    badgeTooltip:
      'Connector tools are active on every message — they add tokens and response time. Click to manage.',
  },
  toolModes: {
    webSearch: 'Web search',
    codeInterpreter: 'Code interpreter',
    off: 'Off',
    auto: 'Auto',
    always: 'Always',
    routingPrivacy: 'Privacy',
    routingAgent: 'Azure AI',
    agentRoutingNote:
      'Azure AI search sends queries through Azure AI Foundry, which may retain them.',
    learnMore: 'Learn more',
  },
  agentAttach: {
    browserTitle: 'Agents',
    browserSubtitle:
      "Add agents and connectors to this chat, or start a new chat with an agent. Most work with whatever model you've chosen.",
    searchPlaceholder: 'Search agents and connectors…',
    loading: 'Loading agents…',
    loadError:
      "Your agents couldn't be loaded just now. This is usually temporary.",
    retry: 'Try again',
    noMatches: 'Nothing matches your search.',
    noAgents: 'No agents available.',
    addToChat: 'Add to this chat',
    removeFromChat: 'Remove from this chat',
    newChat: 'New chat',
    attached: 'Attached',
    detach: 'Detach',
    change: 'Change',
    browse: 'Browse agents…',
    noAgent: 'No agent attached',
    close: 'Close',
    kind: {
      rag: 'Knowledge',
      prompt: 'Persona',
      m365: 'Knowledge (Microsoft 365)',
      org: 'Knowledge',
      foundry: 'Foundry agent',
      connector: 'Connector',
    },
    semantics: {
      'your-model': 'uses your model',
      'pinned-model': 'model set by admin',
      'own-model': 'runs on its own model',
    },
  },
  m365: {
    tools: {
      alwaysConfirmNote:
        'This action always asks for confirmation — it can’t be auto-approved.',
      batchToggleHint:
        'Uncheck items you don’t want — only checked items are created.',
      batchAllUnchecked:
        'Nothing selected — approving would create nothing. Deny instead if you want none.',
      consentCard: {
        listLine: 'List: {name}',
        to: 'To',
        cc: 'Cc',
        bcc: 'Bcc',
        external: 'External',
        replyAllCallout:
          'Reply-all — this reply goes to everyone on the original message.',
        subject: 'Subject',
        fileLine: 'Attach file: {name}',
        draftLine: 'Draft: {id}',
      },
    },
    playbooks: {
      dismissChip: 'Dismiss {title}',
      chipLabel: 'Playbook: {title}',
      menuLabel: 'Microsoft 365 playbooks',
      menuTooltip:
        'Curated multi-step chains over your calendar, mail and tasks — they gather first, propose, and only write after you agree',
      meetingFollowThrough: {
        title: 'Meeting follow-through',
        description:
          'Summary, action items, follow-up draft and (if needed) the next meeting — from this transcript',
      },
      morningTriage: {
        title: 'Morning triage',
        description:
          'What came in, what’s waiting on you, and today’s calendar — one briefing',
      },
      chipsSettingLabel: 'Suggest Microsoft 365 playbooks',
      chipsSettingHint:
        'Show playbook suggestions above the message box when they apply (e.g. after importing a meeting transcript).',
    },
  },
  toolApprovals: {
    title: 'Tool approvals',
    description:
      "Rules that apply in every conversation: automatically allow or block specific connector tools. You can add tools you haven't been prompted for yet.",
    actionApprove: 'Always allow',
    actionReject: 'Always block',
    scopeServer: 'on {name}',
    scopeAny: 'Any connector',
    removeRule: 'Remove rule for {tool}',
    toolNameLabel: 'Tool name',
    toolNamePlaceholder: 'Tool name, e.g. create_issue',
    scopeLabel: 'Connector scope',
    actionLabel: 'Action',
    addRule: 'Add rule',
    rejectPrecedenceNote:
      'Block rules always win — over allow rules and over any per-conversation auto-approval.',
    policyAsk: 'Ask',
    policyAllow: 'Allow',
    policyBlock: 'Block',
    policyGroupLabel: 'Approval policy for {tool}',
    listHint:
      'Set what happens when the assistant wants to run each tool — in every conversation. Ask is the default; Block always wins.',
  },
  agentAccess: {
    title: 'Access & Connectors',
    description:
      "Control which users can use shared agents and organization connectors. Rules only further restrict what a user's own Azure access already allows — they can never grant access Azure denies.",
    backToChat: 'Back to chat',
    loading: 'Loading…',
    loadError: "Couldn't load access data.",
    agentsTab: 'Agents',
    connectorsTab: 'Connectors',
    addConnector: 'Add connector',
    noConnectors: 'No connectors yet.',
    connectorsUnavailableWarning:
      "Couldn't reach the connector store, so this list may be incomplete. Don't create a replacement until it loads.",
    editAccess: 'Edit access',
    deleteConnector: 'Delete',
    deleteConnectorConfirm:
      'Delete this connector? Anyone using it will lose access immediately.',
    confirmDeleteConnector: 'Delete connector',
    connectorSaveSuccess: 'Connector saved.',
    connectorCreateSuccess: 'Connector created.',
    connectorDeleteSuccess: 'Connector deleted.',
    editConnectorTitle: 'Edit connector',
    newConnectorTitle: 'New connector',
    connectorPresetLabel: 'Start from a template',
    connectorPresetNone: 'Start from scratch',
    connectorNameLabel: 'Name',
    connectorDescriptionLabel: 'Description',
    connectorUrlLabel: 'Server URL',
    connectorUrlPlaceholderWarning:
      'Replace the {placeholder} in the URL with your own value before saving.',
    connectorTransportLabel: 'Transport',
    connectorAuthLabel: 'Authentication',
    connectorAuthNone: 'None',
    connectorAuthBearer: 'Token (each user provides their own)',
    connectorAuthOauth: 'OAuth sign-in',
    connectorSealingUnavailable:
      'OAuth is unavailable: this deployment has no AUTH_SECRET configured to encrypt client secrets with.',
    connectorTokenHelpLabel: 'Link to token instructions (optional)',
    connectorClientIdLabel: 'OAuth client ID',
    connectorClientSecretLabel: 'OAuth client secret',
    connectorClientSecretStored:
      'A secret is stored. Leave blank to keep it, or enter a new one to replace it.',
    connectorClientSecretHint:
      'Encrypted before it is stored, and never shown again.',
    connectorScopesLabel: 'Scopes (space-separated, optional)',
    connectorOauthAuthUrlLabel: 'Authorization URL (optional)',
    connectorOauthTokenUrlLabel: 'Token URL (optional)',
    connectorOauthRefreshUrlLabel: 'Refresh URL (optional)',
    connectorOauthEndpointsHint:
      "Leave the endpoint URLs blank to discover them automatically. Set them for providers that don't support discovery, like NetSuite.",
    connectorOauthRefreshUrlHint:
      'Leave blank to refresh against the token URL.',
    connectorOauthEndpointsPairWarning:
      'Authorization URL and token URL must be set together (the refresh URL needs both).',
    rulesUnavailableWarning:
      'Access rules could not be loaded from storage. Agent invocation is currently blocked and rules cannot be edited.',
    retry: 'Retry',
    rulesTab: 'Agent rules',
    localAdminsTab: 'Local admins',
    delegatedAgentsLabel: 'Delegated agents',
    noDelegatedAgents: 'No agents available to delegate.',
    unknownAgentKey: 'Unknown agent key',
    canonicalKeyLabel: 'Key',
    copyKey: 'Copy key',
    agentKeySearchPlaceholder:
      'Search agents, guides, connectors… or paste a key',
    agentKeyAddCustom: 'Add "{key}" as typed',
    agentKeyRemove: 'Remove {name}',
    hideAgent: 'Hide',
    unhideAgent: 'Unhide',
    hideAgentHint: 'Hide this agent from your admin list.',
    unhideAgentHint: 'Show this agent in your admin list again.',
    hiddenBadge: 'Hidden',
    // ICU plurals in the real keys; the mock t() only does {param}
    hiddenAgentsCount: '{count} hidden agents',
    hiddenAgentsShowing: 'Showing {count} hidden agents',
    hiddenAgentsShow: 'Show',
    hiddenAgentsHide: 'Hide again',
    allAgentsHidden:
      'All agents here are hidden from your view — use Show to reveal them.',
    localAdminGroup: {
      agents: 'Agents',
      promptAgents: 'Prompt agents',
      m365Agents: 'Microsoft 365 agents',
      orgAgents: 'Knowledge agents',
      guides: 'Guides',
      connectors: 'Connectors',
      datasets: 'Map datasets',
      unknown: 'Delegated but not found',
    },
    localAdminGroupUnavailable:
      'This list is temporarily unavailable — existing delegations are kept.',
    localAdminBuiltIn: 'built-in',
    // The real key is an ICU plural; the mock t() only does {param}
    localAdminSummary: '{count} delegated: {names}',
    localAdminSummaryMore: '{names} and {more} more',
    localAdminNoDelegations:
      'No delegations yet — a local admin with no agents can only see the admin area.',
    localAdminSelectedCount: '{selected} of {total} selected',
    localAdminCopyFrom: 'Copy from',
    localAdminClearAll: 'Clear all',
    localAdminSelectGroup: 'Select all',
    localAdminClearGroup: 'Clear',
    localAdminSearchPlaceholder: 'Search agents, guides, connectors…',
    localAdminDuplicateEmail:
      'This email is already listed — merge the two entries.',
    localAdminExpand: 'Show delegations',
    localAdminCollapse: 'Hide delegations',
    localAdminDiscard: 'Discard changes',
    noAgents: 'No agents to manage.',
    sourceLabel: 'Source',
    notDiscoverable: 'Not discoverable by you',
    notDiscoverableHint:
      "A rule exists for this agent, but it isn't in your own discovery — it may have been renamed, your Azure access doesn't reach it, or its access rule doesn't include you.",
    accessEveryone: 'Everyone',
    accessRestricted: 'Restricted',
    edit: 'Edit',
    updatedByLine: 'Last updated by {user} on {date}',
    accessTypeLabel: 'Who can use this agent',
    everyoneDescription:
      'Anyone who can already reach this agent through their Azure access.',
    restrictedDescription: 'Only the users and domains listed below.',
    allowDomainsLabel: 'Allowed domains',
    allowDomainsPlaceholder: 'example.org',
    allowUsersLabel: 'Allowed users',
    allowUsersPlaceholder: 'person@example.org',
    chipAddHint: 'Press Enter to add',
    removeChip: 'Remove',
    groupsLabel: 'Allowed groups',
    groupsPlaceholder: 'Entra group object ID',
    groupSearchPlaceholder: 'Search groups by name…',
    groupSearchNoResults: 'No groups match that name.',
    groupSearchError:
      'Group search failed. You can still paste a group object ID below.',
    groupSearchHint:
      "Type at least 2 characters to search your organization's groups, or paste a group object ID directly. Access follows the member list in Microsoft Entra.",
    restrictedEmptyWarning:
      'No users, domains, or groups are listed — nobody will be able to use this agent.',
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Cancel',
    saveSuccess: 'Access rule saved.',
    deleteSuccess: 'Access rule removed — everyone can use this agent again.',
    saveError: "Couldn't save. Please try again.",
    conflictError:
      'Someone else changed this while you were editing. Reload to load the latest version, then make your change again.',
    reload: 'Reload',
    addAgent: 'Add agent',
    newPromptAgentTitle: 'New prompt agent',
    editPromptAgentTitle: 'Edit prompt agent',
    agentNameLabel: 'Name',
    agentNamePlaceholder: 'e.g. Travel Advisor',
    agentDescriptionLabel: 'Description',
    agentDescriptionPlaceholder: 'Shown to users in the model picker',
    agentSystemPromptLabel: 'System prompt',
    agentSystemPromptPlaceholder:
      'Instructions that define how this agent behaves',
    agentModelLabel: 'Model',
    agentModelPlaceholder: 'Select a model…',
    agentModelUnavailable: '{modelId} (unavailable)',
    agentModelUnknownError:
      'The selected model is no longer available. Choose another model and save again.',
    promptAgentBadge: 'Prompt agent',
    editAgent: 'Edit agent',
    deleteAgent: 'Delete',
    deleteAgentConfirm:
      'Delete this agent for everyone? It disappears from the model picker; existing conversations keep their history.',
    confirmDeleteAgent: 'Yes, delete',
    promptAgentCreateSuccess: 'Prompt agent created.',
    promptAgentSaveSuccess: 'Prompt agent saved.',
    promptAgentDeleteSuccess: 'Prompt agent deleted.',
    promptAgentsUnavailableWarning:
      'Prompt agents could not be loaded from storage. They cannot be edited right now.',
  },
  modelSources: {
    connectButtonShort: 'Connect a model source',
    addAnother: 'Add another model source',
    edit: 'Edit',
    disconnect: 'Disconnect {name}',
    disconnectedToast: 'Disconnected {name}',
    modelCountLabel: '{count} models',
    loadingModels: 'Loading models...',
    noModelsAvailable: 'No models available from this source',
    sourceUnreachable:
      "Couldn't reach this source. Your access may have changed, or the service may be temporarily unavailable.",
    retry: 'Retry',
    connectFoundryAccount: 'Connect a Microsoft Azure Foundry Account',
    connectFoundryDescription:
      "Discover model deployments from an Azure Foundry account you have access to. Your own Azure permissions authorize every request — the app's model restrictions don't apply here.",
    selectModelsDescription:
      'Choose which model deployments from this account appear in your model picker.',
    editConnection: 'Edit Connection',
    nameLabel: 'Name',
    namePlaceholder: 'e.g. My Team Sandbox',
    nameRequired: 'Source name is required',
    foundryAccountLabel: 'Foundry Account',
    enterManually: 'Enter manually',
    browseResources: 'Browse resources',
    subscriptionIdLabel: 'Subscription ID',
    resourceGroupLabel: 'Resource Group',
    accountNameLabel: 'Account Name',
    subscriptionRequired: 'Choose a subscription',
    accountRequired: 'Choose a Foundry account',
    accountSelectionRequired: 'Select an account from the list.',
    selectAllRequired: 'Select a subscription, resource group, and account.',
    connectionFailed:
      'Could not reach this account. Check the details are correct and that you have access.',
    duplicateSource: 'This account is already connected as "{name}".',
    connectionSuccessModels: 'Connected — {count} model deployment(s) found',
    connectionSuccessEmpty:
      'Connected, but no model deployments found on this account.',
    checkingConnection: 'Checking connection...',
    next: 'Next',
    back: 'Back',
    cancel: 'Cancel',
    connect: 'Connect',
    save: 'Save',
    scanningResources: 'Scanning your Azure subscriptions...',
    // The real key is an ICU plural; the mock t() only does {param}
    // interpolation, so keep a simple shape here.
    discoveryPartialWarning:
      "{count} subscriptions couldn't be scanned. Use manual entry if your account is missing.",
    discoveryTruncatedWarning:
      'There were too many resources to scan completely. Use manual entry if your account is missing.',
    noAccountsDiscovered:
      'No Foundry accounts found in your subscriptions. Use manual entry if you know the path.',
    retryScan: 'Retry scan',
    searchAccountsPlaceholder: 'Search accounts...',
    modelsSelectedCount: '{selected} of {total} models selected',
    selectAll: 'Select all',
    deselectAll: 'Deselect all',
    autoAddLabel: 'Automatically add new models',
    autoAddDescription:
      'Model deployments added to this account later will appear automatically. Unchecked models stay excluded.',
  },
  documentTranslation: {
    invalidReference: 'Invalid document translation reference',
    pendingTitle: 'Translating {filename}…',
    pendingHint:
      'PDF translations run in the background and can take a few minutes. You can keep working — this card updates when the document is ready, even after a reload.',
    asyncFailed: 'Document translation failed: {error}',
    jobNotFound:
      'the translation job is no longer available. Please try again.',
    retryPolling: 'Check again',
    pollingStalled:
      "We couldn't reach the server to check progress. The translation may still be running.",
    translationSuccess: 'Document translated successfully',
    translationSubmitted:
      'Translation started — PDFs are processed in the background.',
    translatedTo: 'Translated to {language}',
    download: 'Download',
    downloading: 'Downloading…',
    expires: 'Available for {days} days',
  },
  connectors: {
    title: 'Connectors',
    description:
      'Connect external tools through the Model Context Protocol (MCP). Connected tools become available to models in chat, and every tool call runs only after you approve it.',
    adminConnectorsTitle: 'From your organization',
    yourConnectorsTitle: 'Your connectors',
    addTitle: 'Add a connector',
    addDescription:
      "Pick a tool to connect. You'll set up access after choosing.",
    add: 'Add',
    filterLabel: 'Filter connectors',
    filterPlaceholder: 'Search connectors',
    noMatches: 'No connectors match “{query}”.',
    adminConnectorsDescription:
      'Connectors your administrators have set up. Which ones you see depends on your access.',
    managedByOrg: 'Managed by your organization',
    connectorOauthNotConfigured:
      "Sign-in isn't finished being set up for this connector. Contact your administrator.",
    localOnlyNote:
      'You sign in directly with each provider. Access keys are encrypted and stored only on this device, and are relayed through the app server with each request — never stored or logged there.',
    catalog: {
      github: {
        name: 'GitHub',
        description:
          'Search repositories, read and create issues and pull requests.',
      },
      asana: {
        name: 'Asana',
        description: 'Find, create, and update tasks and projects.',
      },
    },
    connect: 'Connect',
    connected: 'Connected',
    tokenEndsIn: 'ends in ••••{last4}',
    disconnect: 'Disconnect',
    // The real key is an ICU plural; the mock t() only does {param}
    // interpolation, so keep a simple shape here.
    toolCount: '{count} tools available',
    patLabel: 'Personal access token',
    createTokenLink: 'Create a token',
    tokenScopeHint:
      'Use a fine-grained token with only the access these tools need.',
    validating: 'Checking connection…',
    validationFailed: 'Could not connect. Check the address and try again.',
    authFailed: 'The server rejected the token. Check it and try again.',
    tokenRequired: 'A token is required',
    enableServer: 'Available in chat',
    arbitraryTitle: 'Other MCP servers',
    arbitraryToggle: 'Allow arbitrary MCP servers',
    arbitraryWarning:
      'Anyone who runs an MCP server can see the messages sent to its tools. Only connect servers you trust. Every tool call still requires your approval.',
    addServer: 'Add MCP server',
    editServer: 'Edit MCP server',
    serverName: 'Name',
    serverUrl: 'Server URL',
    nameRequired: 'Name is required',
    urlRequired: 'URL is required',
    invalidUrl: 'Enter a public https:// address',
    namePlaceholder: 'My MCP server',
    urlPlaceholder: 'https://mcp.example.com',
    tokenOptionalLabel: 'Access token (optional)',
    keepTokenPlaceholder: 'Leave blank to keep the current token',
    disconnectedToast: '{name} disconnected',
    save: 'Save',
    connectWithProvider: 'Connect with {name}',
    useTokenInstead: 'Use an access token instead',
    oauthWaiting: 'Waiting for authorization…',
    oauthFailed: 'Sign-in failed. Try again.',
    oauthDenied: 'Access was denied by the provider.',
    oauthTimeout: 'Sign-in timed out. Try again.',
    oauthCancelled: 'Sign-in was cancelled.',
    oauthUnavailable:
      "Sign-in isn't available for this connector on this deployment. Use an access token instead, or ask your administrator to configure the OAuth app.",
    oauthNoAppConfigured:
      "Signing in with {name} isn't set up on this deployment. Connect by registering your own OAuth app.",
    ownAppToggle: 'Use your own OAuth app',
    ownAppHint:
      'Register an OAuth app in your {name} account (your organization, workspace, or enterprise instance) with the callback URL below, then paste its credentials here. Leave this closed to use the built-in app.',
    ownAppCustomHint:
      'Optionally provide your own OAuth app credentials below; leave them blank to register automatically with the server.',
    ownAppInUse: 'Connected with your own OAuth app.',
    clientIdLabel: 'Client ID',
    clientSecretLabel: 'Client secret (if your app has one)',
    redirectUriLabel: 'Callback / redirect URL to register',
    reconnect: 'Reconnect',
    needsReauth: 'Needs reconnect',
    disconnectOauthNote:
      'Disconnecting removes access from this device only. To fully revoke access, manage authorized apps in your {name} account.',
    authModeLabel: 'Authentication',
    authModeNone: 'None',
    authModeBearer: 'Access token',
    authModeOauth: 'Sign in with the provider (OAuth)',
    oauthCustomHint:
      "You'll sign in with the server's provider in a pop-up window after saving.",
    saveAndSignIn: 'Save & sign in',
    oauthCallback: {
      title: 'Authorization complete',
      missingState: 'Nothing to authorize',
      close: 'You can close this window and return to the app.',
      closeButton: 'Close window',
    },
  },
  memories: {
    title: 'Memories',
    description:
      'Let the assistant remember durable facts you share — like your role, preferences, and ongoing projects — and use them across conversations.',
    enableToggle: 'Enable memories',
    privacyNote:
      'Facts are stored only in this browser and included in your chats to personalize replies.',
    empty:
      'No memories yet. Add one above, or let the assistant save facts from your conversations.',
    savedOn: 'Saved {date}',
    deleteMemory: 'Delete memory',
    clearAll: 'Clear all memories',
    clearAllConfirmQuestion: 'Delete all memories? This cannot be undone.',
    clearAllConfirm: 'Delete all',
    cancel: 'Cancel',
    pauseToggle: 'Pause saving new memories',
    pauseNote:
      'Memories you already have keep personalizing your chats — nothing new is saved until you resume.',
    addLabel: 'Add a memory',
    addPlaceholder:
      'Something the assistant should remember, e.g. "Prefers concise answers"',
    addMemory: 'Add memory',
    editMemory: 'Edit memory',
    saveMemory: 'Save',
    addedByYou: 'Added by you',
    storedCount: '{count} of {max} memories saved',
    charCount: '{count}/{max} characters',
    noLineBreaksHint:
      'Line breaks are removed — a memory is stored as one line.',
    duplicate: 'That memory is already saved.',
    atCapacity:
      "You've reached the {max}-memory limit. Delete one to add another.",
  },
  contextWindow: {
    label: 'Context window',
    value: '{count} messages',
    fewer: 'Fewer messages',
    more: 'More messages',
    description:
      'Older messages beyond this limit are summarized and sent as context.',
  },
  settings: {
    webSearch: {
      title: 'Web Search',
      description:
        'Controls how live web searches run when Search Mode is active. Changes apply immediately.',
      providerLabel: 'Search provider',
      providerAuto: 'Automatic (recommended)',
      providerAutoDescription:
        'Uses the deployment default — currently the combined news search below.',
      providerNews: 'Combined news (GDELT + Google News)',
      providerNewsDescription:
        'Queries both sources in parallel and merges the results, so either one failing never breaks a search. Best balance of speed, source diversity, and working article links.',
      providerGoogleNews: 'Google News only',
      providerGoogleNewsDescription:
        'Anonymous and fast — only the search query reaches Google (no account or cookies) and results arrive in about a second. Note: it mostly scans headlines and short snippets, not full articles, so answers can stay surface-level.',
      providerGdelt: 'GDELT only',
      providerGdeltDescription:
        'Open research database of world news with direct publisher links, which lets follow-up questions read the full articles. Strictly rate-limited — back-to-back searches may queue for a few seconds.',
      providerBing: 'Bing grounding (via Microsoft)',
      providerBingDescription:
        'Reads full pages for deeper summaries and covers the general web, not just news. However, searches routinely take 30–90 seconds and result quality is often inconsistent from one search to the next.',
      providerBingResponses: 'Bing fast search (Azure OpenAI)',
      providerBingResponsesDescription:
        'The same Bing web coverage as Bing grounding, run as a single direct model call instead of a Foundry agent — typically much faster. New option under evaluation against Bing grounding.',
      providerCombined: 'Deep search with early headlines (Bing + Google News)',
      providerCombinedDescription:
        'Runs Bing grounding and Google News together: headlines appear within seconds while the deep Bing search keeps working, and you can choose to answer from the headlines right away instead of waiting out the slow search. When Bing finishes, both result sets are merged.',
      sourcesLabel: 'Sources per search',
      sourcesDescription:
        'How many distinct sources a search keeps as citations. Research-style questions may automatically widen this.',
      freshnessLabel: 'Preferred recency',
      freshnessDescription:
        'How recent results should be. Automatic lets each question decide (breaking news prefers the last day).',
      freshness_auto: 'Automatic',
      freshness_day: 'Past day',
      freshness_week: 'Past week',
      freshness_month: 'Past month',
      freshness_any: 'Any time',
    },
  },
  usageImpact: {
    empty: 'No usage tracked yet.',
    co2Value: '{grams} g CO2e',
    equivalence: '~ {count} smartphone charges',
    requests: 'Requests',
    promptTokens: 'Prompt tokens',
    completionTokens: 'Completion tokens',
    topModels: 'By model',
    byRegion: 'By hosting region',
    regionDefault: 'Default',
    modelRow: '{requests} req - {grams} g',
    estimatedPortion:
      'Includes ~{grams} g CO2e ({requests} requests) estimated from chats that predate tracking',
    disclosure: 'Estimates based on assumptions v{version} - since {since}.',
    reset: 'Reset usage stats',
  },
  emissions: {
    tier: {
      low: 'Lower impact',
      moderate: 'Moderate impact',
      high: 'Higher impact',
    },
    tierTooltip: 'Relative energy impact per request (assumptions v{version})',
    typicalRequest: '~{grams} g CO2e per typical request',
    typicalRequestTooltip:
      'Rough per-request estimate (assumptions v{version})',
    activities: {
      netflixHd: 'Netflix HD streaming',
      zoomCall: 'Zoom call (camera on)',
      webBrowsing: 'Web browsing',
      spotifyAudio: 'Spotify audio',
    },
    equivalents: {
      title: '~ the same carbon as',
      note: 'Same-carbon comparison against published per-hour footprints',
    },
    duration: {
      lessThanSecond: '<1 s',
      seconds: '{value} s',
      minutes: '{value} min',
      hours: '{value} h',
    },
    chip: {
      label: '{grams} g CO2e',
      ariaLabel: 'Estimated carbon footprint: {grams} grams. Show breakdown.',
      ariaLabelToday:
        'Estimated carbon footprint today: {grams} grams. Show breakdown.',
      title: 'This conversation (estimated)',
      today: 'Today',
      total: 'All time',
      measured: 'From reported token counts',
      estimated: 'Back-calculated from older messages',
      lastRequest: 'Last request',
      disclaimer: 'Per-request estimates (assumptions v{version})',
      visibilityGroup: 'Emissions chip visibility',
      visibilityLabel: 'Show:',
      visibility: {
        always: 'Always',
        auto: 'Auto',
        hidden: 'Hide',
      },
      visibilityHint:
        'Auto shows the chip when the estimate updates or you hover it.',
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
    favorites: 'Favorites',
    recommended: 'Recommended',
    searchPlaceholder: 'Search models',
    searchEmpty: 'No models match your search.',
    star: 'Star {name}',
    unstar: 'Unstar {name}',
    variant: {
      label: 'Variant',
    },
    version: {
      label: 'Version',
    },
    deployment: {
      title: 'Deployment',
      source: 'Source',
      account: 'Account',
      location: 'Location',
      deployment: 'Deployment',
      modelVersion: 'Model version',
      publisher: 'Publisher',
    },
    euResidencyNote: 'All models run in the EU Azure region.',
    reasoningModel:
      'Reasoning model: thinks step-by-step before answering. Slower, better on hard problems.',
    hostedRegion: {
      label: 'Hosted region',
      processedIn:
        'This conversation is processed in the {region} Azure region.',
      euOnlyNote:
        '{name} is hosted in the EU Azure region; conversations with it are processed there.',
    },
    hostedExternally:
      "Runs on the provider's own infrastructure through Azure AI Foundry, not inside MSF's Azure environment.",
    hostedIn: {
      label: 'Hosted in {regions}',
      tooltip:
        'The Azure region(s) where this model is deployed. Conversations are processed in your own region.',
    },
    badges: {
      external: 'External',
      externalTooltip:
        "Runs on the provider's own infrastructure through Azure AI Foundry, not inside MSF's Azure environment.",
      regionHostedTooltip:
        'Hosted in the {region} Azure region. Conversations with this model are processed there.',
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
    // Deterministic (timezone-independent) date output so tests can assert it.
    dateTime: (date: Date | number) =>
      new Date(date).toISOString().slice(0, 10),
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

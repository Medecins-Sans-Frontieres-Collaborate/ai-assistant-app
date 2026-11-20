'use client';

import {
  IconAdjustments,
  IconArrowBackUp,
  IconBook2,
  IconClipboardCheck,
  IconCopy,
  IconLanguage,
  IconLock,
  IconPencil,
  IconPencilOff,
  IconPlayerStopFilled,
  IconScan,
  IconUpload,
} from '@tabler/icons-react';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import toast from 'react-hot-toast';

import { useLocale, useTranslations } from 'next-intl';

import { m365ErrorMessageKey } from '@/client/hooks/chat/useM365Attachment';
import { useAvailableGuides } from '@/client/hooks/settings/useAvailableGuides';
import {
  useLimitGates,
  useMyLimits,
} from '@/client/hooks/settings/useMyLimits';
import { useBudgetGate } from '@/client/hooks/settings/useUsageBudgets';
import { useAutoFocusComposer } from '@/client/hooks/ui/useAutoFocusComposer';
import { useElementWidth } from '@/client/hooks/ui/useElementWidth';
import { usePasteComposer } from '@/client/hooks/ui/usePasteComposer';
import { useM365Enabled } from '@/client/hooks/useM365Enabled';
import { useDocumentTranslationReader } from '@/client/hooks/workflows/useDocumentTranslationReader';
import { useEditPreview } from '@/client/hooks/workflows/useEditPreview';
import { useFormattedDocument } from '@/client/hooks/workflows/useFormattedDocument';
import { useFormattedRunStorage } from '@/client/hooks/workflows/useFormattedRunStorage';
import { usePdfPages } from '@/client/hooks/workflows/usePdfPages';
import { useStoredSourceText } from '@/client/hooks/workflows/useStoredSourceText';
import { useWorkflowStream } from '@/client/hooks/workflows/useWorkflowStream';

import { downloadDriveItem } from '@/client/services/m365/m365Client';
import {
  DocumentJobError,
  fetchStoredFile,
  submitDocumentTranslation,
} from '@/client/services/workflows/documentTranslationJob';
import {
  FileTextExtractionError,
  UploadStage,
  extractTextFromUploadedFile,
  ocrUploadedFile,
  uploadAndExtractText,
} from '@/client/services/workflows/fileTextExtraction';
import {
  NativePdfAvailability,
  fetchNativePdfAvailability,
} from '@/client/services/workflows/nativePdfTranslation';
import {
  RunAccess,
  fetchRunFile,
} from '@/client/services/workflows/nativeRunStorage';
import { appendWorkflowRailMessages } from '@/client/services/workflows/railMessages';
import { assessTranslation } from '@/client/services/workflows/translationAssessment';
import { requestTranslationChange } from '@/client/services/workflows/translationChangeRequest';
import { nameWorkflowConversation } from '@/client/services/workflows/workflowTitle';
import { AGENTIC_TRANSLATION_MAX_PASSES } from '@/lib/services/workflows/shared/workflowLimits';

import {
  AddSourceId,
  AddToChatCapabilities,
  needsPicker,
} from '@/lib/utils/app/addToChat';
import {
  LanguageOption,
  sortLanguageOptionsByLabel,
} from '@/lib/utils/app/languagePickerHelpers';
import {
  MAX_OCR_PAGES,
  OCR_ERROR,
  OCR_PAGES_LIMIT_KEY,
  looksLikeSparseText,
  supportsOcr,
} from '@/lib/utils/shared/file/ocr';
import { isCustomCriterionId } from '@/lib/utils/shared/review/customCriteria';
import {
  changedRange,
  locateEdits,
  stampEditAnchors,
  touchedSpanIds,
} from '@/lib/utils/shared/review/editLocation';
import {
  guideCriterionId,
  isGuideCriterionId,
} from '@/lib/utils/shared/review/guideCriteria';
import {
  hasResolvedEdits,
  invertPatch,
  withoutResolvedEdits,
} from '@/lib/utils/shared/review/reviewQueue';
import {
  CHANGE_REQUEST_CRITERION,
  ChangeSelection,
  stampSelectionAnchors,
} from '@/lib/utils/shared/translation/changeRequest';
import {
  fileExtensionOf,
  leaveDocumentReader,
  showDocumentPage,
  wholeDocumentEligibility,
} from '@/lib/utils/shared/translation/documentMode';
import {
  applyEdit,
  applyEditsInOrder,
} from '@/lib/utils/shared/translation/editApplication';
import {
  DEFAULT_DOCUMENT_LAYOUT,
  DEFAULT_FORMATTED_OPTIONS,
  FormattedDocumentOptions,
  FormattedDocumentRun,
  TranslationDocumentLayout,
  formattedEligibility,
  planBatch,
  removedPages,
  translatedPages,
} from '@/lib/utils/shared/translation/formattedDocument';
import { mergeGlossaryEntries } from '@/lib/utils/shared/translation/glossaryMatch';
import {
  TRANSLATION_LANGUAGES,
  findTranslationLanguage,
  translationLanguageLabel,
} from '@/lib/utils/shared/translation/languages';
import {
  FALLBACK_NATIVE_PDF_LIMITS,
  NATIVE_PDF_DEFAULT_DEPTH,
} from '@/lib/utils/shared/translation/nativePdf';
import {
  NativeRunBackend,
  NativeRunRef,
  runFileUrl,
} from '@/lib/utils/shared/translation/nativeRunStorage';
import {
  SourcePage,
  formatPageSelection,
  joinPages,
  parsePageSelection,
  selectBatch,
  splitExtractedPages,
} from '@/lib/utils/shared/translation/pageBatches';
import { stripPageCounters } from '@/lib/utils/shared/translation/pageSheets';
import { TRANSLATION_QUALITY_CRITERIA } from '@/lib/utils/shared/translation/qualityCriteria';
import {
  countAnalysisNotes,
  deriveRunStage,
  hasPaperTrail,
  lastReviewVerdict,
} from '@/lib/utils/shared/translation/runProgress';
import {
  REVIEW_BESIDE_MIN_WIDTH,
  workspaceLayout,
} from '@/lib/utils/shared/translation/workspaceLayout';

import {
  TRANSLATION_PAGES_LIMIT_KEY,
  supportsPagedText,
} from '@/types/documentTranslation';
import type { M365DriveEntry } from '@/types/m365';
import {
  TRANSLATION_KINDS,
  TranslationAnalysis,
  TranslationDocumentJob,
  TranslationEditStatus,
  TranslationGlossary,
  TranslationGlossaryCheck,
  TranslationKind,
  TranslationMode,
  TranslationReviewRound,
  TranslationRoundChange,
  TranslationTargetLanguage,
  TranslationTextMode,
  TranslationWorkflowState,
} from '@/types/workflow';

import AddToChatDialog, {
  AddToChatHost,
} from '@/components/Chat/ChatInput/AddToChatDialog';
import { ConfirmDialog } from '@/components/UI/ConfirmDialog';
import { LanguagePicker } from '@/components/UI/LanguagePicker';

import { RunEstimateHint } from '../Impact/RunEstimateHint';
import { ElapsedTime } from '../Shared/Progress/ElapsedTime';
import { SkeletonLines } from '../Shared/Progress/SkeletonLines';
import { AnnotatedText } from '../Shared/Review/AnnotatedText';
import { AssessmentPanel } from '../Shared/Review/AssessmentPanel';
import { CriteriaManager } from '../Shared/Review/CriteriaManager';
import { CriteriaPicker } from '../Shared/Review/CriteriaPicker';
import { GuidePicker } from '../Shared/Review/GuidePicker';
import { PendingEditsDialog } from '../Shared/Review/PendingEditsDialog';
import { WorkflowWorkspaceProps } from '../registry';
import { AnalysisStrip } from './AnalysisStrip';
import { AssessmentProgress } from './AssessmentProgress';
import { ChangeRequestBar } from './ChangeRequestBar';
import { DocumentDownloadMenu } from './DocumentDownloadMenu';
import { DocumentJobProgress } from './DocumentJobProgress';
import { DocumentReaderBar } from './DocumentReaderBar';
import { FormattedProgress } from './Formatted/FormattedProgress';
import { FormattedReview } from './Formatted/FormattedReview';
import {
  FormattedRunExpiryWarning,
  FormattedRunUnavailable,
} from './Formatted/FormattedRunStorageNotice';
import { EarlierTranslation, FormattedSetup } from './Formatted/FormattedSetup';
import { TranslationOptionsBar } from './Formatted/TranslationOptionsBar';
import { GlossaryManager } from './GlossaryManager';
import { GlossaryPicker, languageFit } from './GlossaryPicker';
import { OcrOffer, OcrOfferReason } from './OcrOffer';
import { SelectionChangeRequest } from './SelectionChangeRequest';
import { SourceDocumentCard } from './SourceDocumentCard';
import { SourcePageSelector } from './SourcePageSelector';
import { SourcePageSheets } from './SourcePageSheets';
import { SourceTextStorageNotice } from './SourceTextStorageNotice';
import { TranslationRunStatus } from './TranslationRunStatus';
import { UploadProgress } from './UploadProgress';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { useWorkflowRailStore } from '@/client/stores/workflowRailStore';
import { useWorkflowRunStore } from '@/client/stores/workflowRunStore';
import { v4 as uuidv4 } from 'uuid';

/** Where the reader goes when it leaves the page in view. */
type PageDeparture = { page: number } | { mode: TranslationMode };

/** Pre-flight cap; the server enforces its own (larger) limit. */
const MAX_SOURCE_CHARS = 60_000;

const ACCEPTED_UPLOADS = '.pdf,.doc,.docx,.txt,.md,.xml,.ppt,.pptx';

/** The same file types as the picker names them: lowercase, no dot. */
const ACCEPTED_UPLOAD_EXTENSIONS: readonly string[] = ACCEPTED_UPLOADS.split(
  ',',
).map((extension) => extension.slice(1));

/** Where a source document can be uploaded from. */
const UPLOAD_SOURCES: readonly AddSourceId[] = ['device', 'onedrive'];

/** Device features the upload picker never uses. */
const NO_CAMERA = false;

/** A quiet text button inside the source document card. */
const CARD_ACTION_CLASS =
  'shrink-0 whitespace-nowrap rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-surface-dark-elevated';

/**
 * Least height a text pane keeps once the workbench scrolls (it no longer
 * fits its window), so a pane is never squeezed down to a line or two.
 */
const PANE_MIN_HEIGHT = 'min-h-[14rem]';

/** A change to the translation asked for in words, from the bar or the rail. */
interface ChangeRequestInput {
  instruction: string;
  /** Limits the edits to one passage of the translation. */
  selection?: ChangeSelection;
  /** The rail's stop button. */
  signal?: AbortSignal;
  /**
   * Given by the rail, which shows the reply as the assistant's message.
   * Without it the request came from the workspace, which logs the
   * exchange in the rail itself.
   */
  settle?: (reply: string) => void;
}

export function TranslationWorkspace({
  conversationId,
}: WorkflowWorkspaceProps) {
  const t = useTranslations('workflows');
  const tM365 = useTranslations('m365');
  const conversation = useConversationStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const updateWorkflowState = useConversationStore(
    (s) => s.updateWorkflowState,
  );
  const glossaries = useSettingsStore((s) => s.glossaries);
  const addGlossary = useSettingsStore((s) => s.addGlossary);
  const customLanguages = useSettingsStore((s) => s.customLanguages);
  const addCustomLanguage = useSettingsStore((s) => s.addCustomLanguage);
  const autoClearResolvedEdits = useSettingsStore(
    (s) => s.autoClearResolvedEdits,
  );
  const setAutoClearResolvedEdits = useSettingsStore(
    (s) => s.setAutoClearResolvedEdits,
  );
  const reviewOverwriteAcknowledged = useSettingsStore(
    (s) => s.reviewOverwriteAcknowledged,
  );
  const setReviewOverwriteAcknowledged = useSettingsStore(
    (s) => s.setReviewOverwriteAcknowledged,
  );
  const analysisHidden = useSettingsStore((s) => s.translationAnalysisHidden);
  const setAnalysisHidden = useSettingsStore(
    (s) => s.setTranslationAnalysisHidden,
  );
  const analysisHeight = useSettingsStore((s) => s.translationAnalysisHeight);
  const setAnalysisHeight = useSettingsStore(
    (s) => s.setTranslationAnalysisHeight,
  );
  const translationCriteria = useSettingsStore((s) => s.translationCriteria);
  const addTranslationCriterion = useSettingsStore(
    (s) => s.addTranslationCriterion,
  );
  const updateTranslationCriterion = useSettingsStore(
    (s) => s.updateTranslationCriterion,
  );
  const deleteTranslationCriterion = useSettingsStore(
    (s) => s.deleteTranslationCriterion,
  );
  const run = useWorkflowRunStore((s) => s.runs[conversationId]);
  const cancelRun = useWorkflowRunStore((s) => s.cancelRun);
  const clearError = useWorkflowRunStore((s) => s.clearError);
  const { runWorkflowStream } = useWorkflowStream();

  const state =
    conversation?.workflowState?.kind === 'translation'
      ? (conversation.workflowState as TranslationWorkflowState)
      : undefined;

  const [langPickerOpen, setLangPickerOpen] = useState(false);
  // Translate was pressed with no target language chosen (askForLanguage).
  const [languageAsked, setLanguageAsked] = useState(false);
  const languageHintId = useId();
  // `sourceDocument.url` whose "translate as a document" offer was declined.
  const [dismissedDocumentOffer, setDismissedDocumentOffer] = useState<
    string | null
  >(null);
  const [glossariesOpen, setGlossariesOpen] = useState(false);
  const [glossaryPickerOpen, setGlossaryPickerOpen] = useState(false);
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  /** Live target text while streaming; null = show persisted finalText. */
  const [targetDraft, setTargetDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [editingTarget, setEditingTarget] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(true);
  // A held-back change to the translation — the suggestions it would have
  // overwritten and the text it would have produced — while the one-time
  // explanation is up (docs/REVIEW_EDIT_UNFREEZE_DESIGN.md §5, §6a).
  const [overwritePrompt, setOverwritePrompt] = useState<{
    ids: string[];
    next: string;
  } | null>(null);
  const [assessing, setAssessing] = useState(false);
  const [assessError, setAssessError] = useState<string | null>(null);
  // A change the user asked for in words, while the server works on it.
  const [changeRun, setChangeRun] = useState<{
    instruction: string;
    startedAt: number;
  } | null>(null);
  const [changeNote, setChangeNote] = useState<string | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);
  const changeAbortRef = useRef<AbortController | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Arrangement follows the workspace's own width (see workspaceLayout).
  // Until measured, assume there is room: that is the desktop arrangement.
  const { ref: measureRoot, width: workspaceWidth } =
    useElementWidth<HTMLDivElement>(REVIEW_BESIDE_MIN_WIDTH);
  const layout = workspaceLayout(workspaceWidth);
  const setRoot = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      measureRoot(node);
    },
    [measureRoot],
  );
  const reviewColumnClasses = `flex shrink-0 flex-col border-gray-200 dark:border-gray-700 ${
    layout.reviewBeside
      ? 'w-96 border-s'
      : layout.panesSideBySide
        ? 'max-h-80 border-t'
        : 'border-t'
  }`;
  const locale = useLocale();
  // The request waiting behind the pending-suggestions dialog.
  const heldChangeRef = useRef<ChangeRequestInput | null>(null);
  // Built-ins on by default; custom criteria start off, so adding one
  // never silently changes what the next assessment measures.
  const [selectedCriteria, setSelectedCriteria] = useState<Set<string>>(
    () => new Set<string>(TRANSLATION_QUALITY_CRITERIA.map((c) => c.id)),
  );
  const langButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The upload in flight, if any: what the source pane shows instead of text.
  const [upload, setUpload] = useState<{
    name: string;
    size?: number;
    stage: UploadStage;
  } | null>(null);
  /** An open offer to read a stored PDF with OCR. */
  const [ocrOffer, setOcrOffer] = useState<{
    name: string;
    url: string;
    reason: OcrOfferReason;
    /** False when the server has no OCR to run. */
    canOcr: boolean;
    error?: string;
  } | null>(null);
  /** The loaded document's text is thin enough to suggest OCR. */
  const [sparseTextHint, setSparseTextHint] = useState(false);
  const uploading = upload !== null;
  // With OneDrive / SharePoint available, "Upload document" opens the same
  // picker the chat uses; without, it goes straight to the system dialog.
  const m365Connected = useSettingsStore((s) => s.m365Connected);
  const { filesEnabled: m365FilesFlag } = useM365Enabled();
  const uploadCapabilities: AddToChatCapabilities = useMemo(
    () => ({
      camera: NO_CAMERA,
      m365Files: m365FilesFlag && m365Connected,
      m365Mail: false,
      m365Meetings: false,
      m365Translation: false,
    }),
    [m365FilesFlag, m365Connected],
  );
  const uploadUsesPicker = needsPicker('attach', uploadCapabilities);
  const [uploadPickerOpen, setUploadPickerOpen] = useState(false);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const assessAbortRef = useRef<AbortController | null>(null);
  // The analysis strip starts as its one-line header and goes back to it
  // whenever a run completes; whether it is shown at all is a preference.
  const [analysisExpanded, setAnalysisExpanded] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Pages of the large document behind `state.sourceDocument`. Held in
  // memory only: workflow state persists the reference, never the text.
  const [sourcePages, setSourcePages] = useState<SourcePage[] | null>(null);
  const [loadingSourcePages, setLoadingSourcePages] = useState(false);
  // The user chose to see (and edit) the document's text as one run rather
  // than as page sheets.
  const [sourceAsText, setSourceAsText] = useState(false);

  const patchState = useCallback(
    (patch: Partial<TranslationWorkflowState>) => {
      updateWorkflowState(conversationId, (prev) => ({
        ...(prev as TranslationWorkflowState),
        ...patch,
        kind: 'translation',
        updatedAt: new Date().toISOString(),
      }));
    },
    [conversationId, updateWorkflowState],
  );

  const languageOptions = useMemo<LanguageOption[]>(() => {
    const catalog = TRANSLATION_LANGUAGES.map<LanguageOption>((lang) => ({
      code: lang.id,
      label: lang.name,
      sublabel: lang.autonym !== lang.name ? lang.autonym : undefined,
    }));
    const custom = customLanguages.map<LanguageOption>((lang) => ({
      code: `custom:${lang.id}`,
      label: lang.name,
      sublabel: t('translation.addedByYou'),
    }));
    return [...sortLanguageOptionsByLabel(catalog), ...custom];
  }, [customLanguages, t]);

  // Current target, tolerating the legacy locale-code field.
  const targetLanguage = useMemo<TranslationTargetLanguage | undefined>(() => {
    if (state?.targetLanguage) return state.targetLanguage;
    if (state?.targetLang) {
      const known = findTranslationLanguage(state.targetLang);
      return known
        ? { id: known.id, label: translationLanguageLabel(known) }
        : { id: state.targetLang, label: state.targetLang, custom: true };
    }
    return undefined;
  }, [state?.targetLanguage, state?.targetLang]);

  const selectTargetById = useCallback(
    (code: string) => {
      if (code.startsWith('custom:')) {
        const custom = customLanguages.find((l) => `custom:${l.id}` === code);
        if (custom) {
          patchState({
            targetLanguage: {
              id: code,
              label: custom.name,
              custom: true,
            },
          });
        }
        return;
      }
      const known = findTranslationLanguage(code);
      if (known) {
        patchState({
          targetLanguage: {
            id: known.id,
            label: translationLanguageLabel(known),
          },
        });
      }
    },
    [customLanguages, patchState],
  );

  const handleCreateLanguage = useCallback(
    (name: string) => {
      const id = uuidv4();
      addCustomLanguage({
        id,
        name,
        createdAt: new Date().toISOString(),
      });
      patchState({
        targetLanguage: { id: `custom:${id}`, label: name, custom: true },
      });
    },
    [addCustomLanguage, patchState],
  );

  const isRunning = run?.isRunning ?? false;
  const sourceText = state?.sourceText ?? '';

  // Stray typing and pasting land in the source pane, the way they land in
  // the chat composer. Deliberately no `onAttach`: this field exists to
  // receive a whole document, so diverting a large paste to an attachment
  // would defeat the workflow rather than protect the composer.
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const appendSource = useCallback(
    (text: string) => patchState({ sourceText: sourceText + text }),
    [patchState, sourceText],
  );
  useAutoFocusComposer({
    textareaRef: sourceRef,
    enabled: !isRunning,
    append: appendSource,
  });
  usePasteComposer({
    textareaRef: sourceRef,
    enabled: !isRunning,
    append: appendSource,
  });
  const targetText = targetDraft ?? state?.finalText ?? '';

  // --- Document mode ------------------------------------------------------
  // Document mode has two layouts (see formattedDocument.ts). `documentMode`
  // below means the TEXT layout, which is what all the reader code in this
  // file is about; `formattedMode` is the formatting-preserving layout,
  // which has its own screens under ./Formatted. Exactly one of the two is
  // true in Document mode.
  const anyDocumentMode = state?.mode === 'document';
  const [formattedService, setFormattedService] =
    useState<NativePdfAvailability | null>(null);
  // Asked once when the workspace opens, in any mode, so the layout row is
  // already there when Document is chosen instead of appearing a moment later.
  useEffect(() => {
    const abort = new AbortController();
    void fetchNativePdfAvailability(abort.signal).then((availability) => {
      if (!abort.signal.aborted) setFormattedService(availability);
    });
    return () => abort.abort();
  }, []);
  const formattedMode =
    anyDocumentMode &&
    !!formattedService?.enabled &&
    (state?.documentLayout ?? DEFAULT_DOCUMENT_LAYOUT) === 'formatted';
  const documentMode = anyDocumentMode && !formattedMode;
  const documentJob = state?.documentJob;
  // The file as uploaded in this session, to submit without re-downloading.
  const uploadedFileRef = useRef<{ url: string; file: File } | null>(null);
  const [submittingDocument, setSubmittingDocument] = useState(false);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [confirmRetranslate, setConfirmRetranslate] = useState(false);
  const [departureGate, setDepartureGate] = useState<PageDeparture | null>(
    null,
  );
  const [queuedDeparture, setQueuedDeparture] = useState<PageDeparture | null>(
    null,
  );
  const { featureRemaining } = useLimitGates();
  const { refetch: refetchLimits } = useMyLimits();

  const patchDocumentJob = useCallback(
    (jobPatch: Partial<TranslationDocumentJob>) => {
      updateWorkflowState(conversationId, (prev) => {
        const p = prev as TranslationWorkflowState;
        if (!p.documentJob) return p;
        return {
          ...p,
          documentJob: { ...p.documentJob, ...jobPatch },
          updatedAt: new Date().toISOString(),
        };
      });
    },
    [conversationId, updateWorkflowState],
  );
  const showPageInPane = useCallback(
    (page: number, text: string) => {
      updateWorkflowState(conversationId, (prev) => {
        const p = prev as TranslationWorkflowState;
        return {
          ...p,
          ...showDocumentPage(p, page, text),
          updatedAt: new Date().toISOString(),
        };
      });
    },
    [conversationId, updateWorkflowState],
  );
  const reader = useDocumentTranslationReader({
    job: documentJob,
    active: documentMode,
    paneText: state?.finalText,
    onJobChange: patchDocumentJob,
    onShowPage: showPageInPane,
  });
  const documentInProgress =
    documentJob?.status === 'translating' ||
    documentJob?.status === 'preparing';
  // The reader has pages to show: the panes show a page, not the source text.
  const readingDocument = documentMode && documentJob?.status === 'ready';
  /** The reader's page is loaded and is the text in the translation pane. */
  const pageInPane =
    readingDocument &&
    !!reader.page &&
    documentJob?.viewPage === reader.page.page;
  /** The page in the pane differs from its machine translation. */
  const pageIsCorrected =
    pageInPane &&
    (state?.finalText ?? '').trim() !== reader.page?.translation.trim();
  /** The text the translation in the pane was made from. */
  const activeSource = readingDocument
    ? (reader.page?.source ?? '')
    : sourceText;

  // Glossary attachments — arrays, with the pre-picker single-id fields
  // read as a fallback so older conversations keep their selection.
  const selectedPersonalIds = useMemo<string[]>(
    () => state?.glossaryIds ?? (state?.glossaryId ? [state.glossaryId] : []),
    [state?.glossaryIds, state?.glossaryId],
  );
  const selectedOrgIds = useMemo<string[]>(
    () =>
      state?.glossaryGuideIds ??
      (state?.glossaryGuideId ? [state.glossaryGuideId] : []),
    [state?.glossaryGuideIds, state?.glossaryGuideId],
  );
  /**
   * Entries of every selected personal glossary, deduplicated with the same
   * first-wins rule the server applies (selection order = precedence).
   */
  const activeGlossaryEntries = useMemo(
    () =>
      mergeGlossaryEntries(
        [],
        selectedPersonalIds.flatMap(
          (id) => glossaries.find((g) => g.id === id)?.entries ?? [],
        ),
      ),
    [selectedPersonalIds, glossaries],
  );
  const stalePersonalIds = useMemo(
    () =>
      selectedPersonalIds.filter((id) => !glossaries.some((g) => g.id === id)),
    [selectedPersonalIds, glossaries],
  );
  const togglePersonalGlossary = useCallback(
    (id: string) => {
      const next = selectedPersonalIds.includes(id)
        ? selectedPersonalIds.filter((x) => x !== id)
        : [...selectedPersonalIds, id];
      patchState({ glossaryIds: next, glossaryId: undefined });
    },
    [selectedPersonalIds, patchState],
  );
  const toggleOrgGlossary = useCallback(
    (id: string) => {
      const next = selectedOrgIds.includes(id)
        ? selectedOrgIds.filter((x) => x !== id)
        : [...selectedOrgIds, id];
      patchState({ glossaryGuideIds: next, glossaryGuideId: undefined });
    },
    [selectedOrgIds, patchState],
  );
  const assessment = state?.assessment;
  const hasUnresolvedEdits =
    assessment?.edits.some((e) => e.status === 'pending') ?? false;

  // In-text preview of the review queue: every pending edit is marked in the
  // translation, the active one opens into a full word diff, and a clicked
  // span pins itself with inline accept/reject.
  const previewEdits = useMemo(
    () => assessment?.edits.filter((e) => e.status === 'pending') ?? [],
    [assessment],
  );
  const pendingIds = useMemo(
    () => previewEdits.map((e) => e.id),
    [previewEdits],
  );
  const preview = useEditPreview(pendingIds);

  const criteriaItems = useMemo(
    () => [
      ...TRANSLATION_QUALITY_CRITERIA.map((c) => ({
        id: c.id as string,
        label: t(`translation.criteria.${c.labelKey}.label`),
        description: t(`translation.criteria.${c.descriptionKey}.description`),
      })),
      ...translationCriteria.map((c) => ({
        id: c.id,
        label: c.name,
        description: c.rubric,
      })),
    ],
    [translationCriteria, t],
  );

  // Admin guides usable in the translation workflow. Terminology guides
  // appear twice by design: as review criteria in the GuidePicker AND as an
  // organization-glossary attachment for generation (the "criterion +
  // generation" model).
  const { guides } = useAvailableGuides();
  const translationGuides = useMemo(
    () => guides.filter((g) => g.workflows.includes('translation')),
    [guides],
  );
  const terminologyGuides = useMemo(
    () => translationGuides.filter((g) => g.kind === 'terminology'),
    [translationGuides],
  );
  const staleOrgIds = useMemo(
    () =>
      selectedOrgIds.filter(
        (id) => !terminologyGuides.some((g) => g.id === id),
      ),
    [selectedOrgIds, terminologyGuides],
  );
  /** Any attached glossary tagged for a different target language. */
  const glossaryLanguageMismatch = useMemo(() => {
    const target = targetLanguage?.id;
    return (
      selectedOrgIds.some(
        (id) =>
          languageFit(
            terminologyGuides.find((g) => g.id === id)?.targetLang,
            target,
          ) === 'other',
      ) ||
      selectedPersonalIds.some(
        (id) =>
          languageFit(
            glossaries.find((g) => g.id === id)?.targetLang,
            target,
          ) === 'other',
      )
    );
  }, [
    selectedOrgIds,
    selectedPersonalIds,
    terminologyGuides,
    glossaries,
    targetLanguage?.id,
  ]);

  /**
   * "Copy to my glossaries": snapshots an organization glossary into the
   * user's own list (entries come from the per-guide detail route, which
   * re-checks access). Admin edits never propagate to the copy — the same
   * semantics as loading a map dataset.
   */
  const copyOrgGlossaryToMine = useCallback(
    async (guide: { id: string; name: string }) => {
      const response = await fetch(
        `/api/guides/${encodeURIComponent(guide.id)}`,
      );
      if (!response.ok) throw new Error(`copy failed (${response.status})`);
      const json = (await response.json()) as {
        data?: {
          guide?: {
            entries?: TranslationGlossary['entries'];
            sourceLang?: string;
            targetLang?: string;
          };
        };
      };
      const loaded = json.data?.guide;
      if (!loaded?.entries) throw new Error('copy failed (no entries)');
      const now = new Date().toISOString();
      addGlossary({
        id: uuidv4(),
        name: t('translation.copiedGlossaryName', { name: guide.name }),
        sourceLang: loaded.sourceLang,
        targetLang: loaded.targetLang,
        entries: loaded.entries,
        copiedFromGuideId: guide.id,
        createdAt: now,
        updatedAt: now,
      });
      toast.success(t('translation.copiedToMine'));
    },
    [addGlossary, t],
  );

  /**
   * Custom ids can't be localized, and a criterion may have been renamed or
   * deleted since the assessment ran — so fall back through the label
   * snapshot, then the live list, then the raw id.
   */
  const resolveCriterionLabel = useCallback(
    (id: string) => {
      if (isGuideCriterionId(id)) {
        return (
          assessment?.labels?.[id] ??
          translationGuides.find((g) => guideCriterionId(g.id) === id)?.name ??
          id
        );
      }
      if (!isCustomCriterionId(id)) {
        return t(`translation.criteria.${id}.label`);
      }
      return (
        assessment?.labels?.[id] ??
        translationCriteria.find((c) => c.id === id)?.name ??
        id
      );
    },
    [assessment?.labels, translationCriteria, translationGuides, t],
  );

  /** Message for an extraction failure, specific where the server was. */
  const extractionErrorMessage = (err: unknown, name: string): string =>
    err instanceof FileTextExtractionError && err.code === 'NO_EXTRACTABLE_TEXT'
      ? t('document.referenceEmpty', { name })
      : err instanceof Error
        ? err.message
        : t('document.uploadFailed');

  /**
   * Makes extracted text the workspace's source: splits it into pages, loads
   * the first batch when it is larger than one, and keeps the file's
   * reference. Shared by plain extraction and OCR.
   *
   * @returns 'loaded', or why nothing was loaded: 'empty' (no text) or
   *   'too-long' (larger than a batch and impossible to page).
   */
  const loadExtractedDocument = (extracted: {
    name: string;
    url: string;
    text: string;
    ocrAvailable: boolean;
    ocrApplied: boolean;
    /** File size in bytes, when known. */
    size?: number;
  }): 'loaded' | 'empty' | 'too-long' => {
    // Splitting also drops the extractor's page markers, which must not
    // reach the translation.
    const pages = splitExtractedPages(extracted.text);
    const allPages = pages.map((page) => page.page);
    const fullText = joinPages(pages, allPages);
    if (!fullText) return 'empty';
    const lastPage = allPages[allPages.length - 1];
    const ocr = {
      ...(extracted.size !== undefined && { size: extracted.size }),
      ...(extracted.ocrAvailable && { ocrAvailable: true }),
      ...(extracted.ocrApplied && { ocrApplied: true }),
    };

    let loadedText = fullText;
    let sourceDocument: TranslationWorkflowState['sourceDocument'];
    if (fullText.length > MAX_SOURCE_CHARS) {
      // Larger than one batch: load the first batch and let the user pick
      // other pages. That needs a server copy to re-read after a reload
      // and more than one page to choose from.
      const firstBatch = selectBatch(pages, MAX_SOURCE_CHARS);
      if (!extracted.url || firstBatch.length === 0) return 'too-long';
      loadedText = joinPages(pages, firstBatch);
      sourceDocument = {
        name: extracted.name,
        url: extracted.url,
        lastPage,
        selectedPages: formatPageSelection(firstBatch),
        ...ocr,
      };
    }

    // A document that fits one batch still keeps its reference when it
    // can be translated whole, which needs the file itself.
    if (
      !sourceDocument &&
      extracted.url &&
      supportsPagedText(fileExtensionOf(extracted.name))
    ) {
      sourceDocument = {
        name: extracted.name,
        url: extracted.url,
        lastPage,
        selectedPages: formatPageSelection(allPages),
        fitsOneBatch: true,
        ...ocr,
      };
    }

    setSourcePages(sourceDocument ? pages : null);
    setSourceAsText(false);
    setSparseTextHint(
      extracted.ocrAvailable &&
        !extracted.ocrApplied &&
        supportsOcr(extracted.name) &&
        looksLikeSparseText(
          pages.map((page) => page.text.length),
          lastPage,
        ),
    );
    setDocumentError(null);
    // A new document replaces the one a whole-document job was run on.
    patchState({
      ...(state ? leaveDocumentReader(state) : {}),
      sourceText: loadedText,
      sourceDocument,
      documentJob: undefined,
    });
    nameWorkflowConversation(conversationId, {
      label: extracted.name,
      sample: loadedText,
      workflow: 'Translation',
    });
    return 'loaded';
  };

  /** Reports why extracted text was not loaded. */
  const reportUnloaded = (outcome: 'empty' | 'too-long', name: string) =>
    setUploadError(
      outcome === 'empty'
        ? t('document.referenceEmpty', { name })
        : t('translation.tooLong', { max: String(MAX_SOURCE_CHARS) }),
    );

  /**
   * Fetches a OneDrive / SharePoint file and loads it as an upload from
   * this device would be.
   */
  const handleDriveUpload = async (entry: M365DriveEntry) => {
    setUploadError(null);
    setOcrOffer(null);
    setUpload({ name: entry.name, size: entry.size, stage: 'uploading' });
    let file: File;
    try {
      const downloaded = await downloadDriveItem(entry.driveId, entry.itemId);
      file = new File([downloaded.blob], downloaded.name || entry.name, {
        type: downloaded.blob.type || entry.mimeType || '',
      });
    } catch (err) {
      setUpload(null);
      setUploadError(`${entry.name}: ${tM365(m365ErrorMessageKey(err))}`);
      return;
    }
    await handleUpload(file);
  };

  /** How the shared picker behaves when it uploads a source document. */
  const uploadHost: AddToChatHost = {
    title: t('translation.uploadPickerTitle'),
    sources: UPLOAD_SOURCES,
    extensions: ACCEPTED_UPLOAD_EXTENSIONS,
    deviceHint: t('translation.uploadPickerHint'),
    confirmLabel: t('translation.uploadPickerConfirm'),
    onDriveItem: (entry) => void handleDriveUpload(entry),
  };

  const handleUpload = async (file: File | null | undefined) => {
    if (!file) return;
    setUploadPickerOpen(false);
    setUploadError(null);
    setOcrOffer(null);
    const abort = new AbortController();
    uploadAbortRef.current = abort;
    setUpload({ name: file.name, size: file.size, stage: 'uploading' });
    /**
     * A stored PDF without text is not a dead end: it can be read with OCR
     * (when the server has it) or translated whole.
     */
    const offerOcr = (url: string | undefined, available: boolean) => {
      if (!url || !supportsPagedText(fileExtensionOf(file.name))) return false;
      uploadedFileRef.current = { url, file };
      setOcrOffer({
        name: file.name,
        url,
        reason: 'no-text',
        canOcr: available && supportsOcr(file.name),
      });
      return true;
    };
    try {
      const extracted = await uploadAndExtractText(file, {
        signal: abort.signal,
        onStage: (stage) =>
          setUpload((current) => (current ? { ...current, stage } : current)),
      });
      const outcome = loadExtractedDocument({
        ...extracted,
        size: file.size,
        ocrApplied: false,
      });
      if (outcome === 'loaded') {
        uploadedFileRef.current = extracted.url
          ? { url: extracted.url, file }
          : null;
      } else if (
        outcome !== 'empty' ||
        !offerOcr(extracted.url, extracted.ocrAvailable)
      ) {
        reportUnloaded(outcome, file.name);
      }
    } catch (err) {
      // A cancelled upload is the user's decision, not a failure to report.
      if (abort.signal.aborted) return;
      const noText =
        err instanceof FileTextExtractionError && err.code === OCR_ERROR.noText;
      if (
        !noText ||
        !offerOcr(err.context.url, err.context.ocrAvailable === true)
      ) {
        setUploadError(extractionErrorMessage(err, file.name));
      }
    } finally {
      setUpload(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  /** Message for a failed OCR attempt, specific where the server was. */
  const ocrErrorMessage = (err: unknown): string => {
    const known = err instanceof FileTextExtractionError ? err : undefined;
    if (known?.context.status === 429) return t('translation.ocrLimitReached');
    switch (known?.code) {
      case OCR_ERROR.tooManyPages:
        return t('translation.ocrTooManyPages', { max: String(MAX_OCR_PAGES) });
      case OCR_ERROR.notConfigured:
        return t('translation.ocrUnavailable');
      case OCR_ERROR.noText:
        return t('translation.ocrNoText');
      default:
        return t('translation.ocrFailed');
    }
  };

  /**
   * Makes the offered file, which has no text, the workspace's document and
   * switches to whole-document mode, where translation reads the pages.
   */
  const handleTranslateScannedWhole = () => {
    const offer = ocrOffer;
    if (!offer || !state) return;
    setOcrOffer(null);
    setSourcePages(null);
    setSparseTextHint(false);
    setUploadError(null);
    setDocumentError(null);
    setEditingTarget(false);
    patchState({
      ...leaveDocumentReader(state),
      mode: 'document',
      sourceText: '',
      sourceDocument: {
        name: offer.name,
        url: offer.url,
        lastPage: 0,
        selectedPages: '',
        fitsOneBatch: true,
        noText: true,
        ...(offer.canOcr && { ocrAvailable: true }),
      },
      documentJob: undefined,
    });
    nameWorkflowConversation(conversationId, {
      label: offer.name,
      sample: offer.name,
      workflow: 'Translation',
    });
  };

  /** Reads the offered file with OCR and loads the result as the source. */
  const handleRunOcr = async () => {
    const offer = ocrOffer;
    if (!offer || uploading) return;
    setUploadError(null);
    const abort = new AbortController();
    uploadAbortRef.current = abort;
    setUpload({ name: offer.name, stage: 'ocr' });
    try {
      const { text } = await ocrUploadedFile(offer.url, abort.signal);
      const outcome = loadExtractedDocument({
        name: offer.name,
        url: offer.url,
        text,
        size: uploadedFileRef.current?.file.size,
        ocrAvailable: true,
        ocrApplied: true,
      });
      if (outcome !== 'loaded') reportUnloaded(outcome, offer.name);
      setOcrOffer(null);
      void refetchLimits();
    } catch (err) {
      // Cancelling leaves the offer open, without an error.
      if (!abort.signal.aborted) {
        setOcrOffer({ ...offer, error: ocrErrorMessage(err) });
      }
    } finally {
      setUpload(null);
    }
  };

  /** Loads a different selection of the large document's pages. */
  const handleSelectSourcePages = (selected: number[]) => {
    if (!state?.sourceDocument || !sourcePages || selected.length === 0) return;
    setUploadError(null);
    patchState({
      sourceText: joinPages(sourcePages, selected),
      sourceDocument: {
        ...state.sourceDocument,
        selectedPages: formatPageSelection(selected),
      },
    });
  };

  /** Re-reads the large document's pages after a reload dropped them. */
  const handleLoadSourcePages = async () => {
    const sourceDocument = state?.sourceDocument;
    if (!sourceDocument || loadingSourcePages) return;
    setUploadError(null);
    setLoadingSourcePages(true);
    try {
      setSourcePages(
        splitExtractedPages(
          await extractTextFromUploadedFile(sourceDocument.url),
        ),
      );
    } catch (err) {
      setUploadError(extractionErrorMessage(err, sourceDocument.name));
    } finally {
      setLoadingSourcePages(false);
    }
  };

  // Runs answer to the user's personal budgets (BudgetRunDialog explains).
  const { guard: guardBudget } = useBudgetGate();

  const handleTranslate = useCallback(async () => {
    if (!state || isRunning || state.mode === 'document') return;
    const text = sourceText.trim();
    if (!text || !targetLanguage) return;
    // A fresh translation replaces the text the suggestions point at:
    // settle the queue first (§6b). Re-issued from the gate once it is.
    if (hasUnresolvedEdits) {
      setReviewGate('translate');
      return;
    }
    clearError(conversationId);

    // Reset the paper trail for this run.
    patchState({
      analysis: undefined,
      rounds: [],
      glossaryCheck: undefined,
      finalText: undefined,
      assessment: undefined,
    });
    setEditingTarget(false);
    setTargetDraft('');

    let analysis: TranslationAnalysis | undefined;
    const rounds: TranslationReviewRound[] = [];
    let finalText = '';

    try {
      await runWorkflowStream({
        conversationId,
        url: '/api/workflows/translation',
        body: {
          sourceText: text,
          targetLanguage: targetLanguage.label,
          mode: state.mode,
          glossaryEntries: activeGlossaryEntries,
          glossaryGuideIds: selectedOrgIds,
          modelId: conversation?.model?.id,
          conversationId,
        },
        // The stream's activity and event markers each leave a line break
        // in the display text, so a draft arrives padded with blank lines
        // before and after. They are not part of the translation.
        onText: (fullText) => setTargetDraft(fullText.trim()),
        onEvent: (event) => {
          if (event.type === 'analysis') {
            analysis = event.data as TranslationAnalysis;
            patchState({ analysis });
          } else if (event.type === 'review_round') {
            const round = event.data as TranslationReviewRound;
            rounds.push(round);
            patchState({ rounds: [...rounds] });
          } else if (event.type === 'revision') {
            const data = event.data as {
              text: string;
              changes?: TranslationRoundChange[];
            };
            setTargetDraft(data.text);
            // Attach the computed changes to their round (the revision
            // event always follows its review_round).
            if (data.changes?.length && rounds.length > 0) {
              rounds[rounds.length - 1] = {
                ...rounds[rounds.length - 1],
                changes: data.changes,
              };
              patchState({ rounds: [...rounds] });
            }
          } else if (event.type === 'glossary_check') {
            patchState({
              glossaryCheck: event.data as TranslationGlossaryCheck,
            });
          } else if (event.type === 'complete') {
            const data = event.data as { finalText: string };
            finalText = data.finalText;
          }
        },
      });

      if (finalText) {
        patchState({ finalText });
        setTargetDraft(null);
        setAnalysisExpanded(false);
        // No label: a pasted-text translation gets named from its own
        // content, but one started from a file keeps the filename.
        nameWorkflowConversation(conversationId, {
          sample: state.sourceText,
          workflow: `Translation into ${targetLanguage.label}`,
        });
        appendWorkflowRailMessages(
          conversationId,
          t('translation.railRequest', { language: targetLanguage.label }),
          state.mode === 'agentic'
            ? t('translation.railDoneAgentic', {
                rounds: String(rounds.length),
              })
            : t('translation.railDoneQuick'),
        );
      }
    } catch {
      // Error lives in the run store; keep whatever partial text streamed.
    }
  }, [
    state,
    isRunning,
    hasUnresolvedEdits,
    sourceText,
    targetLanguage,
    conversationId,
    conversation?.model?.id,
    activeGlossaryEntries,
    selectedOrgIds,
    runWorkflowStream,
    patchState,
    clearError,
    t,
  ]);

  const handleCopy = async () => {
    if (!targetText) return;
    await navigator.clipboard.writeText(targetText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleAssess = useCallback(async () => {
    if (!state || !targetLanguage || assessing || isRunning) return;
    const source = activeSource.trim();
    const translation = state.finalText ?? '';
    if (!source || !translation.trim() || selectedCriteria.size === 0) return;
    // A new assessment replaces the queue outright: settle it first (§6b).
    if (hasUnresolvedEdits) {
      setReviewGate('assess');
      return;
    }

    setAssessError(null);
    setAssessing(true);
    setEditingTarget(false);
    // Only send definitions for criteria actually selected, and drop any
    // with an empty rubric — the server rejects those, and an unfinished
    // criterion shouldn't block the whole assessment.
    const customDefs = translationCriteria
      .filter((c) => selectedCriteria.has(c.id) && c.rubric.trim() !== '')
      .map((c) => ({ id: c.id, name: c.name, rubric: c.rubric }));
    const customIds = new Set(customDefs.map((c) => c.id));
    const criteria = [...selectedCriteria].filter(
      (id) => !isCustomCriterionId(id) || customIds.has(id),
    );
    if (criteria.length === 0) {
      setAssessing(false);
      setAssessError(t('translation.noUsableCriteria'));
      return;
    }

    const abort = new AbortController();
    assessAbortRef.current = abort;
    try {
      const result = await assessTranslation({
        signal: abort.signal,
        sourceText: source,
        translation,
        targetLanguage: targetLanguage.label,
        criteria,
        customCriteria: customDefs,
        glossaryEntries: activeGlossaryEntries,
        glossaryGuideIds: selectedOrgIds,
        modelId: conversation?.model?.id,
        conversationId,
      });
      // Snapshot custom labels so this assessment still reads correctly
      // after the criterion is renamed or deleted.
      const labels: Record<string, string> = {};
      for (const def of customDefs) labels[def.id] = def.name;
      // Guide names snapshot for the same reason (rename/revoke/delete).
      for (const g of translationGuides) {
        const id = guideCriterionId(g.id);
        if (criteria.includes(id)) labels[id] = g.name;
      }
      patchState({
        assessment: {
          id: uuidv4(),
          criteria: result.criteria,
          overallSummary: result.overallSummary,
          // Anchored against the translation as assessed, so each edit keeps
          // pointing at the occurrence the reviewer was shown even once the
          // text around it changes (docs/REVIEW_EDIT_UNFREEZE_DESIGN.md §3).
          edits: stampEditAnchors(
            translation,
            result.edits.map((edit) => ({
              ...edit,
              id: uuidv4(),
              status: 'pending' as const,
            })),
          ),
          createdAt: new Date().toISOString(),
          labels,
        },
      });
      setReviewOpen(true);
      appendWorkflowRailMessages(
        conversationId,
        t('translation.railAssessRequest', {
          language: targetLanguage.label,
        }),
        t('translation.railAssessDone', {
          count: String(result.edits.length),
        }),
      );
    } catch (err) {
      // Stopping an assessment is the user's decision, not a failure.
      if (!abort.signal.aborted) {
        setAssessError(
          err instanceof Error ? err.message : t('document.uploadFailed'),
        );
      }
    } finally {
      setAssessing(false);
    }
  }, [
    state,
    targetLanguage,
    assessing,
    isRunning,
    activeSource,
    selectedCriteria,
    translationCriteria,
    translationGuides,
    hasUnresolvedEdits,
    activeGlossaryEntries,
    selectedOrgIds,
    conversation?.model?.id,
    conversationId,
    patchState,
    t,
  ]);

  /**
   * Accept/reject a single pending edit. Runs through updateWorkflowState
   * directly so the read of finalText and the write are one atomic update.
   */
  const resolveEdit = useCallback(
    (editId: string, decision: 'accepted' | 'rejected') => {
      updateWorkflowState(conversationId, (prev) => {
        const p = prev as TranslationWorkflowState;
        if (!p.assessment) return p;
        const edit = p.assessment.edits.find((e) => e.id === editId);
        if (!edit || edit.status !== 'pending') return p;

        let finalText = p.finalText ?? '';
        let status: TranslationEditStatus = decision;
        if (decision === 'accepted') {
          const outcome = applyEdit(finalText, edit);
          if (outcome.applied) {
            finalText = outcome.text;
          } else {
            status = 'unapplicable';
          }
        }
        const edits = p.assessment.edits.map((e) =>
          e.id === editId
            ? { ...e, status, resolvedAt: new Date().toISOString() }
            : e,
        );
        return {
          ...p,
          finalText,
          assessment: {
            ...p.assessment,
            // Unapplicable edits survive auto-clear: a change that silently
            // failed to land is the one the user most needs to still see.
            edits: autoClearResolvedEdits
              ? withoutResolvedEdits(edits, { keepUnapplicable: true })
              : edits,
          },
          updatedAt: new Date().toISOString(),
        };
      });
    },
    [conversationId, updateWorkflowState, autoClearResolvedEdits],
  );

  /**
   * Puts a resolved edit back in the queue. An accepted edit also has its
   * text change undone by applying the inverse patch; when that patch can
   * no longer be located (a later edit overwrote it, or it was a pure
   * deletion with nothing to search for) the decision stands rather than
   * the text being corrupted on a guess.
   */
  const revertEdit = useCallback(
    (editId: string) => {
      updateWorkflowState(conversationId, (prev) => {
        const p = prev as TranslationWorkflowState;
        if (!p.assessment) return p;
        const edit = p.assessment.edits.find((e) => e.id === editId);
        if (!edit || edit.status === 'pending') return p;

        let finalText = p.finalText ?? '';
        if (edit.status === 'accepted') {
          const inverse = invertPatch(edit);
          if (!inverse) return p;
          const outcome = applyEdit(finalText, inverse);
          if (!outcome.applied) return p;
          finalText = outcome.text;
        }
        return {
          ...p,
          finalText,
          assessment: {
            ...p.assessment,
            edits: p.assessment.edits.map((e) =>
              e.id === editId
                ? { ...e, status: 'pending' as const, resolvedAt: undefined }
                : e,
            ),
          },
          updatedAt: new Date().toISOString(),
        };
      });
    },
    [conversationId, updateWorkflowState],
  );

  /**
   * Typing over a suggested passage (docs/REVIEW_EDIT_UNFREEZE_DESIGN.md §6a).
   * The suggestions move to "not applied": their anchor text no longer
   * exists, and that — not a judgement on them — is the truthful record.
   */
  const dropEdits = useCallback(
    (ids: string[]) => {
      const dropped = new Set(ids);
      updateWorkflowState(conversationId, (prev) => {
        const p = prev as TranslationWorkflowState;
        if (!p.assessment) return p;
        const now = new Date().toISOString();
        const edits = p.assessment.edits.map((e) =>
          dropped.has(e.id) && e.status === 'pending'
            ? { ...e, status: 'unapplicable' as const, resolvedAt: now }
            : e,
        );
        return {
          ...p,
          assessment: {
            ...p.assessment,
            edits: autoClearResolvedEdits
              ? withoutResolvedEdits(edits, { keepUnapplicable: true })
              : edits,
          },
          updatedAt: now,
        };
      });
    },
    [conversationId, updateWorkflowState, autoClearResolvedEdits],
  );

  const notifyDropped = useCallback(
    (ids: string[], previousText: string) => {
      toast(
        (instance) => (
          <div className="flex items-center gap-3">
            <span>
              {ids.length > 1
                ? t('translation.suggestionDroppedMany', {
                    count: String(ids.length),
                  })
                : t('translation.suggestionDroppedOne')}
            </span>
            <button
              type="button"
              onClick={() => {
                // Text first, so the suggestion's passage exists again by the
                // time it is back in the queue. This restores the translation
                // as it was before the change — anything typed since goes
                // with it, the ordinary meaning of Undo.
                patchState({ finalText: previousText });
                ids.forEach(revertEdit);
                toast.dismiss(instance.id);
              }}
              className="text-sm font-semibold text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
            >
              {t('common.undo')}
            </button>
          </div>
        ),
        { duration: 8000 },
      );
    },
    [patchState, revertEdit, t],
  );

  /**
   * The translation textarea's overwrite gate (§5, "warn without showing").
   *
   * A textarea has no transactions to inspect, only its previous and next
   * values — and any one operation differs in exactly one contiguous run, so
   * `changedRange` locates it exactly, and the pending suggestions are
   * located in the previous text the same way the read-only view marks
   * them. First time: the change is held back (not writing it leaves the
   * controlled textarea where it was) and explained; confirming applies the
   * held change, so nothing typed is lost. Thereafter: it lands, the
   * suggestions it overwrote are dropped, and a notice offers undo.
   */
  const handleTargetChange = useCallback(
    (next: string) => {
      const previous = state?.finalText ?? '';
      if (previewEdits.length > 0) {
        const range = changedRange(previous, next);
        if (range) {
          const spans = locateEdits(previous, previewEdits).map((l) => ({
            id: l.id,
            from: l.start,
            to: l.end,
          }));
          const touched = touchedSpanIds(spans, [range]);
          if (touched.length > 0) {
            if (!reviewOverwriteAcknowledged) {
              setOverwritePrompt({ ids: touched, next });
              return;
            }
            dropEdits(touched);
            notifyDropped(touched, previous);
          }
        }
      }
      patchState({ finalText: next });
    },
    [
      state?.finalText,
      previewEdits,
      reviewOverwriteAcknowledged,
      dropEdits,
      notifyDropped,
      patchState,
    ],
  );

  /** Drops the decision record, leaving only edits still awaiting a call. */
  const clearResolved = useCallback(() => {
    updateWorkflowState(conversationId, (prev) => {
      const p = prev as TranslationWorkflowState;
      if (!p.assessment || !hasResolvedEdits(p.assessment.edits)) return p;
      return {
        ...p,
        assessment: {
          ...p.assessment,
          edits: withoutResolvedEdits(p.assessment.edits),
        },
        updatedAt: new Date().toISOString(),
      };
    });
  }, [conversationId, updateWorkflowState]);

  const resolveAll = useCallback(
    (decision: 'accepted' | 'rejected') => {
      updateWorkflowState(conversationId, (prev) => {
        const p = prev as TranslationWorkflowState;
        if (!p.assessment) return p;
        const pending = p.assessment.edits.filter(
          (e) => e.status === 'pending',
        );
        if (pending.length === 0) return p;

        const now = new Date().toISOString();
        if (decision === 'rejected') {
          return {
            ...p,
            assessment: {
              ...p.assessment,
              edits: p.assessment.edits.map((e) =>
                e.status === 'pending'
                  ? { ...e, status: 'rejected' as const, resolvedAt: now }
                  : e,
              ),
            },
            updatedAt: now,
          };
        }

        const result = applyEditsInOrder(p.finalText ?? '', pending);
        const failed = new Set(result.failedIds);
        return {
          ...p,
          finalText: result.text,
          assessment: {
            ...p.assessment,
            edits: p.assessment.edits.map((e) =>
              e.status !== 'pending'
                ? e
                : {
                    ...e,
                    status: failed.has(e.id)
                      ? ('unapplicable' as const)
                      : ('accepted' as const),
                    resolvedAt: now,
                  },
            ),
          },
          updatedAt: now,
        };
      });
    },
    [conversationId, updateWorkflowState],
  );

  /**
   * Carries out a change the user asked for in words: the instruction goes
   * to the server with the text in view and comes back as suggested edits in
   * the review column. Nothing is applied until the user accepts an edit.
   * A message that is a question comes back as a reply with no edits, and
   * leaves the review column as it was.
   */
  const runChangeRequest = useCallback(
    async (request: ChangeRequestInput) => {
      const fromRail = Boolean(request.settle);
      /** Says why nothing happened, where the request was made. */
      const refuse = (message: string) => {
        if (request.settle) request.settle(message);
        else setChangeError(message);
      };
      const translation = state?.finalText ?? '';
      if (
        !state ||
        !targetLanguage ||
        !translation.trim() ||
        (documentMode && !pageInPane)
      ) {
        refuse(t('translation.changeNoTranslation'));
        return;
      }
      if (isRunning || assessing || changeRun) {
        refuse(t('translation.changeBusy'));
        return;
      }
      // New edits replace the queue outright: settle it first (§6b).
      if (hasUnresolvedEdits) {
        heldChangeRef.current = request;
        setReviewGate('request');
        return;
      }

      setChangeError(null);
      setChangeNote(null);
      setEditingTarget(false);
      setChangeRun({ instruction: request.instruction, startedAt: Date.now() });
      const abort = new AbortController();
      changeAbortRef.current = abort;
      const stopFromRail = () => abort.abort();
      request.signal?.addEventListener('abort', stopFromRail);
      if (request.signal?.aborted) abort.abort();

      let reply: string;
      try {
        const result = await requestTranslationChange({
          signal: abort.signal,
          sourceText: activeSource,
          translation,
          targetLanguage: targetLanguage.label,
          instruction: request.instruction,
          selection: request.selection,
          interfaceLocale: locale,
          glossaryEntries: activeGlossaryEntries,
          glossaryGuideIds: selectedOrgIds,
          modelId: conversation?.model?.id,
          conversationId,
        });
        if (result.edits.length === 0) {
          reply = result.reply || t('translation.changeNoEdits');
          if (!fromRail) setChangeNote(reply);
        } else {
          const minted = result.edits.map((edit) => ({
            ...edit,
            criterion: CHANGE_REQUEST_CRITERION,
            severity: 'minor' as const,
            id: uuidv4(),
            status: 'pending' as const,
          }));
          patchState({
            assessment: {
              id: uuidv4(),
              criteria: [],
              overallSummary: result.reply,
              // A selection pins each edit to where the user selected it;
              // otherwise anchor against the translation as sent.
              edits: request.selection
                ? stampSelectionAnchors(translation, request.selection, minted)
                : stampEditAnchors(translation, minted),
              createdAt: new Date().toISOString(),
              request: {
                instruction: request.instruction,
                ...(request.selection && {
                  selectedText: request.selection.text,
                }),
              },
            },
          });
          setReviewOpen(true);
          const pendingLine = t('translation.changeReplyPending', {
            count: result.edits.length,
          });
          reply = result.reply
            ? `${result.reply}\n\n${pendingLine}`
            : pendingLine;
        }
      } catch (err) {
        if (abort.signal.aborted) {
          // Stopping is the user's decision, not a failure.
          reply = t('translation.changeStopped');
        } else {
          reply =
            err instanceof Error ? err.message : t('translation.changeFailed');
          if (!fromRail) setChangeError(reply);
        }
      } finally {
        request.signal?.removeEventListener('abort', stopFromRail);
        setChangeRun(null);
      }
      if (request.settle) request.settle(reply);
      else {
        appendWorkflowRailMessages(conversationId, request.instruction, reply);
      }
    },
    [
      state,
      targetLanguage,
      documentMode,
      pageInPane,
      isRunning,
      assessing,
      changeRun,
      hasUnresolvedEdits,
      activeSource,
      activeGlossaryEntries,
      selectedOrgIds,
      conversation?.model?.id,
      conversationId,
      locale,
      patchState,
      t,
    ],
  );

  /**
   * An AI run asked for while suggestions were still pending
   * (docs/REVIEW_EDIT_UNFREEZE_DESIGN.md §6b). The dialog decides the queue in
   * bulk; the run itself is QUEUED rather than called from the dialog's
   * handler, and fires from the effect below once the store shows no pending
   * edits — by which point this component has re-rendered and the handler's
   * closure holds the post-decision text. Calling the handler straight after
   * `resolveAll` would read the render's stale closure and send the model the
   * pre-decision document, silently discarding what the user just accepted.
   */
  const [reviewGate, setReviewGate] = useState<
    'translate' | 'assess' | 'request' | null
  >(null);
  const [queuedAction, setQueuedAction] = useState<
    'translate' | 'assess' | 'request' | null
  >(null);
  const decidePendingAndRun = useCallback(
    (decision: 'accepted' | 'rejected') => {
      const kind = reviewGate;
      setReviewGate(null);
      if (!kind) return;
      resolveAll(decision);
      setQueuedAction(kind);
    },
    [reviewGate, resolveAll],
  );
  useEffect(() => {
    if (!queuedAction || hasUnresolvedEdits) return;
    setQueuedAction(null);
    if (queuedAction === 'translate') void handleTranslate();
    else if (queuedAction === 'assess') void handleAssess();
    else {
      const held = heldChangeRef.current;
      heldChangeRef.current = null;
      if (held) void runChangeRequest(held);
    }
  }, [
    queuedAction,
    hasUnresolvedEdits,
    handleTranslate,
    handleAssess,
    runChangeRequest,
  ]);

  /** Closes the pending-suggestions dialog without running anything. */
  const cancelReviewGate = useCallback(() => {
    if (reviewGate === 'request') {
      // The rail is waiting for an answer to what the user typed there.
      heldChangeRef.current?.settle?.(t('translation.changeHeld'));
      heldChangeRef.current = null;
    }
    setReviewGate(null);
  }, [reviewGate, t]);

  // An instruction typed in the conversation rail is parked for the
  // workspace, which holds everything the request needs. Taking it removes
  // it, so a repeated effect run cannot act on the same request twice.
  const parkedRailRequest = useWorkflowRailStore(
    (store) => store.workspaceRequests[conversationId],
  );
  const runRailRequest = useEffectEvent((request: ChangeRequestInput) => {
    void runChangeRequest(request);
  });
  useEffect(() => {
    if (!parkedRailRequest) return;
    // The shell mounts the workspace once per layout (side by side and
    // tabbed) and hides one with CSS. Only the copy on screen may act: its
    // progress, its stop button and its dialogs are the ones the user sees.
    const root = rootRef.current;
    if (!root || root.checkVisibility?.() === false) return;
    const taken = useWorkflowRailStore
      .getState()
      .takeWorkspaceRequest(conversationId, parkedRailRequest.id);
    if (!taken) return;
    runRailRequest({
      instruction: taken.text,
      signal: taken.signal,
      settle: taken.settle,
    });
  }, [parkedRailRequest, conversationId]);

  const documentEligibility = wholeDocumentEligibility(
    state?.sourceDocument,
    targetLanguage?.custom ? undefined : targetLanguage?.id,
  );
  const pagesBudget = featureRemaining(TRANSLATION_PAGES_LIMIT_KEY);
  const ocrBudget = featureRemaining(OCR_PAGES_LIMIT_KEY);
  const loadedDocument = state?.sourceDocument;
  /**
   * The loaded document's pages as page sheets, or null when they cannot
   * stand for the source: pages are not in memory, the file has no text, or
   * the text was edited and no longer is those pages. Whole-document mode
   * translates the file itself, so every page shows; the other modes show
   * the pages loaded as source text.
   */
  const sheetPages = useMemo(() => {
    if (!sourcePages || !loadedDocument || loadedDocument.noText) return null;
    const display = stripPageCounters(sourcePages);
    if (state?.mode === 'document') return display;
    const selection = parsePageSelection(
      loadedDocument.selectedPages,
      sourcePages,
    );
    if (!selection.ok) return null;
    if (joinPages(sourcePages, selection.pages) !== sourceText) return null;
    const selected = new Set(selection.pages);
    return display.filter((page) => selected.has(page.page));
  }, [sourcePages, loadedDocument, state?.mode, sourceText]);
  /** The source pane is showing the loaded document, not a busy state. */
  const showDocumentCard =
    !!loadedDocument && !uploading && !readingDocument && ocrOffer === null;
  const showSheets = showDocumentCard && sheetPages !== null && !sourceAsText;
  /** Lets go of the loaded document and the text that came from it. */
  const handleRemoveDocument = () => {
    setSourcePages(null);
    setSparseTextHint(false);
    setUploadError(null);
    patchState({ sourceText: '', sourceDocument: undefined });
  };
  /** OCR can still be asked for on the loaded document. */
  const canOfferOcr =
    !!loadedDocument?.ocrAvailable &&
    !loadedDocument.ocrApplied &&
    supportsOcr(loadedDocument.name);
  const offerOcrForLoaded = (reason: OcrOfferReason) => {
    if (!loadedDocument) return;
    setOcrOffer({
      name: loadedDocument.name,
      url: loadedDocument.url,
      reason,
      canOcr: true,
    });
  };

  /** Sends the uploaded file through whole-document translation. */
  const submitDocument = async () => {
    if (!state || !documentEligibility.ok || submittingDocument) return;
    const { document: source, languageCode } = documentEligibility;
    setDocumentError(null);
    setSubmittingDocument(true);
    try {
      const kept = uploadedFileRef.current;
      const file =
        kept?.url === source.url
          ? kept.file
          : await fetchStoredFile(source.url, source.name);
      const pending = await submitDocumentTranslation(file, languageCode);
      setEditingTarget(false);
      updateWorkflowState(conversationId, (prev) => {
        const p = prev as TranslationWorkflowState;
        return {
          ...p,
          // The pane goes back to the text modes first, so the new job's
          // first page sets aside their result, not the old job's page.
          ...leaveDocumentReader(p),
          documentJob: {
            jobId: pending.jobId,
            status: 'translating',
            submittedAt: pending.submittedAt,
            sourceName: pending.originalFilename,
            translatedFilename: pending.translatedFilename,
            fileExtension: pending.fileExtension,
            targetLanguage: pending.targetLanguage,
            page: 1,
          },
          updatedAt: new Date().toISOString(),
        };
      });
      void refetchLimits();
    } catch (error) {
      const known = error instanceof DocumentJobError ? error : undefined;
      setDocumentError(
        known?.status === 429
          ? t('translation.documentLimitReached')
          : known?.code === 'SERVICE_NOT_CONFIGURED'
            ? t('translation.documentUnavailable')
            : t('translation.documentSubmitFailed', {
                message: error instanceof Error ? error.message : String(error),
              }),
      );
    } finally {
      setSubmittingDocument(false);
    }
  };
  /** A finished job is only replaced on purpose: it charges pages again. */
  const handleTranslateDocument = () => {
    if (documentJob?.status === 'ready') setConfirmRetranslate(true);
    else void submitDocument();
  };

  const goToDocumentPage = (page: number) => {
    setEditingTarget(false);
    patchDocumentJob({ page });
  };
  const changeMode = (mode: TranslationMode) => {
    if (!state || mode === state.mode) return;
    setEditingTarget(false);
    patchState({
      mode,
      // Text and Document each keep their own Quick / Reviewed choice.
      ...(mode === 'document' && state.mode !== 'document'
        ? { textMode: state.mode }
        : {}),
      ...(mode !== 'document' ? leaveDocumentReader(state) : {}),
    });
  };
  const leavePage = (destination: PageDeparture) => {
    if ('page' in destination) goToDocumentPage(destination.page);
    else changeMode(destination.mode);
  };
  /**
   * Suggestions belong to the page they were made for and do not follow the
   * reader off it, so with any still pending the user decides them first.
   */
  const requestLeavePage = (destination: PageDeparture) => {
    if (pageInPane && hasUnresolvedEdits) setDepartureGate(destination);
    else leavePage(destination);
  };
  const decidePendingAndLeave = (decision: 'accepted' | 'rejected') => {
    const destination = departureGate;
    setDepartureGate(null);
    if (!destination) return;
    resolveAll(decision);
    // Leave on a later render, once the decided text is in state, so an
    // accepted suggestion is saved as the page's correction (see queuedAction).
    setQueuedDeparture(destination);
  };
  const leavePageEvent = useEffectEvent(leavePage);
  useEffect(() => {
    if (!queuedDeparture || hasUnresolvedEdits) return;
    setQueuedDeparture(null);
    leavePageEvent(queuedDeparture);
  }, [queuedDeparture, hasUnresolvedEdits]);

  // --- Document mode, formatting-preserving layout -------------------------
  const savedStepInstructions = useSettingsStore(
    (s) => s.formattedStepInstructions,
  );
  const setSavedStepInstructions = useSettingsStore(
    (s) => s.setFormattedStepInstructions,
  );
  const [rememberInstructions, setRememberInstructions] = useState(true);
  const [formattedSetupOpen, setFormattedSetupOpen] = useState(false);
  const formattedSource = state?.sourceDocument;
  const formattedSourceUrl = formattedSource?.url;
  const formattedSourceName = formattedSource?.name ?? '';
  const formattedCheck = formattedEligibility(
    formattedSource,
    targetLanguage?.label,
  );
  // A run belongs to the document it was made from; another document
  // starts at the setup.
  const formattedRunRef =
    state?.formattedRunRef &&
    state.formattedRunRef.sourceUrl === formattedSourceUrl
      ? state.formattedRunRef
      : undefined;
  const formattedRunRefNow = useRef(formattedRunRef);
  useEffect(() => {
    formattedRunRefNow.current = formattedRunRef;
  });
  const loadFormattedFile = useCallback(async (): Promise<File> => {
    if (!formattedSourceUrl) throw new Error('No document is loaded');
    const kept = uploadedFileRef.current;
    if (kept?.url === formattedSourceUrl) return kept.file;
    // A run keeps its own copy of the document, which outlives the upload.
    const stored = formattedRunRefNow.current;
    if (stored) {
      try {
        const bytes = await fetchRunFile(runFileUrl(stored, stored.sourceId));
        return new File([new Uint8Array(bytes)], formattedSourceName, {
          type: 'application/pdf',
        });
      } catch {
        // Fall through to the upload.
      }
    }
    return fetchStoredFile(formattedSourceUrl, formattedSourceName);
  }, [formattedSourceUrl, formattedSourceName]);
  /** The setup and review screens need a PDF to show; a blocker hides them. */
  const formattedHasPdf =
    formattedMode &&
    !!formattedSourceUrl &&
    !uploading &&
    (formattedCheck.ok || formattedCheck.reason === 'no-language');
  const pdfPages = usePdfPages(
    loadFormattedFile,
    formattedHasPdf ? (formattedSourceUrl ?? null) : null,
    // A stored run opens on its translated pages: the source is needed only
    // to look at the original or at untranslated pages, so it loads then.
    // The setup shows the source's pages at once.
    { onDemand: !!formattedRunRef && !formattedSetupOpen },
  );
  // Workflow state holds where the run is stored; the run itself is read
  // from there and saved back (see useFormattedRunStorage).
  const setFormattedRunRef = useCallback(
    (ref: NativeRunRef | undefined) => patchState({ formattedRunRef: ref }),
    [patchState],
  );
  const formattedStorage = useFormattedRunStorage({
    runRef: formattedRunRef,
    setRunRef: setFormattedRunRef,
  });
  const storeFormattedRun = formattedStorage.setRun;
  const setFormattedRun = useCallback(
    (run: FormattedDocumentRun, access: RunAccess) => {
      storeFormattedRun(run, access);
      setFormattedSetupOpen(false);
    },
    [storeFormattedRun],
  );
  const updateFormattedRun = formattedStorage.updateRun;
  /** OneDrive when the person uses Microsoft 365 files, else app storage. */
  const formattedBackend: NativeRunBackend =
    m365FilesFlag && m365Connected ? 'onedrive' : 'app';
  // A large source text is kept in the same place, not in the browser.
  const sourceStorage = useStoredSourceText({
    conversationId,
    state,
    backend: formattedBackend,
  });
  const formatted = useFormattedDocument({
    conversationId,
    run: formattedStorage.run,
    access: formattedRunRef,
    setRun: setFormattedRun,
    updateRun: updateFormattedRun,
    glossaries: {
      glossaryEntries: activeGlossaryEntries,
      glossaryGuideIds: selectedOrgIds,
    },
    modelId: conversation?.model?.id,
    onSpent: refetchLimits,
  });
  const formattedOptions: FormattedDocumentOptions =
    state?.formattedOptions ?? {
      ...DEFAULT_FORMATTED_OPTIONS,
      instructions: savedStepInstructions,
    };
  const formattedDepth = state?.documentDepth ?? NATIVE_PDF_DEFAULT_DEPTH;
  const formattedPageCount =
    pdfPages.pageCount || formattedSource?.lastPage || 0;
  const formattedRun = formattedStorage.run;
  /** A stored run that is still loading, or cannot be shown. */
  const formattedRunPending = !!formattedRunRef && !formattedRun;
  // --- Batches (see formattedDocument.ts) ---
  // The next batch is added to the pages already translated, unless the
  // person starts over or the target language has changed since.
  const [formattedAddingChoice, setFormattedAddingChoice] = useState(true);
  const formattedLimits =
    formattedService?.limits ?? FALLBACK_NATIVE_PDF_LIMITS;
  const formattedDonePages = translatedPages(formattedRun);
  const formattedEarlier: EarlierTranslation | undefined = formattedRun && {
    pages: formattedDonePages.length,
    language: formattedRun.targetLanguage,
    sameLanguage:
      !targetLanguage || formattedRun.targetLanguage === targetLanguage.label,
  };
  const formattedAdding =
    !!formattedEarlier?.sameLanguage && formattedAddingChoice;
  const formattedPlan = planBatch({
    spec: formattedOptions.pages,
    pageCount: formattedPageCount,
    translated: formattedAdding ? formattedDonePages : [],
    removed: formattedAdding ? removedPages(formattedRun) : [],
    batchPages: formattedOptions.batchPages,
    limits: formattedLimits,
  });
  const formattedSelectedCount = formattedPlan.pages.length;
  /** More pages can still be added to the translated ones. */
  const formattedCanAdd =
    !!formattedEarlier?.sameLanguage &&
    formattedDonePages.length <
      Math.min(formattedPageCount, formattedLimits.maxDocumentPages);
  const showFormattedReview =
    !!formattedRun && !formattedSetupOpen && !formatted.running;
  /** Ready to run but for a target language (see askForLanguage). */
  const formattedReady =
    formattedMode &&
    (formattedCheck.ok || formattedCheck.reason === 'no-language') &&
    formattedSelectedCount > 0 &&
    !formatted.running &&
    !uploading;
  const startFormatted = () => {
    if (!formattedReady || !formattedSourceUrl || !targetLanguage) return;
    if (rememberInstructions) {
      setSavedStepInstructions(formattedOptions.instructions);
    }
    void formatted
      .start({
        loadFile: loadFormattedFile,
        sourceUrl: formattedSourceUrl,
        sourceName: formattedSourceName,
        targetLanguage: targetLanguage.label,
        options: formattedOptions,
        depth: formattedDepth,
        pages: formattedPlan.pages,
        requestPages: formattedService?.maxPages,
        base: formattedAdding ? formattedRun : undefined,
        backend: formattedBackend,
      })
      .then(() => {
        // The typed selection named this batch's pages; the next batch
        // starts from the pages still left.
        patchState({ formattedOptions: { ...formattedOptions, pages: '' } });
        setFormattedAddingChoice(true);
      });
  };
  /**
   * Translates pages ticked in the finished translation's page list and
   * adds them to it, with the run's own depth and the current instructions.
   */
  const addFormattedPages = (pages: number[]) => {
    if (
      !formattedRun ||
      !formattedSourceUrl ||
      !targetLanguage ||
      pages.length === 0 ||
      formatted.running
    ) {
      return;
    }
    void formatted.start({
      loadFile: loadFormattedFile,
      sourceUrl: formattedSourceUrl,
      sourceName: formattedSourceName,
      targetLanguage: targetLanguage.label,
      options: formattedOptions,
      depth: formattedRun.depth,
      pages,
      requestPages: formattedService?.maxPages,
      base: formattedRun,
      backend: formattedBackend,
    });
  };
  /** Opens the setup to add pages, or to start over when none can be added. */
  const openFormattedSetup = () => {
    setFormattedAddingChoice(formattedCanAdd);
    setFormattedSetupOpen(true);
  };
  const changeDocumentLayout = (layout: TranslationDocumentLayout) => {
    if (!state) return;
    setEditingTarget(false);
    patchState({
      documentLayout: layout,
      // The text reader gives the pane back before the layout changes.
      ...(layout === 'formatted' ? leaveDocumentReader(state) : {}),
    });
  };

  if (!state) return null;

  /** Ready to translate but for a target language (see askForLanguage). */
  const textReady =
    !isRunning && !uploading && !assessing && sourceText.trim().length > 0;
  const canAssess =
    !isRunning &&
    !uploading &&
    !assessing &&
    !changeRun &&
    !!targetLanguage &&
    activeSource.trim().length > 0 &&
    (state.finalText ?? '').trim().length > 0 &&
    selectedCriteria.size > 0 &&
    // In the reader, only a page that is actually in the pane is assessed.
    (!documentMode || pageInPane);
  const tooLong = !anyDocumentMode && sourceText.length > MAX_SOURCE_CHARS;
  const canTranslateDocument =
    // `no-language` also covers a custom language, which is chosen but not
    // usable here; only a missing one is asked for (see askForLanguage).
    (documentEligibility.ok ||
      (documentEligibility.reason === 'no-language' && !targetLanguage)) &&
    !submittingDocument &&
    !documentInProgress &&
    !uploading &&
    !assessing;
  const documentBlockerKey: Record<string, string> = {
    'no-document': 'translation.documentNeedsFile',
    'unsupported-format': 'translation.documentNeedsPdf',
    'no-language': 'translation.documentNeedsLanguage',
    'unsupported-language': 'translation.documentLanguageUnsupported',
  };
  // Glossaries the user has attached, which this mode cannot apply.
  const ignoredGlossaryCount =
    selectedOrgIds.length + selectedPersonalIds.length;
  // As for the formatted layout: a missing language is said beside the
  // language control. A custom language is chosen but unusable, which only
  // this line explains.
  const documentBlocker =
    documentEligibility.ok ||
    (documentEligibility.reason === 'no-language' && !targetLanguage)
      ? null
      : t(documentBlockerKey[documentEligibility.reason]);

  const textMode = state.mode === 'document' ? 'quick' : state.mode;

  // --- What is being translated, and how thoroughly ---
  const kind: TranslationKind = anyDocumentMode ? 'document' : 'text';
  /** The text depth Document returns to; a new conversation's is its default. */
  const rememberedTextMode: TranslationTextMode = anyDocumentMode
    ? (state.textMode ?? 'agentic')
    : textMode;
  const changeKind = (next: TranslationKind) => {
    if (next === kind) return;
    requestLeavePage({
      mode: next === 'document' ? 'document' : rememberedTextMode,
    });
  };
  // A PDF loaded into Text is translated as extracted text; Document keeps
  // its pages. The offer is made once per document.
  const pdfLoadedAsText =
    !anyDocumentMode &&
    !!state.sourceDocument?.url &&
    state.sourceDocument.name.toLowerCase().endsWith('.pdf');

  // --- Target language: the one choice every translation waits for ---
  // Nothing else on the screen says why Translate does nothing, so the
  // language control itself is marked while it is the only thing missing,
  // and Translate, instead of being dead, opens it.
  const languageMissing =
    !targetLanguage &&
    (formattedMode
      ? formattedReady
      : documentMode
        ? canTranslateDocument
        : textReady && !tooLong);
  const askForLanguage = () => {
    setLanguageAsked(true);
    setLangPickerOpen(true);
  };
  const runStage = deriveRunStage(run?.activityKey, textMode);
  // A Reviewed run's text is a draft until the last review round is done.
  const isDraft = isRunning && state.mode === 'agentic' && targetText !== '';
  const paperTrailHidden =
    !anyDocumentMode && analysisHidden && hasPaperTrail(state);
  const formattedBlockerKey: Record<string, string> = {
    'no-document': 'translation.formatted.needsFile',
    'not-pdf': 'translation.formatted.needsPdf',
    'no-language': 'translation.documentNeedsLanguage',
  };
  // A missing language is said beside the language control itself (see
  // `languageMissing`), not a second time here.
  const formattedBlocker =
    formattedCheck.ok || formattedCheck.reason === 'no-language'
      ? null
      : t(formattedBlockerKey[formattedCheck.reason]);
  const showAnalysis = () => {
    setAnalysisHidden(false);
    setAnalysisExpanded(true);
  };
  const reviewVerdict = lastReviewVerdict(state.rounds);

  return (
    <div ref={setRoot} className="flex h-full min-h-0 flex-col">
      {/* Controls bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <button
          ref={langButtonRef}
          type="button"
          onClick={() => setLangPickerOpen((open) => !open)}
          disabled={isRunning}
          data-needs-language={languageMissing || undefined}
          aria-describedby={languageMissing ? languageHintId : undefined}
          className={`inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm disabled:opacity-50 ${
            languageMissing
              ? `border-amber-500 bg-amber-50 font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-400 dark:bg-amber-900/20 dark:text-amber-200 dark:hover:bg-amber-900/30 ${
                  languageAsked
                    ? 'ring-2 ring-amber-500 ring-offset-1 dark:ring-amber-400 dark:ring-offset-surface-dark'
                    : ''
                }`
              : 'border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-surface-dark-elevated'
          }`}
        >
          <IconLanguage size={15} aria-hidden />
          {targetLanguage?.label ?? t('translation.chooseLanguage')}
        </button>
        {languageMissing && (
          <span
            id={languageHintId}
            role={languageAsked ? 'alert' : undefined}
            className={`text-xs text-amber-700 dark:text-amber-400 ${
              languageAsked ? 'font-medium' : ''
            }`}
          >
            {t('translation.languageNeeded')}
          </span>
        )}
        <LanguagePicker
          triggerRef={langButtonRef}
          isOpen={langPickerOpen}
          onClose={() => setLangPickerOpen(false)}
          options={languageOptions}
          value={targetLanguage?.id ?? null}
          onSelect={(code) => {
            if (code) selectTargetById(code);
            setLangPickerOpen(false);
          }}
          onCreateOption={handleCreateLanguage}
          disabled={isRunning}
        />

        {/* One attachment control for organization + personal glossaries;
            the popover sorts by fit with the current target language. */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setGlossaryPickerOpen((open) => !open)}
            aria-expanded={glossaryPickerOpen}
            aria-haspopup="dialog"
            // Whole-document translation does not take glossaries.
            disabled={isRunning || documentMode}
            title={
              documentMode ? t('translation.documentNoGlossaries') : undefined
            }
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-700 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300"
          >
            <IconBook2 size={15} aria-hidden />
            {t('translation.glossariesButton', {
              count: String(selectedOrgIds.length + selectedPersonalIds.length),
            })}
            {glossaryLanguageMismatch && (
              <span
                className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
                title={t('translation.glossaryLanguageMismatch')}
              >
                {t('translation.glossaryMismatchChip')}
              </span>
            )}
          </button>
          {glossaryPickerOpen && (
            <GlossaryPicker
              orgGlossaries={terminologyGuides}
              personalGlossaries={glossaries}
              selectedOrgIds={selectedOrgIds}
              selectedPersonalIds={selectedPersonalIds}
              staleOrgIds={staleOrgIds}
              stalePersonalIds={stalePersonalIds}
              targetLangId={targetLanguage?.id}
              onToggleOrg={toggleOrgGlossary}
              onTogglePersonal={togglePersonalGlossary}
              onCopyToMine={copyOrgGlossaryToMine}
              onManage={() => {
                setGlossaryPickerOpen(false);
                setGlossariesOpen(true);
                setCriteriaOpen(false);
              }}
              onClose={() => setGlossaryPickerOpen(false)}
              disabled={isRunning}
            />
          )}
        </div>

        <button
          type="button"
          onClick={() => {
            setGlossariesOpen((open) => !open);
            setCriteriaOpen(false);
          }}
          aria-pressed={glossariesOpen}
          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconBook2 size={15} aria-hidden />
          {t('translation.manageGlossaries')}
        </button>

        {/* Two managers share the bottom slot, so opening one closes the
            other rather than stacking two 72-tall panes. */}
        <button
          type="button"
          onClick={() => {
            setCriteriaOpen((open) => !open);
            setGlossariesOpen(false);
          }}
          aria-pressed={criteriaOpen}
          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconAdjustments size={15} aria-hidden />
          {translationCriteria.length > 0
            ? t('translation.manageCriteria')
            : t('translation.addCriteria')}
        </button>

        {/* Text or Document; Quick / Reviewed sit in the row beneath. */}
        <div
          role="radiogroup"
          aria-label={t('translation.kind')}
          className="ms-auto flex rounded-lg bg-gray-100 p-0.5 dark:bg-surface-dark-elevated"
        >
          {TRANSLATION_KINDS.map((option) => (
            <button
              key={option}
              role="radio"
              aria-checked={kind === option}
              onClick={() => changeKind(option)}
              disabled={isRunning || assessing || formatted.running}
              title={
                option === 'text'
                  ? t('translation.kindTextHint')
                  : t('translation.modeDocumentHint')
              }
              className={`rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
                kind === option
                  ? 'bg-white text-gray-900 dark:bg-surface-dark dark:text-gray-100'
                  : 'text-gray-600 dark:text-gray-400'
              }`}
            >
              {option === 'text'
                ? t('translation.kindText')
                : t('translation.modeDocument')}
            </button>
          ))}
        </div>

        {/* What this run will cost, while quick/agentic is still a choice. */}
        {documentMode && pagesBudget && (
          <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">
            {t('translation.documentPagesLeft', {
              count: pagesBudget.remaining,
            })}
          </span>
        )}
        {!isRunning && !anyDocumentMode && (
          <RunEstimateHint
            model={conversation?.model}
            sourceText={state.sourceText}
            // Quick is one pass. Agentic adds the analysis pass and up to
            // MAX_REVIEW_ROUNDS reviews, each re-reading source + draft —
            // an upper bound, since the loop stops early on approval.
            passes={
              state.mode === 'agentic' ? AGENTIC_TRANSLATION_MAX_PASSES : 1
            }
            atMost={state.mode === 'agentic'}
          />
        )}

        {isRunning && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {runStage === 'reviewing' &&
              run?.activityParams?.round &&
              run.activityParams.total && (
                <>
                  {t('translation.runRound', {
                    round: run.activityParams.round,
                    total: run.activityParams.total,
                  })}
                  {' · '}
                </>
              )}
            <ElapsedTime />
          </span>
        )}

        {formattedMode ? (
          formatted.running ? (
            <button
              type="button"
              onClick={formatted.stop}
              className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg border border-gray-400 px-3 py-1.5 text-sm font-medium text-gray-900 hover:bg-gray-100 dark:border-gray-500 dark:text-white dark:hover:bg-surface-dark-elevated"
            >
              <IconPlayerStopFilled size={14} aria-hidden />
              {t('translation.stop')}
            </button>
          ) : showFormattedReview ? (
            <button
              type="button"
              onClick={openFormattedSetup}
              className={
                formattedCanAdd
                  ? 'min-h-[36px] rounded-lg bg-gray-300 px-3 py-1.5 text-sm font-medium text-gray-900 hover:bg-gray-400 dark:bg-surface-dark-base dark:text-white dark:hover:bg-surface-dark-elevated'
                  : 'min-h-[36px] rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-surface-dark-elevated'
              }
            >
              {formattedCanAdd
                ? t('translation.formatted.addPages')
                : t('translation.formatted.translateAgain')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() =>
                targetLanguage
                  ? guardBudget(startFormatted, 'run')
                  : askForLanguage()
              }
              disabled={!formattedReady}
              className="min-h-[36px] rounded-lg bg-gray-300 px-3 py-1.5 text-sm font-medium text-gray-900 hover:bg-gray-400 disabled:pointer-events-none disabled:opacity-30 dark:bg-surface-dark-base dark:text-white dark:hover:bg-surface-dark-elevated"
            >
              {t('translation.formatted.translatePages', {
                count: formattedSelectedCount,
              })}
            </button>
          )
        ) : isRunning ? (
          <button
            type="button"
            onClick={() => cancelRun(conversationId)}
            aria-label={t('shell.stopGenerating')}
            className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg border border-gray-400 px-3 py-1.5 text-sm font-medium text-gray-900 hover:bg-gray-100 dark:border-gray-500 dark:text-white dark:hover:bg-surface-dark-elevated"
          >
            <IconPlayerStopFilled size={14} aria-hidden />
            {t('translation.stop')}
          </button>
        ) : documentMode ? (
          <button
            type="button"
            onClick={() =>
              targetLanguage
                ? guardBudget(handleTranslateDocument, 'run')
                : askForLanguage()
            }
            disabled={!canTranslateDocument}
            className="min-h-[36px] rounded-lg bg-gray-300 px-3 py-1.5 text-sm font-medium text-gray-900 hover:bg-gray-400 disabled:pointer-events-none disabled:opacity-30 dark:bg-surface-dark-base dark:text-white dark:hover:bg-surface-dark-elevated"
          >
            {submittingDocument
              ? t('translation.documentSubmitting')
              : t('translation.translateDocument')}
          </button>
        ) : (
          <button
            type="button"
            onClick={() =>
              targetLanguage
                ? guardBudget(() => void handleTranslate(), 'run')
                : askForLanguage()
            }
            disabled={!textReady || tooLong}
            className="min-h-[36px] rounded-lg bg-gray-300 px-3 py-1.5 text-sm font-medium text-gray-900 hover:bg-gray-400 disabled:pointer-events-none disabled:opacity-30 dark:bg-surface-dark-base dark:text-white dark:hover:bg-surface-dark-elevated"
          >
            {t('translation.translate')}
          </button>
        )}
      </div>

      <TranslationOptionsBar
        kind={kind}
        layout={
          formattedService?.enabled
            ? (state.documentLayout ?? DEFAULT_DOCUMENT_LAYOUT)
            : undefined
        }
        depth={
          formattedMode
            ? formattedDepth
            : documentMode
              ? undefined
              : textMode === 'agentic'
                ? 'reviewed'
                : 'quick'
        }
        disabled={
          isRunning ||
          assessing ||
          submittingDocument ||
          formatted.running ||
          formatted.rendering ||
          (pageInPane && hasUnresolvedEdits)
        }
        onLayoutChange={changeDocumentLayout}
        onDepthChange={(depth) =>
          anyDocumentMode
            ? patchState({ documentDepth: depth })
            : changeMode(depth === 'reviewed' ? 'agentic' : 'quick')
        }
      />

      {pdfLoadedAsText &&
        state.sourceDocument?.url !== dismissedDocumentOffer &&
        !isRunning && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-gray-200 px-3 py-2 text-xs dark:border-gray-700">
            <span className="text-gray-700 dark:text-gray-300">
              {t('translation.pdfAsTextOffer', {
                name: state.sourceDocument?.name ?? '',
              })}
            </span>
            <button
              type="button"
              onClick={() => changeKind('document')}
              className="rounded-lg border border-gray-300 px-2 py-0.5 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
            >
              {t('translation.pdfAsTextSwitch')}
            </button>
            <button
              type="button"
              onClick={() =>
                setDismissedDocumentOffer(state.sourceDocument?.url ?? null)
              }
              className="text-gray-500 hover:underline dark:text-gray-400"
            >
              {t('translation.pdfAsTextKeep')}
            </button>
          </div>
        )}

      {formattedMode && (formattedBlocker || formatted.runError) && (
        <div className="border-b border-gray-200 px-3 py-2 dark:border-gray-700">
          {formattedBlocker && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              {formattedBlocker}
            </p>
          )}
          {formatted.runError && (
            <p className="text-sm text-red-700 dark:text-red-400" role="alert">
              {t('translation.formatted.runFailed', {
                message: formatted.runError,
              })}
            </p>
          )}
        </div>
      )}

      {/* Status / errors */}
      {(run?.error ||
        tooLong ||
        uploadError ||
        targetLanguage?.custom ||
        (documentMode &&
          (documentError ||
            ignoredGlossaryCount > 0 ||
            (documentBlocker && !documentJob)))) && (
        <div className="border-b border-gray-200 px-3 py-2 dark:border-gray-700">
          {targetLanguage?.custom && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {t('translation.customLanguageHint', {
                name: targetLanguage.label,
              })}
            </p>
          )}
          {run?.error && (
            <p className="text-sm text-red-700 dark:text-red-400" role="alert">
              {t('document.runFailed', { message: run.error })}
            </p>
          )}
          {tooLong && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              {t('translation.tooLong', {
                max: String(MAX_SOURCE_CHARS),
              })}
            </p>
          )}
          {uploadError && (
            <p className="text-sm text-red-700 dark:text-red-400" role="alert">
              {uploadError}
            </p>
          )}
          {documentMode && ignoredGlossaryCount > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {t('translation.documentGlossariesIgnored', {
                count: ignoredGlossaryCount,
              })}
            </p>
          )}
          {documentMode && documentBlocker && !documentJob && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              {documentBlocker}
            </p>
          )}
          {documentMode && documentError && (
            <p className="text-sm text-red-700 dark:text-red-400" role="alert">
              {documentError}
            </p>
          )}
        </div>
      )}

      {readingDocument && documentJob && (
        <DocumentReaderBar
          key={`${documentJob.jobId}:${documentJob.page}`}
          job={documentJob}
          correctedPages={reader.correctedPages}
          saveState={reader.saveState}
          disabled={assessing}
          onGoToPage={(page) => requestLeavePage({ page })}
        />
      )}
      {readingDocument && !reader.pagesAligned && (
        <p className="border-b border-gray-200 px-3 py-1.5 text-xs text-amber-700 dark:border-gray-700 dark:text-amber-400">
          {t('translation.documentPagesNotAligned')}
        </p>
      )}

      {sparseTextHint && canOfferOcr && !ocrOffer && !uploading && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-gray-200 px-3 py-2 text-xs dark:border-gray-700">
          <span className="text-amber-700 dark:text-amber-400">
            {t('translation.ocrSparseHint')}
          </span>
          <button
            type="button"
            onClick={() => offerOcrForLoaded('sparse')}
            className="rounded-lg border border-gray-300 px-2 py-0.5 text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
          >
            {t('translation.ocrButton')}
          </button>
          <button
            type="button"
            onClick={() => setSparseTextHint(false)}
            className="rounded-lg px-2 py-0.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
          >
            {t('translation.ocrDismiss')}
          </button>
        </div>
      )}

      {state?.sourceDocument &&
        !state.sourceDocument.fitsOneBatch &&
        !anyDocumentMode && (
          <SourcePageSelector
            key={`${state.sourceDocument.url}:${state.sourceDocument.selectedPages}`}
            document={state.sourceDocument}
            pages={sourcePages}
            maxChars={MAX_SOURCE_CHARS}
            loading={loadingSourcePages}
            disabled={isRunning || uploading || assessing}
            onSelect={handleSelectSourcePages}
            onLoadPages={() => void handleLoadSourcePages()}
          />
        )}

      {formattedHasPdf &&
        (formatted.progress ? (
          <FormattedProgress
            progress={formatted.progress}
            language={targetLanguage?.label ?? ''}
          />
        ) : showFormattedReview && formattedRun ? (
          <FormattedReview
            run={formattedRun}
            pageCount={formattedPageCount}
            batch={
              formattedEarlier?.sameLanguage && targetLanguage
                ? {
                    limits: formattedLimits,
                    batchPages: formattedOptions.batchPages,
                    onTranslate: addFormattedPages,
                  }
                : undefined
            }
            batchBlocked={
              formattedEarlier && !formattedEarlier.sameLanguage
                ? t('translation.formatted.railOtherLanguage', {
                    language: formattedRun.targetLanguage,
                  })
                : undefined
            }
            controller={formatted}
            pdf={pdfPages}
            instructions={formattedOptions.instructions}
            glossaryCount={selectedOrgIds.length + selectedPersonalIds.length}
            stacked={!layout.reviewBeside}
            storage={
              formattedRunRef && {
                runRef: formattedRunRef,
                saveFailed: formattedStorage.saveFailed,
                keeping: formattedStorage.keeping,
                onKeep: () => void formattedStorage.keep(),
              }
            }
            onUpdateRun={updateFormattedRun}
            onChangeOptions={openFormattedSetup}
          />
        ) : formattedRunPending && !formattedSetupOpen ? (
          <FormattedRunUnavailable
            problem={formattedStorage.problem}
            onRetry={formattedStorage.retry}
            onStartOver={() =>
              // Expired files are gone already; anything left is deleted.
              // A run this device cannot read is left for one that can.
              formattedStorage.discard(formattedStorage.problem === 'missing')
            }
          />
        ) : (
          <FormattedSetup
            documentName={formattedSourceName}
            pageCount={formattedPageCount}
            pdf={pdfPages}
            options={formattedOptions}
            depth={formattedDepth}
            plan={formattedPlan}
            requestPages={formattedService?.maxPages}
            targetLanguage={targetLanguage?.label}
            earlier={formattedEarlier}
            adding={formattedAdding}
            onAddingChange={setFormattedAddingChoice}
            maxRefitRounds={formattedService?.maxRefitRounds ?? 0}
            remember={rememberInstructions}
            canGoBack={!!formattedRun}
            onOptionsChange={(options) =>
              patchState({ formattedOptions: options })
            }
            onRememberChange={setRememberInstructions}
            onBack={() => setFormattedSetupOpen(false)}
            onRemove={handleRemoveDocument}
          />
        ))}

      {/* Workbench: panes (+ assess controls) with the review column beside.
          Hidden, not unmounted, while the formatted layout shows its own
          screens: it holds the source pane, where a document is uploaded. */}
      <div
        className={`min-h-0 flex-1 ${formattedHasPdf ? 'hidden' : 'flex'} ${
          // Without room for the review beside the panes, the parts stack
          // and the workbench scrolls instead of squeezing each one flat.
          layout.reviewBeside ? 'flex-row' : 'flex-col overflow-y-auto'
        }`}
      >
        <div
          className={`flex min-w-0 flex-1 flex-col ${
            layout.reviewBeside ? 'min-h-0' : 'shrink-0'
          }`}
        >
          {/* Panes */}
          <div
            className={`flex flex-1 ${
              layout.reviewBeside
                ? 'min-h-0 flex-row'
                : layout.panesSideBySide
                  ? `${PANE_MIN_HEIGHT} flex-row`
                  : 'flex-col'
            }`}
          >
            <div
              className={`flex min-w-0 flex-1 flex-col border-gray-200 dark:border-gray-700 ${
                layout.panesSideBySide
                  ? 'min-h-0 border-e'
                  : `${PANE_MIN_HEIGHT} border-b`
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-3 pt-2">
                <span className="flex items-center gap-2 whitespace-nowrap text-xs font-medium text-gray-500 dark:text-gray-400">
                  {t('translation.sourceLabel')}
                  {readingDocument && documentJob && (
                    <span className="font-normal">
                      {t('translation.pageNumber', {
                        page: String(documentJob.page),
                      })}
                    </span>
                  )}
                  {isRunning && (
                    <span className="inline-flex items-center gap-1 font-normal">
                      <IconLock size={12} aria-hidden />
                      {t('translation.sourceLocked')}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-1 whitespace-nowrap">
                  {loadedDocument?.ocrApplied && !ocrOffer && (
                    <span
                      title={t('translation.ocrAppliedHint')}
                      className="rounded bg-gray-200 px-1.5 py-0.5 text-[11px] text-gray-700 dark:bg-surface-dark-elevated dark:text-gray-300"
                    >
                      {t('translation.ocrApplied')}
                    </span>
                  )}
                  {canOfferOcr && !ocrOffer && !readingDocument && (
                    <button
                      type="button"
                      onClick={() => offerOcrForLoaded('manual')}
                      disabled={
                        isRunning ||
                        uploading ||
                        assessing ||
                        submittingDocument ||
                        documentInProgress
                      }
                      title={t('translation.ocrButtonHint')}
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
                    >
                      <IconScan size={13} aria-hidden />
                      {t('translation.ocrButton')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      uploadUsesPicker
                        ? setUploadPickerOpen(true)
                        : fileInputRef.current?.click()
                    }
                    disabled={
                      isRunning ||
                      uploading ||
                      assessing ||
                      submittingDocument ||
                      documentInProgress
                    }
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
                  >
                    <IconUpload size={13} aria-hidden />
                    {t('translation.uploadDocument')}
                  </button>
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_UPLOADS}
                  hidden
                  onChange={(e) => void handleUpload(e.target.files?.[0])}
                />
                <AddToChatDialog
                  isOpen={uploadPickerOpen}
                  onClose={() => setUploadPickerOpen(false)}
                  initialIntent="attach"
                  capabilities={uploadCapabilities}
                  onBrowseDevice={() => fileInputRef.current?.click()}
                  onDeviceFiles={(files) => void handleUpload(files[0])}
                  host={uploadHost}
                />
              </div>
              {upload && (
                <UploadProgress
                  fileName={upload.name}
                  fileSize={upload.size}
                  stage={upload.stage}
                  onCancel={() => uploadAbortRef.current?.abort()}
                />
              )}
              {ocrOffer && !uploading && (
                <OcrOffer
                  fileName={ocrOffer.name}
                  reason={ocrOffer.reason}
                  canOcr={ocrOffer.canOcr}
                  onTranslateWhole={
                    ocrOffer.reason === 'no-text'
                      ? handleTranslateScannedWhole
                      : undefined
                  }
                  pagesLeft={ocrBudget?.remaining}
                  error={ocrOffer.error}
                  onRun={() => void handleRunOcr()}
                  onDismiss={() => setOcrOffer(null)}
                />
              )}
              {readingDocument && !uploading && !ocrOffer && (
                <div
                  data-testid="document-source-page"
                  className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap p-3 text-sm text-gray-900 dark:text-gray-100"
                >
                  {pageInPane ? (
                    reader.page?.source || (
                      <span className="text-gray-500 dark:text-gray-400">
                        {t('translation.scannedPageNote')}
                      </span>
                    )
                  ) : reader.pageError ? null : (
                    <SkeletonLines widths={['88%', '94%', '61%']} />
                  )}
                </div>
              )}
              {loadedDocument?.noText &&
                sourceText === '' &&
                !readingDocument &&
                !uploading &&
                !ocrOffer && (
                  <p className="px-3 pt-2 text-xs text-gray-600 dark:text-gray-400">
                    {t('translation.scannedSourceNote', {
                      name: loadedDocument.name,
                    })}
                  </p>
                )}
              {showDocumentCard && loadedDocument && (
                <SourceDocumentCard
                  document={loadedDocument}
                  disabled={
                    isRunning ||
                    assessing ||
                    submittingDocument ||
                    documentInProgress
                  }
                  onRemove={handleRemoveDocument}
                  action={
                    loadedDocument.noText
                      ? undefined
                      : sheetPages
                        ? // Whole document reads the file, not this text:
                          // there is nothing to edit there.
                          !documentMode && (
                            <button
                              type="button"
                              onClick={() =>
                                setSourceAsText((asText) => !asText)
                              }
                              disabled={isRunning}
                              className={CARD_ACTION_CLASS}
                            >
                              {sourceAsText
                                ? t('translation.sourceShowPages')
                                : t('translation.sourceEditText')}
                            </button>
                          )
                        : !sourcePages && (
                            <button
                              type="button"
                              onClick={() => {
                                setSourceAsText(false);
                                void handleLoadSourcePages();
                              }}
                              disabled={loadingSourcePages}
                              className={CARD_ACTION_CLASS}
                            >
                              {loadingSourcePages
                                ? t('translation.pagesLoading')
                                : t('translation.sourceShowPages')}
                            </button>
                          )
                  }
                />
              )}
              {showSheets && sheetPages && loadedDocument && (
                <SourcePageSheets
                  pages={sheetPages}
                  lastPage={loadedDocument.lastPage}
                />
              )}
              <FormattedRunExpiryWarning
                subject="sourceText"
                expiresAt={sourceStorage.expiresAt}
                keeping={sourceStorage.keeping}
                onKeep={() => void sourceStorage.keep()}
              />
              <SourceTextStorageNotice storage={sourceStorage} />
              <textarea
                ref={sourceRef}
                hidden={
                  uploading ||
                  readingDocument ||
                  ocrOffer !== null ||
                  showSheets
                }
                value={sourceText}
                onChange={(e) =>
                  patchState({
                    sourceText: e.target.value,
                    // Emptying the pane lets go of the document it came from;
                    // so does typing over a document that brought no text.
                    ...((e.target.value === '' ||
                      state.sourceDocument?.noText) && {
                      sourceDocument: undefined,
                    }),
                  })
                }
                // A text still being fetched must not be typed over.
                disabled={
                  isRunning ||
                  uploading ||
                  sourceStorage.loading ||
                  sourceStorage.problem !== null
                }
                placeholder={
                  sourceStorage.loading || sourceStorage.problem
                    ? ''
                    : t('translation.sourcePlaceholder')
                }
                className="min-h-0 flex-1 resize-none bg-transparent p-3 text-sm text-gray-900 placeholder-gray-500 focus:outline-none disabled:opacity-70 dark:text-gray-100 dark:placeholder-gray-400"
              />
            </div>

            <div
              className={`flex min-w-0 flex-1 flex-col ${
                layout.panesSideBySide ? 'min-h-0' : PANE_MIN_HEIGHT
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-3 pt-2">
                <span className="flex min-w-0 flex-wrap items-center gap-1.5 whitespace-nowrap text-xs font-medium text-gray-500 dark:text-gray-400">
                  {t('translation.targetLabel')}
                  {isDraft && (
                    <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[11px] text-gray-700 dark:bg-surface-dark-elevated dark:text-gray-300">
                      {t('translation.draftLabel')}
                    </span>
                  )}
                  {pageInPane && pageIsCorrected && (
                    <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[11px] text-gray-700 dark:bg-surface-dark-elevated dark:text-gray-300">
                      {t('translation.correctedLabel')}
                    </span>
                  )}
                  {/* The dismissed analysis strip stays one click away. */}
                  {paperTrailHidden && !isRunning && (
                    <button
                      type="button"
                      onClick={showAnalysis}
                      title={t('translation.analysisShow')}
                      className="rounded-full border border-gray-300 px-2 py-0.5 text-[11px] font-normal text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
                    >
                      {state.analysis
                        ? t('translation.analysisPill', {
                            count: countAnalysisNotes(state.analysis),
                          })
                        : reviewVerdict
                          ? t('translation.reviewTitle')
                          : t('translation.glossaryCheckTitle')}
                      {state.analysis && reviewVerdict && (
                        <>
                          {' · '}
                          {reviewVerdict === 'approve'
                            ? t('translation.verdictApprove')
                            : t('translation.verdictRevise')}
                        </>
                      )}
                    </button>
                  )}
                </span>
                <span className="flex items-center gap-1 whitespace-nowrap">
                  {pageInPane && reader.page && pageIsCorrected && (
                    <button
                      type="button"
                      onClick={() =>
                        patchState({
                          finalText: reader.page?.translation ?? '',
                          assessment: undefined,
                        })
                      }
                      disabled={assessing}
                      title={t('translation.correctionRestoreHint')}
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
                    >
                      <IconArrowBackUp size={13} aria-hidden />
                      {t('translation.correctionRestore')}
                    </button>
                  )}
                  {readingDocument && documentJob && (
                    <DocumentDownloadMenu job={documentJob} />
                  )}
                  <button
                    type="button"
                    onClick={() => setEditingTarget((editing) => !editing)}
                    // Pending suggestions no longer lock the translation:
                    // text they don't cover is free to change, and typing
                    // over one goes through handleTargetChange's gate
                    // (docs/REVIEW_EDIT_UNFREEZE_DESIGN.md §5).
                    disabled={
                      isRunning || assessing || (documentMode && !pageInPane)
                    }
                    aria-pressed={editingTarget}
                    title={
                      editingTarget
                        ? t('translation.doneEditing')
                        : t('translation.editTranslation')
                    }
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
                  >
                    {editingTarget ? (
                      <IconPencilOff size={13} aria-hidden />
                    ) : (
                      <IconPencil size={13} aria-hidden />
                    )}
                    {editingTarget
                      ? t('translation.doneEditing')
                      : t('translation.editTranslation')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCopy()}
                    disabled={!targetText}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
                  >
                    <IconCopy size={13} aria-hidden />
                    {copied ? t('translation.copied') : t('translation.copy')}
                  </button>
                </span>
              </div>
              {isRunning && (
                <TranslationRunStatus
                  mode={textMode}
                  stage={runStage}
                  round={run?.activityParams?.round}
                  totalRounds={run?.activityParams?.total}
                />
              )}
              {documentMode && !pageInPane ? (
                documentJob &&
                (documentJob.status === 'translating' ||
                  documentJob.status === 'preparing') ? (
                  <DocumentJobProgress
                    job={{ ...documentJob, status: documentJob.status }}
                    stalled={reader.stalled}
                    onRetry={reader.retryStatus}
                  />
                ) : documentJob?.status === 'failed' || reader.pageError ? (
                  <div
                    role="alert"
                    className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
                  >
                    <p className="max-w-[48ch] text-sm text-red-700 dark:text-red-400">
                      {documentJob?.status === 'failed'
                        ? documentJob.error
                          ? t('translation.documentFailed', {
                              message: documentJob.error,
                            })
                          : t('translation.documentGone')
                        : t('translation.documentPageFailed', {
                            message: reader.pageError ?? '',
                          })}
                    </p>
                    {documentJob?.status !== 'failed' && (
                      <button
                        type="button"
                        onClick={reader.retryPage}
                        className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
                      >
                        {t('translation.retry')}
                      </button>
                    )}
                  </div>
                ) : documentJob ? (
                  <div className="min-h-0 flex-1 p-3">
                    <SkeletonLines widths={['92%', '70%', '84%', '48%']} />
                  </div>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      {t('translation.documentIntroTitle')}
                    </p>
                    <p className="max-w-[52ch] text-xs text-gray-500 dark:text-gray-400">
                      {t('translation.documentIntro')}
                    </p>
                  </div>
                )
              ) : editingTarget ? (
                <>
                  {/* The textarea cannot mark suggestions, so while editing
                      the user is told what is at stake instead (§5 v1). */}
                  {hasUnresolvedEdits && (
                    <p className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
                      {previewEdits.length > 1
                        ? t('translation.editingPendingHint', {
                            count: String(previewEdits.length),
                          })
                        : t('translation.editingPendingHintOne')}
                    </p>
                  )}
                  <textarea
                    value={state.finalText ?? ''}
                    onChange={(e) => handleTargetChange(e.target.value)}
                    placeholder={t('translation.pasteTranslationPlaceholder')}
                    className="min-h-0 flex-1 resize-none bg-transparent p-3 text-sm text-gray-900 placeholder-gray-500 focus:outline-none dark:text-gray-100 dark:placeholder-gray-400"
                  />
                </>
              ) : (
                <div
                  // A draft under review is readable but visibly not final.
                  className={`min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap p-3 text-sm text-gray-900 dark:text-gray-100 ${
                    isDraft && runStage === 'reviewing'
                      ? 'opacity-70 motion-safe:animate-pulse'
                      : ''
                  }`}
                >
                  {isRunning && runStage !== 'reviewing' ? (
                    <>
                      {targetText}
                      <SkeletonLines
                        widths={['92%', '70%', '48%']}
                        className={targetText ? 'mt-3' : ''}
                      />
                    </>
                  ) : targetText ? (
                    <SelectionChangeRequest
                      text={targetText}
                      disabled={
                        isDraft ||
                        assessing ||
                        changeRun !== null ||
                        (documentMode && !pageInPane)
                      }
                      onSubmit={(instruction, selection) =>
                        void runChangeRequest({ instruction, selection })
                      }
                    >
                      <AnnotatedText
                        text={targetText}
                        edits={previewEdits}
                        activeId={preview.activeId}
                        pinnedId={preview.pinnedId}
                        onPin={preview.setPinned}
                        onHover={preview.setHovered}
                        i18nNamespace="workflows.translation"
                        onAccept={(id) => resolveEdit(id, 'accepted')}
                        onReject={(id) => resolveEdit(id, 'rejected')}
                        disabled={assessing || isRunning}
                      />
                    </SelectionChangeRequest>
                  ) : (
                    <span className="text-gray-400 dark:text-gray-500">
                      {t('translation.targetEmpty')}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Ask for a change in words; the answer is suggested edits. */}
          {(state.finalText ?? '').trim().length > 0 &&
            (!documentMode || pageInPane) && (
              <ChangeRequestBar
                runningInstruction={changeRun?.instruction}
                runningSince={changeRun?.startedAt}
                hasResult={Boolean(assessment?.request)}
                disabledReason={
                  isRunning || assessing
                    ? t('translation.changeBusy')
                    : undefined
                }
                note={changeNote}
                error={changeError}
                onSubmit={(instruction) =>
                  void runChangeRequest({ instruction })
                }
                onStop={() => changeAbortRef.current?.abort()}
              />
            )}

          {/* Quality assessment controls */}
          {(state.finalText ?? '').trim().length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-gray-200 px-3 py-2 dark:border-gray-700">
              <CriteriaPicker
                criteria={criteriaItems}
                selected={selectedCriteria}
                onToggle={(id) =>
                  setSelectedCriteria((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                i18nNamespace="workflows.translation"
                disabled={assessing || isRunning}
              />
              <GuidePicker
                guides={translationGuides}
                selected={selectedCriteria}
                onToggle={(id) =>
                  setSelectedCriteria((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                i18nNamespace="workflows.translation"
                disabled={assessing || isRunning}
              />
              <span className="ms-auto flex items-center gap-2">
                {assessment && !reviewOpen && (
                  <button
                    type="button"
                    onClick={() => setReviewOpen(true)}
                    className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
                  >
                    {hasUnresolvedEdits
                      ? t('translation.showReviewPending', {
                          count: String(
                            assessment.edits.filter(
                              (e) => e.status === 'pending',
                            ).length,
                          ),
                        })
                      : t('translation.showReview')}
                  </button>
                )}
                {assessing ? (
                  <>
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {t('translation.assessing')}
                    </span>
                    <button
                      type="button"
                      onClick={() => assessAbortRef.current?.abort()}
                      className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-gray-400 px-2.5 py-1 text-xs font-medium text-gray-900 hover:bg-gray-100 dark:border-gray-500 dark:text-gray-100 dark:hover:bg-surface-dark-elevated"
                    >
                      <IconPlayerStopFilled size={12} aria-hidden />
                      {t('translation.stop')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleAssess()}
                    disabled={!canAssess}
                    className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg bg-gray-200 px-2.5 py-1 text-xs font-medium text-gray-900 hover:bg-gray-300 disabled:pointer-events-none disabled:opacity-30 dark:bg-surface-dark-elevated dark:text-gray-100 dark:hover:bg-gray-700"
                  >
                    <IconClipboardCheck size={14} aria-hidden />
                    {t('translation.assess')}
                  </button>
                )}
              </span>
              {assessError && (
                <p
                  className="w-full text-xs text-red-700 dark:text-red-400"
                  role="alert"
                >
                  {assessError}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Quality review column — a dedicated pane beside the text it
            modifies, so the pending-edit queue is never buried in the
            paper-trail strip below. */}
        {assessing && (
          <div className={reviewColumnClasses}>
            <AssessmentProgress
              criteria={[...selectedCriteria].map(resolveCriterionLabel)}
            />
          </div>
        )}
        {assessment && reviewOpen && !assessing && (
          <div className={reviewColumnClasses}>
            <AssessmentPanel
              assessment={assessment}
              resolveCriterionLabel={resolveCriterionLabel}
              i18nNamespace="workflows.translation"
              request={
                assessment.request && {
                  title: t('translation.changeTitle'),
                  instruction: assessment.request.instruction,
                  selectedText: assessment.request.selectedText,
                  selectedLabel: t('translation.changeSelectedLabel'),
                  emptyMessage: t('translation.changeNoEdits'),
                }
              }
              previewEditId={preview.activeId}
              onPreviewEdit={preview.setHovered}
              onAccept={(id) => resolveEdit(id, 'accepted')}
              onReject={(id) => resolveEdit(id, 'rejected')}
              onAcceptAll={() => resolveAll('accepted')}
              onRejectAll={() => resolveAll('rejected')}
              onRevert={revertEdit}
              onClearResolved={clearResolved}
              autoClearResolved={autoClearResolvedEdits}
              onToggleAutoClear={setAutoClearResolvedEdits}
              onClose={() => setReviewOpen(false)}
              // Not shown at all while assessing (see the condition above).
              disabled={isRunning || changeRun !== null}
            />
          </div>
        )}
      </div>

      {/* Pre-run paper trail (analysis + review rounds) — history only */}
      {!analysisHidden && !anyDocumentMode && (
        <AnalysisStrip
          analysis={state.analysis}
          rounds={state.rounds}
          glossaryCheck={state.glossaryCheck}
          expanded={analysisExpanded}
          onToggleExpanded={() => setAnalysisExpanded((open) => !open)}
          onDismiss={() => setAnalysisHidden(true)}
          height={analysisHeight}
          onResize={setAnalysisHeight}
        />
      )}

      {/* Glossary manager */}
      {criteriaOpen && (
        <div className="h-72 shrink-0">
          <CriteriaManager
            criteria={translationCriteria}
            i18nNamespace="workflows.translation"
            onCreate={addTranslationCriterion}
            onUpdate={updateTranslationCriterion}
            onDelete={deleteTranslationCriterion}
            onClose={() => setCriteriaOpen(false)}
          />
        </div>
      )}

      {glossariesOpen && (
        <div className="h-72 shrink-0">
          <GlossaryManager
            onClose={() => setGlossariesOpen(false)}
            defaultTargetLang={targetLanguage?.id}
          />
        </div>
      )}

      {/* An AI run asked for with suggestions still pending: decide the queue
          in bulk, then the run follows with the post-decision text (§6b). */}
      <PendingEditsDialog
        isOpen={reviewGate !== null}
        pendingCount={previewEdits.length}
        actionLabel={
          reviewGate === 'assess'
            ? t('translation.pendingRunActionAssess')
            : reviewGate === 'request'
              ? t('translation.pendingRunActionRequest')
              : t('translation.pendingRunActionTranslate')
        }
        onAcceptAll={() => decidePendingAndRun('accepted')}
        onRejectAll={() => decidePendingAndRun('rejected')}
        onCancel={cancelReviewGate}
      />
      <PendingEditsDialog
        isOpen={departureGate !== null}
        pendingCount={previewEdits.length}
        actionLabel=""
        message={t('translation.pendingLeavePage')}
        onAcceptAll={() => decidePendingAndLeave('accepted')}
        onRejectAll={() => decidePendingAndLeave('rejected')}
        onCancel={() => setDepartureGate(null)}
      />

      <ConfirmDialog
        isOpen={confirmRetranslate}
        title={t('translation.documentRetranslateTitle')}
        message={t('translation.documentRetranslateMessage')}
        confirmLabel={t('translation.translateDocument')}
        onConfirm={() => {
          setConfirmRetranslate(false);
          void submitDocument();
        }}
        onCancel={() => setConfirmRetranslate(false)}
      />

      {/* First change over a suggested passage: explain once, then act.
          Confirming applies the held change — nothing typed is lost. */}
      <ConfirmDialog
        isOpen={overwritePrompt !== null}
        title={t('translation.overwriteEditTitle')}
        message={t('translation.overwriteEditMessage')}
        confirmLabel={
          (overwritePrompt?.ids.length ?? 0) > 1
            ? t('translation.overwriteEditConfirmMany', {
                count: String(overwritePrompt?.ids.length ?? 0),
              })
            : t('translation.overwriteEditConfirmOne')
        }
        onConfirm={() => {
          if (!overwritePrompt) return;
          const { ids, next } = overwritePrompt;
          setOverwritePrompt(null);
          setReviewOverwriteAcknowledged(true);
          dropEdits(ids);
          patchState({ finalText: next });
        }}
        onCancel={() => setOverwritePrompt(null)}
      />
    </div>
  );
}

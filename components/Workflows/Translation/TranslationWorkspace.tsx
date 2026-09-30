'use client';

import {
  IconAdjustments,
  IconBook2,
  IconClipboardCheck,
  IconCopy,
  IconLanguage,
  IconPencil,
  IconPencilOff,
  IconPlayerStopFilled,
  IconUpload,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { useAvailableGuides } from '@/client/hooks/settings/useAvailableGuides';
import { useAutoFocusComposer } from '@/client/hooks/ui/useAutoFocusComposer';
import { usePasteComposer } from '@/client/hooks/ui/usePasteComposer';
import { useEditPreview } from '@/client/hooks/workflows/useEditPreview';
import { useWorkflowStream } from '@/client/hooks/workflows/useWorkflowStream';

import { uploadAndExtractText } from '@/client/services/workflows/fileTextExtraction';
import { appendWorkflowRailMessages } from '@/client/services/workflows/railMessages';
import { assessTranslation } from '@/client/services/workflows/translationAssessment';
import { nameWorkflowConversation } from '@/client/services/workflows/workflowTitle';
import { AGENTIC_TRANSLATION_MAX_PASSES } from '@/lib/services/workflows/shared/workflowLimits';

import {
  LanguageOption,
  sortLanguageOptionsByLabel,
} from '@/lib/utils/app/languagePickerHelpers';
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
  applyEdit,
  applyEditsInOrder,
} from '@/lib/utils/shared/translation/editApplication';
import { mergeGlossaryEntries } from '@/lib/utils/shared/translation/glossaryMatch';
import {
  TRANSLATION_LANGUAGES,
  findTranslationLanguage,
  translationLanguageLabel,
} from '@/lib/utils/shared/translation/languages';
import { TRANSLATION_QUALITY_CRITERIA } from '@/lib/utils/shared/translation/qualityCriteria';

import {
  TranslationAnalysis,
  TranslationEditStatus,
  TranslationGlossary,
  TranslationGlossaryCheck,
  TranslationReviewRound,
  TranslationRoundChange,
  TranslationTargetLanguage,
  TranslationWorkflowState,
} from '@/types/workflow';

import { ConfirmDialog } from '@/components/UI/ConfirmDialog';
import { LanguagePicker } from '@/components/UI/LanguagePicker';

import { RunEstimateHint } from '../Impact/RunEstimateHint';
import { AnnotatedText } from '../Shared/Review/AnnotatedText';
import { AssessmentPanel } from '../Shared/Review/AssessmentPanel';
import { CriteriaManager } from '../Shared/Review/CriteriaManager';
import { CriteriaPicker } from '../Shared/Review/CriteriaPicker';
import { GuidePicker } from '../Shared/Review/GuidePicker';
import { PendingEditsDialog } from '../Shared/Review/PendingEditsDialog';
import { WorkflowWorkspaceProps } from '../registry';
import { AnalysisPanel } from './AnalysisPanel';
import { GlossaryManager } from './GlossaryManager';
import { GlossaryPicker, languageFit } from './GlossaryPicker';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { useWorkflowRunStore } from '@/client/stores/workflowRunStore';
import { v4 as uuidv4 } from 'uuid';

/** Pre-flight cap; the server enforces its own (larger) limit. */
const MAX_SOURCE_CHARS = 60_000;

const ACCEPTED_UPLOADS = '.pdf,.doc,.docx,.txt,.md,.xml,.ppt,.pptx';

export function TranslationWorkspace({
  conversationId,
}: WorkflowWorkspaceProps) {
  const t = useTranslations('workflows');
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
  // Built-ins on by default; custom criteria start off, so adding one
  // never silently changes what the next assessment measures.
  const [selectedCriteria, setSelectedCriteria] = useState<Set<string>>(
    () => new Set<string>(TRANSLATION_QUALITY_CRITERIA.map((c) => c.id)),
  );
  const langButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

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

  const handleUpload = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const extracted = await uploadAndExtractText(file);
      if (!extracted.text.trim()) {
        setUploadError(t('document.referenceEmpty', { name: file.name }));
      } else {
        patchState({ sourceText: extracted.text.slice(0, MAX_SOURCE_CHARS) });
        nameWorkflowConversation(conversationId, {
          label: file.name,
          sample: extracted.text,
          workflow: 'Translation',
        });
      }
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : t('document.uploadFailed'),
      );
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleTranslate = useCallback(async () => {
    if (!state || isRunning) return;
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
        onText: (fullText) => setTargetDraft(fullText),
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
    const source = sourceText.trim();
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

    try {
      const result = await assessTranslation({
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
      setAssessError(
        err instanceof Error ? err.message : t('document.uploadFailed'),
      );
    } finally {
      setAssessing(false);
    }
  }, [
    state,
    targetLanguage,
    assessing,
    isRunning,
    sourceText,
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
   * An AI run asked for while suggestions were still pending
   * (docs/REVIEW_EDIT_UNFREEZE_DESIGN.md §6b). The dialog decides the queue in
   * bulk; the run itself is QUEUED rather than called from the dialog's
   * handler, and fires from the effect below once the store shows no pending
   * edits — by which point this component has re-rendered and the handler's
   * closure holds the post-decision text. Calling the handler straight after
   * `resolveAll` would read the render's stale closure and send the model the
   * pre-decision document, silently discarding what the user just accepted.
   */
  const [reviewGate, setReviewGate] = useState<'translate' | 'assess' | null>(
    null,
  );
  const [queuedAction, setQueuedAction] = useState<
    'translate' | 'assess' | null
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
    else void handleAssess();
  }, [queuedAction, hasUnresolvedEdits, handleTranslate, handleAssess]);

  if (!state) return null;

  const canTranslate =
    !isRunning &&
    !assessing &&
    sourceText.trim().length > 0 &&
    !!targetLanguage;
  const canAssess =
    !isRunning &&
    !assessing &&
    !!targetLanguage &&
    sourceText.trim().length > 0 &&
    (state.finalText ?? '').trim().length > 0 &&
    selectedCriteria.size > 0;
  const tooLong = sourceText.length > MAX_SOURCE_CHARS;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Controls bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <button
          ref={langButtonRef}
          type="button"
          onClick={() => setLangPickerOpen((open) => !open)}
          disabled={isRunning}
          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
        >
          <IconLanguage size={15} aria-hidden />
          {targetLanguage?.label ?? t('translation.chooseLanguage')}
        </button>
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
            disabled={isRunning}
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

        {/* Mode toggle */}
        <div
          role="radiogroup"
          aria-label={t('translation.mode')}
          className="ms-auto flex rounded-lg bg-gray-100 p-0.5 dark:bg-surface-dark-elevated"
        >
          {(['quick', 'agentic'] as const).map((mode) => (
            <button
              key={mode}
              role="radio"
              aria-checked={state.mode === mode}
              onClick={() => patchState({ mode })}
              disabled={isRunning}
              title={
                mode === 'quick'
                  ? t('translation.modeQuickHint')
                  : t('translation.modeAgenticHint')
              }
              className={`rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
                state.mode === mode
                  ? 'bg-white text-gray-900 dark:bg-surface-dark dark:text-gray-100'
                  : 'text-gray-600 dark:text-gray-400'
              }`}
            >
              {mode === 'quick'
                ? t('translation.modeQuick')
                : t('translation.modeAgentic')}
            </button>
          ))}
        </div>

        {/* What this run will cost, while quick/agentic is still a choice. */}
        {!isRunning && (
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

        {isRunning ? (
          <button
            type="button"
            onClick={() => cancelRun(conversationId)}
            aria-label={t('shell.stopGenerating')}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-300 text-gray-900 hover:bg-gray-400 dark:bg-surface-dark-base dark:text-white dark:hover:bg-surface-dark-elevated"
          >
            <IconPlayerStopFilled size={16} aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleTranslate()}
            disabled={!canTranslate || tooLong}
            className="min-h-[36px] rounded-lg bg-gray-300 px-3 py-1.5 text-sm font-medium text-gray-900 hover:bg-gray-400 disabled:pointer-events-none disabled:opacity-30 dark:bg-surface-dark-base dark:text-white dark:hover:bg-surface-dark-elevated"
          >
            {t('translation.translate')}
          </button>
        )}
      </div>

      {/* Status / errors */}
      {(run?.error || tooLong || uploadError || targetLanguage?.custom) && (
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
        </div>
      )}

      {/* Workbench: panes (+ assess controls) with the review column beside */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Panes */}
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <div className="flex min-h-0 flex-1 flex-col border-b border-gray-200 dark:border-gray-700 md:border-b-0 md:border-e">
              <div className="flex items-center justify-between px-3 pt-2">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                  {t('translation.sourceLabel')}
                </span>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isRunning || uploading}
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
                >
                  <IconUpload size={13} aria-hidden />
                  {uploading
                    ? t('document.uploading')
                    : t('translation.uploadDocument')}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPTED_UPLOADS}
                  hidden
                  onChange={(e) => void handleUpload(e.target.files)}
                />
              </div>
              <textarea
                ref={sourceRef}
                value={sourceText}
                onChange={(e) => patchState({ sourceText: e.target.value })}
                disabled={isRunning}
                placeholder={t('translation.sourcePlaceholder')}
                className="min-h-0 flex-1 resize-none bg-transparent p-3 text-sm text-gray-900 placeholder-gray-500 focus:outline-none disabled:opacity-70 dark:text-gray-100 dark:placeholder-gray-400"
              />
            </div>

            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center justify-between px-3 pt-2">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                  {t('translation.targetLabel')}
                  {isRunning && (
                    <span className="ms-2 animate-pulse">
                      {t('translation.translating')}
                    </span>
                  )}
                  {assessing && (
                    <span className="ms-2 animate-pulse">
                      {t('translation.assessing')}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setEditingTarget((editing) => !editing)}
                    // Pending suggestions no longer lock the translation:
                    // text they don't cover is free to change, and typing
                    // over one goes through handleTargetChange's gate
                    // (docs/REVIEW_EDIT_UNFREEZE_DESIGN.md §5).
                    disabled={isRunning || assessing}
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
              {editingTarget ? (
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
                <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap p-3 text-sm text-gray-900 dark:text-gray-100">
                  {targetText ? (
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
                  ) : (
                    <span className="text-gray-400 dark:text-gray-500">
                      {t('translation.targetEmpty')}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

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
                <button
                  type="button"
                  onClick={() => void handleAssess()}
                  disabled={!canAssess}
                  className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg bg-gray-200 px-2.5 py-1 text-xs font-medium text-gray-900 hover:bg-gray-300 disabled:pointer-events-none disabled:opacity-30 dark:bg-surface-dark-elevated dark:text-gray-100 dark:hover:bg-gray-700"
                >
                  <IconClipboardCheck size={14} aria-hidden />
                  {assessing
                    ? t('translation.assessing')
                    : t('translation.assess')}
                </button>
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
        {assessment && reviewOpen && (
          <div className="flex max-h-80 shrink-0 flex-col border-t border-gray-200 dark:border-gray-700 lg:max-h-none lg:w-96 lg:border-s lg:border-t-0">
            <AssessmentPanel
              assessment={assessment}
              resolveCriterionLabel={resolveCriterionLabel}
              i18nNamespace="workflows.translation"
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
              disabled={assessing || isRunning}
            />
          </div>
        )}
      </div>

      {/* Pre-run paper trail (analysis + review rounds) — history only */}
      <div className="max-h-56 shrink-0 overflow-y-auto">
        <AnalysisPanel
          analysis={state.analysis}
          rounds={state.rounds}
          glossaryCheck={state.glossaryCheck}
        />
      </div>

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
            : t('translation.pendingRunActionTranslate')
        }
        onAcceptAll={() => decidePendingAndRun('accepted')}
        onRejectAll={() => decidePendingAndRun('rejected')}
        onCancel={() => setReviewGate(null)}
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

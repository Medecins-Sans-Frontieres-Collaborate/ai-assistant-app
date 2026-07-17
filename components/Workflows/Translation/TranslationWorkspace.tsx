'use client';

import {
  IconBook2,
  IconClipboardCheck,
  IconCopy,
  IconLanguage,
  IconPencil,
  IconPencilOff,
  IconPlayerStopFilled,
  IconUpload,
} from '@tabler/icons-react';
import { useCallback, useMemo, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useWorkflowStream } from '@/client/hooks/workflows/useWorkflowStream';

import { uploadAndExtractText } from '@/client/services/workflows/fileTextExtraction';
import { appendWorkflowRailMessages } from '@/client/services/workflows/railMessages';
import { assessTranslation } from '@/client/services/workflows/translationAssessment';

import {
  LanguageOption,
  sortLanguageOptionsByLabel,
} from '@/lib/utils/app/languagePickerHelpers';
import {
  applyEdit,
  applyEditsInOrder,
} from '@/lib/utils/shared/translation/editApplication';
import {
  TRANSLATION_LANGUAGES,
  findTranslationLanguage,
  translationLanguageLabel,
} from '@/lib/utils/shared/translation/languages';
import { TRANSLATION_QUALITY_CRITERIA } from '@/lib/utils/shared/translation/qualityCriteria';

import {
  TranslationAnalysis,
  TranslationCriterionId,
  TranslationEditStatus,
  TranslationReviewRound,
  TranslationRoundChange,
  TranslationTargetLanguage,
  TranslationWorkflowState,
} from '@/types/workflow';

import { LanguagePicker } from '@/components/UI/LanguagePicker';

import { AssessmentPanel } from '../Shared/Review/AssessmentPanel';
import { CriteriaPicker } from '../Shared/Review/CriteriaPicker';
import { WorkflowWorkspaceProps } from '../registry';
import { AnalysisPanel } from './AnalysisPanel';
import { GlossaryManager } from './GlossaryManager';

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
  const customLanguages = useSettingsStore((s) => s.customLanguages);
  const addCustomLanguage = useSettingsStore((s) => s.addCustomLanguage);
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
  /** Live target text while streaming; null = show persisted finalText. */
  const [targetDraft, setTargetDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [editingTarget, setEditingTarget] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(true);
  const [assessing, setAssessing] = useState(false);
  const [assessError, setAssessError] = useState<string | null>(null);
  const [selectedCriteria, setSelectedCriteria] = useState<
    Set<TranslationCriterionId>
  >(() => new Set(TRANSLATION_QUALITY_CRITERIA.map((c) => c.id)));
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
  const targetText = targetDraft ?? state?.finalText ?? '';
  const activeGlossary = glossaries.find((g) => g.id === state?.glossaryId);
  const assessment = state?.assessment;
  const hasUnresolvedEdits =
    assessment?.edits.some((e) => e.status === 'pending') ?? false;

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
    clearError(conversationId);

    // Reset the paper trail for this run.
    patchState({
      analysis: undefined,
      rounds: [],
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
          glossaryEntries: activeGlossary?.entries ?? [],
          modelId: conversation?.model?.id,
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
          } else if (event.type === 'complete') {
            const data = event.data as { finalText: string };
            finalText = data.finalText;
          }
        },
      });

      if (finalText) {
        patchState({ finalText });
        setTargetDraft(null);
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
    sourceText,
    targetLanguage,
    conversationId,
    conversation?.model?.id,
    activeGlossary,
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
    if (hasUnresolvedEdits) return;

    setAssessError(null);
    setAssessing(true);
    setEditingTarget(false);
    try {
      const result = await assessTranslation({
        sourceText: source,
        translation,
        targetLanguage: targetLanguage.label,
        criteria: [...selectedCriteria],
        glossaryEntries: activeGlossary?.entries ?? [],
        modelId: conversation?.model?.id,
      });
      patchState({
        assessment: {
          id: uuidv4(),
          criteria: result.criteria,
          overallSummary: result.overallSummary,
          edits: result.edits.map((edit) => ({
            ...edit,
            id: uuidv4(),
            status: 'pending' as const,
          })),
          createdAt: new Date().toISOString(),
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
    hasUnresolvedEdits,
    activeGlossary,
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
        return {
          ...p,
          finalText,
          assessment: {
            ...p.assessment,
            edits: p.assessment.edits.map((e) =>
              e.id === editId
                ? { ...e, status, resolvedAt: new Date().toISOString() }
                : e,
            ),
          },
          updatedAt: new Date().toISOString(),
        };
      });
    },
    [conversationId, updateWorkflowState],
  );

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

  if (!state) return null;

  const canTranslate =
    !isRunning &&
    !assessing &&
    !hasUnresolvedEdits &&
    sourceText.trim().length > 0 &&
    !!targetLanguage;
  const canAssess =
    !isRunning &&
    !assessing &&
    !hasUnresolvedEdits &&
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

        <select
          value={state.glossaryId ?? ''}
          onChange={(e) =>
            patchState({ glossaryId: e.target.value || undefined })
          }
          disabled={isRunning}
          aria-label={t('translation.glossary')}
          className="min-h-[36px] rounded-lg border border-gray-300 bg-transparent px-2 py-1.5 text-sm text-gray-700 disabled:opacity-50 dark:border-gray-700 dark:bg-surface-dark dark:text-gray-300"
        >
          <option value="">{t('translation.noGlossary')}</option>
          {glossaries.map((glossary) => (
            <option key={glossary.id} value={glossary.id}>
              {glossary.name}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => setGlossariesOpen((open) => !open)}
          aria-pressed={glossariesOpen}
          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
        >
          <IconBook2 size={15} aria-hidden />
          {t('translation.manageGlossaries')}
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
                    disabled={isRunning || assessing || hasUnresolvedEdits}
                    aria-pressed={editingTarget}
                    title={
                      hasUnresolvedEdits
                        ? t('translation.editingBlockedPendingEdits')
                        : editingTarget
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
                <textarea
                  value={state.finalText ?? ''}
                  onChange={(e) => patchState({ finalText: e.target.value })}
                  placeholder={t('translation.pasteTranslationPlaceholder')}
                  className="min-h-0 flex-1 resize-none bg-transparent p-3 text-sm text-gray-900 placeholder-gray-500 focus:outline-none dark:text-gray-100 dark:placeholder-gray-400"
                />
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap p-3 text-sm text-gray-900 dark:text-gray-100">
                  {targetText || (
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
                criteria={TRANSLATION_QUALITY_CRITERIA.map((c) => ({
                  id: c.id,
                  label: t(`translation.criteria.${c.labelKey}.label`),
                  description: t(
                    `translation.criteria.${c.descriptionKey}.description`,
                  ),
                }))}
                selected={selectedCriteria as Set<string>}
                onToggle={(id) =>
                  setSelectedCriteria((prev) => {
                    const next = new Set(prev);
                    if (next.has(id as TranslationCriterionId)) {
                      next.delete(id as TranslationCriterionId);
                    } else {
                      next.add(id as TranslationCriterionId);
                    }
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
                  title={
                    hasUnresolvedEdits
                      ? t('translation.editingBlockedPendingEdits')
                      : undefined
                  }
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
              resolveCriterionLabel={(id) =>
                t(`translation.criteria.${id}.label`)
              }
              i18nNamespace="workflows.translation"
              onAccept={(id) => resolveEdit(id, 'accepted')}
              onReject={(id) => resolveEdit(id, 'rejected')}
              onAcceptAll={() => resolveAll('accepted')}
              onRejectAll={() => resolveAll('rejected')}
              onClose={() => setReviewOpen(false)}
              disabled={assessing || isRunning}
            />
          </div>
        )}
      </div>

      {/* Pre-run paper trail (analysis + review rounds) — history only */}
      <div className="max-h-56 shrink-0 overflow-y-auto">
        <AnalysisPanel analysis={state.analysis} rounds={state.rounds} />
      </div>

      {/* Glossary manager */}
      {glossariesOpen && (
        <div className="h-72 shrink-0">
          <GlossaryManager onClose={() => setGlossariesOpen(false)} />
        </div>
      )}
    </div>
  );
}

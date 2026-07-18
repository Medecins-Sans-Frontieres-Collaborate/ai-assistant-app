'use client';

import {
  IconClipboardCheck,
  IconDownload,
  IconFileImport,
  IconPlayerStopFilled,
  IconSparkles,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useMemo, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import type { ExportFormat } from '@/client/hooks/document/exportFormats';
import { useAutoFocusComposer } from '@/client/hooks/ui/useAutoFocusComposer';
import { usePasteComposer } from '@/client/hooks/ui/usePasteComposer';
import { useEditPreview } from '@/client/hooks/workflows/useEditPreview';
import { usePastedTextChips } from '@/client/hooks/workflows/usePastedTextChips';
import { useWorkflowStream } from '@/client/hooks/workflows/useWorkflowStream';

import { assessDocument } from '@/client/services/workflows/documentAssessment';
import { uploadAndExtractText } from '@/client/services/workflows/fileTextExtraction';
import { nameWorkflowConversation } from '@/client/services/workflows/workflowTitle';

import {
  downloadFile,
  exportToDOCX,
  exportToPDF,
  htmlToMarkdown,
  htmlToPlainText,
  sanitizeHtmlForExport,
} from '@/lib/utils/shared/document/exportUtils';
import {
  autoConvertToHtml,
  markdownToHtml,
} from '@/lib/utils/shared/document/formatConverter';
import {
  DOCUMENT_QUALITY_CRITERIA,
  availableDocumentCriteria,
  isCustomCriterionId,
} from '@/lib/utils/shared/document/qualityCriteria';
import {
  applyEdit,
  applyEditsInOrder,
} from '@/lib/utils/shared/review/editApplication';
import {
  hasResolvedEdits,
  invertPatch,
  withoutResolvedEdits,
} from '@/lib/utils/shared/review/reviewQueue';
import { stringHash } from '@/lib/utils/shared/stringHash';

import { Message, MessageType } from '@/types/chat';
import {
  DocumentReference,
  DocumentWorkflowState,
  ReviewEditStatus,
} from '@/types/workflow';

import { DropdownPortal } from '@/components/UI/DropdownPortal';
import { ExportFormatMenu } from '@/components/UI/ExportFormatMenu';

import { PastedTextChips } from '../Shared/PastedTextChips';
import { AssessmentPanel } from '../Shared/Review/AssessmentPanel';
import { CriteriaManager } from '../Shared/Review/CriteriaManager';
import { CriteriaPicker } from '../Shared/Review/CriteriaPicker';
import { EditQuickActions } from '../Shared/Review/EditQuickActions';
import { WorkflowWorkspaceProps } from '../registry';
import { DocumentProfilePanel } from './DocumentProfilePanel';
import { ReferencePanel } from './ReferencePanel';
import {
  EditorSelection,
  RichTextEditor,
  RichTextEditorHandle,
} from './RichTextEditor';
import { SpecManager } from './SpecManager';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { useWorkflowRunStore } from '@/client/stores/workflowRunStore';
import { v4 as uuidv4 } from 'uuid';

/** Streaming preview refresh interval — full re-parse of markdown → HTML. */
const STREAM_RENDER_INTERVAL_MS = 300;

function extractTitle(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

export function DocumentWorkspace({ conversationId }: WorkflowWorkspaceProps) {
  const t = useTranslations('workflows');
  const conversation = useConversationStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const updateWorkflowState = useConversationStore(
    (s) => s.updateWorkflowState,
  );
  const updateConversation = useConversationStore((s) => s.updateConversation);
  const run = useWorkflowRunStore((s) => s.runs[conversationId]);
  const cancelRun = useWorkflowRunStore((s) => s.cancelRun);
  const clearError = useWorkflowRunStore((s) => s.clearError);
  const { runWorkflowStream } = useWorkflowStream();

  const state =
    conversation?.workflowState?.kind === 'document'
      ? (conversation.workflowState as DocumentWorkflowState)
      : undefined;

  const documentSpecs = useSettingsStore((s) => s.documentSpecs);
  const documentCriteria = useSettingsStore((s) => s.documentCriteria);
  const tones = useSettingsStore((s) => s.tones);
  const addDocumentCriterion = useSettingsStore((s) => s.addDocumentCriterion);
  const updateDocumentCriterion = useSettingsStore(
    (s) => s.updateDocumentCriterion,
  );
  const deleteDocumentCriterion = useSettingsStore(
    (s) => s.deleteDocumentCriterion,
  );
  const autoClearResolvedEdits = useSettingsStore(
    (s) => s.autoClearResolvedEdits,
  );
  const setAutoClearResolvedEdits = useSettingsStore(
    (s) => s.setAutoClearResolvedEdits,
  );

  const [instruction, setInstruction] = useState('');
  const [streamHtml, setStreamHtml] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [assessing, setAssessing] = useState(false);
  const [assessError, setAssessError] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(true);
  const [specsOpen, setSpecsOpen] = useState(false);
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const [uploadingBasis, setUploadingBasis] = useState(false);
  const [selectedCriteria, setSelectedCriteria] = useState<Set<string>>(
    () =>
      new Set(
        DOCUMENT_QUALITY_CRITERIA.filter((c) => c.defaultOn && !c.requires).map(
          (c) => c.id,
        ),
      ),
  );
  const [selection, setSelection] = useState<EditorSelection | null>(null);
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const basisInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<RichTextEditorHandle>(null);
  // Reference text lives in memory only; metadata persists in workflowState.
  const referenceTexts = useRef(new Map<string, string>());
  const lastRenderRef = useRef(0);
  const snapshotRef = useRef<string>('');

  const isRunning = run?.isRunning ?? false;
  const docHtml = state?.docHtml ?? '';
  const hasDocument = docHtml.trim().length > 0;

  const assessment = state?.assessment;
  const hasUnresolvedEdits =
    assessment?.edits.some((e) => e.status === 'pending') ?? false;

  // In-text preview of the review queue: pending edits are decorated in the
  // editor, the active one opens into a full word diff, and a clicked span
  // pins itself with inline accept/reject. Edits are written against
  // markdown while the editor shows rendered HTML, so the decoration plugin
  // locates them by visible text and skips any it cannot place.
  const previewEdits = useMemo(
    () => assessment?.edits.filter((e) => e.status === 'pending') ?? [],
    [assessment],
  );
  const pendingIds = useMemo(
    () => previewEdits.map((e) => e.id),
    [previewEdits],
  );
  const preview = useEditPreview(pendingIds);
  const attachedSpec = documentSpecs.find((s) => s.id === state?.specId);
  const attachedTone = tones.find((tone) => tone.id === state?.toneId);
  const isBusy = isRunning || assessing || uploadingBasis;

  // Stray typing and pasting land in the instruction composer. Unlike the
  // bulk-paste fields, a wall of text here is almost always material the
  // instruction refers to rather than the instruction itself, so it is held
  // beside the composer and folded back in at run time.
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  const composerBlocked = isBusy || hasUnresolvedEdits;
  const {
    chips,
    hasChips,
    attachPastedText,
    removeChip,
    clearChips,
    composeWithChips,
  } = usePastedTextChips();
  const appendInstruction = useCallback(
    (text: string) => setInstruction((prev) => prev + text),
    [],
  );
  useAutoFocusComposer({
    textareaRef: instructionRef,
    enabled: !composerBlocked,
    append: appendInstruction,
  });
  usePasteComposer({
    textareaRef: instructionRef,
    enabled: !composerBlocked,
    append: appendInstruction,
    onAttach: attachPastedText,
  });

  const criteriaItems = useMemo(() => {
    const builtins = availableDocumentCriteria({
      hasSpec: !!attachedSpec,
      hasTone: !!attachedTone,
    }).map((c) => ({
      id: c.id as string,
      label: t(`document.criteria.${c.labelKey}.label`),
      description: t(`document.criteria.${c.descriptionKey}.description`),
    }));
    const custom = documentCriteria.map((c) => ({
      id: c.id,
      label: c.name,
      description: c.rubric,
    }));
    return [...builtins, ...custom];
  }, [attachedSpec, attachedTone, documentCriteria, t]);

  const resolveCriterionLabel = useCallback(
    (id: string) => {
      if (isCustomCriterionId(id)) {
        return (
          assessment?.labels?.[id] ??
          documentCriteria.find((c) => c.id === id)?.name ??
          id
        );
      }
      return t(`document.criteria.${id}.label`);
    },
    [assessment?.labels, documentCriteria, t],
  );

  const appendRailMessages = useCallback(
    (userText: string, assistantText: string) => {
      const conv = useConversationStore
        .getState()
        .conversations.find((c) => c.id === conversationId);
      if (!conv) return;
      const userMessage: Message = {
        id: uuidv4(),
        role: 'user',
        content: userText,
        messageType: MessageType.TEXT,
      };
      const assistantMessage: Message = {
        id: uuidv4(),
        role: 'assistant',
        content: assistantText,
        messageType: MessageType.TEXT,
      };
      updateConversation(conversationId, {
        messages: [...conv.messages, userMessage, assistantMessage],
      });
    },
    [conversationId, updateConversation],
  );

  /** Spec/tone/guidance travel inline with every writing request. */
  const buildWritingConstraints = useCallback(() => {
    const qualityGuidance = [...selectedCriteria]
      .map((id) => {
        const builtin = DOCUMENT_QUALITY_CRITERIA.find((c) => c.id === id);
        if (builtin) {
          return { name: builtin.id, rubric: builtin.promptDescription };
        }
        const custom = documentCriteria.find((c) => c.id === id);
        return custom ? { name: custom.name, rubric: custom.rubric } : null;
      })
      .filter((g): g is { name: string; rubric: string } => g !== null);
    return {
      spec: attachedSpec,
      tone: attachedTone
        ? {
            name: attachedTone.name,
            voiceRules: attachedTone.voiceRules,
            examples: attachedTone.examples,
          }
        : undefined,
      qualityGuidance,
    };
  }, [selectedCriteria, documentCriteria, attachedSpec, attachedTone]);

  const handleRun = useCallback(async () => {
    // Held pastes are part of the instruction, so a chip alone is enough to
    // run — "rewrite this" with the material attached is a complete request.
    if (
      (!instruction.trim() && !hasChips) ||
      isBusy ||
      hasUnresolvedEdits ||
      !state
    ) {
      return;
    }
    const trimmed = composeWithChips(instruction);
    clearError(conversationId);

    const mode: 'generate' | 'revise' = hasDocument ? 'revise' : 'generate';
    // Selection scope only applies to revisions of an existing document.
    const scopedSelection = mode === 'revise' ? selection : null;
    snapshotRef.current = docHtml;
    // Selection revisions land atomically on completion — no streaming
    // preview (the preview would misleadingly replace the whole document).
    if (!scopedSelection) setStreamHtml(hasDocument ? docHtml : '');

    const references = state.references
      .map((ref) => ({
        name: ref.name,
        text: referenceTexts.current.get(ref.fileId) ?? '',
      }))
      .filter((ref) => ref.text.length > 0);

    let finalMarkdown = '';
    try {
      await runWorkflowStream({
        conversationId,
        url: '/api/workflows/document',
        body: {
          instruction: trimmed,
          mode,
          currentDocMarkdown: hasDocument ? htmlToMarkdown(docHtml) : undefined,
          selection: scopedSelection?.text,
          references,
          ...buildWritingConstraints(),
          modelId: conversation?.model?.id,
        },
        onText: (fullText) => {
          finalMarkdown = fullText;
          if (scopedSelection) return; // atomic replace on completion
          const now = Date.now();
          if (now - lastRenderRef.current >= STREAM_RENDER_INTERVAL_MS) {
            lastRenderRef.current = now;
            setStreamHtml(markdownToHtml(fullText));
          }
        },
      });

      let html: string;
      if (scopedSelection) {
        // Replace exactly the selected range in the live editor, then
        // persist the editor's resulting HTML.
        const replaced = editorRef.current?.replaceRange(
          scopedSelection.from,
          scopedSelection.to,
          markdownToHtml(finalMarkdown),
        );
        html = replaced ?? docHtml;
        setSelection(null);
      } else {
        html = markdownToHtml(finalMarkdown);
      }
      const title =
        (scopedSelection ? undefined : extractTitle(finalMarkdown)) ||
        state.title;
      updateWorkflowState(conversationId, (prev) => {
        const p = prev as DocumentWorkflowState;
        return {
          ...p,
          docHtml: html,
          title,
          revisions: [
            ...p.revisions,
            {
              id: uuidv4(),
              instruction: trimmed,
              at: new Date().toISOString(),
            },
          ],
          // A full rewrite invalidates the previous assessment record.
          assessment: undefined,
          updatedAt: new Date().toISOString(),
        };
      });
      // The document's own heading is authoritative once it exists, so it
      // upgrades a name taken from a reference upload — but never one the
      // user typed. No sample: there is nothing for a titler to improve on.
      if (title) {
        nameWorkflowConversation(conversationId, {
          label: title,
          workflow: 'Document',
        });
      }
      appendRailMessages(
        trimmed,
        scopedSelection
          ? t('document.revisedSelectionSummary')
          : mode === 'generate'
            ? t('document.generatedSummary')
            : t('document.revisedSummary'),
      );
      setInstruction('');
      clearChips();
      setStreamHtml(null);
    } catch {
      // Run store carries the error; restore the pre-run document view.
      setStreamHtml(null);
    }
  }, [
    instruction,
    hasChips,
    composeWithChips,
    clearChips,
    isBusy,
    hasUnresolvedEdits,
    state,
    hasDocument,
    docHtml,
    selection,
    conversationId,
    conversation,
    runWorkflowStream,
    updateWorkflowState,
    appendRailMessages,
    buildWritingConstraints,
    clearError,
    t,
  ]);

  const handleEditorChange = useCallback(
    (html: string) => {
      if (isRunning || hasUnresolvedEdits) return;
      updateWorkflowState(conversationId, (prev) => ({
        ...(prev as DocumentWorkflowState),
        docHtml: html,
        updatedAt: new Date().toISOString(),
      }));
    },
    [conversationId, isRunning, hasUnresolvedEdits, updateWorkflowState],
  );

  const handleAssess = useCallback(async () => {
    if (!state || isBusy || hasUnresolvedEdits) return;
    if (!hasDocument || selectedCriteria.size === 0) return;
    setAssessError(null);
    setAssessing(true);
    try {
      const docMarkdown = htmlToMarkdown(docHtml);
      const hash = stringHash(docMarkdown);
      const freshProfile =
        state.profile && state.profile.contentHash === hash
          ? state.profile
          : undefined;
      // Only criteria that are currently available (spec/tone gating).
      const availableIds = new Set(criteriaItems.map((c) => c.id));
      const criteria = [...selectedCriteria].filter((id) =>
        availableIds.has(id),
      );
      const customDefs = criteria
        .filter(isCustomCriterionId)
        .map((id) => documentCriteria.find((c) => c.id === id))
        .filter((c): c is NonNullable<typeof c> => !!c)
        .map((c) => ({ id: c.id, name: c.name, rubric: c.rubric }));
      const constraints = buildWritingConstraints();

      const result = await assessDocument({
        docMarkdown,
        selection: selection?.text,
        criteria,
        customCriteria: customDefs,
        spec: criteria.includes('specAdherence') ? attachedSpec : undefined,
        tone: criteria.includes('toneAdherence') ? constraints.tone : undefined,
        profile: freshProfile,
        modelId: conversation?.model?.id,
      });

      const labels: Record<string, string> = {};
      for (const def of customDefs) labels[def.id] = def.name;

      updateWorkflowState(conversationId, (prev) => ({
        ...(prev as DocumentWorkflowState),
        profile: { ...result.profile, contentHash: hash },
        assessment: {
          id: uuidv4(),
          criteria: result.criteria,
          overallSummary: result.overallSummary,
          edits: result.edits.map((edit) => ({
            ...edit,
            id: uuidv4(),
            status: 'pending' as const,
          })),
          docMarkdown,
          scope: selection ? ('selection' as const) : ('document' as const),
          selectionText: selection?.text,
          labels,
          createdAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      }));
      setReviewOpen(true);
      appendRailMessages(
        t('document.railAssessRequest'),
        t('document.railAssessDone', {
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
    isBusy,
    hasUnresolvedEdits,
    hasDocument,
    selectedCriteria,
    selection,
    docHtml,
    criteriaItems,
    documentCriteria,
    attachedSpec,
    buildWritingConstraints,
    conversation?.model?.id,
    conversationId,
    updateWorkflowState,
    appendRailMessages,
    t,
  ]);

  /** Accept/reject one edit atomically against the markdown snapshot. */
  const resolveEdit = useCallback(
    (editId: string, decision: 'accepted' | 'rejected') => {
      updateWorkflowState(conversationId, (prev) => {
        const p = prev as DocumentWorkflowState;
        if (!p.assessment) return p;
        const edit = p.assessment.edits.find((e) => e.id === editId);
        if (!edit || edit.status !== 'pending') return p;

        let docMarkdown = p.assessment.docMarkdown;
        let status: ReviewEditStatus = decision;
        let html = p.docHtml;
        let title = p.title;
        if (decision === 'accepted') {
          const outcome = applyEdit(docMarkdown, edit);
          if (outcome.applied) {
            docMarkdown = outcome.text;
            html = markdownToHtml(docMarkdown);
            title = extractTitle(docMarkdown) || title;
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
          docHtml: html,
          title,
          assessment: {
            ...p.assessment,
            docMarkdown,
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
   * text change undone by applying the inverse patch to the markdown
   * snapshot; when that patch can no longer be located (a later edit
   * overwrote it, or it was a pure deletion with nothing to search for) the
   * decision stands rather than the document being corrupted on a guess.
   */
  const revertEdit = useCallback(
    (editId: string) => {
      updateWorkflowState(conversationId, (prev) => {
        const p = prev as DocumentWorkflowState;
        if (!p.assessment) return p;
        const edit = p.assessment.edits.find((e) => e.id === editId);
        if (!edit || edit.status === 'pending') return p;

        let docMarkdown = p.assessment.docMarkdown;
        let html = p.docHtml;
        let title = p.title;
        if (edit.status === 'accepted') {
          const inverse = invertPatch(edit);
          if (!inverse) return p;
          const outcome = applyEdit(docMarkdown, inverse);
          if (!outcome.applied) return p;
          docMarkdown = outcome.text;
          html = markdownToHtml(docMarkdown);
          title = extractTitle(docMarkdown) || title;
        }
        return {
          ...p,
          docHtml: html,
          title,
          assessment: {
            ...p.assessment,
            docMarkdown,
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

  /** Drops the decision record, leaving only edits still awaiting a call. */
  const clearResolved = useCallback(() => {
    updateWorkflowState(conversationId, (prev) => {
      const p = prev as DocumentWorkflowState;
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
        const p = prev as DocumentWorkflowState;
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

        const result = applyEditsInOrder(p.assessment.docMarkdown, pending);
        const failed = new Set(result.failedIds);
        return {
          ...p,
          docHtml: markdownToHtml(result.text),
          title: extractTitle(result.text) || p.title,
          assessment: {
            ...p.assessment,
            docMarkdown: result.text,
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

  /** Empty-state entry: an uploaded file becomes the document basis. */
  const handleUploadBasis = useCallback(
    async (files: FileList | null) => {
      const file = files?.[0];
      if (!file || hasDocument) return;
      setAssessError(null);
      setUploadingBasis(true);
      try {
        const extracted = await uploadAndExtractText(file);
        if (!extracted.text.trim()) {
          throw new Error(t('document.referenceEmpty', { name: file.name }));
        }
        const html = await autoConvertToHtml(extracted.text, file.name);
        const docMarkdown = htmlToMarkdown(html);
        const basisTitle =
          extractTitle(docMarkdown) || file.name.replace(/\.[^.]+$/, '');
        updateWorkflowState(conversationId, (prev) => ({
          ...(prev as DocumentWorkflowState),
          docHtml: html,
          title: basisTitle,
          updatedAt: new Date().toISOString(),
        }));
        // The uploaded document's own heading is the name to use.
        nameWorkflowConversation(conversationId, {
          label: basisTitle,
          workflow: 'Document',
        });
        // Agentic pre-assessment of the basis (profile-only run).
        const result = await assessDocument({
          docMarkdown,
          criteria: [],
          modelId: conversation?.model?.id,
        });
        updateWorkflowState(conversationId, (prev) => ({
          ...(prev as DocumentWorkflowState),
          profile: {
            ...result.profile,
            contentHash: stringHash(docMarkdown),
          },
          updatedAt: new Date().toISOString(),
        }));
      } catch (err) {
        setAssessError(
          err instanceof Error ? err.message : t('document.uploadFailed'),
        );
      } finally {
        setUploadingBasis(false);
        if (basisInputRef.current) basisInputRef.current.value = '';
      }
    },
    [
      hasDocument,
      conversationId,
      conversation?.model?.id,
      updateWorkflowState,
      t,
    ],
  );

  const handleExport = useCallback(
    async (format: ExportFormat) => {
      setExportOpen(false);
      if (!hasDocument) return;
      const baseName = (state?.title || 'document').replace(
        /[/\\:*?"<>|]/g,
        '-',
      );
      const safeHtml = await sanitizeHtmlForExport(docHtml);
      switch (format) {
        case 'md':
          downloadFile(
            htmlToMarkdown(safeHtml),
            `${baseName}.md`,
            'text/markdown',
          );
          break;
        case 'html':
          downloadFile(safeHtml, `${baseName}.html`, 'text/html');
          break;
        case 'txt':
          downloadFile(
            await htmlToPlainText(safeHtml),
            `${baseName}.txt`,
            'text/plain',
          );
          break;
        case 'docx':
          await exportToDOCX(safeHtml, `${baseName}.docx`);
          break;
        case 'pdf':
          await exportToPDF(safeHtml, `${baseName}.pdf`);
          break;
      }
    },
    [docHtml, hasDocument, state?.title],
  );

  const addReference = useCallback(
    (reference: DocumentReference, text: string) => {
      referenceTexts.current.set(reference.fileId, text);
      updateWorkflowState(conversationId, (prev) => {
        const p = prev as DocumentWorkflowState;
        if (p.references.some((r) => r.fileId === reference.fileId)) return p;
        return {
          ...p,
          references: [...p.references, reference],
          updatedAt: new Date().toISOString(),
        };
      });
      // Provisional name from the first reference. A later generate run
      // upgrades it to the document's own heading, which is the better
      // title once one exists.
      nameWorkflowConversation(conversationId, {
        label: reference.name,
        sample: text,
        workflow: 'Document',
      });
    },
    [conversationId, updateWorkflowState],
  );

  const removeReference = useCallback(
    (fileId: string) => {
      referenceTexts.current.delete(fileId);
      updateWorkflowState(conversationId, (prev) => {
        const p = prev as DocumentWorkflowState;
        return {
          ...p,
          references: p.references.filter((r) => r.fileId !== fileId),
          updatedAt: new Date().toISOString(),
        };
      });
    },
    [conversationId, updateWorkflowState],
  );

  const editorHtml = useMemo(
    () => (streamHtml !== null ? streamHtml : docHtml),
    [streamHtml, docHtml],
  );

  const attachSpec = useCallback(
    (specId: string) => {
      updateWorkflowState(conversationId, (prev) => ({
        ...(prev as DocumentWorkflowState),
        specId: specId || undefined,
        updatedAt: new Date().toISOString(),
      }));
      // Conditional criterion follows the attachment (default ON).
      setSelectedCriteria((prev) => {
        const next = new Set(prev);
        if (specId) next.add('specAdherence');
        else next.delete('specAdherence');
        return next;
      });
    },
    [conversationId, updateWorkflowState],
  );

  const attachTone = useCallback(
    (toneId: string) => {
      updateWorkflowState(conversationId, (prev) => ({
        ...(prev as DocumentWorkflowState),
        toneId: toneId || undefined,
        updatedAt: new Date().toISOString(),
      }));
      setSelectedCriteria((prev) => {
        const next = new Set(prev);
        if (toneId) next.add('toneAdherence');
        else next.delete('toneAdherence');
        return next;
      });
    },
    [conversationId, updateWorkflowState],
  );

  if (!state) return null;

  const selectClass =
    'min-h-[32px] max-w-[150px] truncate rounded-lg border border-gray-300 bg-transparent px-2 py-1 text-xs text-gray-700 disabled:opacity-50 dark:border-gray-700 dark:bg-surface-dark dark:text-gray-300';

  const controlsStrip = (
    <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-1.5 dark:border-gray-700">
      {/* Pickers render only when there is something to pick; the manage
          buttons are the add paths. */}
      {documentSpecs.length > 0 && (
        <select
          value={state.specId ?? ''}
          onChange={(e) => attachSpec(e.target.value)}
          disabled={isBusy || hasUnresolvedEdits}
          aria-label={t('document.spec')}
          className={selectClass}
        >
          <option value="">{t('document.noSpec')}</option>
          {documentSpecs.map((spec) => (
            <option key={spec.id} value={spec.id}>
              {spec.name}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        onClick={() => {
          setSpecsOpen((open) => !open);
          setCriteriaOpen(false);
        }}
        aria-pressed={specsOpen}
        className="min-h-[32px] rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
      >
        {documentSpecs.length > 0
          ? t('document.manageSpecs')
          : t('document.addSpec')}
      </button>

      {tones.length > 0 && (
        <select
          value={state.toneId ?? ''}
          onChange={(e) => attachTone(e.target.value)}
          disabled={isBusy || hasUnresolvedEdits}
          aria-label={t('document.tone')}
          className={selectClass}
        >
          <option value="">{t('document.noTone')}</option>
          {tones.map((tone) => (
            <option key={tone.id} value={tone.id}>
              {tone.name}
            </option>
          ))}
        </select>
      )}

      <button
        type="button"
        onClick={() => {
          setCriteriaOpen((open) => !open);
          setSpecsOpen(false);
        }}
        aria-pressed={criteriaOpen}
        className="ms-auto min-h-[32px] rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
      >
        {documentCriteria.length > 0
          ? t('document.manageCriteria')
          : t('document.addCriteria')}
      </button>
    </div>
  );

  const selectionWordCount = selection
    ? selection.text.trim().split(/\s+/).length
    : 0;
  /** Scope is always explicit: full document vs the active selection. */
  const scopeChip = (
    <span
      className={`inline-flex min-h-[24px] max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        selection
          ? 'bg-blue-600 text-white'
          : 'bg-gray-100 text-gray-600 dark:bg-surface-dark-elevated dark:text-gray-400'
      }`}
    >
      {selection ? (
        <>
          <span className="truncate">
            {t('document.scopeSelection', {
              preview: selection.text.trim().slice(0, 24),
              count: String(selectionWordCount),
            })}
          </span>
          <button
            type="button"
            onClick={() => setSelection(null)}
            aria-label={t('document.clearSelection')}
            className="rounded-full p-0.5 hover:bg-blue-700"
          >
            <IconX size={11} aria-hidden />
          </button>
        </>
      ) : (
        t('document.scopeFullDocument')
      )}
    </span>
  );

  const composer = (
    <div className="border-t border-gray-200 p-3 dark:border-gray-700">
      {run?.error && (
        <p className="mb-2 text-sm text-red-700 dark:text-red-400" role="alert">
          {t('document.runFailed', { message: run.error })}
        </p>
      )}
      {hasDocument && <div className="mb-1.5">{scopeChip}</div>}
      <PastedTextChips chips={chips} onRemove={removeChip} />
      <div className="flex items-end gap-2">
        <textarea
          ref={instructionRef}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleRun();
            }
          }}
          rows={2}
          disabled={isBusy || hasUnresolvedEdits}
          title={
            hasUnresolvedEdits
              ? t('document.editingBlockedPendingEdits')
              : undefined
          }
          placeholder={
            selection && hasDocument
              ? t('document.reviseSelectionPlaceholder')
              : hasDocument
                ? t('document.revisePlaceholder')
                : t('document.generatePlaceholder')
          }
          className="min-h-[44px] flex-1 resize-none rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none disabled:opacity-50 dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400"
        />
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
            onClick={() => void handleRun()}
            disabled={
              (!instruction.trim() && !hasChips) || isBusy || hasUnresolvedEdits
            }
            className="flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg bg-gray-300 px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-400 disabled:pointer-events-none disabled:opacity-30 dark:bg-surface-dark-base dark:text-white dark:hover:bg-surface-dark-elevated"
          >
            <IconSparkles size={15} aria-hidden />
            {hasDocument ? t('document.revise') : t('document.generate')}
          </button>
        )}
      </div>
      {isRunning && (
        <p className="mt-2 animate-pulse text-xs text-gray-500 dark:text-gray-400">
          {t('document.writing')}
        </p>
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-gray-200 px-3 py-1.5 dark:border-gray-700">
        <span className="truncate text-sm font-medium text-gray-700 dark:text-gray-300">
          {state.title || t('document.untitledDocument')}
        </span>
        <div className="relative">
          <button
            ref={exportButtonRef}
            type="button"
            onClick={() => setExportOpen((open) => !open)}
            disabled={!hasDocument || isRunning}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
          >
            <IconDownload size={15} aria-hidden />
            {t('document.export')}
          </button>
          <DropdownPortal
            triggerRef={exportButtonRef}
            isOpen={exportOpen}
            onClose={() => setExportOpen(false)}
          >
            <ExportFormatMenu
              onSelect={(format) => void handleExport(format)}
            />
          </DropdownPortal>
        </div>
      </div>
      {controlsStrip}
      <ReferencePanel
        references={state.references}
        onAdd={addReference}
        onRemove={removeReference}
        disabled={isBusy}
      />

      {/* Workbench: editor (+ assess strip) with the review column beside */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Empty-document hint: type directly, or start from a file. */}
          {!hasDocument && streamHtml === null && (
            <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-3 py-1.5 dark:border-gray-800">
              <p className="min-w-0 flex-1 truncate text-xs text-gray-500 dark:text-gray-400">
                {t('document.emptyHint')}
              </p>
              <button
                type="button"
                onClick={() => basisInputRef.current?.click()}
                disabled={isBusy}
                className="inline-flex min-h-[28px] shrink-0 items-center gap-1 rounded-lg px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
              >
                <IconFileImport size={13} aria-hidden />
                {uploadingBasis
                  ? t('document.uploading')
                  : t('document.uploadBasis')}
              </button>
              <input
                ref={basisInputRef}
                type="file"
                accept=".pdf,.doc,.docx,.txt,.md,.html"
                hidden
                onChange={(e) => void handleUploadBasis(e.target.files)}
              />
            </div>
          )}
          <div className="min-h-0 flex-1">
            <RichTextEditor
              ref={editorRef}
              contentHtml={editorHtml}
              onChange={handleEditorChange}
              editable={!isRunning && !assessing && !hasUnresolvedEdits}
              onSelectionUpdate={setSelection}
              previewEdits={previewEdits}
              activeEditId={preview.activeId}
              pinnedEditId={preview.pinnedId}
              onPinEdit={preview.setPinned}
              renderQuickActions={(position) =>
                preview.pinnedId && (
                  <EditQuickActions
                    editId={preview.pinnedId}
                    i18nNamespace="workflows.document"
                    position={position}
                    onAccept={(id) => resolveEdit(id, 'accepted')}
                    onReject={(id) => resolveEdit(id, 'rejected')}
                    disabled={isBusy}
                  />
                )
              }
            />
          </div>

          {/* Quality assessment controls */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-gray-200 px-3 py-2 dark:border-gray-700">
            {hasDocument && scopeChip}
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
              i18nNamespace="workflows.document"
              disabled={isBusy}
            />
            <span className="ms-auto flex items-center gap-2">
              {assessment && !reviewOpen && (
                <button
                  type="button"
                  onClick={() => setReviewOpen(true)}
                  className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
                >
                  {hasUnresolvedEdits
                    ? t('document.showReviewPending', {
                        count: String(
                          assessment.edits.filter((e) => e.status === 'pending')
                            .length,
                        ),
                      })
                    : t('document.showReview')}
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleAssess()}
                disabled={
                  isBusy || hasUnresolvedEdits || selectedCriteria.size === 0
                }
                title={
                  hasUnresolvedEdits
                    ? t('document.editingBlockedPendingEdits')
                    : undefined
                }
                className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg bg-gray-200 px-2.5 py-1 text-xs font-medium text-gray-900 hover:bg-gray-300 disabled:pointer-events-none disabled:opacity-30 dark:bg-surface-dark-elevated dark:text-gray-100 dark:hover:bg-gray-700"
              >
                <IconClipboardCheck size={14} aria-hidden />
                {assessing ? t('document.assessing') : t('document.assess')}
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
        </div>

        {/* Quality review column — the pending-edit queue lives beside the
            document, never buried below it. */}
        {assessment && reviewOpen && (
          <div className="flex max-h-80 shrink-0 flex-col border-t border-gray-200 dark:border-gray-700 lg:max-h-none lg:w-96 lg:border-s lg:border-t-0">
            <AssessmentPanel
              assessment={assessment}
              resolveCriterionLabel={resolveCriterionLabel}
              i18nNamespace="workflows.document"
              previewEditId={preview.activeId}
              onPreviewEdit={preview.setHovered}
              scopeLabel={
                assessment.scope === 'selection'
                  ? t('document.assessedSelection')
                  : undefined
              }
              onAccept={(id) => resolveEdit(id, 'accepted')}
              onReject={(id) => resolveEdit(id, 'rejected')}
              onAcceptAll={() => resolveAll('accepted')}
              onRejectAll={() => resolveAll('rejected')}
              onRevert={revertEdit}
              onClearResolved={clearResolved}
              autoClearResolved={autoClearResolvedEdits}
              onToggleAutoClear={setAutoClearResolvedEdits}
              onClose={() => setReviewOpen(false)}
              disabled={isBusy}
            />
          </div>
        )}
      </div>

      {/* Agentic pre-assessment strip (history/context, not actions) */}
      {state.profile && (
        <div className="max-h-40 shrink-0 overflow-y-auto">
          <DocumentProfilePanel profile={state.profile} />
        </div>
      )}

      {/* Managers */}
      {specsOpen && (
        <div className="h-72 shrink-0">
          <SpecManager onClose={() => setSpecsOpen(false)} />
        </div>
      )}
      {criteriaOpen && (
        <div className="h-72 shrink-0">
          <CriteriaManager
            criteria={documentCriteria}
            i18nNamespace="workflows.document"
            onCreate={addDocumentCriterion}
            onUpdate={updateDocumentCriterion}
            onDelete={deleteDocumentCriterion}
            onClose={() => setCriteriaOpen(false)}
          />
        </div>
      )}

      {composer}
    </div>
  );
}

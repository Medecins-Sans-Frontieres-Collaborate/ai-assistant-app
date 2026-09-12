'use client';

import {
  IconChecklist,
  IconClipboardCheck,
  IconDownload,
  IconFileText,
  IconLoader,
  IconPlus,
  IconSparkles,
  IconTableImport,
  IconTemplate,
  IconTrash,
} from '@tabler/icons-react';
import { useSession } from 'next-auth/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import {
  destinationToTarget,
  useM365Save,
  useM365SaveAvailable,
} from '@/client/hooks/document/useM365Save';
import { useAvailableFormTemplates } from '@/client/hooks/settings/useAvailableFormTemplates';
import { useSettings } from '@/client/hooks/settings/useSettings';
import { useM365Enabled } from '@/client/hooks/useM365Enabled';
import { useTableImport } from '@/client/hooks/workflows/useTableImport';

import {
  downloadDriveItem,
  saveToOneDrive,
} from '@/client/services/m365/m365Client';
import {
  fetchUrlContent,
  urlErrorKey,
} from '@/client/services/url/urlFetchClient';
import { uploadAndExtractText } from '@/client/services/workflows/fileTextExtraction';
import {
  base64ToBlob,
  downloadBlob,
  fillDocument,
  renderOriginal,
  searchWeb,
  validateDocument,
} from '@/client/services/workflows/form/formApi';
import {
  collectSourceTexts,
  forgetSourceText,
  rememberSourceText,
} from '@/client/services/workflows/form/sourceText';
import { appendWorkflowRailMessages } from '@/client/services/workflows/railMessages';
import { nameWorkflowConversation } from '@/client/services/workflows/workflowTitle';
import { detectLanguage } from '@/lib/services/languageDetection';
import { PrefillUser } from '@/lib/services/workflows/form/adminValues';
import {
  COMMON_LANGUAGES,
  languageNameFromCode,
} from '@/lib/services/workflows/form/language';
import {
  Clock,
  addNote,
  addSource,
  answerQuestion,
  applyValidation,
  attachTemplate,
  clearResolvedProposals,
  recordFillRun,
  removeDocument,
  removeSource,
  resolveAllProposals,
  resolveProposal,
  setFieldDecision,
  setFieldValue,
  setLanguage,
  skipQuestion,
  updateDocument,
} from '@/lib/services/workflows/form/ledger';
import {
  ProvenanceStrings,
  buildProvenanceJson,
  buildProvenanceMarkdown,
} from '@/lib/services/workflows/form/provenance';
import { selectQuestionMode } from '@/lib/services/workflows/form/questions';
import {
  documentsFromRows,
  tableFromDocuments,
} from '@/lib/services/workflows/form/records';
import {
  exportBaseName,
  renderLayout,
  valuesForFill,
} from '@/lib/services/workflows/form/render';
import {
  coverageOf,
  fieldStatus,
  openFieldIds,
} from '@/lib/services/workflows/form/status';
import { formatValue } from '@/lib/services/workflows/form/validation';

import { createWorkflowConversation } from '@/lib/utils/app/conversationInit';
import {
  downloadFile,
  exportToDOCX,
  exportToPDF,
  sanitizeHtmlForExport,
} from '@/lib/utils/shared/document/exportUtils';
import { markdownToHtml } from '@/lib/utils/shared/document/formatConverter';

import {
  FORM_LIMITS,
  FieldValue,
  FillSourceRecord,
  FormDocument,
  FormFillWorkflowState,
  FormTemplate,
  SOURCE_TEXT_STATE_CAP,
} from '@/types/formFill';
import { M365DriveEntry, M365SaveDestination } from '@/types/m365';
import { ReviewEdit } from '@/types/workflow';

import M365FilePickerModal from '@/components/Chat/ChatInput/M365FilePickerModal';

import { AssessmentPanel } from '../Shared/Review/AssessmentPanel';
import { createInitialWorkflowState } from '../initialState';
import { WorkflowWorkspaceProps } from '../registry';
import { CopyView } from './CopyView';
import { DocumentPreview } from './DocumentPreview';
import { FieldDetail } from './FieldDetail';
import { FieldLedger } from './FieldLedger';
import { QuestionsPanel } from './QuestionsPanel';
import { SourcesBar } from './SourcesBar';
import { TemplateManager } from './TemplateManager';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { strToU8, zipSync } from 'fflate';
import { v4 as uuidv4 } from 'uuid';

type RightPane = 'detail' | 'review' | 'templates';
type PreviewTab = 'document' | 'copy';

const clock: Clock = {
  now: () => new Date().toISOString(),
  mintId: () => uuidv4(),
};

const toolbarButton =
  'inline-flex min-h-[36px] items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-surface-dark-elevated';

/**
 * The form-fill workspace (docs/FORM_FILL_WORKFLOW.md): sources on top, the
 * ledger on the left, the rendered document / copy view on the right, and
 * an exclusive right pane for the field detail, the proposal review queue,
 * or the template manager. The ledger is canonical; every output is a
 * projection of it.
 */
export function FormWorkspace({ conversationId }: WorkflowWorkspaceProps) {
  const t = useTranslations('workflows.form');
  const conversation = useConversationStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const updateWorkflowState = useConversationStore(
    (s) => s.updateWorkflowState,
  );
  const state =
    conversation?.workflowState?.kind === 'form-fill'
      ? (conversation.workflowState as FormFillWorkflowState)
      : undefined;
  const document = state?.documents.find(
    (d) => d.id === state.activeDocumentId,
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rightPane, setRightPane] = useState<RightPane | null>(null);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [previewTab, setPreviewTab] = useState<PreviewTab>('document');
  const [exportOpen, setExportOpen] = useState(false);
  const [questionsOpen, setQuestionsOpen] = useState(true);
  const exportRef = useRef<HTMLDivElement>(null);
  const [m365PickerOpen, setM365PickerOpen] = useState(false);
  const rowsInput = useRef<HTMLInputElement>(null);
  const { importFile } = useTableImport();
  const { addConversation } = useConversations();
  const { defaultModelId, models, temperature, systemPrompt } = useSettings();
  const m365Save = useM365Save();
  const m365SaveAvailable = useM365SaveAvailable();
  /** A binary export waiting for a OneDrive folder pick. */
  const [pendingSave, setPendingSave] = useState<{
    blob: Blob;
    name: string;
  } | null>(null);
  const { data: session } = useSession();
  const { filesEnabled } = useM365Enabled();
  const m365Connected = useSettingsStore((s) => s.m365Connected);
  const m365Available = filesEnabled && m365Connected;
  const { templates: adminTemplates } = useAvailableFormTemplates();
  const prefillUser = useMemo<PrefillUser | undefined>(() => {
    const user = session?.user as
      | {
          displayName?: string;
          mail?: string;
          department?: string;
          jobTitle?: string;
          officeName?: string | null;
        }
      | undefined;
    if (!user) return undefined;
    return {
      displayName: user.displayName,
      email: user.mail,
      department: user.department,
      jobTitle: user.jobTitle,
      officeLocation: user.officeName ?? undefined,
    };
  }, [session]);

  useEffect(() => {
    if (!exportOpen) return;
    const close = (e: MouseEvent) => {
      if (!exportRef.current?.contains(e.target as Node)) setExportOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [exportOpen]);

  const modelId = conversation?.model?.id;

  const setState = useCallback(
    (updater: (prev: FormFillWorkflowState) => FormFillWorkflowState) => {
      updateWorkflowState(conversationId, (prev) => {
        if (prev?.kind === 'form-fill') return updater(prev);
        // No workflow state yet: apply the mutation to a fresh one rather
        // than dropping it. A state of another kind is left for the store
        // to refuse (kind mismatch).
        if (!prev) {
          return updater(
            createInitialWorkflowState('form-fill') as FormFillWorkflowState,
          );
        }
        return prev;
      });
    },
    [conversationId, updateWorkflowState],
  );
  const setDocument = useCallback(
    (updater: (doc: FormDocument) => FormDocument) => {
      if (!document) return;
      setState((prev) =>
        updateDocument(prev, document.id, updater, clock.now()),
      );
    },
    [document, setState],
  );

  /* ---------------- templates & documents ---------------- */

  const handleUse = useCallback(
    (template: FormTemplate) => {
      if ((state?.documents.length ?? 0) >= FORM_LIMITS.MAX_DOCUMENTS) {
        setNotice(
          t('importRowsSkipped', {
            count: '1',
            max: String(FORM_LIMITS.MAX_DOCUMENTS),
          }),
        );
        return;
      }
      setState((prev) =>
        attachTemplate(prev, template, {
          language:
            template.language ??
            prev.sources.find((s) => s.language)?.language ??
            'English',
          clock,
          prefillUser,
        }),
      );
      nameWorkflowConversation(conversationId, {
        label: template.name,
        workflow: 'Form',
      });
      setRightPane(null);
      setSelectedFieldId(null);
    },
    [conversationId, setState, prefillUser, state?.documents.length, t],
  );

  /* ---------------- search & M365 ---------------- */

  const handleSearch = async (query: string) => {
    setError(null);
    setBusy(t('searching'));
    try {
      const result = await searchWeb({ query, conversationId });
      const id = uuidv4();
      const text = result.text.slice(0, SOURCE_TEXT_STATE_CAP);
      rememberSourceText(id, text);
      setState((prev) =>
        addSource(prev, {
          id,
          kind: 'search',
          name: t('searchSourceName', { query }),
          query,
          chars: text.length,
          text,
          citations: result.citations,
          addedAt: clock.now(),
        }),
      );
      appendWorkflowRailMessages(
        conversationId,
        t('railSearchRequest', { query }),
        t('railSearchDone', { count: String(result.citations.length) }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : t('searchFailed');
      setError(
        message.includes('SEARCH_UNAVAILABLE')
          ? t('searchUnavailable')
          : message,
      );
    } finally {
      setBusy(null);
    }
  };

  const handleM365Pick = async (entry: M365DriveEntry) => {
    setM365PickerOpen(false);
    setError(null);
    setBusy(t('uploading'));
    try {
      const { blob, name, webUrl } = await downloadDriveItem(
        entry.driveId,
        entry.itemId,
      );
      const file = new File([blob], name || entry.name, {
        type: blob.type || entry.mimeType || 'application/octet-stream',
      });
      const extracted = await uploadAndExtractText(file);
      if (!extracted.text.trim()) throw new Error(t('uploadFailed'));
      const id = uuidv4();
      rememberSourceText(id, extracted.text);
      setState((prev) =>
        addSource(prev, {
          id,
          kind: 'm365',
          name: name || entry.name,
          fileId: extracted.url || undefined,
          url: webUrl ?? entry.webUrl,
          chars: extracted.text.length,
          language: undefined,
          addedAt: clock.now(),
        }),
      );
      void detectName(extracted.text).then((language) => {
        if (!language) return;
        setState((prev) => ({
          ...prev,
          sources: prev.sources.map((s) =>
            s.id === id ? { ...s, language } : s,
          ),
        }));
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('uploadFailed'));
    } finally {
      setBusy(null);
    }
  };

  /* ---------------- validate ---------------- */

  const handleValidate = async () => {
    if (!document) return;
    setError(null);
    setNotice(null);
    setBusy(t('validating'));
    try {
      const result = await validateDocument({
        template: document.template,
        language: document.language,
        fields: document.fields,
        modelId,
        conversationId,
      });
      setDocument((doc) => applyValidation(doc, result, clock.now()));
      setNotice(
        t('validateDone', {
          fields: String(Object.keys(result.fields).length),
          rules: String(result.rules.length),
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : t('validateFailed');
      setError(
        message.includes('NOTHING_TO_VALIDATE')
          ? t('validateNothing')
          : message,
      );
    } finally {
      setBusy(null);
    }
  };

  /* ---------------- sources ---------------- */

  const detectName = async (text: string): Promise<string | undefined> => {
    try {
      const result = await detectLanguage(text.slice(0, 4_000));
      return result.confidence >= 0.5
        ? languageNameFromCode(result.language)
        : undefined;
    } catch {
      return undefined;
    }
  };

  const handleAddFile = async (file: File) => {
    setError(null);
    setBusy(t('uploading'));
    try {
      const extracted = await uploadAndExtractText(file);
      if (!extracted.text.trim()) throw new Error(t('uploadFailed'));
      const id = uuidv4();
      rememberSourceText(id, extracted.text);
      const record: FillSourceRecord = {
        id,
        kind: 'file',
        name: file.name,
        fileId: extracted.url || undefined,
        chars: extracted.text.length,
        language: await detectName(extracted.text),
        addedAt: clock.now(),
      };
      setState((prev) => addSource(prev, record));
      nameWorkflowConversation(conversationId, {
        label: file.name,
        workflow: 'Form',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('uploadFailed'));
    } finally {
      setBusy(null);
    }
  };

  const handleAddUrl = async (url: string) => {
    setError(null);
    setBusy(t('uploading'));
    try {
      const result = await fetchUrlContent(url, { modelId });
      const id = uuidv4();
      if (result.ok) {
        rememberSourceText(id, result.page.text);
        setState((prev) =>
          addSource(prev, {
            id,
            kind: 'url',
            name: result.page.title || result.page.resolvedUrl,
            url: result.page.resolvedUrl,
            chars: result.page.text.length,
            addedAt: clock.now(),
          }),
        );
        void detectName(result.page.text).then((language) => {
          if (!language) return;
          setState((prev) => ({
            ...prev,
            sources: prev.sources.map((s) =>
              s.id === id ? { ...s, language } : s,
            ),
          }));
        });
      } else {
        // Kept, marked — the same rule as document references: a failed
        // fetch must stay visible, not silently vanish.
        setState((prev) =>
          addSource(prev, {
            id,
            kind: 'url',
            name: url,
            url,
            chars: 0,
            addedAt: clock.now(),
            error: urlErrorKey(result.code),
          }),
        );
      }
    } finally {
      setBusy(null);
    }
  };

  const handleAddNote = (text: string, questionId?: string) => {
    let noteId: string | undefined;
    setState((prev) => {
      const result = addNote(prev, text, { clock, questionId });
      rememberSourceText(result.note.sourceId, result.note.text);
      noteId = result.note.id;
      return result.state;
    });
    return noteId;
  };

  const handleRemoveSource = (sourceId: string) => {
    forgetSourceText(sourceId);
    setState((prev) => removeSource(prev, sourceId, clock.now()));
  };

  /* ---------------- fill ---------------- */

  const runFill = useCallback(
    async (targetFieldIds: string[]) => {
      if (!state || !document) return;
      // Read the LIVE state: a caller may have just written a note (an
      // answer to a question) that this render's closure predates.
      const liveState = (() => {
        const ws = useConversationStore
          .getState()
          .conversations.find((c) => c.id === conversationId)?.workflowState;
        return ws?.kind === 'form-fill' ? ws : state;
      })();
      const liveDocument =
        liveState.documents.find((d) => d.id === document.id) ?? document;
      const targets = targetFieldIds.filter((id) => {
        const field = liveDocument.template.fields.find((f) => f.id === id);
        if (!field || field.admin?.locked) return false;
        const { status } = fieldStatus(field, liveDocument.fields[id]);
        return status !== 'confirmed' && status !== 'not_applicable';
      });
      if (targets.length === 0) {
        setNotice(t('fillNoTargets'));
        return;
      }
      setError(null);
      setNotice(null);
      setBusy(t('filling'));
      try {
        const { available, unavailable } = await collectSourceTexts(
          liveState.sources,
          liveState.notes,
        );
        const notes = liveState.notes.map((n) => ({
          id: n.sourceId,
          text: n.text,
        }));
        // No material is allowed: the run then yields no values and the
        // assistant's GENERAL questions about the subject (§6a).
        if (available.length === 0 && notes.length === 0) {
          setNotice(t('askQuestionsHint'));
        }
        const mode = selectQuestionMode(
          liveDocument,
          available.length + notes.length,
        );
        const result = await fillDocument({
          template: document.template,
          language: document.language,
          fields: document.fields,
          targetFieldIds: targets,
          sources: available.slice(0, 12),
          notes,
          mode,
          modelId,
          conversationId,
        });
        setDocument((doc) =>
          recordFillRun(
            doc,
            {
              proposals: result.proposals,
              questions: result.questions,
              targetFieldIds: result.targetFieldIds,
              sourceIds: [...result.sourceIds, ...notes.map((n) => n.id)],
              modelId,
              mode,
            },
            clock,
          ),
        );
        const labels = targets
          .map(
            (id) =>
              document.template.fields.find((f) => f.id === id)?.label ?? id,
          )
          .slice(0, 6)
          .join(', ');
        appendWorkflowRailMessages(
          conversationId,
          t('railFillRequest', { fields: labels }),
          result.proposals.length > 0
            ? t('railFillDone', {
                count: String(result.proposals.length),
                sources: String(available.length + notes.length),
              })
            : t('railFillNone'),
        );
        if (unavailable.length > 0) {
          setNotice(
            `${t('sourceFailed')}: ${unavailable.map((s) => s.name).join(', ')}`,
          );
        }
        if (result.proposals.length > 0) setRightPane('review');
      } catch (err) {
        setError(err instanceof Error ? err.message : t('fillFailed'));
      } finally {
        setBusy(null);
      }
    },
    [state, document, t, modelId, conversationId, setDocument],
  );

  /* ---------------- review queue ---------------- */

  const reviewAssessment = useMemo(() => {
    if (!document) return null;
    const edits: ReviewEdit[] = document.proposals.map((p) => {
      const field = document.template.fields.find((f) => f.id === p.fieldId);
      const before = formatValue(document.fields[p.fieldId]?.value);
      const after = p.value === null ? before : formatValue(p.value);
      const reasonParts = [
        t('proposalReason', {
          confidence: t(`confidenceLevel.${p.confidence}`),
          gaps: p.gaps ?? '',
        }).trim(),
      ];
      if (p.provenance.length === 0 && !p.generalKnowledge) {
        reasonParts.push(t('noProvenance'));
      }
      return {
        id: p.id,
        criterion: p.fieldId,
        before,
        after,
        reason: reasonParts.join(' '),
        severity: field?.required ? 'major' : 'minor',
        status: p.status,
      };
    });
    return { criteria: [], overallSummary: '', edits };
  }, [document, t]);
  const pendingCount =
    document?.proposals.filter((p) => p.status === 'pending').length ?? 0;
  const pendingByField = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of document?.proposals ?? []) {
      if (p.status === 'pending')
        map.set(p.fieldId, (map.get(p.fieldId) ?? 0) + 1);
    }
    return map;
  }, [document?.proposals]);

  /* ---------------- export ---------------- */

  const provenanceStrings = useMemo<ProvenanceStrings>(() => {
    const p = (key: string, params?: Record<string, string>) =>
      t(`provenanceDoc.${key}`, params ?? {});
    return {
      title: p('title'),
      generatedAt: p('generatedAt'),
      template: p('template'),
      language: p('language'),
      runs: p('runs'),
      runLine: (at, model, fields, sources) =>
        p('runLine', {
          at,
          model,
          fields: String(fields),
          sources: String(sources),
        }),
      sources: p('sources'),
      noSources: p('noSources'),
      sourceLine: (source) =>
        `${p(`sourceKind.${source.kind}`)}: ${source.name}${source.url ? ` — ${source.url}` : ''}${source.language ? ` (${source.language})` : ''}${source.error ? ` — ${t('sourceFailed')}` : ''}`,
      fields: p('fields'),
      status: {
        label: p('status'),
        empty: t('status.empty'),
        partial: t('status.partial'),
        filled: t('status.filled'),
        confirmed: t('status.confirmed'),
        not_applicable: t('status.not_applicable'),
      },
      confidence: p('confidence'),
      issues: p('issues'),
      issueText: (issue) => t(`issue.${issue.code}`, issue.params ?? {}),
      gaps: p('gaps'),
      supportedBy: p('supportedBy'),
      unsourced: p('unsourced'),
      generalKnowledge: p('generalKnowledge'),
      lockedByAdmin: p('lockedByAdmin'),
      fromNote: p('fromNote'),
      openQuestions: p('openQuestions'),
      noOpenQuestions: p('noOpenQuestions'),
      notApplicableFields: p('notApplicableFields'),
      none: p('none'),
      value: p('value'),
      empty: p('empty'),
    };
  }, [t]);

  const handleExport = async (
    kind:
      | 'original'
      | 'md'
      | 'html'
      | 'docx'
      | 'pdf'
      | 'prov-md'
      | 'prov-json'
      | 'all-zip',
  ) => {
    setExportOpen(false);
    if (!document || !state) return;
    const base = exportBaseName(document.template.name);
    setError(null);
    try {
      if (kind === 'original') {
        setBusy(t('export'));
        const result = await renderOriginal({
          template: document.template,
          values: valuesForFill(document),
        });
        downloadBlob(
          base64ToBlob(result.bytes, result.mime),
          `${base}.${result.ext}`,
        );
        const parts = [
          t('renderReport', {
            filled: String(result.filled.length),
            missing: String(result.missing.length),
            failed: String(result.failed.length),
          }),
        ];
        if (result.failed.length > 0) {
          parts.push(
            t('renderFailedFields', {
              fields: result.failed
                .map((f) => `${f.name} (${f.reason})`)
                .join(', '),
            }),
          );
        }
        setNotice(parts.join(' '));
        return;
      }
      if (kind === 'all-zip') {
        const now = new Date();
        const files: Record<string, Uint8Array> = {};
        const used = new Set<string>();
        for (const doc of state.documents) {
          let name = exportBaseName(doc.template.name);
          let n = 2;
          while (used.has(name))
            name = `${exportBaseName(doc.template.name)}-${n++}`;
          used.add(name);
          files[`${name}.md`] = strToU8(
            renderLayout(doc, { emptyAs: 'blank' }),
          );
          files[`${name}-provenance.md`] = strToU8(
            buildProvenanceMarkdown({
              document: doc,
              sources: state.sources,
              notes: state.notes,
              strings: provenanceStrings,
              now,
            }),
          );
        }
        downloadBlob(
          new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' }),
          `${base}-all.zip`,
        );
        return;
      }
      if (kind === 'prov-md' || kind === 'prov-json') {
        const now = new Date();
        if (kind === 'prov-json') {
          downloadFile(
            JSON.stringify(
              buildProvenanceJson({
                document,
                sources: state.sources,
                notes: state.notes,
                now,
              }),
              null,
              2,
            ),
            `${base}-provenance.json`,
            'application/json',
          );
        } else {
          downloadFile(
            buildProvenanceMarkdown({
              document,
              sources: state.sources,
              notes: state.notes,
              strings: provenanceStrings,
              now,
            }),
            `${base}-provenance.md`,
            'text/markdown',
          );
        }
        return;
      }
      const markdown = renderLayout(document, { emptyAs: 'blank' });
      if (kind === 'md') {
        downloadFile(markdown, `${base}.md`, 'text/markdown');
        return;
      }
      const safeHtml = await sanitizeHtmlForExport(markdownToHtml(markdown));
      if (kind === 'html') downloadFile(safeHtml, `${base}.html`, 'text/html');
      else if (kind === 'docx') {
        setBusy(t('export'));
        await exportToDOCX(safeHtml, `${base}.docx`);
      } else {
        setBusy(t('export'));
        await exportToPDF(safeHtml, `${base}.pdf`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('exportFailed'));
    } finally {
      setBusy(null);
    }
  };

  /* ---------------- multi-record bridge ---------------- */

  const handleImportRows = async (file: File) => {
    if (!document) return;
    setError(null);
    setBusy(t('uploading'));
    try {
      const table = await importFile(file);
      const template = document.template;
      let result: ReturnType<typeof documentsFromRows> | null = null;
      setState((prev) => {
        result = documentsFromRows(prev, template, table, {
          clock,
          prefillUser,
        });
        return result.state;
      });
      if (!result) return;
      const { created, skipped, matchedFieldIds } = result as ReturnType<
        typeof documentsFromRows
      >;
      if (matchedFieldIds.length === 0) {
        setNotice(t('importRowsNoMatch'));
      } else {
        setNotice(
          [
            t('importRowsDone', {
              created: String(created),
              fields: String(matchedFieldIds.length),
            }),
            skipped > 0
              ? t('importRowsSkipped', {
                  count: String(skipped),
                  max: String(FORM_LIMITS.MAX_DOCUMENTS),
                })
              : '',
          ]
            .filter(Boolean)
            .join(' '),
        );
      }
      setSelectedFieldId(null);
      setRightPane(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('importRowsFailed'));
    } finally {
      setBusy(null);
    }
  };

  const handleSendToData = () => {
    if (!state || state.documents.length === 0 || models.length === 0) return;
    setExportOpen(false);
    const table = tableFromDocuments(state.documents);
    const now = clock.now();
    const conversation = createWorkflowConversation(
      models,
      defaultModelId,
      systemPrompt || '',
      temperature || 0.5,
      'data-analysis',
      {
        kind: 'data-analysis',
        columns: table.columns,
        rows: table.rows,
        nextRowId: table.nextRowId,
        sources: [
          {
            id: uuidv4(),
            kind: 'paste',
            name: state.documents[0].template.name,
            addedAt: now,
            rowCount: table.rows.length,
          },
        ],
        operations: [],
        viewMode: table.rows.length === 1 ? 'record' : 'table',
        updatedAt: now,
      },
    );
    addConversation({
      ...conversation,
      name: state.documents[0].template.name,
      nameAutoGenerated: true,
    });
    toast.success(
      t('sendToDataDone', { count: String(state.documents.length) }),
    );
  };

  /* ---------------- OneDrive ---------------- */

  const saveBlobToOneDrive = async (
    blob: Blob,
    name: string,
    destination: M365SaveDestination | null,
  ) => {
    const toastId = toast.loading(t('saveToOneDrive'));
    try {
      const result = await saveToOneDrive(
        blob,
        name,
        destinationToTarget(destination),
      );
      toast.success(t('saved', { name: result.name }), { id: toastId });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'), {
        id: toastId,
      });
    }
  };

  const handleSaveToOneDrive = async (
    kind: 'original' | 'docx' | 'prov-md',
  ) => {
    setExportOpen(false);
    if (!document || !state) return;
    const base = exportBaseName(document.template.name);
    setError(null);
    try {
      if (kind === 'docx') {
        const markdown = renderLayout(document, { emptyAs: 'blank' });
        const safeHtml = await sanitizeHtmlForExport(markdownToHtml(markdown));
        await m365Save.save('docx', safeHtml, base);
        return;
      }
      if (kind === 'prov-md') {
        const markdown = buildProvenanceMarkdown({
          document,
          sources: state.sources,
          notes: state.notes,
          strings: provenanceStrings,
        });
        await m365Save.save('md', '', `${base}-provenance`, markdown);
        return;
      }
      setBusy(t('export'));
      const result = await renderOriginal({
        template: document.template,
        values: valuesForFill(document),
      });
      const blob = base64ToBlob(result.bytes, result.mime);
      const name = `${base}.${result.ext}`;
      const { m365SaveSkipPicker, m365SaveDestination } =
        useSettingsStore.getState();
      if (m365SaveSkipPicker) {
        await saveBlobToOneDrive(blob, name, m365SaveDestination ?? null);
      } else {
        // Binary exports do not go through the HTML-based save dialog: pick
        // a folder with the shared picker, then upload the bytes directly.
        setPendingSave({ blob, name });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setBusy(null);
    }
  };

  /* ---------------- render ---------------- */

  if (!state || !conversation) return null;

  if (!document) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-gray-200 px-6 py-5 dark:border-gray-700">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t('emptyTitle')}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-gray-600 dark:text-gray-400">
            {t('emptyBody')}
          </p>
        </div>
        <div className="min-h-0 flex-1">
          <TemplateManager
            modelId={modelId}
            conversationId={conversationId}
            onUse={handleUse}
            onClose={() => undefined}
          />
        </div>
      </div>
    );
  }

  const coverage = coverageOf(document);
  // The language is fixed once the USER has put values in — admin prefills
  // are the template's, not a translation decision.
  const languageLocked =
    document.runs.length > 0 ||
    document.template.fields.some(
      (f) =>
        !f.admin?.prefill &&
        fieldStatus(f, document.fields[f.id]).status !== 'empty',
    );
  const fillMode = document.template.original?.fillMode ?? 'none';
  const fieldLabel = (id: string) =>
    document.template.fields.find((f) => f.id === id)?.label ?? id;
  const adminMeta =
    document.templateRef?.origin === 'admin'
      ? adminTemplates.find((a) => a.id === document.templateRef?.id)
      : undefined;
  const templateUpdated =
    adminMeta &&
    document.templateRef &&
    adminMeta.updatedAt > document.templateRef.updatedAt
      ? adminMeta.updatedAt.slice(0, 10)
      : null;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
          {state.documents.length > 1 ? (
            <select
              value={document.id}
              onChange={(e) => {
                setState((prev) => ({
                  ...prev,
                  activeDocumentId: e.target.value,
                }));
                setSelectedFieldId(null);
                setRightPane(null);
              }}
              aria-label={t('documents')}
              disabled={busy !== null}
              className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-surface-dark dark:text-gray-100"
            >
              {state.documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.template.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
              {document.template.name}
            </span>
          )}
          <span
            className="rounded-sm bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-700 dark:bg-surface-dark-elevated dark:text-gray-300"
            title={document.template.original?.name}
          >
            {t(`fillMode.${fillMode}`)}
          </span>
          <span className="text-xs text-gray-600 dark:text-gray-400">
            {t('coverage', {
              filled: String(coverage.filled + coverage.confirmed),
              partial: String(coverage.partial),
              empty: String(coverage.empty),
            })}
            {coverage.requiredTotal > 0 &&
              ` · ${t('coverageRequired', {
                addressed: String(coverage.requiredAddressed),
                total: String(coverage.requiredTotal),
              })}`}
          </span>
          <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
            {t('language')}
            <input
              list="form-doc-languages"
              value={document.language}
              disabled={languageLocked || busy !== null}
              title={languageLocked ? t('languageLocked') : undefined}
              onChange={(e) =>
                setDocument((doc) => setLanguage(doc, e.target.value))
              }
              className="w-28 rounded border border-gray-300 bg-white px-1.5 py-1 text-xs dark:border-gray-700 dark:bg-surface-dark dark:text-gray-100"
            />
            <datalist id="form-doc-languages">
              {COMMON_LANGUAGES.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </label>

          <div className="ms-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => runFill(openFieldIds(document))}
              disabled={busy !== null}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-30"
            >
              {busy === t('filling') ? (
                <IconLoader size={15} className="animate-spin" aria-hidden />
              ) : (
                <IconSparkles size={15} aria-hidden />
              )}
              {state.sources.length === 0 && state.notes.length === 0
                ? t('askQuestions')
                : t('fillOpen')}
            </button>
            {(document.template.rules?.length ||
              document.template.fields.some((f) => f.validation?.rubric)) && (
              <button
                type="button"
                onClick={() => void handleValidate()}
                disabled={busy !== null}
                className={toolbarButton}
              >
                <IconChecklist size={15} aria-hidden />
                {t('validate')}
              </button>
            )}
            {pendingCount > 0 && rightPane !== 'review' && (
              <button
                type="button"
                onClick={() => setRightPane('review')}
                className={`${toolbarButton} text-amber-700 dark:text-amber-400`}
              >
                <IconClipboardCheck size={15} aria-hidden />
                {t('showReviewPending', { count: String(pendingCount) })}
              </button>
            )}
            <input
              ref={rowsInput}
              type="file"
              accept=".csv,.tsv,.xlsx,.xls,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleImportRows(file);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => rowsInput.current?.click()}
              disabled={busy !== null}
              className={toolbarButton}
              title={t('importRowsHint')}
            >
              <IconTableImport size={15} aria-hidden />
              {t('importRows')}
            </button>
            <button
              type="button"
              onClick={() =>
                setRightPane(rightPane === 'templates' ? null : 'templates')
              }
              disabled={busy !== null}
              className={toolbarButton}
              title={t('addDocument')}
            >
              <IconPlus size={15} aria-hidden />
              <IconTemplate size={15} aria-hidden />
            </button>
            <div className="relative" ref={exportRef}>
              <button
                type="button"
                onClick={() => setExportOpen((o) => !o)}
                disabled={busy !== null}
                aria-haspopup="menu"
                aria-expanded={exportOpen}
                className={toolbarButton}
              >
                <IconDownload size={15} aria-hidden />
                {t('export')}
              </button>
              {exportOpen && (
                <div
                  role="menu"
                  className="absolute end-0 z-20 mt-1 w-56 rounded-lg border border-gray-200 bg-white p-1 shadow-lg dark:border-gray-700 dark:bg-surface-dark"
                >
                  {fillMode !== 'none' && document.template.original && (
                    <MenuItem
                      onClick={() => handleExport('original')}
                      label={t('exportOriginal', {
                        ext: document.template.original.mime,
                      })}
                      strong
                    />
                  )}
                  <MenuHeading label={t('exportDocument')} />
                  <MenuItem
                    onClick={() => handleExport('md')}
                    label="Markdown"
                  />
                  <MenuItem onClick={() => handleExport('html')} label="HTML" />
                  <MenuItem onClick={() => handleExport('docx')} label="DOCX" />
                  <MenuItem onClick={() => handleExport('pdf')} label="PDF" />
                  <MenuHeading label={t('exportProvenance')} />
                  <MenuItem
                    onClick={() => handleExport('prov-md')}
                    label="Markdown"
                  />
                  <MenuItem
                    onClick={() => handleExport('prov-json')}
                    label="JSON"
                  />
                  <MenuHeading label={t('documents')} />
                  <MenuItem
                    onClick={handleSendToData}
                    label={t('sendToData')}
                  />
                  {state.documents.length > 1 && (
                    <MenuItem
                      onClick={() => handleExport('all-zip')}
                      label={t('exportAllDocuments')}
                    />
                  )}
                  {m365SaveAvailable && (
                    <>
                      <MenuHeading label={t('saveToOneDrive')} />
                      {fillMode !== 'none' && document.template.original && (
                        <MenuItem
                          onClick={() => void handleSaveToOneDrive('original')}
                          label={t('saveOriginalToOneDrive', {
                            ext: document.template.original.mime,
                          })}
                        />
                      )}
                      <MenuItem
                        onClick={() => void handleSaveToOneDrive('docx')}
                        label={t('saveDocumentToOneDrive')}
                      />
                      <MenuItem
                        onClick={() => void handleSaveToOneDrive('prov-md')}
                        label={t('saveProvenanceToOneDrive')}
                      />
                    </>
                  )}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                if (window.confirm(t('removeDocumentConfirm'))) {
                  setState((prev) =>
                    removeDocument(prev, document.id, clock.now()),
                  );
                  setSelectedFieldId(null);
                  setRightPane(null);
                }
              }}
              disabled={busy !== null}
              aria-label={t('removeDocument')}
              className={toolbarButton}
            >
              <IconTrash size={15} aria-hidden />
            </button>
          </div>
        </div>

        <SourcesBar
          sources={state.sources}
          documentLanguage={document.language}
          busy={busy !== null}
          onAddFile={(file) => void handleAddFile(file)}
          onAddUrl={(url) => void handleAddUrl(url)}
          onAddNote={(text) => void handleAddNote(text)}
          onSearch={(query) => void handleSearch(query)}
          onAddFromM365={
            m365Available ? () => setM365PickerOpen(true) : undefined
          }
          onRemove={handleRemoveSource}
          suggestedQuery={[
            document.template.name,
            ...openFieldIds(document)
              .slice(0, 3)
              .map((id) => fieldLabel(id)),
          ].join(' ')}
        />
        {m365Available && (
          <M365FilePickerModal
            isOpen={m365PickerOpen}
            onClose={() => setM365PickerOpen(false)}
            onPick={(entry) => void handleM365Pick(entry)}
            acceptExtensions={[
              'docx',
              'pdf',
              'md',
              'txt',
              'html',
              'htm',
              'csv',
              'xlsx',
              'pptx',
            ]}
          />
        )}
        {m365Save.dialog}
        {m365SaveAvailable && pendingSave && (
          <M365FilePickerModal
            isOpen
            onClose={() => setPendingSave(null)}
            onPickFolder={(destination) => {
              const pending = pendingSave;
              setPendingSave(null);
              void saveBlobToOneDrive(pending.blob, pending.name, destination);
            }}
          />
        )}
        {templateUpdated && (
          <div
            role="status"
            className="border-b border-blue-200 bg-blue-50 px-3 py-1.5 text-xs text-blue-900 dark:border-blue-900/40 dark:bg-blue-900/20 dark:text-blue-200"
          >
            {t('templateUpdatedNotice', { date: templateUpdated })}
          </div>
        )}
        {document.ruleResults && document.ruleResults.length > 0 && (
          <ul className="border-b border-gray-200 px-3 py-1.5 text-xs dark:border-gray-700">
            {document.ruleResults.map((r, i) => (
              <li key={i} className="flex gap-1.5">
                <span
                  className={`shrink-0 font-medium ${r.ok ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'}`}
                >
                  {r.ok ? t('ruleOk') : t('ruleFailed')}
                </span>
                <span className="text-gray-700 dark:text-gray-300">
                  {r.rule}
                  {r.note ? ` — ${r.note}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}

        {(error || notice) && (
          <div
            role={error ? 'alert' : 'status'}
            className={`border-b px-3 py-1.5 text-xs ${
              error
                ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300'
                : 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-300'
            }`}
          >
            {error ?? notice}
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {/* Ledger + questions */}
          <div className="flex w-full min-w-0 flex-col border-e border-gray-200 md:w-2/5 dark:border-gray-700">
            <div className="min-h-0 flex-1">
              <FieldLedger
                document={document}
                selectedFieldId={selectedFieldId}
                pendingByField={pendingByField}
                onSelect={(id) => {
                  setSelectedFieldId(id);
                  setRightPane('detail');
                }}
              />
            </div>
            <div className="max-h-[40%] shrink-0 overflow-y-auto border-t border-gray-200 dark:border-gray-700">
              <button
                type="button"
                onClick={() => setQuestionsOpen((o) => !o)}
                aria-expanded={questionsOpen}
                className="flex w-full items-center px-3 py-1.5 text-xs font-semibold text-gray-900 dark:text-gray-100"
              >
                {t('questions')}
              </button>
              {questionsOpen && (
                <QuestionsPanel
                  document={document}
                  busy={busy !== null}
                  onAnswer={(questionId, answer) => {
                    const question = document.questions.find(
                      (q) => q.id === questionId,
                    );
                    const noteId = handleAddNote(answer, questionId);
                    if (noteId)
                      setDocument((doc) =>
                        answerQuestion(doc, questionId, noteId),
                      );
                    appendWorkflowRailMessages(
                      conversationId,
                      t('railAnswer', {
                        question: question?.text ?? '',
                        answer,
                      }),
                      t('railAnswerAck'),
                    );
                    if (question && question.fieldIds.length > 0) {
                      void runFill(question.fieldIds);
                    }
                  }}
                  onSkip={(questionId) =>
                    setDocument((doc) => skipQuestion(doc, questionId))
                  }
                  onNotApplicable={(questionId, fieldIds) =>
                    setDocument((doc) => {
                      let next = skipQuestion(doc, questionId);
                      for (const id of fieldIds) {
                        next = setFieldDecision(
                          next,
                          id,
                          'not_applicable',
                          clock.now(),
                        );
                      }
                      return next;
                    })
                  }
                />
              )}
            </div>
          </div>

          {/* Preview */}
          <div className="hidden min-w-0 flex-1 flex-col md:flex">
            <div className="flex items-center gap-1 border-b border-gray-200 px-3 py-1 dark:border-gray-700">
              {(['document', 'copy'] as PreviewTab[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setPreviewTab(tab)}
                  aria-pressed={previewTab === tab}
                  className={`rounded px-2 py-1 text-xs ${
                    previewTab === tab
                      ? 'bg-gray-200 text-gray-900 dark:bg-surface-dark-elevated dark:text-gray-100'
                      : 'text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
                  }`}
                >
                  {tab === 'document' ? (
                    <IconFileText
                      size={13}
                      aria-hidden
                      className="me-1 inline"
                    />
                  ) : null}
                  {t(tab === 'document' ? 'preview' : 'copyView')}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1">
              {previewTab === 'document' ? (
                <DocumentPreview
                  document={document}
                  selectedFieldId={selectedFieldId}
                  onSelectField={(id) => {
                    setSelectedFieldId(id);
                    setRightPane('detail');
                  }}
                />
              ) : (
                <CopyView
                  document={document}
                  onSelectField={(id) => {
                    setSelectedFieldId(id);
                    setRightPane('detail');
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Exclusive right pane */}
      {rightPane === 'detail' && selectedFieldId && (
        <aside className="w-full shrink-0 border-s border-gray-200 md:w-96 dark:border-gray-700">
          <FieldDetail
            document={document}
            fieldId={selectedFieldId}
            sources={state.sources}
            busy={busy !== null}
            onSetValue={(id, value: FieldValue) =>
              setDocument((doc) => setFieldValue(doc, id, value, clock.now()))
            }
            onConfirm={(id) =>
              setDocument((doc) =>
                setFieldDecision(doc, id, 'confirmed', clock.now()),
              )
            }
            onUnlock={(id) =>
              setDocument((doc) =>
                setFieldDecision(doc, id, 'clear', clock.now()),
              )
            }
            onNotApplicable={(id, on) =>
              setDocument((doc) =>
                setFieldDecision(
                  doc,
                  id,
                  on ? 'not_applicable' : 'clear',
                  clock.now(),
                ),
              )
            }
            onFillField={(id) => void runFill([id])}
            onClose={() => setRightPane(null)}
          />
        </aside>
      )}
      {rightPane === 'review' && reviewAssessment && (
        <aside className="hidden w-96 shrink-0 border-s border-gray-200 lg:flex lg:flex-col dark:border-gray-700">
          <AssessmentPanel
            assessment={reviewAssessment}
            resolveCriterionLabel={fieldLabel}
            i18nNamespace="workflows.form"
            getEditLocationLabel={(edit) => {
              const field = document.template.fields.find(
                (f) => f.id === edit.criterion,
              );
              const section = document.template.sections.find(
                (s) => s.id === field?.sectionId,
              );
              return field
                ? t('proposalLocation', {
                    section: section?.heading ?? '',
                    field: field.label,
                  })
                : undefined;
            }}
            onAccept={(id) =>
              setDocument((doc) => resolveProposal(doc, id, true, clock.now()))
            }
            onReject={(id) =>
              setDocument((doc) => resolveProposal(doc, id, false, clock.now()))
            }
            onAcceptAll={() =>
              setDocument((doc) => resolveAllProposals(doc, true, clock.now()))
            }
            onRejectAll={() =>
              setDocument((doc) => resolveAllProposals(doc, false, clock.now()))
            }
            onClearResolved={() =>
              setDocument((doc) => clearResolvedProposals(doc))
            }
            onClose={() => setRightPane(null)}
            disabled={busy !== null}
          />
        </aside>
      )}
      {rightPane === 'templates' && (
        <aside className="w-full shrink-0 border-s border-gray-200 md:w-[28rem] dark:border-gray-700">
          <TemplateManager
            modelId={modelId}
            conversationId={conversationId}
            onUse={handleUse}
            onClose={() => setRightPane(null)}
          />
        </aside>
      )}
    </div>
  );
}

function MenuHeading({ label }: { label: string }) {
  return (
    <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
      {label}
    </div>
  );
}

function MenuItem({
  onClick,
  label,
  strong,
}: {
  onClick: () => void;
  label: string;
  strong?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`block w-full rounded px-2 py-1.5 text-start text-sm hover:bg-gray-100 dark:hover:bg-surface-dark-elevated ${
        strong
          ? 'font-medium text-blue-700 dark:text-blue-300'
          : 'text-gray-900 dark:text-gray-100'
      }`}
    >
      {label}
    </button>
  );
}

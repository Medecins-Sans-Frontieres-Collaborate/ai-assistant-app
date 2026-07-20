'use client';

import {
  IconArrowBackUp,
  IconCamera,
  IconChartHistogram,
  IconClipboard,
  IconClipboardCheck,
  IconColumns,
  IconDownload,
  IconFileSpreadsheet,
  IconFileTextAi,
  IconFlag,
  IconForms,
  IconSparkles,
  IconTable,
  IconTrash,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useAutoFocusComposer } from '@/client/hooks/ui/useAutoFocusComposer';
import { useCameraSupport } from '@/client/hooks/ui/useCameraSupport';
import { usePasteComposer } from '@/client/hooks/ui/usePasteComposer';
import { usePastedTextChips } from '@/client/hooks/workflows/usePastedTextChips';
import { useTableImport } from '@/client/hooks/workflows/useTableImport';

import { assessData } from '@/client/services/workflows/data/dataAssessment';
import {
  photoExtract,
  photoInfer,
  uploadPhotos,
} from '@/client/services/workflows/data/photoExtraction';
import { uploadAndExtractText } from '@/client/services/workflows/fileTextExtraction';
import { appendWorkflowRailMessages } from '@/client/services/workflows/railMessages';
import { nameWorkflowConversation } from '@/client/services/workflows/workflowTitle';
import { profileTable } from '@/lib/services/workflows/data/columnStats';
import {
  applyDerivedColumns,
  stripDerivedCells,
} from '@/lib/services/workflows/data/derived';
import {
  ColumnFilter,
  applyFilters,
} from '@/lib/services/workflows/data/filtering';
import { photoInferToTable } from '@/lib/services/workflows/data/photoIngest';
import { applyQualityEdit } from '@/lib/services/workflows/data/qualityApplication';
import {
  DEFAULT_MISSING_FIELD_POLICY,
  MissingFieldPolicy,
  enforceMissingFieldPolicy,
  missingRequiredCells,
} from '@/lib/services/workflows/data/requiredFields';
import {
  SchemaDraftColumn,
  applySchemaChanges,
} from '@/lib/services/workflows/data/schemaEdit';
import { mergeScopedResult } from '@/lib/services/workflows/data/scopedMerge';
import {
  MAX_ASSESS_ROWS,
  MAX_ROWS,
  carryRowIds,
  coerceCell,
  deriveNextRowId,
  getRowId,
  strideSample,
  stripRowIds,
  withRowIds,
} from '@/lib/services/workflows/data/tableUtils';
import {
  detectAttributeMatrix,
  transposeTable,
} from '@/lib/services/workflows/data/transpose';

import { FILE_COUNT_LIMITS } from '@/lib/utils/app/const';
import { isMobile } from '@/lib/utils/app/env';
import { DATA_QUALITY_CRITERIA } from '@/lib/utils/shared/data/qualityCriteria';
import { downloadFile } from '@/lib/utils/shared/document/exportUtils';

import {
  DataAnalysisWorkflowState,
  DataColumn,
  DataQualityAssessment,
  DataQualityEdit,
  ReviewEdit,
  ReviewEditStatus,
} from '@/types/workflow';

import CameraCaptureModal from '@/components/UI/CameraCaptureModal';

import { PastedTextChips } from '../Shared/PastedTextChips';
import { AssessmentPanel } from '../Shared/Review/AssessmentPanel';
import { CriteriaPicker } from '../Shared/Review/CriteriaPicker';
import { WorkflowWorkspaceProps } from '../registry';
import { DataGrid } from './DataGrid';
import { InsightsPanel } from './InsightsPanel';
import { RecordView } from './RecordView';
import { SchemaEditor } from './SchemaEditor';
import { DataScope, ScopeChip } from './ScopeChip';
import { SourceQcPanel } from './SourceQcPanel';
import { SourcesStrip } from './SourcesStrip';

import { useConversationStore } from '@/client/stores/conversationStore';
import Papa from 'papaparse';
import { v4 as uuidv4 } from 'uuid';

type Rows = Record<string, unknown>[];

/** Rows sampled into the title seed — enough to characterize the table. */
const TITLE_SAMPLE_ROWS = 3;

/**
 * Compact header + first-rows rendering of a table, used only as context
 * for auto-titling. Not user-facing, so it stays untranslated.
 */
function describeTable(columns: DataColumn[], rows: Rows): string {
  if (columns.length === 0) return '';
  const names = columns.map((column) => column.name);
  const lines = [names.join(', ')];
  for (const row of rows.slice(0, TITLE_SAMPLE_ROWS)) {
    lines.push(
      columns.map((column) => String(row[column.id] ?? '')).join(', '),
    );
  }
  return lines.join('\n');
}

export function DataWorkspace({ conversationId }: WorkflowWorkspaceProps) {
  const t = useTranslations('workflows');
  const conversation = useConversationStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const updateWorkflowState = useConversationStore(
    (s) => s.updateWorkflowState,
  );
  const { importFile, importPasted } = useTableImport();

  const state =
    conversation?.workflowState?.kind === 'data-analysis'
      ? (conversation.workflowState as DataAnalysisWorkflowState)
      : undefined;

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Non-error outcome strip (drops, conversions, ingest reports). */
  const [notice, setNotice] = useState<string | null>(null);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [extractOpen, setExtractOpen] = useState(false);
  const [extractText, setExtractText] = useState('');
  const [instruction, setInstruction] = useState('');
  /** Selected rows by stable row id (__rid) — survives sort/filter. */
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  /** Ephemeral per-column filters (view concern, never persisted). */
  const [filters, setFilters] = useState<Record<string, ColumnFilter>>({});
  /** Explicit scope choice; null = auto (narrowest available). */
  const [scopeChoice, setScopeChoice] = useState<DataScope | null>(null);
  const [selectedCriteria, setSelectedCriteria] = useState<Set<string>>(
    () =>
      new Set(
        DATA_QUALITY_CRITERIA.filter((c) => c.defaultOn).map((c) => c.id),
      ),
  );
  /** Exclusive right pane: quality review OR a photo source's QC view. */
  const [rightPane, setRightPane] = useState<
    { type: 'review' } | { type: 'source'; sourceId: string } | null
  >(null);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const extractFileRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  /** Mobile camera hand-off; desktop uses the in-page capture modal instead. */
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const hasCamera = useCameraSupport();
  /** Single-level undo snapshot; transient by design. */
  const undoRef = useRef<{ columns: DataColumn[]; rows: Rows } | null>(null);
  const [canUndo, setCanUndo] = useState(false);

  const columns = useMemo(() => state?.columns ?? [], [state?.columns]);
  const rawRows = useMemo(() => state?.rows ?? [], [state?.rows]);
  /**
   * The choke point every consumer reads (grid, filters, exports,
   * transform payloads, insights): persisted rows overlaid with
   * computed derived-column cells. Identity when no formulas exist.
   */
  const rows = useMemo(
    () => applyDerivedColumns(columns, rawRows),
    [columns, rawRows],
  );
  const hasTable = columns.length > 0;

  // Two composers compete for stray input here, so the open paste box wins:
  // opening it is an explicit "I am about to paste a table". It takes no
  // `onAttach` — a pasted CSV must reach the import parser, not become an
  // attachment. The transform bar gets the attaching behavior instead, since
  // a wall of text there is material, not an instruction.
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  const idle = busy === null;
  const {
    chips,
    hasChips,
    attachPastedText,
    removeChip,
    clearChips,
    composeWithChips,
  } = usePastedTextChips();

  const appendPaste = useCallback(
    (text: string) => setPasteText((prev) => prev + text),
    [],
  );
  useAutoFocusComposer({
    textareaRef: pasteRef,
    enabled: pasteOpen && idle,
    append: appendPaste,
  });
  usePasteComposer({
    textareaRef: pasteRef,
    enabled: pasteOpen && idle,
    append: appendPaste,
  });

  const appendInstruction = useCallback(
    (text: string) => setInstruction((prev) => prev + text),
    [],
  );
  useAutoFocusComposer({
    textareaRef: instructionRef,
    enabled: !pasteOpen && hasTable && idle,
    append: appendInstruction,
  });
  usePasteComposer({
    textareaRef: instructionRef,
    enabled: !pasteOpen && hasTable && idle,
    append: appendInstruction,
    onAttach: attachPastedText,
  });
  /** Exact stats over the FULL table (prompt ground truth + header popovers). */
  const profiles = useMemo(() => profileTable(columns, rows), [columns, rows]);
  const policy: MissingFieldPolicy =
    state?.missingFieldPolicy ?? DEFAULT_MISSING_FIELD_POLICY;
  /** Live deterministic scan: empty cells in required columns. */
  const missingRequired = useMemo(
    () => missingRequiredCells(columns, rows),
    [columns, rows],
  );

  const sources = state?.sources;
  /** Photo source whose QC pane is open (its rows filter the grid). */
  const activeQcSource =
    rightPane?.type === 'source'
      ? sources?.find((s) => s.id === rightPane.sourceId)
      : undefined;
  const sourceFilterRids = useMemo(
    () =>
      activeQcSource?.rowIds && activeQcSource.rowIds.length > 0
        ? new Set(activeQcSource.rowIds)
        : null,
    [activeQcSource],
  );

  /** Feature-matrix shape (attributes as rows) → offer a transpose. */
  const matrixDetected = useMemo(
    () => hasTable && detectAttributeMatrix(columns, rows),
    [hasTable, columns, rows],
  );

  const filterList = useMemo(() => Object.values(filters), [filters]);
  const visibleRows = useMemo(() => {
    const filtered = applyFilters(rows, filterList);
    if (!sourceFilterRids) return filtered;
    return filtered.filter((row) => {
      const rid = getRowId(row);
      return !!rid && sourceFilterRids.has(rid);
    });
  }, [rows, filterList, sourceFilterRids]);

  /**
   * Working scope for LLM operations — always explicit via the ScopeChip.
   * Auto picks the narrowest available; a stale explicit choice (its rows
   * vanished) falls back rather than silently widening to the full table.
   */
  const autoScope: DataScope =
    selectedRows.size > 0
      ? 'selection'
      : visibleRows.length < rows.length
        ? 'filtered'
        : 'table';
  const scope: DataScope =
    scopeChoice === 'selection' && selectedRows.size === 0
      ? autoScope
      : scopeChoice === 'filtered' && visibleRows.length === rows.length
        ? autoScope
        : (scopeChoice ?? autoScope);
  const scopedRows = useMemo(() => {
    if (scope === 'selection') {
      return rows.filter((row) => {
        const rid = getRowId(row);
        return !!rid && selectedRows.has(rid);
      });
    }
    return scope === 'filtered' ? visibleRows : rows;
  }, [scope, rows, visibleRows, selectedRows]);

  /** One-shot heal for states persisted before stable row ids existed. */
  const needsRowIds = rows.length > 0 && rows.some((row) => !getRowId(row));
  useEffect(() => {
    if (!needsRowIds) return;
    updateWorkflowState(conversationId, (prev) => {
      const p = prev as DataAnalysisWorkflowState;
      const { rows: healed, nextRowId } = withRowIds(
        p.rows,
        p.nextRowId ?? deriveNextRowId(p.rows),
      );
      if (healed === p.rows) return p;
      return { ...p, rows: healed, nextRowId };
    });
  }, [needsRowIds, conversationId, updateWorkflowState]);

  const applyTable = useCallback(
    (
      next: { columns: DataColumn[]; rows: Rows },
      record:
        | { source?: DataAnalysisWorkflowState['sources'][number] }
        | { operation?: DataAnalysisWorkflowState['operations'][number] },
    ) => {
      // Snapshot RAW rows: overlaid derived cells must never persist,
      // and undo writes the snapshot straight back to the store.
      undoRef.current = { columns, rows: rawRows };
      setCanUndo(true);
      setSelectedRows(new Set());
      updateWorkflowState(conversationId, (prev) => {
        const p = prev as DataAnalysisWorkflowState;
        // Canonicalize: drop derived cells (they are recomputed by the
        // overlay), then assign stable ids to any id-less rows.
        const strippedRows = stripDerivedCells(next.columns, next.rows);
        const { rows: nextRows, nextRowId } = withRowIds(
          strippedRows,
          p.nextRowId ?? deriveNextRowId(strippedRows),
        );
        // Rids only exist after withRowIds, so source→row attribution is
        // injected here: appended rows = positions that had no rid before.
        const appendedRowIds = next.rows
          .map((row, i) => (getRowId(row) ? null : getRowId(nextRows[i])))
          .filter((rid): rid is string => !!rid);
        // Source attribution must reference rows that still exist —
        // stale rids would blank a QC-pane-filtered grid.
        const keptRids = new Set(
          nextRows.map((row) => getRowId(row)).filter(Boolean),
        );
        const prunedSources = p.sources.map((source) =>
          source.rowIds?.some((rid) => !keptRids.has(rid))
            ? {
                ...source,
                rowIds: source.rowIds.filter((rid) => keptRids.has(rid)),
              }
            : source,
        );
        return {
          ...p,
          columns: next.columns,
          rows: nextRows,
          nextRowId,
          // Wholesale table changes invalidate any quality assessment.
          assessment: undefined,
          sources:
            'source' in record && record.source
              ? [...prunedSources, { ...record.source, rowIds: appendedRowIds }]
              : prunedSources,
          // New data may be matrix-shaped again — re-offer the transpose.
          transposeSuggestionDismissed:
            'source' in record && record.source
              ? undefined
              : p.transposeSuggestionDismissed,
          operations:
            'operation' in record && record.operation
              ? [...p.operations, record.operation]
              : p.operations,
          updatedAt: new Date().toISOString(),
        };
      });

      // Name from the first table imported; later imports and transforms
      // leave the established name alone.
      if ('source' in record && record.source && !sources?.length) {
        nameWorkflowConversation(conversationId, {
          label: record.source.name,
          // Headers plus a couple of rows say far more about what this
          // table is than its filename does.
          sample: describeTable(next.columns, next.rows),
          workflow: 'Data analysis',
        });
      }
    },
    [columns, rawRows, sources, conversationId, updateWorkflowState],
  );

  const handleUndo = useCallback(() => {
    const snapshot = undoRef.current;
    if (!snapshot) return;
    undoRef.current = null;
    setCanUndo(false);
    setSelectedRows(new Set());
    updateWorkflowState(conversationId, (prev) => ({
      ...(prev as DataAnalysisWorkflowState),
      columns: snapshot.columns,
      rows: snapshot.rows,
      assessment: undefined,
      updatedAt: new Date().toISOString(),
    }));
  }, [conversationId, updateWorkflowState]);

  const importError = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('ROW_CAP_EXCEEDED:')) {
      setError(
        t('data.rowCapExceeded', {
          max: String(MAX_ROWS),
          count: message.split(':')[1],
        }),
      );
    } else {
      setError(message);
    }
  };

  const handleImportFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    setBusy('import');
    try {
      const table = await importFile(file);
      const effectiveColumns = hasTable ? columns : table.columns;
      const merged = mergeRows(admitRows(table.rows, effectiveColumns));
      applyTable(
        { columns: effectiveColumns, rows: merged },
        {
          source: {
            id: uuidv4(),
            kind: table.sourceKind,
            name: table.sourceName,
            addedAt: new Date().toISOString(),
            rowCount: table.rows.length,
          },
        },
      );
    } catch (err) {
      importError(err);
    } finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  /** Appending to an existing table keeps the current columns. */
  const mergeRows = (newRows: Rows): Rows => {
    if (!hasTable) return newRows;
    if (rows.length + newRows.length > MAX_ROWS) {
      throw new Error(`ROW_CAP_EXCEEDED:${rows.length + newRows.length}`);
    }
    return [...rows, ...newRows];
  };

  /**
   * Missing-field policy gate for INCOMING rows (deterministic,
   * client-side): 'strict' drops offenders and reports what was
   * missing; 'flag'/'lenient' admit everything (flagging is the live
   * scan's job).
   */
  const admitRows = (newRows: Rows, effectiveColumns: DataColumn[]): Rows => {
    const result = enforceMissingFieldPolicy(effectiveColumns, newRows, policy);
    if (result.dropped > 0) {
      setNotice(
        t('data.droppedIncompleteRows', {
          count: String(result.dropped),
          fields: result.droppedFields.join(', '),
        }),
      );
    }
    return result.rows;
  };

  const handleApplySchema = (draft: SchemaDraftColumn[]) => {
    const result = applySchemaChanges(columns, rows, draft);
    setNotice(
      result.converted > 0
        ? t('data.schemaCellsConverted', { count: String(result.converted) })
        : null,
    );
    applyTable(
      { columns: result.columns, rows: result.rows },
      {
        operation: {
          id: uuidv4(),
          engine: 'client',
          instruction: t('data.schemaEdited'),
          at: new Date().toISOString(),
        },
      },
    );
    setSchemaOpen(false);
  };

  const handlePaste = () => {
    setError(null);
    setBusy('paste');
    try {
      const table = importPasted(pasteText);
      const effectiveColumns = hasTable ? columns : table.columns;
      const merged = mergeRows(admitRows(table.rows, effectiveColumns));
      applyTable(
        { columns: effectiveColumns, rows: merged },
        {
          source: {
            id: uuidv4(),
            kind: table.sourceKind === 'json' ? 'json' : 'paste',
            name: table.sourceName,
            addedAt: new Date().toISOString(),
            rowCount: table.rows.length,
          },
        },
      );
      setPasteText('');
      setPasteOpen(false);
    } catch (err) {
      importError(err);
    } finally {
      setBusy(null);
    }
  };

  const runExtract = async (sourceText: string, sourceName: string) => {
    setError(null);
    setBusy('extract');
    let ingestCheckSourceId: string | null = null;
    try {
      const response = await fetch('/api/workflows/data/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceText,
          // Derived columns are computed locally — never ask the model
          // to extract values for them.
          columns: columns.filter((c) => !c.formula),
          modelId: conversation?.model?.id,
        }),
      });
      const parsed = await response.json();
      if (!response.ok || !parsed?.success) {
        throw new Error(
          parsed?.error || `Extraction failed (${response.status})`,
        );
      }
      const sourceId = uuidv4();
      const newRows = admitRows(parsed.data.rows as Rows, columns);
      const merged = mergeRows(newRows);
      applyTable(
        { columns, rows: merged },
        {
          source: {
            id: sourceId,
            kind: 'extraction',
            name: sourceName,
            addedAt: new Date().toISOString(),
            rowCount: newRows.length,
          },
        },
      );
      appendWorkflowRailMessages(
        conversationId,
        t('data.railExtractRequest', { source: sourceName }),
        t('data.railExtractDone', { count: String(newRows.length) }),
      );
      setExtractText('');
      setExtractOpen(false);
      ingestCheckSourceId = sourceId;
    } catch (err) {
      importError(err);
    } finally {
      setBusy(null);
    }
    if (ingestCheckSourceId) await runIngestCheck(ingestCheckSourceId);
  };

  const handleExtractFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    setBusy('extract');
    try {
      const extracted = await uploadAndExtractText(file);
      if (!extracted.text.trim()) {
        throw new Error(t('document.referenceEmpty', { name: file.name }));
      }
      await runExtract(extracted.text, file.name);
    } catch (err) {
      importError(err);
      setBusy(null);
    } finally {
      if (extractFileRef.current) extractFileRef.current.value = '';
    }
  };

  /**
   * Photo(s) → data: downscale + upload each image, then one vision
   * call — 'extract' into the existing schema, or 'infer' (structure +
   * values) when the table is empty. One batch = one source record with
   * all its photo refs, so the QC pane can show every photo beside the
   * rows it produced.
   */
  const handlePhotoFiles = async (files: FileList | File[] | null) => {
    const selected = Array.from(files ?? []).slice(
      0,
      FILE_COUNT_LIMITS.MAX_IMAGES,
    );
    if (selected.length === 0) return;
    setError(null);
    setNotice(null);
    setBusy('photo');
    let ingestCheckSourceId: string | null = null;
    try {
      const uploaded = await uploadPhotos(selected);
      const imageRefs = uploaded.map((photo) => photo.url);
      const sourceId = uuidv4();
      const sourceName =
        selected.length === 1
          ? selected[0].name
          : t('data.photoBatchName', { count: String(selected.length) });
      const modelId = conversation?.model?.id;

      let addedCount = 0;
      if (hasTable) {
        const result = await photoExtract({
          imageRefs,
          columns: columns.filter((c) => !c.formula),
          modelId,
        });
        const newRows = admitRows(result.rows as Rows, columns);
        const merged = mergeRows(newRows);
        addedCount = newRows.length;
        applyTable(
          { columns, rows: merged },
          {
            source: {
              id: sourceId,
              kind: 'photo',
              name: sourceName,
              addedAt: new Date().toISOString(),
              rowCount: newRows.length,
              imageFileUrls: imageRefs,
            },
          },
        );
      } else {
        const inference = await photoInfer({ imageRefs, modelId });
        const table = photoInferToTable(inference);
        const newRows = admitRows(table.rows, table.columns);
        addedCount = newRows.length;
        applyTable(
          { columns: table.columns, rows: newRows },
          {
            source: {
              id: sourceId,
              kind: 'photo',
              name: sourceName,
              addedAt: new Date().toISOString(),
              rowCount: newRows.length,
              imageFileUrls: imageRefs,
            },
          },
        );
        if (inference.kind === 'record') {
          updateWorkflowState(conversationId, (prev) => ({
            ...(prev as DataAnalysisWorkflowState),
            viewMode: 'record',
            updatedAt: new Date().toISOString(),
          }));
        }
        if (inference.notes.trim()) {
          setNotice(inference.notes.trim());
        }
      }
      appendWorkflowRailMessages(
        conversationId,
        t('data.railPhotoRequest', {
          count: String(selected.length),
          name: sourceName,
        }),
        t('data.railPhotoDone', { count: String(addedCount) }),
      );
      // Manual QC is the point of photo ingestion: open the photo pane.
      setRightPane({ type: 'source', sourceId });
      ingestCheckSourceId = sourceId;
    } catch (err) {
      importError(err);
    } finally {
      setBusy(null);
      if (photoInputRef.current) photoInputRef.current.value = '';
      if (cameraInputRef.current) cameraInputRef.current.value = '';
    }
    if (ingestCheckSourceId) await runIngestCheck(ingestCheckSourceId);
  };

  const handleTransform = async () => {
    // Held pastes are part of the instruction, so a chip alone is enough.
    if ((!instruction.trim() && !hasChips) || !hasTable) return;
    const trimmed = composeWithChips(instruction);
    const scoped = scope !== 'table';
    setError(null);
    setBusy('transform');
    try {
      const response = await fetch('/api/workflows/data/transform', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          columns,
          rows: stripRowIds(scopedRows),
          instruction: trimmed,
          engine: 'llm',
          scoped,
          modelId: conversation?.model?.id,
        }),
      });
      const parsed = await response.json();
      if (!response.ok || !parsed?.success) {
        throw new Error(
          parsed?.error || `Transform failed (${response.status})`,
        );
      }
      // The LLM round-trip loses format/formula metadata — re-attach
      // for columns that kept their id and number type. (Materialized
      // derived values in the result are stripped again in applyTable;
      // the overlay recomputes them.)
      const prevById = new Map(columns.map((column) => [column.id, column]));
      const resultColumns = (parsed.data.columns as DataColumn[]).map(
        (column) => {
          const prev = prevById.get(column.id);
          if (!prev || prev.type !== 'number' || column.type !== 'number') {
            return column;
          }
          const carried: DataColumn = { ...column };
          if (prev.format && !carried.format) carried.format = prev.format;
          if (prev.formula && !carried.formula) carried.formula = prev.formula;
          return carried;
        },
      );
      const resultRows = parsed.data.rows as Rows;

      let nextRows = resultRows;
      if (!scoped) {
        nextRows = carryRowIds(rows, resultRows);
      } else {
        // Positional merge-back (server enforced same count/order): each
        // scoped row keeps its rid; out-of-scope rows get null for any
        // new columns.
        nextRows = mergeScopedResult({
          rows,
          scopedRids: new Set(
            scopedRows
              .map((row) => getRowId(row))
              .filter((rid): rid is string => !!rid),
          ),
          columns,
          resultColumns,
          resultRows,
        });
      }

      // Transactional: replace only now that we have a valid result.
      applyTable(
        { columns: resultColumns, rows: nextRows },
        {
          operation: {
            id: uuidv4(),
            engine: 'llm',
            instruction: scoped
              ? t('data.scopedInstruction', {
                  instruction: trimmed,
                  count: String(scopedRows.length),
                })
              : trimmed,
            at: new Date().toISOString(),
            explanation: parsed.data.explanation,
          },
        },
      );
      appendWorkflowRailMessages(
        conversationId,
        trimmed,
        parsed.data.explanation || t('data.railTransformDone'),
      );
      setInstruction('');
      clearChips();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const handleTranspose = () => {
    applyTable(transposeTable(columns, rows, t('data.transposeAxisColumn')), {
      operation: {
        id: uuidv4(),
        engine: 'client',
        instruction: t('data.transposedTable'),
        at: new Date().toISOString(),
      },
    });
  };

  const dismissTransposeSuggestion = () => {
    updateWorkflowState(conversationId, (prev) => ({
      ...(prev as DataAnalysisWorkflowState),
      transposeSuggestionDismissed: true,
      updatedAt: new Date().toISOString(),
    }));
  };

  const handleDeleteSelected = () => {
    if (selectedRows.size === 0) return;
    applyTable(
      {
        columns,
        rows: rows.filter((row) => {
          const rid = getRowId(row);
          return !rid || !selectedRows.has(rid);
        }),
      },
      {
        operation: {
          id: uuidv4(),
          engine: 'client',
          instruction: t('data.deletedRows', {
            count: String(selectedRows.size),
          }),
          at: new Date().toISOString(),
        },
      },
    );
  };

  const assessment = state?.assessment;
  const pendingEditCount =
    assessment?.edits.filter((e) => e.status === 'pending').length ?? 0;
  const assessmentEdits = assessment?.edits;

  /**
   * Per-cell issue flags for the grid/record views: red = empty
   * required cell (deterministic scan), amber = pending quality edit
   * targeting the cell. Missing wins when both apply.
   */
  const cellFlags = useMemo(() => {
    const flags = new Map<string, Map<string, 'missing' | 'pending'>>();
    for (const edit of assessmentEdits ?? []) {
      if (edit.status !== 'pending' || edit.kind !== 'cell' || !edit.columnId) {
        continue;
      }
      let byColumn = flags.get(edit.rid);
      if (!byColumn) {
        byColumn = new Map();
        flags.set(edit.rid, byColumn);
      }
      byColumn.set(edit.columnId, 'pending');
    }
    for (const [rid, columnIds] of missingRequired) {
      let byColumn = flags.get(rid);
      if (!byColumn) {
        byColumn = new Map();
        flags.set(rid, byColumn);
      }
      for (const columnId of columnIds) byColumn.set(columnId, 'missing');
    }
    return flags;
  }, [assessmentEdits, missingRequired]);
  const flagCount = [...cellFlags.values()].reduce(
    (sum, byColumn) => sum + byColumn.size,
    0,
  );

  // A fresh assessment opens the review pane — unless the user is in a
  // photo QC pane (manual checking wins; the flags chip still leads here).
  const assessmentId = assessment?.id;
  useEffect(() => {
    if (!assessmentId) return;
    setRightPane((prev) =>
      prev?.type === 'source' ? prev : { type: 'review' },
    );
  }, [assessmentId]);

  /** Runs an assessment over the given rows and stores the result. */
  const runAssessment = useCallback(
    async (options: {
      targetRows: Rows;
      targetColumns: DataColumn[];
      allRows: Rows;
      criteria: string[];
      scope: DataQualityAssessment['scope'];
    }) => {
      const { targetRows, targetColumns, allRows, criteria } = options;
      const sampled = targetRows.length > MAX_ASSESS_ROWS;
      const sampledRows = strideSample(targetRows, MAX_ASSESS_ROWS);
      const result = await assessData({
        columns: targetColumns,
        rows: sampledRows,
        stats: [...profileTable(targetColumns, allRows).values()],
        criteria,
        scope: options.scope,
        sampled,
        totalRowCount: targetRows.length,
        modelId: conversation?.model?.id,
      });
      const edits: DataQualityEdit[] = result.edits.map((edit) => ({
        id: uuidv4(),
        criterion: edit.criterion,
        kind: edit.kind,
        rid: edit.rid,
        columnId: edit.kind === 'cell' ? edit.columnId : undefined,
        before: edit.before,
        after: edit.after,
        reason: edit.reason,
        severity: edit.severity,
        status: 'pending',
      }));
      updateWorkflowState(conversationId, (prev) => ({
        ...(prev as DataAnalysisWorkflowState),
        assessment: {
          id: uuidv4(),
          criteria: result.criteria,
          overallSummary: result.overallSummary,
          edits,
          scope: options.scope,
          sampled,
          assessedRowCount: sampledRows.length,
          totalRowCount: targetRows.length,
          createdAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      }));
      appendWorkflowRailMessages(
        conversationId,
        t('data.railAssessRequest', { count: String(sampledRows.length) }),
        result.overallSummary ||
          t('data.railAssessDone', { count: String(edits.length) }),
      );
    },
    [conversationId, conversation?.model?.id, t, updateWorkflowState],
  );

  const handleAssess = async () => {
    if (!hasTable || scopedRows.length === 0 || selectedCriteria.size === 0) {
      return;
    }
    setError(null);
    setBusy('assess');
    try {
      await runAssessment({
        targetRows: scopedRows,
        targetColumns: columns,
        allRows: rows,
        criteria: [...selectedCriteria],
        scope,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Agentic post-ingest check: after an LLM-mediated ingest
   * (photo/extraction), automatically assess the NEW rows — unless the
   * user turned it off or the policy is lenient ("don't bother me").
   * Reads the fresh source from the store (zustand set is synchronous)
   * so the appended rids assigned inside applyTable are available.
   */
  const runIngestCheck = async (sourceId: string) => {
    const current = useConversationStore
      .getState()
      .conversations.find((c) => c.id === conversationId)?.workflowState;
    if (current?.kind !== 'data-analysis') return;
    const s = current as DataAnalysisWorkflowState;
    if (s.autoCheckOnIngest === false) return;
    if ((s.missingFieldPolicy ?? DEFAULT_MISSING_FIELD_POLICY) === 'lenient') {
      return;
    }
    const source = s.sources.find((entry) => entry.id === sourceId);
    const rids = new Set(source?.rowIds ?? []);
    if (rids.size === 0) return;
    // Store rows bypass the workspace memo — overlay derived cells so
    // ingest checks see the same values manual assessments do.
    const allRows = applyDerivedColumns(s.columns, s.rows);
    const newRows = allRows.filter((row) => {
      const rid = getRowId(row);
      return !!rid && rids.has(rid);
    });
    if (newRows.length === 0) return;

    setBusy('ingestCheck');
    try {
      await runAssessment({
        targetRows: newRows,
        targetColumns: s.columns,
        allRows,
        criteria: DATA_QUALITY_CRITERIA.filter((c) => c.defaultOn).map(
          (c) => c.id,
        ),
        scope: 'ingest',
      });
    } catch (err) {
      // Auto-checks are best-effort: report without blocking the data.
      setNotice(
        t('data.ingestCheckFailed', {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setBusy(null);
    }
  };

  /**
   * Direct cell edit from the record view. Coerces per column type
   * (''→null) and, like accept-edit, does NOT clear the assessment —
   * a stale pending fix degrades to 'unapplicable' via its before-check.
   */
  const setCell = useCallback(
    (rid: string, columnId: string, raw: string) => {
      updateWorkflowState(conversationId, (prev) => {
        const p = prev as DataAnalysisWorkflowState;
        const column = p.columns.find((c) => c.id === columnId);
        // Derived cells are formula-owned — never directly writable.
        if (!column || column.formula) return p;
        const index = p.rows.findIndex((row) => getRowId(row) === rid);
        if (index === -1) return p;
        const value = raw === '' ? null : coerceCell(raw, column.type);
        if (p.rows[index][columnId] === value) return p;
        const nextRows = [...p.rows];
        nextRows[index] = { ...nextRows[index], [columnId]: value };
        return { ...p, rows: nextRows, updatedAt: new Date().toISOString() };
      });
    },
    [conversationId, updateWorkflowState],
  );

  /**
   * Accept/reject one quality edit. Runs entirely inside the store
   * updater (atomic); accepted fixes mutate rows in place — this must
   * NOT clear the assessment (unlike wholesale applyTable replacement).
   */
  const resolveEdit = useCallback(
    (editId: string, accept: boolean) => {
      updateWorkflowState(conversationId, (prev) => {
        const p = prev as DataAnalysisWorkflowState;
        if (!p.assessment) return p;
        const edit = p.assessment.edits.find((e) => e.id === editId);
        if (!edit || edit.status !== 'pending') return p;

        let nextRows = p.rows;
        let status: ReviewEditStatus = 'rejected';
        if (accept) {
          const result = applyQualityEdit(p.rows, p.columns, edit);
          nextRows = result.rows;
          status = result.applied ? 'accepted' : 'unapplicable';
        }
        return {
          ...p,
          rows: nextRows,
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

  const resolveAllEdits = useCallback(
    (accept: boolean) => {
      updateWorkflowState(conversationId, (prev) => {
        const p = prev as DataAnalysisWorkflowState;
        if (!p.assessment) return p;
        let nextRows = p.rows;
        const resolvedAt = new Date().toISOString();
        const edits = p.assessment.edits.map((edit) => {
          if (edit.status !== 'pending') return edit;
          let status: ReviewEditStatus = 'rejected';
          if (accept) {
            const result = applyQualityEdit(nextRows, p.columns, edit);
            nextRows = result.rows;
            status = result.applied ? 'accepted' : 'unapplicable';
          }
          return { ...edit, status, resolvedAt };
        });
        return {
          ...p,
          rows: nextRows,
          assessment: { ...p.assessment, edits },
          updatedAt: resolvedAt,
        };
      });
    },
    [conversationId, updateWorkflowState],
  );

  const viewMode = state?.viewMode ?? 'table';

  const handleExport = (format: 'csv' | 'json') => {
    if (!hasTable) return;
    if (format === 'csv') {
      const csv = Papa.unparse({
        fields: columns.map((c) => c.name),
        data: rows.map((row) => columns.map((c) => row[c.id] ?? '')),
      });
      downloadFile(csv, 'data.csv', 'text/csv');
    } else {
      const named = rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const c of columns) out[c.name] = row[c.id] ?? null;
        return out;
      });
      // A single record exports as the flat object, not a 1-element array.
      const payload =
        viewMode === 'record' && named.length === 1 ? named[0] : named;
      downloadFile(
        JSON.stringify(payload, null, 2),
        'data.json',
        'application/json',
      );
    }
  };

  /**
   * Mobile hands off to the native camera app (one shot, same ingest path);
   * desktop opens the in-page capture modal.
   */
  const handleTakePhotoClick = () => {
    if (isMobile()) {
      cameraInputRef.current?.click();
    } else {
      setCameraOpen(true);
    }
  };

  const cameraModal = (
    <CameraCaptureModal
      isOpen={cameraOpen}
      onClose={() => setCameraOpen(false)}
      onCapture={(file) => {
        setCameraOpen(false);
        void handlePhotoFiles([file]);
      }}
    />
  );

  if (!state) return null;

  const importButtons = (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={busy !== null}
        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
      >
        <IconFileSpreadsheet size={15} aria-hidden />
        {busy === 'import' ? t('data.importing') : t('data.importFile')}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.tsv,.json,.xls,.xlsx"
        hidden
        onChange={(e) => void handleImportFiles(e.target.files)}
      />
      <button
        type="button"
        onClick={() => setPasteOpen((open) => !open)}
        aria-pressed={pasteOpen}
        disabled={busy !== null}
        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
      >
        <IconClipboard size={15} aria-hidden />
        {t('data.pasteData')}
      </button>
      <button
        type="button"
        onClick={() => photoInputRef.current?.click()}
        disabled={busy !== null}
        title={t('data.fromPhotoHint')}
        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
      >
        <IconCamera size={15} aria-hidden />
        {busy === 'photo' ? t('data.readingPhoto') : t('data.fromPhoto')}
      </button>
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => void handlePhotoFiles(e.target.files)}
      />
      {hasCamera && (
        <>
          <button
            type="button"
            onClick={handleTakePhotoClick}
            disabled={busy !== null}
            title={t('data.takePhotoHint')}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
          >
            <IconCamera size={15} aria-hidden />
            {t('data.takePhoto')}
          </button>
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => void handlePhotoFiles(e.target.files)}
          />
        </>
      )}
      {hasTable && (
        <button
          type="button"
          onClick={() => setExtractOpen((open) => !open)}
          aria-pressed={extractOpen}
          disabled={busy !== null}
          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
        >
          <IconFileTextAi size={15} aria-hidden />
          {busy === 'extract' ? t('data.extracting') : t('data.addFromSource')}
        </button>
      )}
      <button
        type="button"
        onClick={() => setSchemaOpen((open) => !open)}
        aria-pressed={schemaOpen}
        disabled={busy !== null}
        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
      >
        <IconColumns size={15} aria-hidden />
        {hasTable ? t('data.editStructure') : t('data.defineStructure')}
      </button>
      {columns.some((c) => c.required) && (
        <label className="inline-flex min-h-[36px] items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
          {t('data.missingFieldPolicy')}
          <select
            value={policy}
            onChange={(e) =>
              updateWorkflowState(conversationId, (prev) => ({
                ...(prev as DataAnalysisWorkflowState),
                missingFieldPolicy: e.target
                  .value as DataAnalysisWorkflowState['missingFieldPolicy'],
                updatedAt: new Date().toISOString(),
              }))
            }
            className="min-h-[32px] rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-300"
          >
            <option value="strict">{t('data.policyStrict')}</option>
            <option value="flag">{t('data.policyFlag')}</option>
            <option value="lenient">{t('data.policyLenient')}</option>
          </select>
        </label>
      )}
      {hasTable && (
        <label
          className="inline-flex min-h-[36px] cursor-pointer items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400"
          title={t('data.autoCheckHint')}
        >
          <input
            type="checkbox"
            checked={state?.autoCheckOnIngest !== false}
            onChange={(e) =>
              updateWorkflowState(conversationId, (prev) => ({
                ...(prev as DataAnalysisWorkflowState),
                autoCheckOnIngest: e.target.checked,
                updatedAt: new Date().toISOString(),
              }))
            }
          />
          {t('data.autoCheck')}
        </label>
      )}
    </div>
  );

  if (!hasTable) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 overflow-y-auto p-6">
        <div className="w-full max-w-lg">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {t('data.emptyTitle')}
          </h2>
          <p className="mt-1 max-w-[65ch] text-sm text-gray-600 dark:text-gray-400">
            {t('data.emptyBody')}
          </p>
          <div className="mt-4">{importButtons}</div>
          {schemaOpen && (
            <div className="mt-3">
              <SchemaEditor
                columns={columns}
                onApply={handleApplySchema}
                onClose={() => setSchemaOpen(false)}
                disabled={busy !== null}
              />
            </div>
          )}
          {pasteOpen && (
            <div className="mt-3">
              <textarea
                ref={pasteRef}
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                rows={6}
                placeholder={t('data.pastePlaceholder')}
                className="w-full resize-y rounded-lg border border-gray-300 bg-gray-50 p-3 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400"
              />
              <button
                type="button"
                onClick={handlePaste}
                disabled={!pasteText.trim() || busy !== null}
                className="mt-2 min-h-[36px] rounded-lg bg-gray-300 px-3 py-1.5 text-sm font-medium text-gray-900 hover:bg-gray-400 disabled:opacity-30 dark:bg-surface-dark-base dark:text-white dark:hover:bg-surface-dark-elevated"
              >
                {t('data.import')}
              </button>
            </div>
          )}
          {error && (
            <p
              className="mt-3 text-sm text-red-700 dark:text-red-400"
              role="alert"
            >
              {error}
            </p>
          )}
          {cameraModal}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
          {importButtons}
          <div className="ms-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                updateWorkflowState(conversationId, (prev) => ({
                  ...(prev as DataAnalysisWorkflowState),
                  viewMode: viewMode === 'record' ? 'table' : 'record',
                  updatedAt: new Date().toISOString(),
                }))
              }
              className="inline-flex min-h-[36px] items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
            >
              {viewMode === 'record' ? (
                <IconTable size={15} aria-hidden />
              ) : (
                <IconForms size={15} aria-hidden />
              )}
              {viewMode === 'record'
                ? t('data.viewAsTable')
                : t('data.viewAsRecord')}
            </button>
            <button
              type="button"
              onClick={() => setInsightsOpen((open) => !open)}
              aria-pressed={insightsOpen}
              className={`inline-flex min-h-[36px] items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm hover:bg-gray-100 dark:hover:bg-surface-dark-elevated ${
                insightsOpen
                  ? 'text-blue-700 dark:text-blue-300'
                  : 'text-gray-600 dark:text-gray-400'
              }`}
            >
              <IconChartHistogram size={15} aria-hidden />
              {t('data.insights')}
            </button>
            {flagCount > 0 && (
              <button
                type="button"
                onClick={() => assessment && setRightPane({ type: 'review' })}
                title={
                  assessment
                    ? t('data.flagsChipOpenReview')
                    : t('data.flagsChipMissingOnly')
                }
                className="inline-flex min-h-[36px] items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-amber-700 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-900/20"
              >
                <IconFlag size={15} aria-hidden />
                {t('data.flagsChip', { count: String(flagCount) })}
              </button>
            )}
            {assessment && rightPane?.type !== 'review' && (
              <button
                type="button"
                onClick={() => setRightPane({ type: 'review' })}
                className="inline-flex min-h-[36px] items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
              >
                <IconClipboardCheck size={15} aria-hidden />
                {pendingEditCount > 0
                  ? t('data.showReviewPending', {
                      count: String(pendingEditCount),
                    })
                  : t('data.showReview')}
              </button>
            )}
            {canUndo && (
              <button
                type="button"
                onClick={handleUndo}
                className="inline-flex min-h-[36px] items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
              >
                <IconArrowBackUp size={15} aria-hidden />
                {t('data.undo')}
              </button>
            )}
            {selectedRows.size > 0 && (
              <button
                type="button"
                onClick={handleDeleteSelected}
                className="inline-flex min-h-[36px] items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
              >
                <IconTrash size={15} aria-hidden />
                {t('data.deleteSelected', { count: String(selectedRows.size) })}
              </button>
            )}
            <button
              type="button"
              onClick={() => handleExport('csv')}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
            >
              <IconDownload size={15} aria-hidden />
              CSV
            </button>
            <button
              type="button"
              onClick={() => handleExport('json')}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
            >
              <IconDownload size={15} aria-hidden />
              JSON
            </button>
          </div>
        </div>

        {/* Where the data came from (photo chips open the QC pane) */}
        <SourcesStrip
          sources={sources ?? []}
          activeSourceId={activeQcSource?.id}
          onOpenSource={(sourceId) =>
            setRightPane({ type: 'source', sourceId })
          }
        />

        {/* Inline panels */}
        {schemaOpen && (
          <SchemaEditor
            columns={columns}
            onApply={handleApplySchema}
            onClose={() => setSchemaOpen(false)}
            disabled={busy !== null}
          />
        )}
        {pasteOpen && (
          <div className="border-b border-gray-200 p-3 dark:border-gray-700">
            <textarea
              ref={pasteRef}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={4}
              placeholder={t('data.pastePlaceholder')}
              className="w-full resize-y rounded-lg border border-gray-300 bg-gray-50 p-3 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400"
            />
            <button
              type="button"
              onClick={handlePaste}
              disabled={!pasteText.trim() || busy !== null}
              className="mt-2 min-h-[36px] rounded-lg bg-gray-300 px-3 py-1.5 text-sm font-medium text-gray-900 hover:bg-gray-400 disabled:opacity-30 dark:bg-surface-dark-base dark:text-white dark:hover:bg-surface-dark-elevated"
            >
              {t('data.import')}
            </button>
          </div>
        )}
        {extractOpen && (
          <div className="border-b border-gray-200 p-3 dark:border-gray-700">
            <p className="mb-2 max-w-[75ch] text-xs text-gray-500 dark:text-gray-400">
              {t('data.extractHint')}
            </p>
            <textarea
              value={extractText}
              onChange={(e) => setExtractText(e.target.value)}
              rows={4}
              placeholder={t('data.extractPlaceholder')}
              className="w-full resize-y rounded-lg border border-gray-300 bg-gray-50 p-3 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  void runExtract(extractText.trim(), t('data.pastedSource'))
                }
                disabled={!extractText.trim() || busy !== null}
                className="min-h-[36px] rounded-lg bg-gray-300 px-3 py-1.5 text-sm font-medium text-gray-900 hover:bg-gray-400 disabled:opacity-30 dark:bg-surface-dark-base dark:text-white dark:hover:bg-surface-dark-elevated"
              >
                {busy === 'extract'
                  ? t('data.extracting')
                  : t('data.extractRows')}
              </button>
              <button
                type="button"
                onClick={() => extractFileRef.current?.click()}
                disabled={busy !== null}
                className="min-h-[36px] rounded-lg px-2.5 py-1.5 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-surface-dark-elevated"
              >
                {t('data.extractFromFile')}
              </button>
              <input
                ref={extractFileRef}
                type="file"
                accept=".pdf,.doc,.docx,.txt,.md"
                hidden
                onChange={(e) => void handleExtractFile(e.target.files)}
              />
            </div>
          </div>
        )}

        {error && (
          <p
            className="border-b border-gray-200 px-3 py-2 text-sm text-red-700 dark:border-gray-700 dark:text-red-400"
            role="alert"
          >
            {error}
          </p>
        )}
        {busy === 'ingestCheck' && (
          <p
            className="border-b border-gray-200 px-3 py-2 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400"
            role="status"
          >
            {t('data.checkingNewRows')}
          </p>
        )}
        {notice && (
          <p
            className="flex items-center justify-between gap-2 border-b border-gray-200 px-3 py-2 text-sm text-amber-800 dark:border-gray-700 dark:text-amber-300"
            role="status"
          >
            {notice}
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="text-xs text-gray-500 underline-offset-2 hover:underline dark:text-gray-400"
            >
              {t('data.dismiss')}
            </button>
          </p>
        )}

        {matrixDetected && !state?.transposeSuggestionDismissed && (
          <p
            className="flex items-center justify-between gap-2 border-b border-gray-200 px-3 py-2 text-sm text-gray-700 dark:border-gray-700 dark:text-gray-300"
            role="status"
          >
            {t('data.transposeSuggestion')}
            <span className="flex shrink-0 items-center gap-3">
              <button
                type="button"
                onClick={handleTranspose}
                disabled={busy !== null}
                className="text-sm font-medium text-blue-700 underline-offset-2 hover:underline disabled:opacity-50 dark:text-blue-400"
              >
                {t('data.transpose')}
              </button>
              <button
                type="button"
                onClick={dismissTransposeSuggestion}
                className="text-xs text-gray-500 underline-offset-2 hover:underline dark:text-gray-400"
              >
                {t('data.dismiss')}
              </button>
            </span>
          </p>
        )}

        {/* Grid / record form */}
        <div className="min-h-0 flex-1">
          {viewMode === 'record' ? (
            <RecordView
              columns={columns}
              rows={visibleRows}
              cellFlags={cellFlags}
              onSetCell={setCell}
              disabled={busy !== null}
            />
          ) : (
            <DataGrid
              columns={columns}
              rows={visibleRows}
              totalRowCount={rows.length}
              profiles={profiles}
              cellFlags={cellFlags}
              filters={filters}
              onFilterChange={(columnId, filter) =>
                setFilters((prev) => {
                  const next = { ...prev };
                  if (filter) next[columnId] = filter;
                  else delete next[columnId];
                  return next;
                })
              }
              selectedRows={selectedRows}
              onToggleRow={(rid) =>
                setSelectedRows((prev) => {
                  const next = new Set(prev);
                  if (next.has(rid)) next.delete(rid);
                  else next.add(rid);
                  return next;
                })
              }
              onToggleAll={() =>
                setSelectedRows((prev) => {
                  // Select-all operates on the VISIBLE (filtered) rows.
                  const rids = visibleRows
                    .map((row) => getRowId(row))
                    .filter((rid): rid is string => !!rid);
                  const allSelected =
                    rids.length > 0 && rids.every((rid) => prev.has(rid));
                  return allSelected ? new Set<string>() : new Set(rids);
                })
              }
            />
          )}
        </div>

        {/* Insights: deterministic charts over the VISIBLE rows */}
        {insightsOpen && <InsightsPanel columns={columns} rows={visibleRows} />}

        {/* Transform bar */}
        <div className="border-t border-gray-200 p-3 dark:border-gray-700">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <ScopeChip
              scope={scope}
              totalCount={rows.length}
              filteredCount={visibleRows.length}
              selectedCount={selectedRows.size}
              onChange={setScopeChoice}
              disabled={busy !== null}
            />
            {filterList.length > 0 && (
              <button
                type="button"
                onClick={() => setFilters({})}
                className="min-h-[28px] rounded-lg px-2 py-1 text-xs text-gray-600 underline-offset-2 hover:underline dark:text-gray-400"
              >
                {t('data.clearFilters')}
              </button>
            )}
            {activeQcSource && sourceFilterRids && (
              <button
                type="button"
                onClick={() => setRightPane(null)}
                title={t('data.clearSourceFilter')}
                className="inline-flex min-h-[28px] items-center gap-1 rounded-lg bg-blue-100 px-2 py-1 text-xs text-blue-900 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-200 dark:hover:bg-blue-900/50"
              >
                {t('data.sourceFilterChip', { name: activeQcSource.name })}
                <span aria-hidden>✕</span>
              </button>
            )}
            <div className="ms-auto flex flex-wrap items-center gap-2">
              <CriteriaPicker
                criteria={DATA_QUALITY_CRITERIA.map((criterion) => ({
                  id: criterion.id,
                  label: t(`data.criteria.${criterion.labelKey}.label`),
                  description: t(
                    `data.criteria.${criterion.descriptionKey}.description`,
                  ),
                }))}
                selected={selectedCriteria}
                onToggle={(id) =>
                  setSelectedCriteria((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                i18nNamespace="workflows.data"
                disabled={busy !== null}
              />
              <button
                type="button"
                onClick={() => void handleAssess()}
                disabled={
                  busy !== null ||
                  scopedRows.length === 0 ||
                  selectedCriteria.size === 0
                }
                className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-surface-dark-elevated"
              >
                <IconClipboardCheck size={15} aria-hidden />
                {busy === 'assess' ? t('data.assessing') : t('data.assess')}
              </button>
            </div>
          </div>
          <PastedTextChips chips={chips} onRemove={removeChip} />
          <div className="flex items-end gap-2">
            <textarea
              ref={instructionRef}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleTransform();
                }
              }}
              rows={1}
              disabled={busy !== null}
              placeholder={t('data.transformPlaceholder')}
              className="min-h-[44px] flex-1 resize-none rounded-lg border border-gray-300 bg-gray-50 px-3 py-2.5 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none disabled:opacity-50 dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400"
            />
            <button
              type="button"
              onClick={() => void handleTransform()}
              disabled={(!instruction.trim() && !hasChips) || busy !== null}
              className="flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg bg-gray-300 px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-400 disabled:pointer-events-none disabled:opacity-30 dark:bg-surface-dark-base dark:text-white dark:hover:bg-surface-dark-elevated"
            >
              <IconSparkles size={15} aria-hidden />
              {busy === 'transform'
                ? t('data.transforming')
                : t('data.transform')}
            </button>
          </div>
          {scopedRows.length > 500 && (
            <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">
              {t('data.transformCapHint', { max: '500' })}
            </p>
          )}
        </div>
      </div>

      {/* Exclusive right pane: quality review OR photo-source QC. */}
      {assessment && rightPane?.type === 'review' && (
        <aside className="hidden w-96 shrink-0 border-s border-gray-200 dark:border-gray-700 lg:flex lg:flex-col">
          <AssessmentPanel
            assessment={assessment}
            resolveCriterionLabel={(id) => t(`data.criteria.${id}.label`)}
            i18nNamespace="workflows.data"
            scopeLabel={buildAssessmentScopeLabel(assessment, t)}
            getEditLocationLabel={(edit: ReviewEdit) => {
              const dataEdit = edit as DataQualityEdit;
              if (dataEdit.kind === 'deleteRow') {
                return t('data.editLocationRow', { row: dataEdit.rid });
              }
              const columnName =
                columns.find((c) => c.id === dataEdit.columnId)?.name ??
                dataEdit.columnId ??
                '';
              return t('data.editLocation', {
                row: dataEdit.rid,
                column: columnName,
              });
            }}
            onAccept={(id) => resolveEdit(id, true)}
            onReject={(id) => resolveEdit(id, false)}
            onAcceptAll={() => resolveAllEdits(true)}
            onRejectAll={() => resolveAllEdits(false)}
            onClose={() => setRightPane(null)}
            disabled={busy !== null}
          />
        </aside>
      )}
      {activeQcSource && (
        <aside className="hidden w-96 shrink-0 border-s border-gray-200 dark:border-gray-700 lg:flex lg:flex-col">
          <SourceQcPanel
            source={activeQcSource}
            onClose={() => setRightPane(null)}
          />
        </aside>
      )}
      {cameraModal}
    </div>
  );
}

/** "Filtered rows · sample of 300 of 1,200" style badge for the panel. */
function buildAssessmentScopeLabel(
  assessment: NonNullable<DataAnalysisWorkflowState['assessment']>,
  t: ReturnType<typeof useTranslations<'workflows'>>,
): string | undefined {
  const scopePart =
    assessment.scope === 'filtered'
      ? t('data.assessedFiltered')
      : assessment.scope === 'selection'
        ? t('data.assessedSelection')
        : assessment.scope === 'ingest'
          ? t('data.assessedIngest')
          : undefined;
  const samplePart = assessment.sampled
    ? t('data.assessedSample', {
        shown: String(assessment.assessedRowCount),
        total: String(assessment.totalRowCount),
      })
    : undefined;
  if (scopePart && samplePart) return `${scopePart} · ${samplePart}`;
  return scopePart ?? samplePart;
}

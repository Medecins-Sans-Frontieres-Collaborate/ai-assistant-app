'use client';

import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconCircle,
  IconCircleX,
  IconDownload,
  IconExternalLink,
  IconFileUpload,
  IconFilter,
  IconLoader,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useSession } from 'next-auth/react';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';

import { canAccessGrants } from '@/lib/services/grants/access';

import { GrantsWorkflowState, GrantsWorkflowStep } from '@/types/workflow';

import { WorkflowWorkspaceProps } from '../registry';

import { useConversationStore } from '@/client/stores/conversationStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BlobDocument {
  name: string;
  size: number;
  lastModified: string;
  blobPath: string;
}

interface ProgressStage {
  status: 'completed' | 'running' | 'pending';
  percent: number;
}

interface ProgressData {
  runId: string;
  status: 'running' | 'succeeded' | 'failed';
  overall_percent: number;
  current_stage: number;
  current_stage_name: string;
  stages: Record<string, ProgressStage>;
  error?: string;
  downloadUrl?: string;
}

interface ValidationFlag {
  row: number;
  column: string;
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

interface SupplementalReportEntry {
  category: string;
  file?: string;
  entries?: number;
  match_type?: string;
  expected?: string;
  error?: string;
}

interface SupplementalReport {
  loaded: SupplementalReportEntry[];
  missing: SupplementalReportEntry[];
  failed: SupplementalReportEntry[];
}

interface ExtractionData {
  columns: string[];
  rows: Record<string, string>[];
  validation: {
    total_rows: number;
    summary: { errors: number; warnings: number; info: number };
    flags: ValidationFlag[];
  };
  sourceFileMap?: Record<string, string>;
  sourceTypes?: Record<string, string>;
  supplementalReport?: SupplementalReport;
}

// Column width categories for validation review table
const NARROW_COLUMNS = new Set([
  'Project Code',
  'OC',
  'Project Active',
  'New Project',
  'Emergency Project',
  'Closing Project',
  'Sanctions',
  'Emergency Relief Fund',
  'Sensitive Context for Screening',
  'Impact of Climate Change',
  'Nutrition',
  'Refugees and IDPs',
  'Mental Health',
  'Maternal Health',
  'Pediatrics',
  'Community/Patient-Centered',
  'Armed Conflict',
]);
const WIDE_COLUMNS = new Set([
  'Project Objective',
  'Key Terms/Activities',
  'Evidence Summary',
]);
// Long-text fields shown in the row detail panel
const DETAIL_FIELDS = [
  'Project Objective',
  'Key Terms/Activities',
  'Evidence Summary',
];

type UIState =
  | 'document-management'
  | 'confirm'
  | 'coverage-check'
  | 'progress'
  | 'validation-review'
  | 'complete';

// Pre-processing coverage-check reconciliation (mirrors lib/services/grants/preprocess.ts)
interface ReconciliationRow {
  projectCode: string;
  projectName: string;
  projectCodeInNarrative: string;
  projectNameInNarrative: string;
  narrativeFile?: string;
  recovered?: boolean;
  evidence?: string;
  align: 'Yes' | 'No';
  differences: string;
  aligned: string;
}

interface NameMatchProposal {
  proposedCode: string;
  proposedName: string;
  country?: string;
  file: string;
  narrativeName: string;
  matchedTerms: string[];
  countryMatched: boolean;
  confidence: number;
}

interface Reconciliation {
  rows: ReconciliationRow[];
  expected: string[];
  found: string[];
  matched: string[];
  missingFromNarratives: string[];
  proposals: NameMatchProposal[];
}

interface CoverageData {
  oc: string;
  hasExpectedList: boolean;
  reconciliation: Reconciliation;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OC_OPTIONS = ['OCA', 'OCB', 'OCBA', 'OCG', 'OCP', 'WaCA'] as const;

const STAGE_NAMES: Record<string, string> = {
  extract_text: 'Extracting Text (Document Intelligence)',
  extract_fields: 'Extracting Fields (LLM)',
  normalize: 'Normalizing Data',
  enrich: 'Enriching with Supplemental Data',
  validate: 'Running Validation Rules',
  build_output: 'Building Output CSV',
};

const STAGE_ORDER = [
  'extract_text',
  'extract_fields',
  'normalize',
  'enrich',
  'validate',
  'build_output',
];

const COLUMN_GROUPS: {
  label: string;
  columns: string[];
}[] = [
  {
    label: 'Core Identity',
    columns: ['Project Code', 'Project Name', 'Country', 'OC'],
  },
  {
    label: 'Project Details',
    columns: ['Project Objective', 'Key Terms/Activities', 'Evidence Summary'],
  },
  {
    label: 'Dates & Status',
    columns: [
      'Start Date',
      'End Date',
      'Project Active',
      'New Project',
      'Closing Project',
    ],
  },
  {
    label: 'Funding',
    columns: ['Purpose Code', 'Initial Budget EUR'], // need to add revised budgets
  },
  {
    label: 'Operational',
    columns: ['Sanctions', 'Emergency Project', 'Emergency Relief Fund'],
  },
  {
    label: 'Thematic Flags',
    columns: [
      'Sensitive Context for Screening',
      'Impact of Climate Change',
      'Nutrition',
      'Refugees and IDPs',
      'Mental Health',
      'Maternal Health',
      'Pediatrics',
      'Community/Patient-Centered',
      'Armed Conflict',
    ],
  },
  {
    label: 'Classification',
    columns: [
      'Context',
      'Event',
      'Population Type',
      'ICA Country',
      'ICA Country Code',
    ],
  },
  {
    label: 'Metadata',
    columns: ['Source File'],
  },
];

const ALL_CSV_COLUMNS = COLUMN_GROUPS.flatMap((g) => g.columns);

// The five fields the grants team is currently focused on — checked by default
const DEFAULT_COLUMNS = [
  'Project Code',
  'Project Name',
  'OC',
  'Project Objective',
  'Key Terms/Activities',
  'Country',
].filter((c) => ALL_CSV_COLUMNS.includes(c));

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Only genuine OUTLIERS are flagged for review and excluded from the export by
 *  default: coordination and strategy documents. Overviews / compilations /
 *  country profiles are NOT flagged — for several OCs they ARE the project
 *  source (OCP's country docs, OCG's compilation), so treating them as outliers
 *  wrongly unchecked most of those OCs' real projects. Anything not matched here
 *  (including an unknown/empty type) is treated as a normal narrative. */
function isFlaggedDocType(t?: string): boolean {
  return !!t && /coordinat|strateg/i.test(t);
}

function isGreenInitiativeDocType(t?: string): boolean {
  return !!t && /green/i.test(t);
}

/**
 * Grants extraction workspace: the OC/document setup, coverage check,
 * extraction progress, and validation review, hosted inside a
 * workflow conversation. Ported from the former standalone
 * /grants/extraction page; server APIs are unchanged. Only identifiers
 * (OC, year, step, run ids) persist on the conversation — run artifacts are
 * re-fetched from the server when the conversation reopens.
 */
export function GrantsWorkspace({ conversationId }: WorkflowWorkspaceProps) {
  // Access control — restrict the whole page to allowlisted users.
  const { data: session, status: sessionStatus } = useSession();
  const hasGrantsAccess = canAccessGrants(session?.user);

  // State management
  const [uiState, setUiState] = useState<UIState>('document-management');
  // Latest coverage-check run id — persisted on the conversation so the
  // reconciliation can be restored when the conversation reopens.
  const [coverageRunId, setCoverageRunId] = useState<string | null>(null);
  const updateWorkflowState = useConversationStore(
    (s) => s.updateWorkflowState,
  );
  const updateConversation = useConversationStore((s) => s.updateConversation);
  const hydratedRef = useRef(false);
  const [selectedOC, setSelectedOC] = useState<string>('');
  const [selectedYear, setSelectedYear] = useState<number>(() =>
    new Date().getFullYear(),
  );
  const [existingDocs, setExistingDocs] = useState<BlobDocument[]>([]);
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [supplementalExpanded, setSupplementalExpanded] = useState(false);
  const [supplementalFiles, setSupplementalFiles] = useState<BlobDocument[]>(
    [],
  );
  const [selectedColumns, setSelectedColumns] = useState<Set<string>>(
    () => new Set(DEFAULT_COLUMNS),
  );
  const [columnsExpanded, setColumnsExpanded] = useState(false);

  // Extraction state
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [extractionData, setExtractionData] = useState<ExtractionData | null>(
    null,
  );
  const [editedRows, setEditedRows] = useState<Record<string, string>[]>([]);
  // Which rows are included in the exported CSV. Rows sourced from a regular
  // narrative are included by default; rows sourced from a non-narrative document
  // (coordination / strategy / overview) are excluded by default and must be
  // opted-in by the user via the checkbox in the leftmost column.
  const [includedRows, setIncludedRows] = useState<Set<number>>(new Set());
  const [filterMode, setFilterMode] = useState<
    'all' | 'flagged' | 'errors' | 'warnings'
  >('all');
  const [editingCell, setEditingCell] = useState<{
    row: number;
    col: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  // Pre-processing coverage check
  const [coverageData, setCoverageData] = useState<CoverageData | null>(null);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [coverageProgress, setCoverageProgress] = useState<{
    percent: number;
    label: string;
  }>({
    percent: 0,
    label: '',
  });
  const [acceptedProposals, setAcceptedProposals] = useState<Set<string>>(
    new Set(),
  );
  // Likely-match rows (no code in the document)
  const [includedLikely, setIncludedLikely] = useState<Set<string>>(new Set());

  // Extraction prompt editor (per-OC, blob-backed via /api/grants/prompt)
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptText, setPromptText] = useState('');
  const [promptPristine, setPromptPristine] = useState('');
  const [promptMeta, setPromptMeta] = useState<{
    isOverride: boolean;
    updatedBy: string | null;
    updatedAt: string | null;
  } | null>(null);
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);
  const [promptNotice, setPromptNotice] = useState<string | null>(null);
  const [promptLoadedOC, setPromptLoadedOC] = useState<string>('');
  const [promptLoadedYear, setPromptLoadedYear] = useState<number>(0);

  // -------------------------------------------------------------------------
  // Fetch documents when OC changes
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!selectedOC) {
      setExistingDocs([]);
      return;
    }
    const fetchDocs = async () => {
      setLoadingDocs(true);
      try {
        const res = await fetch(
          `/api/grants/documents?oc=${selectedOC}&type=narrative`,
        );
        if (res.ok) {
          const data = await res.json();
          setExistingDocs(data.documents ?? []);
        }
      } catch {
        console.error('Failed to fetch documents');
      } finally {
        setLoadingDocs(false);
      }
    };
    fetchDocs();
    // Also fetch supplemental
    const fetchSupplemental = async () => {
      try {
        const res = await fetch(`/api/grants/supplemental?oc=${selectedOC}`);
        if (res.ok) {
          const data = await res.json();
          setSupplementalFiles(data.files ?? []);
        }
      } catch {
        console.error('Failed to fetch supplemental files');
      }
    };
    fetchSupplemental();
  }, [selectedOC]);

  // -------------------------------------------------------------------------
  // Progress polling
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (
      !currentRunId ||
      progress?.status === 'succeeded' ||
      progress?.status === 'failed'
    ) {
      return;
    }

    const poll = async () => {
      try {
        const res = await fetch(`/api/grants/runs/${currentRunId}/progress`);
        if (res.ok) {
          const data: ProgressData = await res.json();
          setProgress(data);
          if (data.status === 'failed') {
            setError(data.error || 'Pipeline failed');
          } else if (data.status === 'succeeded') {
            // Transition to validation review
            await fetchExtractionData(currentRunId);
            setUiState('validation-review');
          }
        }
      } catch {
        console.error('Error polling progress');
      }
    };

    const interval = setInterval(poll, 2000);
    poll();
    return () => clearInterval(interval);
  }, [currentRunId, progress?.status]);

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------
  const fetchExtractionData = async (runId: string) => {
    try {
      const res = await fetch(`/api/grants/runs/${runId}/data`);
      if (res.ok) {
        const data: ExtractionData = await res.json();
        setExtractionData(data);
        setEditedRows(data.rows.map((r) => ({ ...r })));
        // Default inclusion: narrative-sourced rows in, non-narrative out.
        const included = new Set<number>();
        data.rows.forEach((r, i) => {
          const t = data.sourceTypes?.[r['Source File'] || ''];
          if (!isFlaggedDocType(t)) included.add(i);
        });
        setIncludedRows(included);
      }
    } catch {
      console.error('Failed to fetch extraction data');
    }
  };

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || !selectedOC) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(e.target.files)) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('oc', selectedOC);
        const res = await fetch('/api/grants/documents', {
          method: 'POST',
          body: formData,
        });
        if (!res.ok) throw new Error('Upload failed');
      }
      // Refresh document list
      const res = await fetch(
        `/api/grants/documents?oc=${selectedOC}&type=narrative`,
      );
      if (res.ok) {
        const data = await res.json();
        setExistingDocs(data.documents ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleSupplementalUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    if (!e.target.files || !selectedOC) return;
    setUploading(true);
    try {
      for (const file of Array.from(e.target.files)) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('oc', selectedOC);
        await fetch('/api/grants/supplemental', {
          method: 'POST',
          body: formData,
        });
      }
      const res = await fetch(`/api/grants/supplemental?oc=${selectedOC}`);
      if (res.ok) {
        const data = await res.json();
        setSupplementalFiles(data.files ?? []);
      }
    } catch {
      setError('Supplemental upload failed');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const handleDeleteDoc = async (blobPath: string) => {
    try {
      await fetch(
        `/api/grants/documents?blobPath=${encodeURIComponent(blobPath)}`,
        {
          method: 'DELETE',
        },
      );
      setExistingDocs((prev) => prev.filter((d) => d.blobPath !== blobPath));
      setSelectedDocs((prev) => {
        const next = new Set(prev);
        next.delete(blobPath);
        return next;
      });
    } catch {
      setError('Failed to delete document');
    }
  };

  const handleDeleteAllDocs = async () => {
    if (!selectedOC || existingDocs.length === 0) return;
    try {
      await fetch(
        `/api/grants/documents?blobPath=all&oc=${encodeURIComponent(selectedOC)}`,
        { method: 'DELETE' },
      );
      setExistingDocs([]);
      setSelectedDocs(new Set());
    } catch {
      setError('Failed to remove all documents');
    }
  };

  const handleDeleteSupplemental = async (blobPath: string) => {
    try {
      await fetch(
        `/api/grants/supplemental?blobPath=${encodeURIComponent(blobPath)}`,
        { method: 'DELETE' },
      );
      setSupplementalFiles((prev) =>
        prev.filter((f) => f.blobPath !== blobPath),
      );
    } catch {
      setError('Failed to delete supplemental file');
    }
  };

  const handleDeleteAllSupplemental = async () => {
    if (!selectedOC || supplementalFiles.length === 0) return;
    try {
      await fetch(
        `/api/grants/supplemental?blobPath=all&oc=${encodeURIComponent(selectedOC)}`,
        { method: 'DELETE' },
      );
      setSupplementalFiles([]);
    } catch {
      setError('Failed to remove all supplemental files');
    }
  };

  const toggleDocSelection = (blobPath: string) => {
    setSelectedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(blobPath)) next.delete(blobPath);
      else next.add(blobPath);
      return next;
    });
  };

  // Pre-processing gate: run the coverage check before extraction.
  const handleRunCoverageCheck = async () => {
    setError(null);
    setCoverageLoading(true);
    setCoverageProgress({ percent: 0, label: 'Starting…' });
    setAcceptedProposals(new Set());

    const runId =
      typeof globalThis.crypto !== 'undefined' && globalThis.crypto.randomUUID
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setCoverageRunId(runId);

    try {
      // Starts the coverage check. The server runs it in the background and
      // reports progress + the final reconciliation via the progress endpoint,
      // so this request returns immediately (avoids the gateway stream timeout
      // that a long-held synchronous request hits in deployed environments).
      const res = await fetch('/api/grants/preprocess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oc: selectedOC,
          documentBlobPaths: Array.from(selectedDocs),
          runId,
        }),
      });
      if (!res.ok) throw new Error(await res.text());

      // Poll the progress file until the background run reports a terminal
      // state, then read the result (or error) straight from the poll payload.
      const data = await new Promise<CoverageData>((resolve, reject) => {
        const deadline = Date.now() + 20 * 60 * 1000; // 20-minute safety cap
        const poll = setInterval(async () => {
          if (Date.now() > deadline) {
            clearInterval(poll);
            reject(new Error('Coverage check timed out'));
            return;
          }
          try {
            const pr = await fetch(
              `/api/grants/preprocess/progress?runId=${runId}`,
            );
            if (!pr.ok) return;
            const d = await pr.json();
            setCoverageProgress({
              percent: d.percent ?? 0,
              label: d.label ?? '',
            });
            if (d.status === 'done') {
              clearInterval(poll);
              resolve({
                oc: d.oc,
                hasExpectedList: d.hasExpectedList,
                reconciliation: d.reconciliation,
              });
            } else if (d.status === 'error') {
              clearInterval(poll);
              reject(new Error(d.error || 'Coverage check failed'));
            }
          } catch {
            /* ignore transient poll errors */
          }
        }, 1500);
      });

      setCoverageData(data);
      setIncludedLikely(defaultRowSelection(data.reconciliation));
      setUiState('coverage-check');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to run coverage check',
      );
    } finally {
      setCoverageLoading(false);
    }
  };

  /* Proposed-matches accept/toggle — disabled while the code-matching UI is
     scoped out with the Grants team
  const toggleProposal = (file: string) => {
    setAcceptedProposals((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  };
  */

  // Default row selection for a fresh coverage result: confirmed code matches
  // are pre-selected (verified matches forward automatically); amber likely
  // matches start unselected until a human reviews the document.
  const defaultRowSelection = (rec: Reconciliation): Set<string> =>
    new Set(
      rec.rows
        .filter((r) => r.align === 'Yes' && r.narrativeFile)
        .map((r) => r.projectCode),
    );

  // -------------------------------------------------------------------------
  // Conversation persistence: hydrate once from the conversation's workflow
  // state, then write identifiers back on every transition. Run artifacts are
  // never persisted — they're re-fetched from the server by run id.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const ws = useConversationStore
      .getState()
      .conversations.find((c) => c.id === conversationId)?.workflowState;
    if (ws?.kind !== 'grants') return;
    if (ws.oc) setSelectedOC(ws.oc);
    if (ws.year) setSelectedYear(ws.year);
    (async () => {
      if (ws.step === 'validation-review' && ws.extractionRunId) {
        setCurrentRunId(ws.extractionRunId);
        await fetchExtractionData(ws.extractionRunId);
        setUiState('validation-review');
      } else if (ws.step === 'coverage-check' && ws.coverageRunId) {
        try {
          const pr = await fetch(
            `/api/grants/preprocess/progress?runId=${encodeURIComponent(ws.coverageRunId)}`,
          );
          if (!pr.ok) return;
          const d = await pr.json();
          if (d?.status === 'done' && d?.reconciliation) {
            setCoverageRunId(ws.coverageRunId ?? null);
            setCoverageData({
              oc: d.oc,
              hasExpectedList: !!d.hasExpectedList,
              reconciliation: d.reconciliation,
            });
            setIncludedLikely(defaultRowSelection(d.reconciliation));
            setUiState('coverage-check');
          }
        } catch {
          /* stale run — stay on the fresh start screen */
        }
      } else if (ws.step === 'confirm' || ws.step === 'document-management') {
        setUiState(ws.step);
      }
    })();
    // Mount-only: hydration must not re-run as state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    // 'complete' restores to the review it concluded from.
    const step: GrantsWorkflowStep =
      uiState === 'complete' ? 'validation-review' : uiState;
    updateWorkflowState(conversationId, (prev) => {
      const base: GrantsWorkflowState =
        prev?.kind === 'grants'
          ? prev
          : { kind: 'grants', updatedAt: new Date().toISOString() };
      const next: GrantsWorkflowState = {
        ...base,
        oc: selectedOC || undefined,
        year: selectedYear,
        step,
        coverageRunId: coverageRunId || base.coverageRunId,
        extractionRunId: currentRunId || base.extractionRunId,
        updatedAt: new Date().toISOString(),
      };
      const same =
        base.oc === next.oc &&
        base.year === next.year &&
        base.step === next.step &&
        base.coverageRunId === next.coverageRunId &&
        base.extractionRunId === next.extractionRunId;
      return same && prev?.kind === 'grants' ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOC, selectedYear, uiState, coverageRunId, currentRunId]);

  // Name the conversation after the run so sidebar history stays legible
  // ("Grants — OCB 2026" instead of a default title).
  useEffect(() => {
    if (!hydratedRef.current || !selectedOC) return;
    updateConversation(conversationId, {
      name: `Grants — ${selectedOC} ${selectedYear}`,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOC, selectedYear]);

  // Resolve a narrative filename to its blob path so it can be opened via the
  // document-serve endpoint. Prefers the actual selected-doc blob path; falls
  // back to the conventional grants/{oc}/narratives/{file} layout.
  const narrativeBlobPath = (file: string): string => {
    const match = existingDocs.find(
      (d) => d.blobPath.split('/').pop() === file || d.name === file,
    );
    if (match) return match.blobPath;
    const oc = coverageData?.oc || selectedOC;
    return `grants/${oc}/narratives/${file}`;
  };

  // --- Extraction prompt editor ---------------------------------------------
  const promptDirty = promptText !== promptPristine;

  const loadPrompt = useCallback(
    async (oc: string) => {
      if (!oc) return;
      setPromptLoading(true);
      setPromptNotice(null);
      try {
        const res = await fetch(
          `/api/grants/prompt?oc=${encodeURIComponent(oc)}&year=${selectedYear}`,
        );
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        setPromptText(data.prompt || '');
        setPromptPristine(data.prompt || '');
        setPromptMeta({
          isOverride: !!data.isOverride,
          updatedBy: data.updatedBy ?? null,
          updatedAt: data.updatedAt ?? null,
        });
        setPromptLoadedOC(oc);
        setPromptLoadedYear(selectedYear);
      } catch (err) {
        setPromptNotice(
          err instanceof Error ? err.message : 'Failed to load prompt',
        );
      } finally {
        setPromptLoading(false);
      }
    },
    [selectedYear],
  );

  // Load (or reload) the prompt whenever the panel is open and it's stale for the
  // current OC or year — covers first-open, switching OC, and changing the year
  // (the year is baked into the rendered prompt). Skipped when there are unsaved
  // edits so we don't clobber them.
  useEffect(() => {
    if (
      promptOpen &&
      selectedOC &&
      !promptDirty &&
      (promptLoadedOC !== selectedOC || promptLoadedYear !== selectedYear)
    ) {
      loadPrompt(selectedOC);
    }
  }, [
    promptOpen,
    selectedOC,
    selectedYear,
    promptLoadedOC,
    promptLoadedYear,
    promptDirty,
    loadPrompt,
  ]);

  const savePrompt = async () => {
    if (!selectedOC) return;
    setPromptSaving(true);
    setPromptNotice(null);
    try {
      const res = await fetch('/api/grants/prompt', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oc: selectedOC, prompt: promptText }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setPromptPristine(promptText);
      setPromptMeta({
        isOverride: true,
        updatedBy: data.updatedBy ?? null,
        updatedAt: data.updatedAt ?? null,
      });
      setPromptNotice(
        'Saved — this prompt will be used for future extractions.',
      );
    } catch (err) {
      setPromptNotice(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setPromptSaving(false);
    }
  };

  const resetPrompt = async () => {
    if (!selectedOC) return;
    setPromptSaving(true);
    setPromptNotice(null);
    try {
      const res = await fetch(
        `/api/grants/prompt?oc=${encodeURIComponent(selectedOC)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error(await res.text());
      await loadPrompt(selectedOC); // reloads the code default
      setPromptNotice('Reset to the default prompt.');
    } catch (err) {
      setPromptNotice(err instanceof Error ? err.message : 'Failed to reset');
    } finally {
      setPromptSaving(false);
    }
  };

  const handleStartExtraction = async () => {
    setError(null);
    setUiState('progress');
    setProgress(null);

    // Carry forward any name-match proposals the user accepted as code overrides
    // (keyed by narrative filename → confirmed project code).
    const codeOverrides: Record<string, string> = {};
    if (coverageData) {
      for (const p of coverageData.reconciliation.proposals) {
        if (acceptedProposals.has(p.proposedCode))
          codeOverrides[p.file] = p.proposedCode;
      }
      // Rows the user selected on the coverage screen: attribute the
      // allocation code to that row's narrative during extraction.
      const selectedByFile = new Map<string, string[]>();
      for (const r of coverageData.reconciliation.rows) {
        if (
          r.narrativeFile &&
          (r.align === 'Yes' || r.recovered) &&
          includedLikely.has(r.projectCode)
        ) {
          const list = selectedByFile.get(r.narrativeFile) || [];
          list.push(r.projectCode);
          selectedByFile.set(r.narrativeFile, list);
        }
      }
      for (const [file, codes] of selectedByFile) {
        if (codes.length === 1) codeOverrides[file] = codes[0];
      }
    }

    try {
      const res = await fetch('/api/grants/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oc: selectedOC,
          documentBlobPaths: Array.from(selectedDocs),
          selectedColumns: Array.from(selectedColumns),
          year: selectedYear,
          supplementalBlobPaths: Object.fromEntries(
            supplementalFiles.map((f) => [f.name, f.blobPath]),
          ),
          codeOverrides,
          // Only send an in-flight prompt when the user has actually EDITED it
          // for this OC (unsaved changes). Merely opening the editor must not
          // pin a prompt onto the run — otherwise the server falls back to a
          // saved override or the code default (the intended behavior).
          promptOverride:
            promptDirty && promptLoadedOC === selectedOC
              ? promptText
              : undefined,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setCurrentRunId(data.runId);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to start extraction',
      );
      setUiState('document-management');
    }
  };

  // Download the reconciliation as a CSV in the stakeholder's column order.
  const handleDownloadReconciliation = () => {
    if (!coverageData) return;
    const cols = [
      'Project Code',
      'Project Name',
      'Project Code in Narrative',
      'Project Name in Narrative',
      'Do Allocation List and Narrative Align?',
      'What are the differences?',
      'What is aligned?',
    ];
    const esc = (v: string) =>
      /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    const lines = coverageData.reconciliation.rows.map((r) =>
      [
        r.projectCode,
        r.projectName,
        r.projectCodeInNarrative,
        r.projectNameInNarrative,
        r.align,
        r.differences,
        r.aligned,
      ]
        .map((x) => esc(String(x ?? '')))
        .join(','),
    );
    const csv = [cols.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `coverage-check-${selectedOC}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCellEdit = (rowIndex: number, column: string, value: string) => {
    setEditedRows((prev) => {
      const updated = [...prev];
      updated[rowIndex] = { ...updated[rowIndex], [column]: value };
      return updated;
    });
  };

  const handleSaveChanges = async () => {
    if (!currentRunId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/grants/runs/${currentRunId}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: editedRows }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.validation && extractionData) {
          setExtractionData({
            ...extractionData,
            rows: editedRows,
            validation: data.validation,
          });
        }
      }
    } catch {
      setError('Failed to save changes');
    } finally {
      setSaving(false);
      setEditingCell(null);
    }
  };

  const handleDownload = (type: 'output' | 'validation') => {
    if (currentRunId) {
      let url = `/api/grants/runs/${currentRunId}/download?file=${type}`;
      if (type === 'output' && selectedColumns.size < ALL_CSV_COLUMNS.length) {
        url += `&columns=${Array.from(selectedColumns).map(encodeURIComponent).join(',')}`;
      }
      window.open(url, '_blank');
    }
  };

  const docTypeForRow = (rowIdx: number): string => {
    const sf = editedRows[rowIdx]?.['Source File'] || '';
    return extractionData?.sourceTypes?.[sf] || 'narrative';
  };

  const toggleIncluded = (rowIdx: number) => {
    setIncludedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowIdx)) next.delete(rowIdx);
      else next.add(rowIdx);
      return next;
    });
  };

  const toggleAllVisible = () => {
    const idxs = getFilteredRowIndices();
    setIncludedRows((prev) => {
      const next = new Set(prev);
      const allIn = idxs.every((i) => next.has(i));
      idxs.forEach((i) => (allIn ? next.delete(i) : next.add(i)));
      return next;
    });
  };

  // Build and download the final CSV from the included rows only, honoring the
  // currently-selected columns. Reflects unsaved edits and the inclusion
  // checkboxes (unlike the server download, which serves the saved file as-is).
  const handleExportSelected = () => {
    if (!extractionData) return;
    const cols = extractionData.columns.filter((c) => selectedColumns.has(c));
    const esc = (v: string) => {
      const s = v ?? '';
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [cols.map(esc).join(',')];
    editedRows.forEach((row, i) => {
      if (!includedRows.has(i)) return;
      lines.push(cols.map((c) => esc(row[c] || '')).join(','));
    });
    const blob = new Blob([lines.join('\n')], {
      type: 'text/csv;charset=utf-8;',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `grant-extraction-${selectedOC || 'results'}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  };

  const handleStartOver = () => {
    setUiState('document-management');
    setSelectedOC('');
    setSelectedYear(new Date().getFullYear());
    setExistingDocs([]);
    setSelectedDocs(new Set());
    setCurrentRunId(null);
    setProgress(null);
    setExtractionData(null);
    setEditedRows([]);
    setError(null);
    setSelectedColumns(new Set(DEFAULT_COLUMNS));
    setColumnsExpanded(false);
    setExpandedRow(null);
    setSearchTerm('');
    setCoverageData(null);
    setAcceptedProposals(new Set());
    setIncludedLikely(new Set());
  };

  const handleRunAgain = () => {
    setUiState('confirm');
    setProgress(null);
    setCoverageData(null);
    setAcceptedProposals(new Set());
    setIncludedLikely(new Set());
    setExtractionData(null);
    setEditedRows([]);
    setError(null);
    setExpandedRow(null);
    setSearchTerm('');
  };

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  const getFlagsForCell = (
    rowIndex: number,
    column: string,
  ): ValidationFlag[] => {
    if (!extractionData) return [];
    return extractionData.validation.flags.filter(
      (f) => f.row === rowIndex + 1 && f.column === column && f.rule === 'R13',
    );
  };

  // The reason a row's Key Terms/Activities is blank (validation rule R19), so the
  // review UI never shows an unexplained empty activities cell.
  const getBlankActivitiesReason = (rowIndex: number): string | null => {
    if (!extractionData) return null;
    const f = extractionData.validation.flags.find(
      (fl) => fl.row === rowIndex + 1 && fl.rule === 'R19',
    );
    return f?.message || null;
  };

  const getFilteredRowIndices = (): number[] => {
    if (!extractionData) return [];
    let indices = editedRows.map((_, i) => i);

    // Filter by blank fields
    if (filterMode === 'flagged') {
      const flaggedRows = new Set(
        extractionData.validation.flags
          .filter((f) => f.rule === 'R13')
          .map((f) => f.row - 1),
      );
      indices = indices.filter((i) => flaggedRows.has(i));
    }

    // Filter by search term
    if (searchTerm.trim()) {
      const term = searchTerm.trim().toLowerCase();
      indices = indices.filter((i) => {
        const row = editedRows[i];
        return extractionData.columns.some(
          (col) =>
            selectedColumns.has(col) &&
            (row[col] || '').toLowerCase().includes(term),
        );
      });
    }

    return indices;
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const toggleColumn = (col: string) => {
    setSelectedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  };

  const toggleGroup = (group: (typeof COLUMN_GROUPS)[number]) => {
    const allSelected = group.columns.every((c) => selectedColumns.has(c));
    setSelectedColumns((prev) => {
      const next = new Set(prev);
      for (const col of group.columns) {
        if (allSelected) next.delete(col);
        else next.add(col);
      }
      return next;
    });
  };

  const selectAllColumns = () => {
    setSelectedColumns(new Set(DEFAULT_COLUMNS));
  };

  const deselectAllColumns = () => {
    setSelectedColumns(new Set<string>());
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  // Access gate — block direct-URL access for non-allowlisted users.
  if (sessionStatus !== 'loading' && !hasGrantsAccess) {
    return (
      <div className="mx-auto flex h-full max-w-7xl items-center justify-center overflow-y-auto p-6">
        <div className="max-w-md rounded-lg border border-gray-200 bg-white p-8 text-center dark:border-gray-700 dark:bg-gray-800">
          <h1 className="mb-2 text-xl font-semibold text-gray-900 dark:text-white">
            Access restricted
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            The Grants Processing tool is limited to authorized users. If you
            believe you should have access, please contact the grants team.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto h-full max-w-7xl overflow-y-auto p-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
          Grant Extraction Pipeline
        </h1>
        <p className="mt-2 text-gray-600 dark:text-gray-400">
          Extract structured data from narrative grant documents, validate,
          review, and export to CSV.
        </p>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-2 font-medium underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ================================================================= */}
      {/* STATE 1: Document Management                                      */}
      {/* ================================================================= */}
      {uiState === 'document-management' && (
        <div className="space-y-6">
          {/* OC Selector */}
          <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
            <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
              Select Operational Center
            </h2>
            <div className="flex items-end gap-6">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Operational Center
                </label>
                <select
                  value={selectedOC}
                  onChange={(e) => {
                    setSelectedOC(e.target.value);
                    setSelectedDocs(new Set());
                  }}
                  className="w-full max-w-xs rounded-lg border border-gray-300 px-4 py-2 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                >
                  <option value="">-- Select OC --</option>
                  {OC_OPTIONS.map((oc) => (
                    <option key={oc} value={oc}>
                      {oc}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Reporting Year
                </label>
                <select
                  value={selectedYear}
                  onChange={(e) => setSelectedYear(Number(e.target.value))}
                  className="rounded-lg border border-gray-300 px-4 py-2 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                >
                  {[2024, 2025, 2026, 2027, 2028, 2029, 2030].map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Extraction prompt (per-OC) */}
          {selectedOC && (
            <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
              <button
                onClick={() => setPromptOpen((v) => !v)}
                className="flex w-full items-center justify-between p-4 text-left"
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
                  {promptOpen ? (
                    <IconChevronDown size={18} />
                  ) : (
                    <IconChevronRight size={18} />
                  )}
                  Extraction prompt — {selectedOC}{' '}
                  <span className="font-normal text-gray-400">(advanced)</span>
                </span>
                {promptMeta?.isOverride && (
                  <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                    Customized
                  </span>
                )}
              </button>

              {promptOpen && (
                <div className="border-t border-gray-100 p-4 dark:border-gray-700">
                  {promptLoading ? (
                    <div className="flex items-center gap-2 text-sm text-gray-500">
                      <IconLoader size={16} className="animate-spin" />
                      Loading prompt…
                    </div>
                  ) : (
                    <>
                      <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
                        This is the exact instruction sent to the model for{' '}
                        {selectedOC}. Edits apply to your next extraction. Save
                        to keep them for future runs (shared with your team);
                        Reset restores the default.
                      </p>
                      <textarea
                        value={promptText}
                        onChange={(e) => setPromptText(e.target.value)}
                        spellCheck={false}
                        className="h-80 w-full resize-y rounded-lg border border-gray-300 bg-gray-50 p-3 font-mono text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                      />
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <button
                          onClick={savePrompt}
                          disabled={promptSaving || !promptDirty}
                          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                        >
                          {promptSaving ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          onClick={resetPrompt}
                          disabled={promptSaving}
                          className="flex items-center gap-1 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300"
                        >
                          <IconRefresh size={16} />
                          Reset to default
                        </button>
                        {promptDirty && (
                          <span className="text-xs italic text-amber-600 dark:text-amber-400">
                            Unsaved changes (will still apply to the next run)
                          </span>
                        )}
                        {promptDirty &&
                          promptLoadedYear !== 0 &&
                          promptLoadedYear !== selectedYear && (
                            <span className="text-xs italic text-red-600 dark:text-red-400">
                              This prompt still references {promptLoadedYear},
                              but you&apos;ve selected {selectedYear} — Reset to
                              refresh the year, or update it manually.
                            </span>
                          )}
                        {promptMeta?.isOverride && promptMeta.updatedBy && (
                          <span className="text-xs text-gray-400">
                            Last saved by {promptMeta.updatedBy}
                            {promptMeta.updatedAt
                              ? ` · ${new Date(
                                  promptMeta.updatedAt,
                                ).toLocaleString()}`
                              : ''}
                          </span>
                        )}
                      </div>
                      {promptNotice && (
                        <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">
                          {promptNotice}
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Document List + Upload */}
          {selectedOC && (
            <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                  Narrative Documents ({existingDocs.length})
                </h2>
                <div className="flex items-center gap-2">
                  {existingDocs.length > 0 && (
                    <button
                      onClick={handleDeleteAllDocs}
                      className="flex items-center gap-1 rounded-lg border border-red-300 px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
                    >
                      <IconTrash size={16} />
                      Remove All
                    </button>
                  )}
                  <label className="flex cursor-pointer items-center gap-2 rounded-lg border-2 border-dashed border-gray-300 px-4 py-2 text-sm hover:border-blue-500 dark:border-gray-600">
                    <IconFileUpload size={18} />
                    <span>
                      {uploading ? 'Uploading...' : 'Upload Documents'}
                    </span>
                    <input
                      type="file"
                      accept=".pdf,.docx,.doc"
                      multiple
                      onChange={handleFileUpload}
                      className="hidden"
                      disabled={uploading}
                    />
                  </label>
                </div>
              </div>

              {existingDocs.length > 0 && (
                <div className="mb-3 flex items-center gap-3">
                  <button
                    onClick={() => {
                      if (selectedDocs.size === existingDocs.length) {
                        setSelectedDocs(new Set());
                      } else {
                        setSelectedDocs(
                          new Set(existingDocs.map((d) => d.blobPath)),
                        );
                      }
                    }}
                    className="text-sm font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                  >
                    {selectedDocs.size === existingDocs.length
                      ? 'Deselect All'
                      : 'Select All'}
                  </button>
                  {selectedDocs.size > 0 &&
                    selectedDocs.size < existingDocs.length && (
                      <span className="text-xs text-gray-500">
                        {selectedDocs.size} of {existingDocs.length} selected
                      </span>
                    )}
                </div>
              )}

              {loadingDocs ? (
                <div className="flex items-center gap-2 py-4 text-gray-500">
                  <IconLoader size={20} className="animate-spin" />
                  Loading documents...
                </div>
              ) : existingDocs.length === 0 ? (
                <p className="py-4 text-gray-500 dark:text-gray-400">
                  No documents uploaded yet. Upload narrative PDFs/DOCX files
                  above.
                </p>
              ) : (
                <div
                  className="space-y-2 overflow-y-auto"
                  style={{ maxHeight: '24rem' }}
                >
                  {existingDocs.map((doc) => (
                    <div
                      key={doc.blobPath}
                      className="flex items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 dark:border-gray-600 dark:bg-gray-700"
                    >
                      <input
                        type="checkbox"
                        checked={selectedDocs.has(doc.blobPath)}
                        onChange={() => toggleDocSelection(doc.blobPath)}
                        className="h-4 w-4 rounded"
                      />
                      <span className="flex-1 text-sm font-medium text-gray-900 dark:text-white">
                        {doc.name}
                      </span>
                      <span className="text-xs text-gray-500">
                        {formatSize(doc.size)}
                      </span>
                      <button
                        onClick={() => handleDeleteDoc(doc.blobPath)}
                        className="text-red-500 hover:text-red-700"
                      >
                        <IconX size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Supplemental Files */}
          {selectedOC && (
            <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
              <button
                onClick={() => setSupplementalExpanded(!supplementalExpanded)}
                className="flex w-full items-center justify-between"
              >
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                  Supplemental Files ({supplementalFiles.length})
                </h2>
                {supplementalExpanded ? (
                  <IconChevronUp size={20} />
                ) : (
                  <IconChevronDown size={20} />
                )}
              </button>
              {supplementalExpanded && (
                <div className="mt-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <label className="flex cursor-pointer items-center gap-2 rounded-lg border-2 border-dashed border-gray-300 px-4 py-2 text-sm hover:border-blue-500 dark:border-gray-600">
                      <IconFileUpload size={18} />
                      <span>Upload Supplemental Files</span>
                      <input
                        type="file"
                        accept=".xlsx,.xls,.csv"
                        multiple
                        onChange={handleSupplementalUpload}
                        className="hidden"
                      />
                    </label>
                    {supplementalFiles.length > 0 && (
                      <button
                        onClick={handleDeleteAllSupplemental}
                        className="flex items-center gap-1 rounded-lg border border-red-300 px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
                      >
                        <IconTrash size={16} />
                        Remove All
                      </button>
                    )}
                  </div>
                  {supplementalFiles.map((f) => (
                    <div
                      key={f.blobPath}
                      className="flex items-center gap-3 rounded border border-gray-200 bg-gray-50 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-700"
                    >
                      <IconCheck size={16} className="text-green-500" />
                      <span className="flex-1">{f.name}</span>
                      <span className="text-xs text-gray-500">
                        {formatSize(f.size)}
                      </span>
                      <button
                        onClick={() => handleDeleteSupplemental(f.blobPath)}
                        className="text-red-500 hover:text-red-700"
                      >
                        <IconX size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Continue Button */}
          {selectedDocs.size > 0 && (
            <div className="flex justify-end">
              <button
                onClick={() => setUiState('confirm')}
                className="rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700"
              >
                Continue ({selectedDocs.size} document
                {selectedDocs.size !== 1 ? 's' : ''} selected)
              </button>
            </div>
          )}
        </div>
      )}

      {/* ================================================================= */}
      {/* STATE 2: Confirm & Start                                          */}
      {/* ================================================================= */}
      {uiState === 'confirm' && (
        <div className="space-y-6">
          <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
            <h2 className="mb-4 text-xl font-semibold text-gray-900 dark:text-white">
              Confirm Extraction
            </h2>
            <div className="space-y-3 text-gray-700 dark:text-gray-300">
              <p>
                <span className="font-medium">Operational Center:</span>{' '}
                {selectedOC}
              </p>
              <p>
                <span className="font-medium">Documents to process:</span>{' '}
                {selectedDocs.size}
              </p>
              <p>
                <span className="font-medium">Supplemental files:</span>{' '}
                {supplementalFiles.length}
              </p>
            </div>

            {/* Column Selection */}
            <div className="mt-6 rounded-lg border border-gray-200 dark:border-gray-600">
              <button
                onClick={() => setColumnsExpanded(!columnsExpanded)}
                className="flex w-full items-center justify-between px-4 py-3"
              >
                <span className="font-medium text-gray-900 dark:text-white">
                  Output Columns ({selectedColumns.size} of{' '}
                  {ALL_CSV_COLUMNS.length} selected)
                </span>
                {columnsExpanded ? (
                  <IconChevronUp size={20} />
                ) : (
                  <IconChevronDown size={20} />
                )}
              </button>
              {columnsExpanded && (
                <div className="border-t border-gray-200 px-4 py-3 dark:border-gray-600">
                  <div className="mb-3 flex gap-2">
                    <button
                      onClick={selectAllColumns}
                      className="rounded border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                    >
                      Select All
                    </button>
                    <button
                      onClick={deselectAllColumns}
                      className="rounded border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                    >
                      Deselect All
                    </button>
                  </div>
                  <div className="space-y-4">
                    {COLUMN_GROUPS.map((group) => {
                      const selectedCount = group.columns.filter((c) =>
                        selectedColumns.has(c),
                      ).length;
                      const allSelected =
                        selectedCount === group.columns.length;
                      const someSelected = selectedCount > 0 && !allSelected;

                      return (
                        <div key={group.label}>
                          <label className="mb-1 flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={allSelected}
                              ref={(el) => {
                                if (el) el.indeterminate = someSelected;
                              }}
                              onChange={() => toggleGroup(group)}
                              className="h-4 w-4 rounded"
                            />
                            <span className="text-sm font-semibold text-gray-900 dark:text-white">
                              {group.label}
                            </span>
                          </label>
                          <div className="ml-6 grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-3">
                            {group.columns.map((col) => (
                              <label
                                key={col}
                                className="flex items-center gap-2"
                              >
                                <input
                                  type="checkbox"
                                  checked={selectedColumns.has(col)}
                                  onChange={() => toggleColumn(col)}
                                  className="h-3.5 w-3.5 rounded"
                                />
                                <span className="text-xs text-gray-700 dark:text-gray-300">
                                  {col}
                                </span>
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setUiState('document-management')}
                className="rounded-lg border border-gray-300 px-6 py-2 font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"
              >
                Back
              </button>
              <button
                onClick={handleRunCoverageCheck}
                disabled={coverageLoading}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {coverageLoading && (
                  <IconLoader size={18} className="animate-spin" />
                )}
                {coverageLoading
                  ? 'Checking coverage…'
                  : 'Continue to Coverage Check'}
              </button>
            </div>

            {coverageLoading && (
              <div className="mt-4">
                <div className="mb-1 flex items-center justify-between text-sm text-gray-600 dark:text-gray-400">
                  <span>
                    {coverageProgress.label || 'Running coverage check…'}
                  </span>
                  <span>{coverageProgress.percent}%</span>
                </div>
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                  <div
                    className="h-full bg-blue-600 transition-all duration-500"
                    style={{ width: `${coverageProgress.percent}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  Extracting text and reading project names/codes from the
                  selected narratives — this can take a moment for large or
                  multi-page documents.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* STATE 2.5: Coverage Check (pre-processing gate)                   */}
      {/* ================================================================= */}
      {uiState === 'coverage-check' && coverageData && (
        <div className="space-y-6">
          <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
            <h2 className="mb-1 text-xl font-semibold text-gray-900 dark:text-white">
              Coverage Check
            </h2>
            <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
              Before extracting, we check the selected narratives against your
              allocation list — confirming each expected project code is found,
              and flagging any that are missing.
            </p>

            {!coverageData.hasExpectedList && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-300">
                <IconAlertTriangle size={18} className="mt-0.5 flex-shrink-0" />
                <span>
                  No allocation list (expected project codes) was found in this
                  OC&apos;s supplemental files, so coverage can&apos;t be
                  reconciled. The codes detected in the narratives are shown
                  below. Upload the allocation list to enable the full check.
                </span>
              </div>
            )}

            {coverageData.hasExpectedList && (
              <div className="mb-4 flex flex-wrap gap-4 text-sm">
                <span className="rounded-md bg-gray-100 px-3 py-1 font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                  {coverageData.reconciliation.matched.length} of{' '}
                  {coverageData.reconciliation.expected.length} expected codes
                  found
                </span>
                {coverageData.reconciliation.missingFromNarratives.length >
                  0 && (
                  <span className="rounded-md bg-red-100 px-3 py-1 font-medium text-red-700 dark:bg-red-900/30 dark:text-red-300">
                    {coverageData.reconciliation.missingFromNarratives.length}{' '}
                    missing:{' '}
                    {coverageData.reconciliation.missingFromNarratives.join(
                      ', ',
                    )}
                  </span>
                )}
              </div>
            )}

            {/* Reconciliation table (stakeholder column layout) */}
            {coverageData.reconciliation.rows.length > 0 && (
              <div className="mb-6 overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 dark:bg-gray-900/40">
                    <tr>
                      <th className="w-8 py-2 pl-2 pr-0">
                        <span className="sr-only">
                          Include likely match in extraction
                        </span>
                      </th>
                      {[
                        'Allocation List Project Code',
                        'Code in Narratives',
                        'Allocation List Project Name',
                        'Name in Narratives',
                        'Notes',
                        'Source',
                      ].map((h) => (
                        <th
                          key={h}
                          className="px-3 py-2 text-left font-semibold text-gray-700 dark:text-gray-300"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {coverageData.reconciliation.rows.map((r, i) => (
                      <tr
                        key={i}
                        className="border-t border-gray-100 dark:border-gray-700/60"
                      >
                        <td className="w-8 py-2 pl-2 pr-0 align-middle">
                          {r.narrativeFile &&
                            (r.align === 'Yes' || r.recovered) && (
                              <input
                                type="checkbox"
                                checked={includedLikely.has(r.projectCode)}
                                onChange={() =>
                                  setIncludedLikely((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(r.projectCode))
                                      next.delete(r.projectCode);
                                    else next.add(r.projectCode);
                                    return next;
                                  })
                                }
                                title={`Include ${r.projectCode} from "${r.narrativeFile}" in the extraction results`}
                                className="h-4 w-4 cursor-pointer rounded-full border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600"
                              />
                            )}
                        </td>
                        <td className="px-3 py-2 font-mono text-gray-900 dark:text-gray-100">
                          {r.projectCode}
                        </td>
                        <td className="px-3 py-2 font-mono text-gray-700 dark:text-gray-300">
                          {r.projectCodeInNarrative ? (
                            r.projectCodeInNarrative
                          ) : r.recovered ? (
                            <span className="not-italic font-medium text-amber-600 dark:text-amber-400">
                              Likely (review)
                            </span>
                          ) : (
                            <span className="italic text-red-600 dark:text-red-400">
                              Not Found
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-gray-700 dark:text-gray-300">
                          {r.projectName}
                        </td>
                        <td className="px-3 py-2 text-gray-700 dark:text-gray-300">
                          {r.projectNameInNarrative || (
                            <span className="italic text-red-600 dark:text-red-400">
                              Not Found
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-gray-500 dark:text-gray-400">
                          {r.differences || '—'}
                        </td>
                        <td className="px-3 py-2">
                          {r.narrativeFile ? (
                            <a
                              href={`/api/grants/documents/serve?blobPath=${encodeURIComponent(narrativeBlobPath(r.narrativeFile))}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={`View "${r.narrativeFile}" — the document this ${r.recovered ? 'likely match was suggested' : 'match was found'} in`}
                              className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
                            >
                              <IconExternalLink size={14} />
                              View document
                            </a>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {coverageData.reconciliation.rows.some(
              (r) => r.narrativeFile && (r.align === 'Yes' || r.recovered),
            ) && (
              <p className="mb-6 -mt-4 text-xs text-gray-500 dark:text-gray-400">
                Ticked rows carry their project code and document into the
                extraction results. Confirmed code matches are pre-selected.
                Rows marked{' '}
                <span className="font-medium text-amber-600 dark:text-amber-400">
                  Likely (review)
                </span>{' '}
                have no project code written in their document — open the
                document to verify the match before ticking. Unticked rows are
                left for the extractor to resolve on its own.
              </p>
            )}

            {/*
              Proposed Code Matches — the automated name/country matching is
              being reworked. The previous country-based matching produced
              misleading results (grants-team feedback), so it's disabled for
              now; the prior implementation is commented out until we design a 
              better approach.
            */}
            <div className="mb-6">
              <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">
                Proposed Code Matches
              </h3>
              <p className="text-xs italic text-gray-500 dark:text-gray-400">
                Coming soon
              </p>
            </div>

            {/* --- Previous proposed-matches implementation (disabled) ---
            {coverageData.reconciliation.proposals.length > 0 && (
              <div className="mb-6">
                <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">
                  Proposed code matches (review before accepting)
                </h3>
                <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                  These allocation-list projects had no project code detected in
                  the narratives. Based on project-name keywords (and country)
                  found in the document text, here is where each one could
                  potentially appear, with the evidence behind each suggestion.
                  These are suggestions to review — accept only the ones
                  you&apos;ve verified, and accepted codes are applied to the
                  extraction (single-project OCs).
                </p>
                <div className="space-y-2">
                  {coverageData.reconciliation.proposals.map((p) => (
                    <div
                      key={p.proposedCode}
                      className="flex items-start gap-3 rounded-lg border border-gray-200 p-3 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/40"
                    >
                      <label className="flex flex-1 cursor-pointer items-start gap-3">
                        <input
                          type="checkbox"
                          checked={acceptedProposals.has(p.proposedCode)}
                          onChange={() => toggleProposal(p.proposedCode)}
                          className="mt-1 h-4 w-4 rounded"
                        />
                        <div className="text-sm">
                          <div className="text-gray-900 dark:text-gray-100">
                            <span className="font-mono font-medium">
                              {p.proposedCode}
                            </span>{' '}
                            ({p.proposedName}) — potentially in{' '}
                            <span className="font-medium">{p.file}</span>
                          </div>
                          <div className="text-gray-600 dark:text-gray-400">
                            {p.matchedTerms.length > 0 ? (
                              <>
                                Matched terms:{' '}
                                <span className="italic">
                                  {p.matchedTerms.join(', ')}
                                </span>
                              </>
                            ) : (
                              <>No project-name terms matched</>
                            )}
                            {p.countryMatched && p.country && (
                              <>
                                {' · '}Country match: {p.country}
                              </>
                            )}
                            {' · '}Match strength:{' '}
                            {p.confidence >= 0.85
                              ? 'Strong'
                              : p.confidence >= 0.6
                                ? 'Moderate'
                                : 'Tentative'}
                          </div>
                        </div>
                      </label>
                      <a
                        href={`/api/grants/documents/serve?blobPath=${encodeURIComponent(narrativeBlobPath(p.file))}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-0.5 flex flex-shrink-0 items-center gap-1 whitespace-nowrap text-sm font-medium text-blue-600 hover:text-blue-500 dark:text-blue-400"
                      >
                        <IconExternalLink size={14} />
                        Open document
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            )}
            --- end previous proposed-matches implementation --- */}

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                onClick={() => setUiState('confirm')}
                className="rounded-lg border border-gray-300 px-6 py-2 font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"
              >
                Back
              </button>
              <button
                onClick={handleDownloadReconciliation}
                className="flex items-center gap-2 rounded-lg border border-gray-300 px-6 py-2 font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"
              >
                <IconDownload size={18} />
                Download Coverage CSV
              </button>
              <button
                onClick={handleStartExtraction}
                className="rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700"
              >
                Confirm &amp; Continue to Extraction
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* STATE 3: Progress                                                 */}
      {/* ================================================================= */}
      {uiState === 'progress' && (
        <div className="space-y-6">
          <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
            <h2 className="mb-6 text-xl font-semibold text-gray-900 dark:text-white">
              Extracting Grant Data...
            </h2>

            {/* Overall progress bar */}
            <div className="mb-6">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Overall Progress
                </span>
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {progress?.overall_percent ?? 0}%
                </span>
              </div>
              <div className="h-3 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                <div
                  className="h-full bg-blue-600 transition-all duration-300"
                  style={{ width: `${progress?.overall_percent ?? 0}%` }}
                />
              </div>
            </div>

            {/* Stage indicators */}
            <div className="space-y-4">
              {STAGE_ORDER.map((key) => {
                const stage = progress?.stages?.[key];
                const isCompleted = stage?.status === 'completed';
                const isRunning = stage?.status === 'running';

                return (
                  <div key={key} className="flex items-center gap-3">
                    <div className="flex-shrink-0">
                      {isCompleted && (
                        <IconCheck size={24} className="text-green-600" />
                      )}
                      {isRunning && (
                        <IconLoader
                          size={24}
                          className="animate-spin text-blue-600"
                        />
                      )}
                      {!isCompleted && !isRunning && (
                        <IconCircle
                          size={24}
                          className="text-gray-300 dark:text-gray-600"
                        />
                      )}
                    </div>
                    <div className="flex-grow">
                      <div className="text-sm font-medium text-gray-900 dark:text-white">
                        {STAGE_NAMES[key]}
                      </div>
                      {isRunning && (
                        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                          <div
                            className="h-full bg-blue-600 transition-all duration-300"
                            style={{ width: `${stage?.percent ?? 0}%` }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {progress?.error && (
              <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
                <strong>Error:</strong> {progress.error}
              </div>
            )}
          </div>

          {progress?.status === 'failed' && (
            <div className="flex justify-center">
              <button
                onClick={handleStartOver}
                className="rounded-lg border border-gray-300 px-6 py-2 font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"
              >
                Start Over
              </button>
            </div>
          )}
        </div>
      )}

      {/* ================================================================= */}
      {/* STATE 4: Validation Review & Inline Editing                       */}
      {/* ================================================================= */}
      {uiState === 'validation-review' && extractionData && (
        <div className="space-y-6">
          {/* Summary bar */}
          <div className="flex items-center gap-4 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              Validation Review
            </h2>
            {(() => {
              const blankCount = extractionData.validation.flags.filter(
                (f) => f.rule === 'R13',
              ).length;
              return blankCount > 0 ? (
                <div className="flex items-center gap-1 rounded-full bg-red-100 px-3 py-1 text-sm font-medium text-red-800 dark:bg-red-900/30 dark:text-red-400">
                  <IconCircleX size={16} />
                  {blankCount} blank field{blankCount !== 1 ? 's' : ''}
                </div>
              ) : (
                <div className="flex items-center gap-1 rounded-full bg-green-100 px-3 py-1 text-sm font-medium text-green-800 dark:bg-green-900/30 dark:text-green-400">
                  No blank fields
                </div>
              );
            })()}
            <div className="ml-auto flex items-center gap-3">
              <div className="relative">
                <IconSearch
                  size={14}
                  className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400"
                />
                <input
                  type="text"
                  placeholder="Search rows..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-48 rounded border border-gray-300 py-1 pl-7 pr-2 text-sm dark:border-gray-600 dark:bg-gray-700"
                />
              </div>
              <select
                value={filterMode}
                onChange={(e) =>
                  setFilterMode(e.target.value as typeof filterMode)
                }
                className="rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700"
              >
                <option value="all">Show All</option>
                <option value="flagged">Blank Fields Only</option>
              </select>
            </div>
          </div>

          {/* Supplemental data warnings (Fix 3) */}
          {extractionData.supplementalReport &&
            (extractionData.supplementalReport.missing.length > 0 ||
              extractionData.supplementalReport.failed.length > 0) && (
              <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 dark:border-yellow-800 dark:bg-yellow-900/20">
                <div className="mb-2 flex items-center gap-2 font-medium text-yellow-800 dark:text-yellow-400">
                  <IconAlertTriangle size={18} />
                  Supplemental Data Issues
                </div>
                <ul className="ml-6 list-disc space-y-1 text-sm text-yellow-700 dark:text-yellow-400">
                  {extractionData.supplementalReport.missing.map((item, i) => (
                    <li key={`missing-${i}`}>
                      <span className="font-medium capitalize">
                        {item.category.replace(/_/g, ' ')}
                      </span>{' '}
                      data not loaded — file not found
                      {item.expected && (
                        <span className="text-yellow-600 dark:text-yellow-500">
                          {' '}
                          (expected: {item.expected})
                        </span>
                      )}
                    </li>
                  ))}
                  {extractionData.supplementalReport.failed.map((item, i) => (
                    <li key={`failed-${i}`}>
                      <span className="font-medium capitalize">
                        {item.category.replace(/_/g, ' ')}
                      </span>{' '}
                      failed to load
                      {item.file && <span> ({item.file})</span>}
                      {item.error && (
                        <span className="text-yellow-600 dark:text-yellow-500">
                          : {item.error}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

          {/* Data table */}
          <div
            className="overflow-auto rounded-lg border border-gray-200 dark:border-gray-700"
            style={{ maxHeight: 'calc(100vh - 280px)' }}
          >
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 z-20 bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th className="sticky left-0 z-30 bg-gray-50 px-3 py-2 text-left font-medium text-gray-700 dark:bg-gray-800 dark:text-white">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={
                          getFilteredRowIndices().length > 0 &&
                          getFilteredRowIndices().every((i) =>
                            includedRows.has(i),
                          )
                        }
                        onChange={toggleAllVisible}
                        title="Include / exclude all visible rows in the export"
                        className="h-4 w-4 cursor-pointer"
                      />
                      <span>#</span>
                    </div>
                  </th>
                  {extractionData.columns
                    .filter((col) => selectedColumns.has(col))
                    .map((col) => (
                      <th
                        key={col}
                        className="whitespace-nowrap px-3 py-2 text-left font-medium text-gray-700 dark:text-white"
                      >
                        {col}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {getFilteredRowIndices().map((rowIdx) => {
                  const row = editedRows[rowIdx];
                  const isExpanded = expandedRow === rowIdx;
                  const sourceFile = row['Source File'] || '';
                  const blobPath =
                    extractionData.sourceFileMap?.[sourceFile] || '';
                  const visibleCols = extractionData.columns.filter((col) =>
                    selectedColumns.has(col),
                  );

                  return (
                    <Fragment key={rowIdx}>
                      <tr
                        className={`hover:bg-gray-50 dark:hover:bg-gray-800/50 ${
                          includedRows.has(rowIdx) ? '' : 'opacity-40'
                        }`}
                      >
                        <td className="sticky left-0 z-10 bg-white dark:bg-gray-900">
                          <div className="flex items-center gap-1 px-2 py-2">
                            <input
                              type="checkbox"
                              checked={includedRows.has(rowIdx)}
                              onChange={() => toggleIncluded(rowIdx)}
                              onClick={(e) => e.stopPropagation()}
                              title="Include this row in the exported CSV"
                              className="h-4 w-4 cursor-pointer"
                            />
                            <button
                              onClick={() =>
                                setExpandedRow(isExpanded ? null : rowIdx)
                              }
                              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                              title={
                                isExpanded
                                  ? 'Collapse row'
                                  : 'Expand row details'
                              }
                            >
                              <IconChevronRight
                                size={14}
                                className={`transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                              />
                            </button>
                            <span className="text-gray-500 dark:text-gray-400">
                              {rowIdx + 1}
                            </span>
                            {blobPath && (
                              <a
                                href={`/api/grants/documents/serve?blobPath=${encodeURIComponent(blobPath)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-blue-500 hover:text-blue-400"
                                title="Open source document"
                              >
                                <IconExternalLink size={13} />
                              </a>
                            )}
                            {isFlaggedDocType(docTypeForRow(rowIdx)) && (
                              <span
                                className="ml-0.5 whitespace-nowrap rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                                title="Coordination/strategy document — not a project narrative. Review and check the box to include it in the exported CSV."
                              >
                                {docTypeForRow(rowIdx)}
                              </span>
                            )}
                            {isGreenInitiativeDocType(
                              docTypeForRow(rowIdx),
                            ) && (
                              <span
                                className="ml-0.5 whitespace-nowrap rounded bg-emerald-100 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                                title="Green Initiative submission — included in the export by default."
                              >
                                {docTypeForRow(rowIdx)}
                              </span>
                            )}
                          </div>
                        </td>
                        {visibleCols.map((col) => {
                          const flags = getFlagsForCell(rowIdx, col);
                          const hasError = flags.length > 0;
                          const isEditing =
                            editingCell?.row === rowIdx &&
                            editingCell?.col === col;
                          const maxW = NARROW_COLUMNS.has(col)
                            ? 'max-w-[120px]'
                            : WIDE_COLUMNS.has(col)
                              ? 'max-w-[400px]'
                              : 'max-w-[250px]';

                          // Source File column: render as clickable link
                          if (col === 'Source File' && blobPath && !isEditing) {
                            return (
                              <td
                                key={col}
                                className="px-3 py-2 cursor-pointer"
                                onClick={() =>
                                  setEditingCell({ row: rowIdx, col })
                                }
                                title={row[col]}
                              >
                                <a
                                  href={`/api/grants/documents/serve?blobPath=${encodeURIComponent(blobPath)}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className={`flex items-center gap-1 text-blue-500 hover:text-blue-400 ${maxW} truncate`}
                                >
                                  <IconExternalLink
                                    size={13}
                                    className="shrink-0"
                                  />
                                  {row[col]}
                                </a>
                              </td>
                            );
                          }

                          // Provides a reason for an empty cell rather than leaving a blank value
                          if (
                            col === 'Key Terms/Activities' &&
                            !isEditing &&
                            !(row[col] || '').trim()
                          ) {
                            const reason = getBlankActivitiesReason(rowIdx);
                            return (
                              <td
                                key={col}
                                className="cursor-pointer px-3 py-2"
                                onClick={() =>
                                  setEditingCell({ row: rowIdx, col })
                                }
                                title={reason || 'No activities extracted'}
                              >
                                <span className="block max-w-[400px] text-xs italic text-amber-600 dark:text-amber-400">
                                  {reason ||
                                    'No activities extracted (reason unavailable).'}
                                </span>
                              </td>
                            );
                          }

                          return (
                            <td
                              key={col}
                              className={`px-3 py-2 cursor-pointer ${
                                hasError
                                  ? 'border-2 border-red-400 bg-red-50 dark:bg-red-900/20'
                                  : ''
                              }`}
                              onClick={() =>
                                setEditingCell({ row: rowIdx, col })
                              }
                              title={
                                hasError
                                  ? flags
                                      .map((f) => `[${f.rule}] ${f.message}`)
                                      .join('\n')
                                  : row[col] || ''
                              }
                            >
                              {isEditing ? (
                                <input
                                  type="text"
                                  value={row[col] ?? ''}
                                  onChange={(e) =>
                                    handleCellEdit(rowIdx, col, e.target.value)
                                  }
                                  onBlur={() => setEditingCell(null)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') setEditingCell(null);
                                  }}
                                  autoFocus
                                  className="w-full rounded border border-blue-500 bg-white px-1 py-0.5 text-sm text-gray-900 dark:bg-gray-800 dark:text-white"
                                />
                              ) : (
                                <span
                                  className={`block ${maxW} truncate text-gray-900 dark:text-gray-100`}
                                >
                                  {row[col]}
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                      {/* Expanded row detail panel */}
                      {isExpanded && (
                        <tr className="!bg-gray-800">
                          <td
                            colSpan={visibleCols.length + 1}
                            className="!bg-gray-800 px-6 py-4"
                          >
                            <div className="space-y-3">
                              <div className="flex items-center justify-between">
                                <span className="text-sm font-semibold text-white">
                                  {row['Project Code']} &mdash;{' '}
                                  {row['Project Name']}
                                </span>
                                {blobPath && (
                                  <a
                                    href={`/api/grants/documents/serve?blobPath=${encodeURIComponent(blobPath)}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-1 text-sm text-blue-500 hover:text-blue-400"
                                  >
                                    <IconExternalLink size={14} />
                                    View Document
                                  </a>
                                )}
                              </div>
                              {DETAIL_FIELDS.map((field) => {
                                const val = row[field];
                                if (!val) return null;
                                const isDetailEditing =
                                  editingCell?.row === rowIdx &&
                                  editingCell?.col === field;
                                return (
                                  <div key={field}>
                                    <div className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                                      {field}
                                    </div>
                                    {isDetailEditing ? (
                                      <textarea
                                        value={row[field] ?? ''}
                                        onChange={(e) =>
                                          handleCellEdit(
                                            rowIdx,
                                            field,
                                            e.target.value,
                                          )
                                        }
                                        onBlur={() => setEditingCell(null)}
                                        autoFocus
                                        rows={3}
                                        className="w-full rounded border border-blue-500 px-2 py-1 text-sm dark:bg-gray-800"
                                      />
                                    ) : (
                                      <div
                                        onClick={() =>
                                          setEditingCell({
                                            row: rowIdx,
                                            col: field,
                                          })
                                        }
                                        className="cursor-pointer whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-200"
                                      >
                                        {val}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleSaveChanges}
              disabled={saving}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-2 font-semibold text-white hover:bg-blue-700 disabled:bg-gray-400"
            >
              {saving ? (
                <IconLoader size={18} className="animate-spin" />
              ) : (
                <IconCheck size={18} />
              )}
              Save Changes
            </button>
            <button
              onClick={handleExportSelected}
              className="flex items-center gap-2 rounded-lg border border-gray-300 px-6 py-2 font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"
              title="Exports only the checked (included) rows"
            >
              <IconDownload size={18} />
              Download CSV ({includedRows.size} row
              {includedRows.size !== 1 ? 's' : ''})
            </button>
            <button
              onClick={() => setUiState('complete')}
              className="ml-auto rounded-lg bg-green-600 px-6 py-2 font-semibold text-white hover:bg-green-700"
            >
              Finalize
            </button>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* STATE 5: Complete                                                 */}
      {/* ================================================================= */}
      {uiState === 'complete' && (
        <div className="space-y-6">
          <div className="rounded-lg border border-gray-200 bg-white p-6 text-center dark:border-gray-700 dark:bg-gray-800">
            <IconCheck size={48} className="mx-auto mb-4 text-green-600" />
            <h2 className="mb-2 text-xl font-semibold text-gray-900 dark:text-white">
              Extraction Complete
            </h2>
            <p className="text-gray-600 dark:text-gray-400">
              {extractionData?.validation.total_rows ?? 0} records extracted
              from {selectedDocs.size} document
              {selectedDocs.size !== 1 ? 's' : ''}.
            </p>

            <div className="mt-6 flex justify-center gap-4">
              <button
                onClick={handleExportSelected}
                className="flex items-center gap-2 rounded-lg bg-green-600 px-6 py-3 font-semibold text-white hover:bg-green-700"
                title="Exports only the checked (included) rows"
              >
                <IconDownload size={20} />
                Download CSV ({includedRows.size} row
                {includedRows.size !== 1 ? 's' : ''})
              </button>
              <button
                onClick={() => handleDownload('validation')}
                className="flex items-center gap-2 rounded-lg border border-gray-300 px-6 py-3 font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"
              >
                <IconDownload size={20} />
                Download Validation Report
              </button>
            </div>
          </div>

          <div className="flex justify-center gap-4">
            <button
              onClick={handleStartOver}
              className="rounded-lg border border-gray-300 px-6 py-2 font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"
            >
              Start Over
            </button>
            <button
              onClick={handleRunAgain}
              className="flex items-center gap-2 rounded-lg border border-blue-300 px-6 py-2 font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-600 dark:text-blue-300"
            >
              <IconRefresh size={18} />
              Run Again with Same Documents
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

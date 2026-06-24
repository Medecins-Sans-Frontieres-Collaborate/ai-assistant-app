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
  supplementalReport?: SupplementalReport;
}

// Column width categories for validation review table
const NARROW_COLUMNS = new Set([
  'Project Number',
  'OC',
  'Project Active',
  'New Project',
  'Emergency Project',
  'Closing Project',
  'Remote Management',
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
  'Remote Management Notes',
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
    columns: ['Project Number', 'Project Name', 'Mission Country', 'OC'],
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
    columns: ['Purpose Code', 'Initial Budget EUR'],
  },
  {
    label: 'Operational',
    columns: [
      'Remote Management',
      'Remote Management Notes',
      'Sanctions',
      'Emergency Project',
      'Emergency Relief Fund',
    ],
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function GrantExtractionPage() {
  // Access control — restrict the whole page to allowlisted users.
  const { data: session, status: sessionStatus } = useSession();
  const hasGrantsAccess = canAccessGrants(session?.user);

  // State management
  const [uiState, setUiState] = useState<UIState>('document-management');
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
    () => new Set(ALL_CSV_COLUMNS),
  );
  const [columnsExpanded, setColumnsExpanded] = useState(false);

  // Extraction state
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [extractionData, setExtractionData] = useState<ExtractionData | null>(
    null,
  );
  const [editedRows, setEditedRows] = useState<Record<string, string>[]>([]);
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
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Poll the progress file the route writes while the request is in flight.
    const poll = setInterval(async () => {
      try {
        const pr = await fetch(
          `/api/grants/preprocess/progress?runId=${runId}`,
        );
        if (pr.ok) {
          const d = await pr.json();
          setCoverageProgress({
            percent: d.percent ?? 0,
            label: d.label ?? '',
          });
        }
      } catch {
        /* ignore poll errors */
      }
    }, 800);

    try {
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
      const data: CoverageData = await res.json();
      setCoverageData(data);
      setUiState('coverage-check');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to run coverage check',
      );
    } finally {
      clearInterval(poll);
      setCoverageLoading(false);
    }
  };

  const toggleProposal = (file: string) => {
    setAcceptedProposals((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  };

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
    setSelectedColumns(new Set(ALL_CSV_COLUMNS));
    setColumnsExpanded(false);
    setExpandedRow(null);
    setSearchTerm('');
    setCoverageData(null);
    setAcceptedProposals(new Set());
  };

  const handleRunAgain = () => {
    setUiState('confirm');
    setProgress(null);
    setCoverageData(null);
    setAcceptedProposals(new Set());
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
    setSelectedColumns(new Set(ALL_CSV_COLUMNS));
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
      <div
        className="mx-auto flex max-w-7xl items-center justify-center p-6"
        style={{ position: 'fixed', inset: 0 }}
      >
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
    <div
      className="mx-auto max-w-7xl overflow-y-auto p-6"
      style={{ position: 'fixed', inset: 0 }}
    >
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
                      accept=".pdf,.docx"
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
                {coverageData.reconciliation.proposals.length > 0 && (
                  <span className="rounded-md bg-blue-100 px-3 py-1 font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                    {coverageData.reconciliation.proposals.length} name-match
                    proposal(s) to review
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
                      {[
                        'Project Code',
                        'Project Name',
                        'Code in Narratives',
                        'Name in Narratives',
                        'Found?',
                        'Notes',
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
                        <td className="px-3 py-2 font-mono text-gray-900 dark:text-gray-100">
                          {r.projectCode}
                        </td>
                        <td className="px-3 py-2 text-gray-700 dark:text-gray-300">
                          {r.projectName}
                        </td>
                        <td className="px-3 py-2 font-mono text-gray-700 dark:text-gray-300">
                          {r.projectCodeInNarrative || '—'}
                        </td>
                        <td className="px-3 py-2 text-gray-700 dark:text-gray-300">
                          {r.projectNameInNarrative || '—'}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={
                              r.align === 'Yes'
                                ? 'font-medium text-green-600 dark:text-green-400'
                                : 'font-medium text-red-600 dark:text-red-400'
                            }
                          >
                            {r.align}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-gray-500 dark:text-gray-400">
                          {r.differences || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Name-match proposals for code-less narratives */}
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
                    #
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
                      <tr className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                        <td className="sticky left-0 z-10 bg-white dark:bg-gray-900">
                          <div className="flex items-center gap-1 px-2 py-2">
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
                                  className="w-full rounded border border-blue-500 px-1 py-0.5 text-sm dark:bg-gray-800"
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
                                  {row['Project Number']} &mdash;{' '}
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
              onClick={() => handleDownload('output')}
              className="flex items-center gap-2 rounded-lg border border-gray-300 px-6 py-2 font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"
            >
              <IconDownload size={18} />
              Download CSV
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
                onClick={() => handleDownload('output')}
                className="flex items-center gap-2 rounded-lg bg-green-600 px-6 py-3 font-semibold text-white hover:bg-green-700"
              >
                <IconDownload size={20} />
                Download CSV
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

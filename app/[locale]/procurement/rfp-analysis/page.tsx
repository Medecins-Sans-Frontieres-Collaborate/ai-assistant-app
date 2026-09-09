'use client';

import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconDownload,
  IconEdit,
  IconFileUpload,
  IconLoader,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';

interface VendorFile {
  name: string;
  fileId: string;
  file?: File;
}

interface ProgressData {
  runId: string;
  status: 'running' | 'succeeded' | 'failed' | 'awaiting_review';
  overall_percent: number;
  current_stage: number;
  current_stage_name: string;
  stages: {
    extract_pdfs: { status: string; percent: number };
    extract_responses: { status: string; percent: number };
    generate_rubrics: { status: string; percent: number };
    score_vendors: { status: string; percent: number };
    build_scorecard: { status: string; percent: number };
  };
  error?: string;
  downloadUrl?: string;
}

interface RubricLevel {
  [level: string]: string;
}

interface RubricEntry {
  category: string;
  criterion: string;
  questions: number[];
  weight: number;
  audience: string | null;
  levels: RubricLevel;
}

interface RubricsData {
  [key: string]: RubricEntry;
}

const STAGE_NAMES: Record<string, string> = {
  extract_pdfs: 'Extracting Text from PDFs',
  extract_responses: 'Extracting Vendor Responses',
  generate_rubrics: 'Generating Scoring Rubrics',
  review_rubrics: 'Review Scoring Rubrics',
  score_vendors: 'Scoring Vendors',
  build_scorecard: 'Building Scorecard',
};

const LEVEL_LABELS: Record<string, string> = {
  '0': 'N/A / No Response',
  '1': 'High Concern',
  '2': 'Concern',
  '3': 'Adequate',
  '4': 'Strong',
  '5': 'Excellent',
};

export default function RFPAnalysisPage() {
  const [questionnaireFile, setQuestionnaireFile] = useState<File | null>(null);
  const [criteriaGridFile, setCriteriaGridFile] = useState<File | null>(null);
  const [rfpName, setRfpName] = useState<string>('');
  const [vendorFiles, setVendorFiles] = useState<VendorFile[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Rubric review state
  const [rubrics, setRubrics] = useState<RubricsData | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(),
  );
  const [expandedCriteria, setExpandedCriteria] = useState<Set<string>>(
    new Set(),
  );
  const [isSavingRubrics, setIsSavingRubrics] = useState(false);
  const [rubricsFetched, setRubricsFetched] = useState(false);

  // Recover an in-flight run after a reload (runId persisted in the URL)
  useEffect(() => {
    const rid = new URLSearchParams(window.location.search).get('runId');
    // Only accept a strict UUID — the value lands in API request URLs
    if (
      rid &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        rid,
      )
    ) {
      setCurrentRunId(rid);
      setIsGenerating(true);
    }
  }, []);

  // Poll for progress
  useEffect(() => {
    if (
      !currentRunId ||
      progress?.status === 'succeeded' ||
      progress?.status === 'failed' ||
      progress?.status === 'awaiting_review'
    ) {
      return;
    }

    const pollProgress = async () => {
      try {
        const response = await fetch(
          `/api/procurement/runs/${encodeURIComponent(currentRunId)}/progress`,
        );
        if (response.ok) {
          const data = await response.json();
          setProgress(data);

          if (data.status === 'failed') {
            setError(data.error || 'Pipeline failed');
            setIsGenerating(false);
          } else if (data.status === 'succeeded') {
            setIsGenerating(false);
          } else if (data.status === 'awaiting_review') {
            setIsGenerating(false);
          }
        }
      } catch (err) {
        console.error('Error polling progress:', err);
      }
    };

    const interval = setInterval(pollProgress, 2000);
    pollProgress();

    return () => clearInterval(interval);
  }, [currentRunId, progress?.status]);

  const fetchRubrics = useCallback(async () => {
    if (!currentRunId) return;
    try {
      const response = await fetch(
        `/api/procurement/runs/${encodeURIComponent(currentRunId)}/rubrics`,
      );
      if (response.ok) {
        const data = await response.json();
        setRubrics(data.rubrics);
        setRubricsFetched(true);

        // Auto-expand all categories
        const categories = new Set<string>();
        Object.values(data.rubrics as RubricsData).forEach((entry) => {
          categories.add(entry.category);
        });
        setExpandedCategories(categories);
      }
    } catch (err) {
      console.error('Error fetching rubrics:', err);
      setError('Failed to load rubrics for review');
    }
  }, [currentRunId]);

  // Fetch rubrics when entering review state
  useEffect(() => {
    if (
      progress?.status === 'awaiting_review' &&
      currentRunId &&
      !rubricsFetched
    ) {
      fetchRubrics();
    }
  }, [progress?.status, currentRunId, rubricsFetched, fetchRubrics]);

  const handleQuestionnaireUpload = (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    if (e.target.files?.[0]) {
      setQuestionnaireFile(e.target.files[0]);
    }
  };

  const handleCriteriaGridUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      setCriteriaGridFile(e.target.files[0]);
    }
  };

  const handleVendorUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const newVendors: VendorFile[] = Array.from(e.target.files).map(
        (file, index) => {
          let cleanName = file.name.replace(/\.pdf$/i, '');
          const firstWordMatch = cleanName.match(/^([A-Za-z]+)/);
          if (firstWordMatch) {
            cleanName = firstWordMatch[1];
          }
          if (cleanName.length > 20 || cleanName.length < 2) {
            cleanName = `Vendor ${vendorFiles.length + index + 1}`;
          }
          return {
            name: cleanName,
            fileId: '',
            file,
          };
        },
      );
      setVendorFiles((prev) => [...prev, ...newVendors]);
    }
  };

  const removeVendor = (index: number) => {
    setVendorFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const updateVendorName = (index: number, newName: string) => {
    setVendorFiles((prev) =>
      prev.map((v, i) => (i === index ? { ...v, name: newName } : v)),
    );
  };

  const handleGenerate = async () => {
    if (
      !questionnaireFile ||
      !criteriaGridFile ||
      !rfpName.trim() ||
      vendorFiles.length === 0
    ) {
      setError(
        'Please upload questionnaire, criteria grid, provide RFP name, and at least one vendor response',
      );
      return;
    }

    setError(null);
    setIsGenerating(true);
    setProgress(null);
    setRubrics(null);
    setRubricsFetched(false);

    try {
      const formData = new FormData();
      formData.append('questionnaire', questionnaireFile);
      formData.append('criteriaGrid', criteriaGridFile);
      formData.append('rfpName', rfpName.trim());

      vendorFiles.forEach((vendor, index) => {
        if (vendor.file) {
          formData.append(`vendor_${index}_file`, vendor.file);
          formData.append(`vendor_${index}_name`, vendor.name);
        }
      });

      const response = await fetch('/api/procurement/generate-scorecard', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const data = await response.json();
      setCurrentRunId(data.runId);
      // Persist the run in the URL so a reload can recover it
      window.history.replaceState(null, '', `?runId=${data.runId}`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to start generation',
      );
      setIsGenerating(false);
    }
  };

  const handleRubricLevelChange = (
    rubricKey: string,
    level: string,
    value: string,
  ) => {
    if (!rubrics) return;
    setRubrics((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        [rubricKey]: {
          ...prev[rubricKey],
          levels: {
            ...prev[rubricKey].levels,
            [level]: value,
          },
        },
      };
    });
  };

  const handleApproveRubrics = async () => {
    if (!currentRunId || !rubrics) return;

    setIsSavingRubrics(true);
    setError(null);

    try {
      // Save edited rubrics
      const saveResponse = await fetch(
        `/api/procurement/runs/${encodeURIComponent(currentRunId)}/rubrics`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rubrics }),
        },
      );

      if (!saveResponse.ok) {
        throw new Error('Failed to save rubrics');
      }

      // Resume the pipeline
      const resumeResponse = await fetch(
        `/api/procurement/runs/${encodeURIComponent(currentRunId)}/resume`,
        {
          method: 'POST',
        },
      );

      if (!resumeResponse.ok) {
        throw new Error('Failed to resume pipeline');
      }

      // Reset state to resume progress polling
      setProgress((prev) => (prev ? { ...prev, status: 'running' } : prev));
      setIsGenerating(true);
      setRubrics(null);
      setRubricsFetched(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to save and resume',
      );
    } finally {
      setIsSavingRubrics(false);
    }
  };

  const handleDownload = () => {
    if (progress?.downloadUrl) {
      window.open(progress.downloadUrl, '_blank');
    }
  };

  const toggleCategory = (category: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const toggleCriterion = (key: string) => {
    setExpandedCriteria((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // Group rubrics by category
  const rubricsByCategory = rubrics
    ? Object.entries(rubrics).reduce<
        Record<string, Array<[string, RubricEntry]>>
      >((acc, [key, entry]) => {
        if (!acc[entry.category]) {
          acc[entry.category] = [];
        }
        acc[entry.category].push([key, entry]);
        return acc;
      }, {})
    : {};

  const resetAll = () => {
    setProgress(null);
    setCurrentRunId(null);
    setIsGenerating(false);
    setQuestionnaireFile(null);
    setCriteriaGridFile(null);
    setRfpName('');
    setVendorFiles([]);
    setRubrics(null);
    setRubricsFetched(false);
    setError(null);
    window.history.replaceState(null, '', window.location.pathname);
  };

  // Override global overflow:hidden on html/body so this page can scroll
  useEffect(() => {
    document.documentElement.style.overflow = 'auto';
    document.documentElement.style.position = 'static';
    document.body.style.overflow = 'auto';
    document.body.style.position = 'static';
    return () => {
      document.documentElement.style.overflow = '';
      document.documentElement.style.position = '';
      document.body.style.overflow = '';
      document.body.style.position = '';
    };
  }, []);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
          RFP Scorecard Generator
        </h1>
        <p className="mt-2 text-gray-600 dark:text-gray-400">
          Upload vendor response documents to automatically generate a
          comprehensive scorecard with rankings and justifications.
        </p>
      </div>

      {/* Upload Form */}
      {!isGenerating && !progress && (
        <div className="space-y-6">
          {/* Questionnaire Upload */}
          <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
            <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
              1. Upload Vendor Questionnaire
            </h2>
            <div className="flex items-center gap-4">
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border-2 border-dashed border-gray-300 px-4 py-3 hover:border-blue-500 dark:border-gray-600">
                <IconFileUpload size={20} />
                <span>Choose PDF File</span>
                <input
                  type="file"
                  accept=".pdf"
                  onChange={handleQuestionnaireUpload}
                  className="hidden"
                />
              </label>
              {questionnaireFile && (
                <div className="flex items-center gap-2 text-green-600">
                  <IconCheck size={20} />
                  <span className="font-medium">{questionnaireFile.name}</span>
                </div>
              )}
            </div>
          </div>

          {/* Criteria Grid Upload */}
          <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
            <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
              2. Upload Criteria & Selection Grid
            </h2>
            <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
              Upload your scoring criteria document that defines categories,
              weights, and evaluation criteria.
            </p>
            <div className="flex items-center gap-4 mb-4">
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border-2 border-dashed border-gray-300 px-4 py-3 hover:border-blue-500 dark:border-gray-600">
                <IconFileUpload size={20} />
                <span>Choose File (PDF, Excel, etc.)</span>
                <input
                  type="file"
                  accept=".pdf,.xlsx,.xls,.csv,.docx"
                  onChange={handleCriteriaGridUpload}
                  className="hidden"
                />
              </label>
              {criteriaGridFile && (
                <div className="flex items-center gap-2 text-green-600">
                  <IconCheck size={20} />
                  <span className="font-medium">{criteriaGridFile.name}</span>
                </div>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                RFP Name / Template Name
              </label>
              <input
                type="text"
                value={rfpName}
                onChange={(e) => setRfpName(e.target.value)}
                placeholder="e.g., coffee_vendor, it_services, direct_mail_2026"
                className="w-full rounded-lg border border-gray-300 px-4 py-2 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Use lowercase letters, numbers, and underscores only
              </p>
            </div>
          </div>

          {/* Vendor Upload */}
          <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
            <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
              3. Upload Vendor Responses ({vendorFiles.length})
            </h2>
            <div className="mb-4">
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border-2 border-dashed border-gray-300 px-4 py-3 hover:border-blue-500 dark:border-gray-600">
                <IconFileUpload size={20} />
                <span>Add Vendor PDFs</span>
                <input
                  type="file"
                  accept=".pdf"
                  multiple
                  onChange={handleVendorUpload}
                  className="hidden"
                />
              </label>
            </div>

            {vendorFiles.length > 0 && (
              <div className="space-y-2">
                {vendorFiles.map((vendor, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 dark:border-gray-600 dark:bg-gray-700"
                  >
                    <input
                      type="text"
                      value={vendor.name}
                      onChange={(e) => updateVendorName(index, e.target.value)}
                      className="flex-1 rounded border border-gray-300 px-2 py-1 font-medium dark:border-gray-500 dark:bg-gray-600 dark:text-white"
                      placeholder="Vendor name"
                    />
                    <span className="text-sm text-gray-500 dark:text-gray-400">
                      {vendor.file?.name}
                    </span>
                    <button
                      onClick={() => removeVendor(index)}
                      className="text-red-600 hover:text-red-700"
                    >
                      <IconX size={20} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Generate Button */}
          <div className="flex justify-end">
            <button
              onClick={handleGenerate}
              disabled={
                !questionnaireFile ||
                !criteriaGridFile ||
                !rfpName.trim() ||
                vendorFiles.length === 0
              }
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              <IconFileUpload size={20} />
              Generate Scorecard
            </button>
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
              {error}
            </div>
          )}
        </div>
      )}

      {/* Rubric Review UI */}
      {progress?.status === 'awaiting_review' && rubrics && (
        <div className="space-y-6">
          {/* Mini progress tracker showing current position */}
          <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <div className="flex items-center gap-2">
              {Object.entries(STAGE_NAMES).map(([key, name], idx) => {
                const isReviewStep = key === 'review_rubrics';
                const isBeforeReview = [
                  'extract_pdfs',
                  'extract_responses',
                  'generate_rubrics',
                ].includes(key);
                const isAfterReview = [
                  'score_vendors',
                  'build_scorecard',
                ].includes(key);

                return (
                  <div key={key} className="flex items-center gap-2">
                    {idx > 0 && (
                      <div
                        className={`h-px w-4 ${isAfterReview ? 'bg-gray-300 dark:bg-gray-600' : 'bg-green-400'}`}
                      />
                    )}
                    <div className="flex items-center gap-1.5">
                      {isBeforeReview && (
                        <IconCheck size={16} className="text-green-600" />
                      )}
                      {isReviewStep && (
                        <IconEdit size={16} className="text-amber-500" />
                      )}
                      {isAfterReview && (
                        <div className="h-4 w-4 rounded-full border-2 border-gray-300 dark:border-gray-600" />
                      )}
                      <span
                        className={`text-xs whitespace-nowrap ${
                          isReviewStep
                            ? 'font-semibold text-amber-600 dark:text-amber-400'
                            : isBeforeReview
                              ? 'text-green-700 dark:text-green-400'
                              : 'text-gray-400 dark:text-gray-500'
                        }`}
                      >
                        {name}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 dark:border-amber-800 dark:bg-amber-900/20">
            <div className="flex items-start gap-3">
              <IconEdit
                size={24}
                className="mt-0.5 text-amber-600 dark:text-amber-400"
              />
              <div>
                <h2 className="text-xl font-semibold text-amber-800 dark:text-amber-200">
                  Review Scoring Rubrics
                </h2>
                <p className="mt-1 text-amber-700 dark:text-amber-300">
                  AI has generated scoring rubrics for each criterion. Review
                  and edit them below to ensure they capture the nuances
                  important to your evaluation. For example, you can add
                  requirements for specific evidence like dollar amounts,
                  certifications, or timelines.
                </p>
              </div>
            </div>
          </div>

          {Object.entries(rubricsByCategory).map(([category, entries]) => (
            <div
              key={category}
              className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800"
            >
              <button
                onClick={() => toggleCategory(category)}
                className="flex w-full items-center justify-between p-4 text-left hover:bg-gray-50 dark:hover:bg-gray-750"
              >
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                  {category}
                </h3>
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <span>{entries.length} criteria</span>
                  {expandedCategories.has(category) ? (
                    <IconChevronDown size={20} />
                  ) : (
                    <IconChevronRight size={20} />
                  )}
                </div>
              </button>

              {expandedCategories.has(category) && (
                <div className="border-t border-gray-200 dark:border-gray-700">
                  {entries.map(([key, entry]) => (
                    <div
                      key={key}
                      className="border-b border-gray-100 last:border-b-0 dark:border-gray-700"
                    >
                      <button
                        onClick={() => toggleCriterion(key)}
                        className="flex w-full items-center justify-between px-6 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-750"
                      >
                        <div>
                          <span className="font-medium text-gray-900 dark:text-white">
                            {entry.criterion}
                          </span>
                          <span className="ml-2 text-sm text-gray-500">
                            (weight: {(entry.weight * 100).toFixed(0)}%
                            {entry.audience
                              ? ` | audience: ${entry.audience}`
                              : ''}
                            )
                          </span>
                        </div>
                        {expandedCriteria.has(key) ? (
                          <IconChevronDown
                            size={18}
                            className="text-gray-400"
                          />
                        ) : (
                          <IconChevronRight
                            size={18}
                            className="text-gray-400"
                          />
                        )}
                      </button>

                      {expandedCriteria.has(key) && (
                        <div className="space-y-3 px-6 pb-4">
                          {['5', '4', '3', '2', '1', '0'].map((level) => (
                            <div key={level} className="flex gap-3">
                              <div className="flex-shrink-0 pt-2">
                                <span
                                  className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold ${
                                    level === '5'
                                      ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                                      : level === '4'
                                        ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                                        : level === '3'
                                          ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
                                          : level === '2'
                                            ? 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200'
                                            : level === '1'
                                              ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
                                              : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200'
                                  }`}
                                >
                                  {level}
                                </span>
                              </div>
                              <div className="flex-grow">
                                <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                                  {LEVEL_LABELS[level]}
                                </label>
                                <textarea
                                  value={entry.levels[level] || ''}
                                  onChange={(e) =>
                                    handleRubricLevelChange(
                                      key,
                                      level,
                                      e.target.value,
                                    )
                                  }
                                  rows={2}
                                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Action buttons */}
          <div className="flex items-center justify-between">
            <button
              onClick={resetAll}
              className="rounded-lg border border-gray-300 px-6 py-2 font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
            <button
              onClick={handleApproveRubrics}
              disabled={isSavingRubrics}
              className="flex items-center gap-2 rounded-lg bg-green-600 px-6 py-3 font-semibold text-white hover:bg-green-700 disabled:bg-gray-400"
            >
              {isSavingRubrics ? (
                <>
                  <IconLoader size={20} className="animate-spin" />
                  Saving & Resuming...
                </>
              ) : (
                <>
                  <IconCheck size={20} />
                  Approve Rubrics & Score Vendors
                </>
              )}
            </button>
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
              {error}
            </div>
          )}
        </div>
      )}

      {/* Progress Display (running or completed, but not awaiting_review with rubrics loaded) */}
      {(isGenerating ||
        (progress && progress.status !== 'awaiting_review')) && (
        <div className="space-y-6">
          <div className="rounded-lg border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
            <h2 className="mb-6 text-xl font-semibold text-gray-900 dark:text-white">
              {progress?.status === 'succeeded'
                ? 'Scorecard Complete!'
                : progress?.status === 'failed'
                  ? 'Pipeline Failed'
                  : 'Generating Scorecard...'}
            </h2>

            {/* Overall Progress */}
            <div className="mb-6">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  Overall Progress
                </span>
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {progress?.overall_percent || 0}%
                </span>
              </div>
              <div className="h-3 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                <div
                  className="h-full bg-blue-600 transition-all duration-300"
                  style={{ width: `${progress?.overall_percent || 0}%` }}
                />
              </div>
            </div>

            {/* Stage Progress */}
            <div className="space-y-4">
              {Object.entries(STAGE_NAMES).map(([key, name]) => {
                let stageStatus: string;
                let stagePercent = 0;

                if (key === 'review_rubrics') {
                  // Virtual step — derive status from pipeline state
                  const rubricsDone =
                    progress?.stages.generate_rubrics?.status === 'completed';
                  const scoringStarted =
                    progress?.stages.score_vendors?.status === 'running' ||
                    progress?.stages.score_vendors?.status === 'completed';
                  if (scoringStarted) {
                    stageStatus = 'completed';
                  } else if (rubricsDone) {
                    stageStatus = 'completed';
                  } else {
                    stageStatus = 'pending';
                  }
                } else {
                  const stage =
                    progress?.stages[key as keyof typeof progress.stages];
                  stageStatus = stage?.status || 'pending';
                  stagePercent = stage?.percent || 0;
                }

                const isCompleted = stageStatus === 'completed';
                const isRunning = stageStatus === 'running';

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
                        <div className="h-6 w-6 rounded-full border-2 border-gray-300" />
                      )}
                    </div>
                    <div className="flex-grow">
                      <div className="text-sm font-medium text-gray-900 dark:text-white">
                        {name}
                      </div>
                      {isRunning && key !== 'review_rubrics' && (
                        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                          <div
                            className="h-full bg-blue-600 transition-all duration-300"
                            style={{ width: `${stagePercent}%` }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Download Button */}
            {progress?.status === 'succeeded' && (
              <div className="mt-6">
                <button
                  onClick={handleDownload}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-green-600 px-6 py-3 font-semibold text-white hover:bg-green-700"
                >
                  <IconDownload size={20} />
                  Download Scorecard
                </button>
              </div>
            )}

            {/* Error Display */}
            {progress?.error && (
              <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
                <strong>Error:</strong> {progress.error}
              </div>
            )}
          </div>

          {/* Start Over Button */}
          {(progress?.status === 'succeeded' ||
            progress?.status === 'failed') && (
            <div className="flex justify-center">
              <button
                onClick={resetAll}
                className="rounded-lg border border-gray-300 px-6 py-2 font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                Start Over
              </button>
            </div>
          )}
        </div>
      )}

      {/* Loading rubrics state */}
      {progress?.status === 'awaiting_review' && !rubrics && (
        <div className="flex items-center justify-center gap-3 p-12">
          <IconLoader size={24} className="animate-spin text-blue-600" />
          <span className="text-gray-600 dark:text-gray-400">
            Loading rubrics for review...
          </span>
        </div>
      )}
    </div>
  );
}

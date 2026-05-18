export const EXPORT_FORMATS = [
  { format: 'md', labelKey: 'artifact.formatMarkdown' },
  { format: 'html', labelKey: 'artifact.formatHtml' },
  { format: 'docx', labelKey: 'artifact.formatDocx' },
  { format: 'txt', labelKey: 'artifact.formatText' },
  { format: 'pdf', labelKey: 'artifact.formatPdf' },
] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number]['format'];

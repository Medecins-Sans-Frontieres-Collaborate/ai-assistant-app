'use client';

import { IconCheck, IconCopy, IconDownload } from '@tabler/icons-react';
import {
  ComponentProps,
  FC,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { useDocumentExport } from '@/client/hooks/document/useDocumentExport';

import {
  TableRows,
  extractTableRows,
  tableRowsToCsv,
  tableRowsToHtml,
  tableRowsToMarkdown,
  tableRowsToTsv,
} from '@/lib/utils/shared/chat/tableExport';
import { downloadFile } from '@/lib/utils/shared/document/exportUtils';

import { DropdownPortal } from '@/components/UI/DropdownPortal';

import { StreamdownContext } from 'streamdown';

type CopyFormat = 'md' | 'csv' | 'tsv';
type DownloadFormat = 'csv' | 'md' | 'docx';

const COPY_FORMATS = [
  { format: 'md', labelKey: 'table.copyMarkdown' },
  { format: 'csv', labelKey: 'table.copyCsv' },
  { format: 'tsv', labelKey: 'table.copyTsv' },
] as const;

const DOWNLOAD_FORMATS = [
  { format: 'csv', labelKey: 'table.formatCsv' },
  { format: 'md', labelKey: 'artifact.formatMarkdown' },
  { format: 'docx', labelKey: 'artifact.formatDocx' },
] as const;

const COPIED_RESET_MS = 2000;

function FormatMenu<F extends string>({
  items,
  onSelect,
}: {
  items: ReadonlyArray<{ format: F; labelKey: string }>;
  onSelect: (format: F) => void;
}) {
  const t = useTranslations();
  return (
    <div
      role="menu"
      className="w-40 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg overflow-hidden"
    >
      {items.map(({ format, labelKey }) => (
        <button
          key={format}
          role="menuitem"
          onClick={() => onSelect(format)}
          className="w-full px-4 py-2 text-left text-sm text-neutral-900 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors"
        >
          {t(labelKey)}
        </button>
      ))}
    </div>
  );
}

type MarkdownTableProps = ComponentProps<'table'> & { node?: unknown };

/**
 * Replaces Streamdown's default table renderer (and its built-in controls)
 * for assistant responses. Keeps the same wrapper structure and classes so
 * existing prose/table styling applies, but swaps the control row for the
 * app's own copy menu (Markdown / CSV / TSV) and download menu (CSV /
 * Markdown / Word), reusing the shared document-export pipeline.
 */
export const MarkdownTable: FC<MarkdownTableProps> = ({
  children,
  className,
  node: _node,
  ...props
}) => {
  const t = useTranslations();
  const exportAs = useDocumentExport();
  const { isAnimating } = useContext(StreamdownContext);

  const tableRef = useRef<HTMLTableElement>(null);
  const copyTriggerRef = useRef<HTMLButtonElement>(null);
  const downloadTriggerRef = useRef<HTMLButtonElement>(null);
  const [openMenu, setOpenMenu] = useState<'copy' | 'download' | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimeoutRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedTimeoutRef.current !== null) {
        window.clearTimeout(copiedTimeoutRef.current);
      }
    },
    [],
  );

  const readRows = (): TableRows =>
    tableRef.current ? extractTableRows(tableRef.current) : [];

  const handleCopy = async (format: CopyFormat) => {
    setOpenMenu(null);
    const rows = readRows();
    if (rows.length === 0) return;
    const text =
      format === 'md'
        ? tableRowsToMarkdown(rows)
        : format === 'csv'
          ? tableRowsToCsv(rows)
          : tableRowsToTsv(rows);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copiedTimeoutRef.current !== null) {
        window.clearTimeout(copiedTimeoutRef.current);
      }
      copiedTimeoutRef.current = window.setTimeout(
        () => setCopied(false),
        COPIED_RESET_MS,
      );
    } catch {
      toast.error(t('table.copyFailed'));
    }
  };

  const handleDownload = async (format: DownloadFormat) => {
    setOpenMenu(null);
    const rows = readRows();
    if (rows.length === 0) return;
    switch (format) {
      case 'csv':
        // BOM so Excel detects UTF-8 when opening the .csv directly.
        downloadFile(
          '\u{FEFF}' + tableRowsToCsv(rows),
          'table.csv',
          'text/csv;charset=utf-8',
        );
        toast.success(t('table.exportedAsCsv'));
        break;
      case 'md':
        await exportAs('md', '', 'table', tableRowsToMarkdown(rows));
        break;
      case 'docx':
        await exportAs('docx', tableRowsToHtml(rows), 'table');
        break;
    }
  };

  const buttonClass =
    'p-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300 transition-colors disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div
      className="my-4 flex flex-col space-y-2"
      data-streamdown="table-wrapper"
    >
      <div className="flex items-center justify-end gap-1">
        <button
          ref={copyTriggerRef}
          type="button"
          className={buttonClass}
          disabled={isAnimating}
          onClick={() =>
            setOpenMenu((prev) => (prev === 'copy' ? null : 'copy'))
          }
          aria-label={t('table.copyTable')}
          aria-haspopup="menu"
          aria-expanded={openMenu === 'copy'}
          title={t('table.copyTable')}
        >
          {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
        </button>
        <button
          ref={downloadTriggerRef}
          type="button"
          className={buttonClass}
          disabled={isAnimating}
          onClick={() =>
            setOpenMenu((prev) => (prev === 'download' ? null : 'download'))
          }
          aria-label={t('table.downloadTable')}
          aria-haspopup="menu"
          aria-expanded={openMenu === 'download'}
          title={t('table.downloadTable')}
        >
          <IconDownload size={16} />
        </button>
      </div>

      <DropdownPortal
        triggerRef={copyTriggerRef}
        isOpen={openMenu === 'copy'}
        onClose={() => setOpenMenu(null)}
        align="right"
      >
        <FormatMenu items={COPY_FORMATS} onSelect={handleCopy} />
      </DropdownPortal>
      <DropdownPortal
        triggerRef={downloadTriggerRef}
        isOpen={openMenu === 'download'}
        onClose={() => setOpenMenu(null)}
        align="right"
      >
        <FormatMenu items={DOWNLOAD_FORMATS} onSelect={handleDownload} />
      </DropdownPortal>

      <div className="overflow-x-auto">
        <table
          ref={tableRef}
          className={['w-full border-collapse border border-border', className]
            .filter(Boolean)
            .join(' ')}
          data-streamdown="table"
          {...props}
        >
          {children}
        </table>
      </div>
    </div>
  );
};

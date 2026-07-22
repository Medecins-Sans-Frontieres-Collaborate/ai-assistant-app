/**
 * Download helper for the backup recovery key, following the blob-anchor
 * idiom in `lib/utils/app/export/conversationExport.ts`.
 *
 * The caller supplies the (already translated) header lines so all
 * user-facing copy stays in the components' i18n layer.
 */

function getCurrentDateString(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export interface DownloadRecoveryKeyFileOptions {
  /** Canonical dash-grouped recovery code. */
  code: string;
  /** Translated lines written above the code (heading, warning, ...). */
  headerLines: string[];
}

export function downloadRecoveryKeyFile({
  code,
  headerLines,
}: DownloadRecoveryKeyFileOptions): void {
  const content = [...headerLines, '', code, ''].join('\n');

  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.download = `chat-backup-recovery-key_${getCurrentDateString()}.txt`;
  link.href = url;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

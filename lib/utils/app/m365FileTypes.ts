/**
 * File-type groups for the M365 picker's user-facing type filter. Grouping
 * mirrors the Type filter in OneDrive/SharePoint web (Word, Excel, PDF, …)
 * rather than raw extensions. Shared by the picker UI (display filtering)
 * and the search client, which sends the group's extensions to the drive
 * route so the filename query can carry a KQL `filetype:` restriction.
 */

export type M365FileTypeGroupId =
  | 'word'
  | 'excel'
  | 'pdf'
  | 'powerpoint'
  | 'text'
  | 'image'
  | 'audio'
  | 'video';

export interface M365FileTypeGroup {
  id: M365FileTypeGroupId;
  /** Lowercase extensions without the dot. */
  extensions: readonly string[];
}

export const M365_FILE_TYPE_GROUPS: readonly M365FileTypeGroup[] = [
  {
    id: 'word',
    extensions: ['doc', 'docx', 'docm', 'dot', 'dotx', 'rtf', 'odt'],
  },
  { id: 'excel', extensions: ['xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'ods'] },
  { id: 'pdf', extensions: ['pdf'] },
  {
    id: 'powerpoint',
    extensions: ['ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'odp'],
  },
  { id: 'text', extensions: ['txt', 'md', 'markdown', 'log'] },
  {
    id: 'image',
    extensions: [
      'png',
      'jpg',
      'jpeg',
      'gif',
      'bmp',
      'webp',
      'svg',
      'tiff',
      'heic',
    ],
  },
  {
    id: 'audio',
    extensions: ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac', 'wma'],
  },
  { id: 'video', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv'] },
];

/** Groups shown as inline chips; the rest sit behind the "more" menu. */
export const M365_PRIMARY_FILE_TYPE_IDS: readonly M365FileTypeGroupId[] = [
  'word',
  'excel',
  'pdf',
];

export function getFileTypeGroup(
  id: M365FileTypeGroupId,
): M365FileTypeGroup | undefined {
  return M365_FILE_TYPE_GROUPS.find((group) => group.id === id);
}

/** Lowercase extension of a filename, '' when there is none. */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

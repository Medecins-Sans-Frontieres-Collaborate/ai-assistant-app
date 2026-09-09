import {
  IconFile,
  IconFileCode,
  IconFileTypeCsv,
  IconFileTypeDoc,
  IconFileTypePdf,
  IconFileTypePpt,
  IconFileTypeTxt,
  IconFileTypeXls,
  IconFileTypeZip,
  IconFolder,
  IconMail,
  IconMusic,
  IconPhoto,
  IconVideo,
} from '@tabler/icons-react';
import { FC } from 'react';

import type { M365DriveEntry } from '@/types/m365';

type TablerIcon = typeof IconFile;

type IconSpec = [TablerIcon, string];

// All accent classes must keep acceptable contrast in both themes.
const EXTENSION_ICONS: Record<string, IconSpec> = {
  pdf: [IconFileTypePdf, 'text-red-500'],
  doc: [IconFileTypeDoc, 'text-blue-600 dark:text-blue-400'],
  docx: [IconFileTypeDoc, 'text-blue-600 dark:text-blue-400'],
  ppt: [IconFileTypePpt, 'text-orange-500'],
  pptx: [IconFileTypePpt, 'text-orange-500'],
  xls: [IconFileTypeXls, 'text-green-600 dark:text-green-400'],
  xlsx: [IconFileTypeXls, 'text-green-600 dark:text-green-400'],
  csv: [IconFileTypeCsv, 'text-green-600 dark:text-green-400'],
  txt: [IconFileTypeTxt, 'text-gray-500'],
  md: [IconFileTypeTxt, 'text-gray-500'],
  rtf: [IconFileTypeTxt, 'text-gray-500'],
  zip: [IconFileTypeZip, 'text-gray-500'],
  '7z': [IconFileTypeZip, 'text-gray-500'],
  rar: [IconFileTypeZip, 'text-gray-500'],
  gz: [IconFileTypeZip, 'text-gray-500'],
  png: [IconPhoto, 'text-purple-500'],
  jpg: [IconPhoto, 'text-purple-500'],
  jpeg: [IconPhoto, 'text-purple-500'],
  gif: [IconPhoto, 'text-purple-500'],
  svg: [IconPhoto, 'text-purple-500'],
  webp: [IconPhoto, 'text-purple-500'],
  heic: [IconPhoto, 'text-purple-500'],
  mp4: [IconVideo, 'text-purple-500'],
  mov: [IconVideo, 'text-purple-500'],
  webm: [IconVideo, 'text-purple-500'],
  mkv: [IconVideo, 'text-purple-500'],
  mp3: [IconMusic, 'text-purple-500'],
  m4a: [IconMusic, 'text-purple-500'],
  wav: [IconMusic, 'text-purple-500'],
  ogg: [IconMusic, 'text-purple-500'],
  js: [IconFileCode, 'text-gray-500'],
  ts: [IconFileCode, 'text-gray-500'],
  tsx: [IconFileCode, 'text-gray-500'],
  py: [IconFileCode, 'text-gray-500'],
  json: [IconFileCode, 'text-gray-500'],
  html: [IconFileCode, 'text-gray-500'],
  css: [IconFileCode, 'text-gray-500'],
  xml: [IconFileCode, 'text-gray-500'],
  yml: [IconFileCode, 'text-gray-500'],
  yaml: [IconFileCode, 'text-gray-500'],
  msg: [IconMail, 'text-gray-500'],
  eml: [IconMail, 'text-gray-500'],
};

const MIME_PREFIX_ICONS: [string, IconSpec][] = [
  ['image/', [IconPhoto, 'text-purple-500']],
  ['video/', [IconVideo, 'text-purple-500']],
  ['audio/', [IconMusic, 'text-purple-500']],
];

/**
 * File-type icon for picker rows: extension wins, mimeType prefix is the
 * fallback. Decorative only — the row's accessible name stays the file name.
 */
const M365FileTypeIcon: FC<{ entry: M365DriveEntry; size?: number }> = ({
  entry,
  size = 18,
}) => {
  if (entry.isFolder) {
    return (
      <IconFolder
        size={size}
        className="flex-shrink-0 text-amber-500"
        aria-hidden="true"
      />
    );
  }
  const dot = entry.name.lastIndexOf('.');
  const extension = dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : '';
  // Object.hasOwn, not bracket access: a file named "x.constructor" would
  // otherwise resolve a prototype member and crash the destructure below.
  let spec: IconSpec | undefined = Object.hasOwn(EXTENSION_ICONS, extension)
    ? EXTENSION_ICONS[extension]
    : undefined;
  if (!spec && entry.mimeType) {
    const mimeType = entry.mimeType;
    spec = MIME_PREFIX_ICONS.find(([prefix]) =>
      mimeType.startsWith(prefix),
    )?.[1];
  }
  const [Icon, className] = spec ?? [IconFile, 'text-gray-400'];
  return (
    <Icon
      size={size}
      className={`flex-shrink-0 ${className}`}
      aria-hidden="true"
    />
  );
};

export default M365FileTypeIcon;

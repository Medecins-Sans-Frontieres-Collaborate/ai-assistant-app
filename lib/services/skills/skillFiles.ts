/** Client-safe resource paths, bounds, and supported skill document formats. */
import { SKILL_LIMITS } from './types';

/** Invalid resource input, returned as an actionable HTTP 400 by API helpers. */
export class SkillResourceError extends Error {
  readonly status = 400;
}

export const SKILL_DOCUMENT_EXTENSIONS = [
  'pdf',
  'docx',
  'doc',
  'pptx',
  'xlsx',
  'odt',
  'rtf',
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'html',
  'htm',
  'xml',
  'tex',
];
export const SKILL_ASSET_EXTENSIONS = [
  ...SKILL_DOCUMENT_EXTENSIONS,
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'css',
];

/** Validates a relative package path; throws for traversal or ambiguous names. */
export function validateResourcePath(value: string): string {
  if (
    !value ||
    value.length > 240 ||
    /[\\:]/.test(value) ||
    [...value].some((char) => char.charCodeAt(0) < 32) ||
    value.startsWith('/') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new SkillResourceError(
      'Resource paths must be relative and cannot contain traversal segments',
    );
  }
  return value;
}

/** Extension used by both validation and extraction. */
export function skillFileExtension(name: string): string {
  if (/^licen[sc]e$/i.test(name.split('/').at(-1) ?? '')) return 'txt';
  return name.split('.').at(-1)?.toLowerCase() ?? '';
}

/** Preserves package-relative paths; root-level references are valid Agent Skills files. */
export function skillResourcePath(name: string): string {
  const path = validateResourcePath(name);
  if (path === 'SKILL.md' || path.startsWith('scripts/'))
    throw new SkillResourceError(
      'SKILL.md and executable scripts are not reference uploads',
    );
  const extensions = path.startsWith('assets/')
    ? SKILL_ASSET_EXTENSIONS
    : SKILL_DOCUMENT_EXTENSIONS;
  if (!extensions.includes(skillFileExtension(path)))
    throw new SkillResourceError(`Unsupported skill resource: ${path}`);
  return path;
}

/** Enforces the file and aggregate caps before resources enter storage. */
export function validateSkillFiles(
  files: readonly { name: string; size: number }[],
): void {
  if (files.length > SKILL_LIMITS.maxDocuments)
    throw new SkillResourceError(
      `At most ${SKILL_LIMITS.maxDocuments} skill resources are allowed`,
    );
  const paths = new Set<string>();
  let total = 0;
  for (const file of files) {
    const path = skillResourcePath(file.name);
    if (paths.has(path.toLowerCase()))
      throw new SkillResourceError(`Duplicate resource path: ${path}`);
    paths.add(path.toLowerCase());
    if (file.size <= 0 || file.size > SKILL_LIMITS.maxDocumentBytes)
      throw new SkillResourceError(
        `Resource ${path} must be nonempty and at most 10 MB`,
      );
    total += file.size;
  }
  if (total > SKILL_LIMITS.maxBundleBytes)
    throw new SkillResourceError(
      'Skill resources exceed the 20 MB total limit',
    );
}

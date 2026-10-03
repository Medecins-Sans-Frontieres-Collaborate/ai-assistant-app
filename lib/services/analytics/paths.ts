/**
 * Path rules for the analytics delivery container. Pure and client-importable.
 *
 * A folder path is the blob prefix the ETL wrote to, without leading or
 * trailing slash; '' is the root. Matching is exact and case-sensitive — the
 * same as the storage itself — with ONE exception: the raw gate.
 */

/** Everything under this top-level folder is identifiable raw telemetry. */
export const RAW_ROOT = 'raw';

/**
 * Raw is decided by LOCATION, in code, and case-insensitively: `Raw/` or
 * `RAW/` must not slip past a gate that an exact match on `raw/` would leave
 * open. No stored configuration can widen this.
 */
export function isRawPath(path: string): boolean {
  const first = path.split('/')[0];
  return first.toLowerCase() === RAW_ROOT;
}

/**
 * A path the app is willing to treat as a folder or file name: relative, no
 * empty / `.` / `..` segments, no backslashes or control characters.
 */
export function isSafeRelativePath(path: string): boolean {
  if (path === '') return true;
  if (path.length > 1024) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;
  return path
    .split('/')
    .every(
      (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
    );
}

/** Trims slashes and whitespace; does not validate. */
export function normalizeFolderPath(path: string): string {
  return path.trim().replace(/^\/+|\/+$/g, '');
}

export function folderOfFile(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index < 0 ? '' : filePath.slice(0, index);
}

export function baseName(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}

export function parentFolder(folderPath: string): string | null {
  if (folderPath === '') return null;
  return folderOfFile(folderPath);
}

/** The folder itself first, then each ancestor, ending with the root ''. */
export function folderChain(folderPath: string): string[] {
  const chain: string[] = [];
  let current: string | null = folderPath;
  while (current !== null) {
    chain.push(current);
    current = parentFolder(current);
  }
  return chain;
}

export function extensionOf(path: string): string {
  const name = baseName(path);
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index + 1).toLowerCase();
}

/** Every folder that holds a file, plus all their ancestors (root included). */
export function foldersOfFiles(filePaths: readonly string[]): Set<string> {
  const folders = new Set<string>(['']);
  for (const filePath of filePaths) {
    for (const folder of folderChain(folderOfFile(filePath))) {
      folders.add(folder);
    }
  }
  return folders;
}

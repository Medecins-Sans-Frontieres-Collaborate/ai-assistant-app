/**
 * Resident memory of a process and everything it started, read from
 * Linux's /proc.
 *
 * Why resident memory and not an address-space limit (`ulimit -v`): the
 * address space a LibreOffice build reserves says little about what it
 * uses. Alpine's LibreOffice 25.8 renders a 60-slide deck under a 384 MB
 * address-space limit, while a glibc build of 26.8 cannot convert one line
 * of text under 8 GB of it and then needs 300 MB resident. Resident memory
 * is what fills the machine, and it is measured the same way everywhere.
 *
 * PRIVATE resident memory only (anonymous plus shared-memory pages): pages
 * mapped from files (fonts, libraries) are page cache the kernel can drop
 * and other processes share. Measured on a desktop with many fonts, one
 * conversion of a five-slide deck held 100 MB private and up to 3.9 GB
 * file-backed, so counting VmRSS stopped a harmless job. Where the kernel
 * does not split the figure, VmRSS is used.
 */
import fs from 'fs';
import path from 'path';

/**
 * The process ids of `rootPid` and all its descendants, found by walking
 * each thread's `children` list; null where the kernel does not provide
 * those lists (built without CONFIG_PROC_CHILDREN).
 */
async function processTree(
  rootPid: number,
  procRoot: string,
): Promise<number[] | null> {
  const found: number[] = [];
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (found.includes(pid)) continue;
    found.push(pid);
    const tasks = await fs.promises
      .readdir(path.join(procRoot, String(pid), 'task'))
      .catch(() => [] as string[]);
    for (const task of tasks) {
      const children = await fs.promises
        .readFile(
          path.join(procRoot, String(pid), 'task', task, 'children'),
          'utf8',
        )
        .catch((error: NodeJS.ErrnoException) =>
          error.code === 'ENOENT' ? null : '',
        );
      if (children === null) {
        // The root's own list missing means the kernel has none at all; a
        // child's can simply have exited.
        if (pid === rootPid) return null;
        continue;
      }
      for (const child of children.split(/\s+/)) {
        if (/^\d+$/.test(child)) pending.push(Number(child));
      }
    }
  }
  return found;
}

/**
 * Every process in process group `groupId`, by reading each process's
 * `stat`. Slower than the tree walk; used where the kernel has no
 * children lists. The render service starts LibreOffice as a group leader
 * (its pid is the group id) and LibreOffice keeps its processes in it.
 */
async function processGroup(
  groupId: number,
  procRoot: string,
): Promise<number[]> {
  const entries = await fs.promises.readdir(procRoot).catch(() => []);
  const members: number[] = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const stat = await fs.promises
      .readFile(path.join(procRoot, name, 'stat'), 'utf8')
      .catch(() => '');
    // Fields after the command, which is in parentheses and may contain
    // spaces: state, ppid, pgrp, ...
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(rest[2]) === groupId) members.push(Number(name));
  }
  return members;
}

/** A `kB` field of a `status` file in bytes, or null when absent. */
function statusBytes(status: string, field: string): number | null {
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, 'm').exec(status);
  return match ? Number(match[1]) * 1024 : null;
}

/**
 * A process's private resident memory in bytes (see the module comment),
 * from its `status`; 0 when gone.
 */
export function privateResidentBytes(status: string): number {
  const anonymous = statusBytes(status, 'RssAnon');
  if (anonymous !== null) {
    return anonymous + (statusBytes(status, 'RssShmem') ?? 0);
  }
  return statusBytes(status, 'VmRSS') ?? 0;
}

async function residentBytes(pid: number, procRoot: string): Promise<number> {
  const status = await fs.promises
    .readFile(path.join(procRoot, String(pid), 'status'), 'utf8')
    .catch(() => '');
  return privateResidentBytes(status);
}

/**
 * Total resident memory of `rootPid` and its descendants.
 *
 * @param rootPid - The process first started.
 * @param procRoot - Where /proc is (tests point it elsewhere).
 * @returns Bytes; null where /proc cannot be read (not Linux), so a caller
 *   can tell "nothing measured" from "nothing used".
 */
export async function treeResidentBytes(
  rootPid: number,
  procRoot = '/proc',
): Promise<number | null> {
  const readable = await fs.promises
    .access(path.join(procRoot, String(rootPid)))
    .then(() => true)
    .catch(() => false);
  if (!readable) {
    const procExists = await fs.promises
      .access(procRoot)
      .then(() => true)
      .catch(() => false);
    return procExists ? 0 : null;
  }
  const pids =
    (await processTree(rootPid, procRoot)) ??
    (await processGroup(rootPid, procRoot));
  const sizes = await Promise.all(
    pids.map((pid) => residentBytes(pid, procRoot)),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

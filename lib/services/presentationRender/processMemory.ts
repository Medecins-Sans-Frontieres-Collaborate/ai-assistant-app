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
 */
import fs from 'fs';
import path from 'path';

/**
 * The process ids of `rootPid` and all its descendants, found by walking
 * each thread's `children` list.
 */
async function processTree(
  rootPid: number,
  procRoot: string,
): Promise<number[]> {
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
        .catch(() => '');
      for (const child of children.split(/\s+/)) {
        if (/^\d+$/.test(child)) pending.push(Number(child));
      }
    }
  }
  return found;
}

/** A process's resident memory in bytes, from its `status`; 0 when gone. */
async function residentBytes(pid: number, procRoot: string): Promise<number> {
  const status = await fs.promises
    .readFile(path.join(procRoot, String(pid), 'status'), 'utf8')
    .catch(() => '');
  const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
  return match ? Number(match[1]) * 1024 : 0;
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
  const pids = await processTree(rootPid, procRoot);
  const sizes = await Promise.all(
    pids.map((pid) => residentBytes(pid, procRoot)),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

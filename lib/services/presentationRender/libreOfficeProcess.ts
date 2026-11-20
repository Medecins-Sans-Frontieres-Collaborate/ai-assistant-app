/**
 * Runs one LibreOffice conversion as a contained process. Used only by the
 * render service, which decides when it may run.
 *
 * - Its own process group, so a timeout or an abort kills the launcher and
 *   `soffice.bin` together.
 * - A memory limit on what the process group actually uses (resident
 *   memory, checked every MEMORY_CHECK_MS; see processMemory for why not
 *   an address-space limit) and a lower CPU priority (`nice`): a deck too
 *   large fails as a job and the server goes on.
 * - Its own profile directory, so conversions never share a profile lock.
 * - Success is the output file: LibreOffice exits 0 when it fails to load
 *   a file, so the exit code alone means nothing (probe results in
 *   docs/POWERPOINT_TRANSLATION.md).
 */
import { treeResidentBytes } from './processMemory';

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

/** Characters of output kept for diagnostics. */
const LOG_TAIL_CHARS = 4_000;

/** CPU priority LibreOffice runs at; higher is lower priority. */
const NICENESS = 10;

/** How often the process group's memory is checked. */
export const MEMORY_CHECK_MS = 250;

export interface LibreOfficeConversion {
  /** The file to convert; already checked against its type. */
  inputPath: string;
  /** LibreOffice import filter for the input (see libreOfficeInputs). */
  importFilter: string;
  /**
   * The `--convert-to` argument: an extension, optionally with an export
   * filter and its options, as `pdf:impress_pdf_Export:{...}`.
   */
  convertTo: string;
  /** Directory the output is written to; created if missing. */
  outputDir: string;
  /** Directory for this run's profile; must not be shared. */
  profileDir: string;
  /** Killed after this long. */
  timeoutMs: number;
  /** Resident memory the process group may use, in megabytes. */
  memoryLimitMb: number;
  /** Stops the conversion (the process group is killed). */
  signal?: AbortSignal;
  /** The LibreOffice launcher to run; `libreoffice` by default. */
  binary?: string;
  /** Measures the process tree's memory; replaced in tests. */
  measureMemory?: (rootPid: number) => Promise<number | null>;
}

/** Raised when a conversion used more memory than allowed; it was killed. */
export class LibreOfficeMemoryError extends Error {
  readonly code = 'RENDER_MEMORY';
  constructor(readonly limitMb: number) {
    super(
      `The document converter needed more than ${limitMb} MB of memory and was stopped. The file may be too large to convert.`,
    );
    this.name = 'LibreOfficeMemoryError';
  }
}

/** Raised when a conversion runs past its time limit; it was killed. */
export class LibreOfficeTimeoutError extends Error {
  readonly code = 'RENDER_TIMEOUT';
  constructor(readonly timeoutMs: number) {
    super(
      `The document converter took longer than ${Math.round(timeoutMs / 1000)} s and was stopped.`,
    );
    this.name = 'LibreOfficeTimeoutError';
  }
}

/**
 * Raised when a conversion produced no output. `crashed` is true when the
 * process died (a signal, or a non-zero exit, as when it runs out of
 * memory); false when it ran and could not load or convert the file, which
 * trying again will not change.
 */
export class LibreOfficeFailedError extends Error {
  readonly code = 'RENDER_FAILED';
  constructor(
    message: string,
    readonly crashed: boolean,
    readonly logs: string,
  ) {
    super(message);
    this.name = 'LibreOfficeFailedError';
  }
}

/** Name LibreOffice gives the output: the input's base name, new extension. */
export function expectedOutputPath(
  inputPath: string,
  convertTo: string,
  outputDir: string,
): string {
  const extension = convertTo.split(':')[0];
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(outputDir, `${base}.${extension}`);
}

/**
 * The command line: LibreOffice under `nice`. Arguments go straight to the
 * process (no shell), so no file name is ever interpreted.
 */
export function libreOfficeCommand(job: LibreOfficeConversion): {
  command: string;
  args: string[];
} {
  return {
    command: 'nice',
    args: [
      '-n',
      String(NICENESS),
      job.binary ?? 'libreoffice',
      `-env:UserInstallation=file://${job.profileDir}`,
      '--headless',
      '--norestore',
      `--infilter=${job.importFilter}`,
      '--convert-to',
      job.convertTo,
      '--outdir',
      job.outputDir,
      job.inputPath,
    ],
  };
}

/** Kills a process group, ignoring one that has already gone. */
function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already exited.
  }
}

/**
 * Converts one file.
 *
 * @param job - What to convert, where, and within which limits.
 * @returns Path of the converted file.
 * @throws LibreOfficeTimeoutError past `timeoutMs`.
 * @throws LibreOfficeMemoryError past `memoryLimitMb`.
 * @throws The signal's reason when aborted.
 * @throws LibreOfficeFailedError when no output was produced.
 */
export async function runLibreOffice(
  job: LibreOfficeConversion,
): Promise<string> {
  if (job.signal?.aborted) throw job.signal.reason;
  await fs.promises.mkdir(job.outputDir, { recursive: true });
  const { command, args } = libreOfficeCommand(job);
  const output = expectedOutputPath(
    job.inputPath,
    job.convertTo,
    job.outputDir,
  );

  const measure =
    job.measureMemory ?? ((pid: number) => treeResidentBytes(pid));
  const limitBytes = job.memoryLimitMb * 1024 * 1024;
  const { code, signal, logs, timedOut, aborted, overMemory } =
    await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      logs: string;
      timedOut: boolean;
      aborted: boolean;
      overMemory: boolean;
    }>((resolve, reject) => {
      const child = spawn(command, args, {
        detached: true, // its own process group; see killGroup
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let logs = '';
      const keep = (chunk: Buffer) => {
        logs = (logs + chunk.toString()).slice(-LOG_TAIL_CHARS);
      };
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
      let timedOut = false;
      let aborted = false;
      let overMemory = false;
      let measuring = false;
      const watchdog = setInterval(() => {
        if (measuring || !child.pid) return;
        measuring = true;
        measure(child.pid)
          .then((bytes) => {
            if (bytes !== null && bytes > limitBytes && !overMemory) {
              overMemory = true;
              killGroup(child.pid);
            }
          })
          .catch(() => undefined)
          .finally(() => {
            measuring = false;
          });
      }, MEMORY_CHECK_MS);
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid);
      }, job.timeoutMs);
      const onAbort = () => {
        aborted = true;
        killGroup(child.pid);
      };
      job.signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (error) => {
        clearTimeout(timer);
        clearInterval(watchdog);
        job.signal?.removeEventListener('abort', onAbort);
        reject(error);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        clearInterval(watchdog);
        job.signal?.removeEventListener('abort', onAbort);
        // The launcher can exit while soffice.bin lingers; never leave it.
        killGroup(child.pid);
        resolve({ code, signal, logs, timedOut, aborted, overMemory });
      });
    });

  if (aborted) throw job.signal?.reason ?? new Error('Conversion aborted');
  if (timedOut) throw new LibreOfficeTimeoutError(job.timeoutMs);
  if (overMemory) throw new LibreOfficeMemoryError(job.memoryLimitMb);
  const produced = await fs.promises
    .stat(output)
    .then((stats) => stats.size > 0)
    .catch(() => false);
  if (produced) return output;

  const crashed = signal !== null || (code !== null && code !== 0);
  throw new LibreOfficeFailedError(
    crashed
      ? `The document converter stopped unexpectedly (${signal ?? `exit ${code}`}).`
      : 'The document converter could not read this file.',
    crashed,
    logs,
  );
}

/**
 * Runs the presentation sandbox script (pptxNativeScript.ts) on this
 * machine, with the same contract as runSandboxScript: inputs placed beside
 * the script, the command's archive unpacked. Tests that need it skip where
 * Python or lxml is missing (`deckScriptAvailable`).
 */
import {
  PPTX_NATIVE_OUTPUT_ARCHIVE,
  PPTX_NATIVE_SCRIPT,
  PPTX_NATIVE_SCRIPT_FILENAME,
  PptxNativeCommand,
} from '@/lib/services/documentTranslation/native/pptxNativeScript';
import type { SandboxInputFile } from '@/lib/services/documentTranslation/native/sandboxScriptRunner';

import { execFileSync } from 'child_process';
import { unzipSync } from 'fflate';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const PYTHON = process.env.DECK_SCRIPT_PYTHON ?? 'python3';

/** Whether Python with lxml is here to run the script. */
export const deckScriptAvailable = (() => {
  try {
    execFileSync(PYTHON, ['-I', '-c', 'import lxml'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** A fresh folder holding the script, for one run. */
export function scriptDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-script-'));
  fs.writeFileSync(
    path.join(dir, PPTX_NATIVE_SCRIPT_FILENAME),
    PPTX_NATIVE_SCRIPT,
  );
  return dir;
}

/**
 * Runs one command and returns its archive's files.
 *
 * @param command - extract or rebuild.
 * @param inputs - Files placed beside the script (job.json among them).
 */
export function runDeckScript(
  command: PptxNativeCommand,
  inputs: SandboxInputFile[],
): Map<string, Uint8Array> {
  const dir = scriptDir();
  try {
    for (const input of inputs) {
      fs.writeFileSync(path.join(dir, input.filename), input.data);
    }
    execFileSync(
      PYTHON,
      ['-I', path.join(dir, PPTX_NATIVE_SCRIPT_FILENAME), command, dir],
      { stdio: 'pipe', timeout: 120_000 },
    );
    const archive = fs.readFileSync(
      path.join(dir, PPTX_NATIVE_OUTPUT_ARCHIVE[command]),
    );
    return new Map(Object.entries(unzipSync(new Uint8Array(archive))));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Runs Python code with the script importable as `deck`.
 *
 * @returns What the code printed, parsed as JSON.
 */
export function withDeckModule<T>(code: string): T {
  const dir = scriptDir();
  try {
    fs.renameSync(
      path.join(dir, PPTX_NATIVE_SCRIPT_FILENAME),
      path.join(dir, 'deck.py'),
    );
    const program = `import sys, json\nsys.path.insert(0, ${JSON.stringify(dir)})\nimport deck\n${code}`;
    const out = execFileSync(PYTHON, ['-I', '-c', program], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    return JSON.parse(out) as T;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The job file input. */
export function jobInput(job: Record<string, unknown>): SandboxInputFile {
  return { filename: 'job.json', data: Buffer.from(JSON.stringify(job)) };
}

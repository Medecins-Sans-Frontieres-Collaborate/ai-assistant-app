/**
 * Runs a sandbox program of the documents layer (a SandboxScript) on this
 * machine, with the same contract as runSandboxScript: the program, its
 * modules and the inputs placed side by side, the command's archive
 * unpacked. Tests that need it skip where Python or a module is missing
 * (`pythonHas`).
 *
 * The Python used is DOCUMENT_SCRIPT_PYTHON when set (a virtual
 * environment with PyMuPDF, say), else python3.
 */
import {
  SandboxInputFile,
  SandboxScript,
  assertSandboxInputNames,
} from '@/lib/services/documents/sandbox/sandboxScriptRunner';

import { execFileSync } from 'child_process';
import { unzipSync } from 'fflate';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const SCRIPT_PYTHON =
  process.env.DOCUMENT_SCRIPT_PYTHON ??
  process.env.DECK_SCRIPT_PYTHON ??
  'python3';

/** Whether the Python here can import every module named. */
export function pythonHas(modules: string[]): boolean {
  try {
    execFileSync(
      SCRIPT_PYTHON,
      [
        '-I',
        '-W',
        'ignore',
        '-c',
        modules.map((m) => `import ${m}`).join('; '),
      ],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs one command of a program and returns its archive's files.
 *
 * @param script - The program, as the sandbox runner takes it.
 * @param command - One of its commands.
 * @param inputs - Files placed beside it (job.json among them).
 */
export function runLocalScript(
  script: SandboxScript,
  command: string,
  inputs: SandboxInputFile[],
): Map<string, Uint8Array> {
  const archive = script.archives[command];
  if (!archive) throw new Error(`${script.filename} has no ${command}`);
  // Refuse what the sandbox refuses, so a test cannot pass on a name it
  // would turn away.
  assertSandboxInputNames(inputs);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-script-'));
  try {
    fs.writeFileSync(path.join(dir, script.filename), script.source);
    for (const extra of script.modules ?? []) {
      fs.writeFileSync(path.join(dir, extra.filename), extra.source);
    }
    for (const input of inputs) {
      fs.writeFileSync(path.join(dir, input.filename), input.data);
    }
    execFileSync(
      SCRIPT_PYTHON,
      ['-I', '-W', 'ignore', path.join(dir, script.filename), command, dir],
      { stdio: 'pipe', timeout: 120_000 },
    );
    const data = fs.readFileSync(path.join(dir, archive));
    return new Map(Object.entries(unzipSync(new Uint8Array(data))));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

import { createFoundryOpenAIClient } from '@/lib/services/chat/tools/CodeInterpreterTool';
import { WorkflowUsageCollector } from '@/lib/services/workflows/shared/workflowUsage';

import {
  PDF_NATIVE_OUTPUT_ARCHIVE,
  PDF_NATIVE_SCRIPT,
  PDF_NATIVE_SCRIPT_FILENAME,
  PdfNativeCommand,
} from './pdfNativeScript';

import { env } from '@/config/environment';
import { unzipSync } from 'fflate';
import { toFile } from 'openai';

/** One file placed beside the script in the sandbox. */
export interface SandboxInputFile {
  filename: string;
  data: Buffer;
  mimeType?: string;
}

export interface SandboxScriptRun {
  /** The command's output archive, unpacked: filename → bytes. */
  files: Map<string, Uint8Array>;
  /** What the script printed, for diagnostics. */
  logs: string;
  durationMs: number;
}

/** Raised when the sandbox ran but the script did not produce its archive. */
export class SandboxScriptError extends Error {
  constructor(
    message: string,
    readonly logs: string,
  ) {
    super(message);
    this.name = 'SandboxScriptError';
  }
}

const LOG_TAIL_CHARS = 2_000;

/** Directory the launch snippet assembles the job in, inside the sandbox. */
const SANDBOX_DATA_DIR = '/mnt/data';
const SANDBOX_WORK_DIR = `${SANDBOX_DATA_DIR}/native_job`;

/**
 * The whole instruction given to the sandbox model. It launches the uploaded
 * script and nothing else: no PDF logic is ever written by a model.
 *
 * The sandbox stores an uploaded file as `assistant-<id>-<name>`, so the
 * snippet first copies each input into a work directory under its plain
 * name, which is what the script and its job file refer to. The output
 * archive is copied back to the data directory, where the container's file
 * list reports it.
 */
function launchInstruction(
  command: PdfNativeCommand,
  filenames: string[],
): string {
  const archive = PDF_NATIVE_OUTPUT_ARCHIVE[command];
  return [
    'Run exactly this Python code once in the code interpreter, unchanged.',
    'Do not modify it, do not write any other code, and do not open or inspect the files.',
    'When it has run, reply with only the word DONE.',
    '',
    '```python',
    'import glob, os, shutil, subprocess, sys',
    `names = ${JSON.stringify(filenames)}`,
    `work = '${SANDBOX_WORK_DIR}'`,
    'os.makedirs(work, exist_ok=True)',
    `for path in glob.glob('${SANDBOX_DATA_DIR}/*'):`,
    '    base = os.path.basename(path)',
    '    for name in names:',
    "        if os.path.isfile(path) and (base == name or base.endswith('-' + name)):",
    '            shutil.copy(path, os.path.join(work, name))',
    `result = subprocess.run([sys.executable, os.path.join(work, '${PDF_NATIVE_SCRIPT_FILENAME}'), '${command}'], capture_output=True, text=True)`,
    `print(result.stdout[-${LOG_TAIL_CHARS}:])`,
    `print(result.stderr[-${LOG_TAIL_CHARS}:])`,
    `if os.path.exists(os.path.join(work, '${archive}')):`,
    `    shutil.copy(os.path.join(work, '${archive}'), '${SANDBOX_DATA_DIR}/${archive}')`,
    '```',
  ].join('\n');
}

/**
 * Runs one command of the fixed PDF script in a fresh code-interpreter
 * sandbox and returns the files it produced.
 *
 * Each call uploads its inputs, starts a new container and reads the output
 * archive straight from the container's file list, so nothing depends on the
 * sandbox model describing or citing what it made. Containers are not
 * reused: they expire after about 30 minutes idle, and every command here
 * starts from the original document anyway.
 *
 * @param command - Which script command to run.
 * @param inputs - Files the command reads (the script itself is added).
 * @param usage - Collector the sandbox model's token use is reported to.
 * @returns The unpacked output archive and the script's log tail.
 * @throws SandboxScriptError when the archive is missing (the script failed).
 * @throws Error when the Foundry client or an upload fails.
 */
export async function runSandboxScript(
  command: PdfNativeCommand,
  inputs: SandboxInputFile[],
  usage?: WorkflowUsageCollector,
): Promise<SandboxScriptRun> {
  const startedAt = Date.now();
  const client = await createFoundryOpenAIClient();
  const files: SandboxInputFile[] = [
    {
      filename: PDF_NATIVE_SCRIPT_FILENAME,
      data: Buffer.from(PDF_NATIVE_SCRIPT, 'utf-8'),
      mimeType: 'text/x-python',
    },
    ...inputs,
  ];

  const fileIds: string[] = [];
  try {
    for (const file of files) {
      const uploaded = await client.files.create({
        purpose: 'assistants',
        file: await toFile(file.data, file.filename, {
          type: file.mimeType ?? 'application/octet-stream',
        }),
      });
      fileIds.push(uploaded.id);
    }

    const model = env.CODE_INTERPRETER_MODEL;
    const response = await client.responses.create({
      model,
      input: launchInstruction(
        command,
        files.map((file) => file.filename),
      ),
      tools: [
        {
          type: 'code_interpreter',
          container: { type: 'auto', file_ids: fileIds },
        },
      ],
      include: ['code_interpreter_call.outputs'],
    });
    usage?.recordRaw(
      {
        prompt_tokens: response.usage?.input_tokens,
        completion_tokens: response.usage?.output_tokens,
        total_tokens: response.usage?.total_tokens,
      },
      model,
      `native-pdf-sandbox-${command}`,
    );

    const containerIds: string[] = [];
    const logParts: string[] = [];
    for (const item of response.output ?? []) {
      if (item.type !== 'code_interpreter_call') continue;
      if (item.container_id && !containerIds.includes(item.container_id)) {
        containerIds.push(item.container_id);
      }
      for (const output of item.outputs ?? []) {
        if (output.type === 'logs') logParts.push(output.logs);
      }
    }
    const logs = logParts.join('\n').trim();

    const archiveName = PDF_NATIVE_OUTPUT_ARCHIVE[command];
    for (const containerId of containerIds) {
      const listing = await client.containers.files.list(containerId);
      for await (const file of listing) {
        const path = (file as { path?: string }).path ?? '';
        if (path.split('/').pop() !== archiveName) continue;
        const download = await client.containers.files.content.retrieve(
          file.id,
          { container_id: containerId },
        );
        const unpacked = unzipSync(
          new Uint8Array(await download.arrayBuffer()),
        );
        return {
          files: new Map(Object.entries(unpacked)),
          logs,
          durationMs: Date.now() - startedAt,
        };
      }
    }
    const reason =
      containerIds.length === 0
        ? `The sandbox did not run the ${command} script`
        : `The ${command} script produced no output archive`;
    // The log tail travels in the message: it is the only evidence of why.
    throw new SandboxScriptError(
      logs ? `${reason}: ${logs.slice(-LOG_TAIL_CHARS)}` : reason,
      logs,
    );
  } finally {
    // Inputs were copied into the container; the originals are not needed.
    for (const id of fileIds) {
      void client.files.delete(id).catch(() => undefined);
    }
  }
}

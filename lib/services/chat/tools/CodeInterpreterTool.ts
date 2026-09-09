import { Session } from 'next-auth';

import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { getAzureMonitorLogger } from '@/lib/services/observability';

import Hasher from '@/lib/utils/app/hash';
import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import { getContentType } from '@/lib/utils/server/file/mimeTypes';
import { validateOrSanitizeImageBytes } from '@/lib/utils/server/file/svgSanitization';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';
import { rewriteSandboxLinks } from '@/lib/utils/shared/chat/sandboxLinks';
import { isAllowedFoundryHost } from '@/lib/utils/shared/foundryHostAllowlist';

import { env } from '@/config/environment';
import { GeneratedFileRef } from '@/lib/streamMarkers';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type OpenAI from 'openai';
import { toFile } from 'openai';

/** One file handed to the sandbox for analysis (raw bytes, not summaries). */
export interface CodeInterpreterInputFile {
  filename: string;
  data: Buffer;
  mimeType?: string;
}

export interface CodeInterpreterToolParams {
  /** Self-contained task for the interpreter model ("analyze X, chart Y"). */
  task: string;
  session: Session;
  inputFiles?: CodeInterpreterInputFile[];
  /**
   * Use `task` verbatim as the ENTIRE instruction (plus the attached-file
   * list) instead of wrapping it in the generic run-code preamble. For
   * callers that compose their own deterministic contract, e.g. the
   * document-trim pipeline's mechanical plan-application script.
   */
  verbatimTask?: boolean;
}

/** One sandbox execution round (a single `code_interpreter_call` item). */
export interface CodeRun {
  code: string | null;
  /** Concatenated log outputs (stdout/stderr) surfaced by the sandbox. */
  logs: string | null;
  status: string;
}

export interface CodeInterpreterResult {
  /** The interpreter model's final text answer for the task. */
  text: string;
  codeRuns: CodeRun[];
  /** Files the sandbox produced, already persisted to the user's blob storage. */
  generatedFiles: GeneratedFileRef[];
  /**
   * Container ids of the sandbox sessions that ran. Lets callers list
   * container files directly when the model produced a file but failed to
   * cite it (containers expire ~30 min idle — use promptly).
   */
  containerIds: string[];
  durationMs: number;
}

/** Extensions the file serve route can name (≤4 chars, alphanumeric). */
const EXTENSION_RE = /^[a-z0-9]{1,4}$/i;

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** One `container_file_citation` reference from a code-interpreter run. */
export interface ContainerFileCitationRef {
  containerId: string;
  fileId: string;
  filename: string;
}

/**
 * Downloads cited container files and persists them to the user's blob
 * storage under the SAME content-hash naming as uploads, so the existing
 * `/api/file/<sha256>.<ext>` route serves them (and dedup is free).
 * Shared by the Phase 1 sub-tool round-trip and the Phase 2 native
 * Responses-API path. Download promptly — containers expire (~30 min idle).
 */
export async function persistContainerFiles(
  client: OpenAI,
  citations: ContainerFileCitationRef[],
  session: Session,
): Promise<GeneratedFileRef[]> {
  if (citations.length === 0) return [];

  const userId = getUserIdFromSession(session);
  const blobStorageClient = createBlobStorageClient(session);
  const results: GeneratedFileRef[] = [];
  // The same file can be cited more than once (inline mention + final
  // list); persist each container file a single time.
  const seen = new Set<string>();

  for (const citation of citations) {
    const key = `${citation.containerId}/${citation.fileId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      const download = await client.containers.files.content.retrieve(
        citation.fileId,
        { container_id: citation.containerId },
      );
      let data: Buffer = Buffer.from(await download.arrayBuffer());

      const rawExtension = citation.filename.split('.').pop() ?? '';
      const extension = EXTENSION_RE.test(rawExtension)
        ? rawExtension.toLowerCase()
        : 'bin';
      const isImage = IMAGE_EXTENSIONS.has(extension);
      const mimeType = getContentType(extension);

      if (isImage) {
        const validated = await validateOrSanitizeImageBytes(data);
        if (!validated.ok) {
          console.warn(
            `[CodeInterpreter] Dropping generated image that failed validation: ${sanitizeForLog(citation.filename)}`,
          );
          continue;
        }
        data = validated.data;
      }

      const hash = Hasher.sha256(data);
      const uploadLocation = isImage ? 'images' : 'files';
      await blobStorageClient.upload(
        `${userId}/uploads/${uploadLocation}/${hash}.${extension}`,
        data,
        { blobHTTPHeaders: { blobContentType: mimeType } },
      );

      results.push({
        url: `/api/file/${hash}.${extension}`,
        filename: citation.filename,
        mime_type: mimeType,
        is_image: isImage,
      });
      console.log(
        `[CodeInterpreter] Persisted generated file ${sanitizeForLog(citation.filename)} (${data.length} bytes)`,
      );
    } catch (err) {
      // A single failed download must not sink the whole result — the
      // text and code output are still valuable.
      console.error(
        `[CodeInterpreter] Failed to persist generated file ${sanitizeForLog(citation.filename)}:`,
        err,
      );
      // Console output is not collected in production — emit an alertable
      // event so a systematic failure (e.g. a 401 from a missing data-plane
      // role on one regional Foundry account) can't stay invisible while
      // chats keep completing without their files.
      const status =
        err && typeof err === 'object' && 'status' in err
          ? ` (status ${(err as { status: unknown }).status})`
          : '';
      void getAzureMonitorLogger().logError({
        user: session.user,
        errorCode: 'CODE_INTERPRETER_FILE_PERSIST_FAILED',
        errorMessage: `${err instanceof Error ? err.message : String(err)}${status}`,
        operation: 'persistContainerFiles',
      });
    }
  }

  return results;
}

/**
 * Foundry project client exposing the OpenAI Responses surface (files,
 * responses, containers). Shared by CodeInterpreterTool and callers that
 * need direct container access (e.g. the document-trim pipeline's
 * uncited-output-file fallback).
 */
export async function createFoundryOpenAIClient(): Promise<OpenAI> {
  const aiProjects = await import('@azure/ai-projects');
  const { DefaultAzureCredential } = await import('@azure/identity');

  const endpoint = env.AZURE_AI_FOUNDRY_ENDPOINT;
  if (!endpoint) {
    throw new Error(
      'Code interpreter requires AZURE_AI_FOUNDRY_ENDPOINT to be configured',
    );
  }
  if (!isAllowedFoundryHost(endpoint)) {
    throw new Error(
      `Refusing to invoke Foundry against disallowed host: ${endpoint}`,
    );
  }

  const project = new aiProjects.AIProjectClient(
    endpoint,
    new DefaultAzureCredential(),
  );
  return (await project.getOpenAIClient()) as unknown as OpenAI;
}

/**
 * CodeInterpreterTool
 *
 * Runs a task in Azure AI Foundry's sandboxed Python environment via the
 * Responses API's `code_interpreter` tool (ephemeral auto container — no
 * agent definition needed). Mirrors WebSearchTool's privacy posture: only
 * the routed task text and explicitly attached files are sent, never the
 * full conversation.
 *
 * Generated files (charts, exports) are downloaded from the sandbox
 * container immediately — container sessions expire after ~30 min idle —
 * and persisted to the user's blob storage under the standard upload path,
 * so the existing `/api/file/[id]` route serves them with the same
 * per-user access control as uploads.
 */
export class CodeInterpreterTool {
  readonly type = 'code_interpreter' as const;
  readonly name = 'Code Interpreter';
  readonly description =
    'Executes Python code in a sandbox for data analysis, math, and chart generation';

  private tracer = trace.getTracer('code-interpreter-tool');

  async execute(
    params: CodeInterpreterToolParams,
  ): Promise<CodeInterpreterResult> {
    return await this.tracer.startActiveSpan(
      'code_interpreter.execute',
      {
        attributes: {
          'code_interpreter.task_length': params.task.length,
          'code_interpreter.input_files': params.inputFiles?.length ?? 0,
          'code_interpreter.model': env.CODE_INTERPRETER_MODEL,
        },
      },
      async (span) => {
        const startTime = Date.now();
        try {
          const openAIClient = await this.createClient();

          const inputFileIds = await this.uploadInputFiles(
            openAIClient,
            params.inputFiles ?? [],
          );

          try {
            const response = await this.runInterpreter(
              openAIClient,
              params.task,
              inputFileIds,
              params.inputFiles ?? [],
              params.verbatimTask === true,
            );

            const { text, codeRuns, citations, containerIds } =
              this.parseOutput(response);
            const generatedFiles = await this.persistGeneratedFiles(
              openAIClient,
              citations,
              params.session,
            );

            const durationMs = Date.now() - startTime;
            span.setAttribute('code_interpreter.code_runs', codeRuns.length);
            span.setAttribute(
              'code_interpreter.generated_files',
              generatedFiles.length,
            );
            span.setStatus({ code: SpanStatusCode.OK });

            return { text, codeRuns, generatedFiles, containerIds, durationMs };
          } finally {
            // Input files were copied into the sandbox container; the
            // originals in Foundry file storage are no longer needed.
            void this.deleteInputFiles(openAIClient, inputFileIds);
          }
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'Unknown error',
          });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  private async createClient(): Promise<OpenAI> {
    return createFoundryOpenAIClient();
  }

  private async uploadInputFiles(
    client: OpenAI,
    files: CodeInterpreterInputFile[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const f of files) {
      const uploaded = await client.files.create({
        purpose: 'assistants',
        file: await toFile(f.data, f.filename, {
          type: f.mimeType ?? 'application/octet-stream',
        }),
      });
      ids.push(uploaded.id);
      console.log(
        `[CodeInterpreterTool] Uploaded input file ${sanitizeForLog(f.filename)} (${f.data.length} bytes) as ${uploaded.id}`,
      );
    }
    return ids;
  }

  private async deleteInputFiles(
    client: OpenAI,
    fileIds: string[],
  ): Promise<void> {
    for (const id of fileIds) {
      try {
        await client.files.delete(id);
      } catch (err) {
        // Best-effort cleanup; orphaned inputs age out server-side.
        console.warn(
          `[CodeInterpreterTool] Failed to delete input file ${id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  private async runInterpreter(
    client: OpenAI,
    task: string,
    fileIds: string[],
    inputFiles: CodeInterpreterInputFile[],
    verbatimTask: boolean,
  ): Promise<OpenAI.Responses.Response> {
    const fileList = inputFiles.length
      ? `\n\nAttached files (available in the sandbox working directory):\n${inputFiles
          .map((f) => `- ${f.filename}`)
          .join('\n')}`
      : '';

    // Mirrors WebSearchTool's forced-search instruction: without it the
    // model may answer from knowledge and never touch the sandbox, which
    // defeats a forced "Run code" request. Verbatim callers bring their own
    // complete contract and skip the generic preamble.
    const instruction = verbatimTask
      ? `${task}${fileList}`
      : `Use the code interpreter to complete the following task. Write and execute Python code — do not answer from knowledge alone. ` +
        `When the task involves data, actually load and process it. When a chart or output file is the natural result, save it as a file. ` +
        `When the task transforms an attached file (shortening, rewriting, reformatting, translating, cleaning), save the result as a NEW ` +
        `file in the SAME format as the input — e.g. .docx in → .docx out via python-docx, .xlsx via openpyxl — unless the task explicitly ` +
        `names a different output format. Do not deliver the transformed content as chat text when the input was a file. ` +
        `Report your findings concisely; the numbers and files you produce are the deliverable.\n\n` +
        `Task: ${task}${fileList}`;

    return await client.responses.create({
      model: env.CODE_INTERPRETER_MODEL,
      input: instruction,
      tools: [
        {
          type: 'code_interpreter',
          container: {
            type: 'auto',
            ...(fileIds.length ? { file_ids: fileIds } : {}),
          },
        },
      ],
    });
  }

  private parseOutput(response: OpenAI.Responses.Response): {
    text: string;
    codeRuns: CodeRun[];
    citations: Array<{
      containerId: string;
      fileId: string;
      filename: string;
    }>;
    containerIds: string[];
  } {
    const codeRuns: CodeRun[] = [];
    const citations: Array<{
      containerId: string;
      fileId: string;
      filename: string;
    }> = [];
    const containerIds: string[] = [];
    const textParts: string[] = [];

    for (const item of response.output ?? []) {
      if (item.type === 'code_interpreter_call') {
        const logs = (item.outputs ?? [])
          .filter((o): o is { type: 'logs'; logs: string } => o.type === 'logs')
          .map((o) => o.logs)
          .join('\n');
        codeRuns.push({
          code: item.code,
          logs: logs || null,
          status: item.status,
        });
        if (item.container_id && !containerIds.includes(item.container_id)) {
          containerIds.push(item.container_id);
        }
      } else if (item.type === 'message') {
        for (const content of item.content ?? []) {
          if (content.type !== 'output_text') continue;
          textParts.push(content.text);
          for (const annotation of content.annotations ?? []) {
            if (annotation.type === 'container_file_citation') {
              citations.push({
                containerId: annotation.container_id,
                fileId: annotation.file_id,
                filename: annotation.filename,
              });
            }
          }
        }
      }
    }

    return {
      // The interpreter model links its outputs as `sandbox:/mnt/data/…`,
      // which nothing outside the container can resolve. Degrade those to
      // plain text here so the picked model never sees (and never echoes)
      // a link that renders as "[blocked]" client-side.
      text: rewriteSandboxLinks(textParts.join('\n').trim()),
      codeRuns,
      citations,
      containerIds,
    };
  }

  /**
   * Downloads each cited container file and persists it to the user's blob
   * storage using the SAME content-hash naming as uploads, so the existing
   * `/api/file/<sha256>.<ext>` route serves it (and dedup is free).
   */
  private async persistGeneratedFiles(
    client: OpenAI,
    citations: ContainerFileCitationRef[],
    session: Session,
  ): Promise<GeneratedFileRef[]> {
    return persistContainerFiles(client, citations, session);
  }
}

import { stripThinking } from '@/lib/utils/app/stream/thinking';

import {
  FileMessageContent,
  ImageMessageContent,
  Message,
  TextMessageContent,
} from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { CodeInterpreterInputFile } from '../tools/CodeInterpreterTool';

import type { AzureOpenAI } from 'openai';
import type OpenAI from 'openai';
import { toFile } from 'openai';

/** Native code-interpreter request for a Responses turn. */
export interface ResponsesCodeInterpreterOptions {
  /** Uploaded Foundry file ids to mount into the sandbox container. */
  fileIds: string[];
  /** Original filenames of the mounted files (for the instructions). */
  filenames?: string[];
  /** InterpreterMode.ALWAYS — instruct the model to actually execute. */
  forced: boolean;
}

/**
 * Handler for models routed through the Azure OpenAI **Responses API**
 * (`supportsResponsesApi`). Compared to chat.completions this exposes
 * reasoning summaries — the only way GPT reasoning models surface visible
 * thinking — and is the strategic surface Azure ships built-in tools on.
 *
 * Scope: the PLAIN chat path only. MCP tool loops, structured extraction,
 * and the DeploymentNotFound fallback chain stay on chat.completions;
 * StandardChatService degrades to that path on any Responses failure.
 *
 * Statelessness: `store: false` on every request — the app's privacy
 * posture keeps conversation state client-side, mirroring chat.completions.
 */
export class ResponsesApiHandler {
  constructor(private client: AzureOpenAI) {}

  /**
   * Converts app messages to Responses-API input items. The system prompt
   * travels separately via `instructions`, so system messages are dropped
   * here. Assistant history is flattened to text with prior-turn <think>
   * blocks stripped (reasoning must not be fed back).
   */
  prepareInput(messages: Message[]): OpenAI.Responses.ResponseInput {
    const input: OpenAI.Responses.ResponseInput = [];

    for (const msg of messages) {
      if (msg.role === 'system') continue;

      if (msg.role === 'assistant') {
        const text = this.flattenToText(msg.content);
        const cleaned = stripThinking(text) || text;
        if (cleaned) {
          input.push({ role: 'assistant', content: cleaned });
        }
        continue;
      }

      // User messages keep multimodal parts (text + images).
      if (typeof msg.content === 'string') {
        input.push({ role: 'user', content: msg.content });
        continue;
      }

      if (Array.isArray(msg.content)) {
        const parts: OpenAI.Responses.ResponseInputContent[] = [];
        for (const item of msg.content) {
          if (item.type === 'text' && 'text' in item) {
            parts.push({
              type: 'input_text',
              text: (item as TextMessageContent).text,
            });
          } else if (item.type === 'image_url' && 'image_url' in item) {
            const url = (item as ImageMessageContent).image_url.url;
            // Only data URLs reach the providers (reference URLs are
            // resolved client-side before send, same as chat.completions).
            if (url.startsWith('data:')) {
              parts.push({
                type: 'input_image',
                image_url: url,
                detail: 'auto',
              });
            }
          } else if (item.type === 'file_url') {
            // Files are extracted/summarized by the pipeline into text
            // context; keep a marker so the model knows one was attached.
            const f = item as FileMessageContent;
            parts.push({
              type: 'input_text',
              text: `[File attached: ${f.originalFilename || 'file'}]`,
            });
          }
        }
        if (parts.length > 0) {
          input.push({ role: 'user', content: parts });
        }
        continue;
      }

      const text = this.flattenToText(msg.content);
      if (text) input.push({ role: 'user', content: text });
    }

    return input;
  }

  buildRequestParams(
    modelConfig: OpenAIModel,
    input: OpenAI.Responses.ResponseInput,
    systemPrompt: string,
    temperature: number | undefined,
    stream: boolean,
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high',
    verbosity?: 'low' | 'medium' | 'high',
    codeInterpreter?: ResponsesCodeInterpreterOptions,
  ): OpenAI.Responses.ResponseCreateParams {
    // Forced mode mirrors the round-trip's instruction: without it the
    // model may answer from knowledge and never touch the sandbox.
    const forcedInstruction =
      codeInterpreter?.forced === true
        ? `\n\nThe user has enabled "Run code" for this message: use the code interpreter to complete the task. ` +
          `Write and execute Python code — do not answer from knowledge alone. When the task involves data, actually load and process it; ` +
          `save charts or output files when they are the natural result.`
        : '';

    // Applies whenever sandbox input files are mounted (forced or not).
    // Two jobs: (1) the model must know the sandbox has the REAL files and
    // must actually execute transformation tasks — without this, a capable
    // chat model given the document's extracted text inline will answer
    // with advice/a plan instead of performing the task; (2) a transformed
    // document must come back as a file in the input's format, not pasted
    // into the chat as markdown.
    const mountedList = codeInterpreter?.filenames?.length
      ? ` Mounted files: ${codeInterpreter.filenames.join(', ')}.`
      : '';
    const fileFormatInstruction =
      codeInterpreter && codeInterpreter.fileIds.length > 0
        ? `\n\nA Python code interpreter is available with the user's uploaded file(s) mounted in its working directory.${mountedList} ` +
          `When the request asks you to TRANSFORM an attached file — shorten or trim it to a target length (words, characters, or pages), rewrite, ` +
          `reformat, translate, or clean it — or to produce any downloadable artifact, you MUST use the code interpreter and actually perform the ` +
          `task now. Do NOT respond with a plan, recommendations, or a description of how you would do it. ` +
          `Save the result as a NEW file in the SAME format as the input — e.g. .docx in → .docx out via python-docx, .xlsx via openpyxl — unless ` +
          `the user explicitly asks for a different output format, and do not deliver the transformed content as chat text. ` +
          `For questions ABOUT the file's content that need no new file, answer directly without running code.`
        : '';

    const params: OpenAI.Responses.ResponseCreateParams = {
      model: modelConfig.deploymentName ?? modelConfig.id,
      input,
      instructions:
        `${systemPrompt}${forcedInstruction}${fileFormatInstruction}` ||
        undefined,
      stream,
      // Stateless: conversation history travels in full on every request;
      // never retain it server-side.
      store: false,
    };

    if (codeInterpreter) {
      params.tools = [
        {
          type: 'code_interpreter',
          container: {
            type: 'auto',
            ...(codeInterpreter.fileIds.length
              ? { file_ids: codeInterpreter.fileIds }
              : {}),
          },
        },
      ];
    }

    if (modelConfig.supportsTemperature !== false && temperature != null) {
      params.temperature = temperature;
    }

    if (modelConfig.supportsReasoningEffort) {
      const effort =
        reasoningEffort === 'minimal' && !modelConfig.supportsMinimalReasoning
          ? 'low'
          : reasoningEffort;
      params.reasoning = {
        ...(effort ? { effort } : {}),
        // The entire point of this API surface for us: visible reasoning.
        summary: 'auto',
      };
    }

    if (modelConfig.supportsVerbosity && verbosity) {
      params.text = { verbosity };
    }

    return params;
  }

  /**
   * Uploads raw attachment bytes to Foundry file storage for the sandbox
   * container. Best-effort per file — a failed upload drops that file, not
   * the turn.
   */
  async uploadInputFiles(files: CodeInterpreterInputFile[]): Promise<string[]> {
    const ids: string[] = [];
    for (const f of files) {
      try {
        const uploaded = await this.client.files.create({
          purpose: 'assistants',
          file: await toFile(f.data, f.filename, {
            type: f.mimeType ?? 'application/octet-stream',
          }),
        });
        ids.push(uploaded.id);
      } catch (err) {
        console.warn(
          `[ResponsesApiHandler] Failed to upload sandbox input file:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return ids;
  }

  /** Best-effort cleanup of uploaded sandbox input files. */
  async deleteInputFiles(fileIds: string[]): Promise<void> {
    for (const id of fileIds) {
      try {
        await this.client.files.delete(id);
      } catch {
        // Orphaned inputs age out server-side.
      }
    }
  }

  async executeStreaming(
    params: OpenAI.Responses.ResponseCreateParams,
  ): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>> {
    return (await this.client.responses.create({
      ...params,
      stream: true,
    })) as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>;
  }

  async executeNonStreaming(
    params: OpenAI.Responses.ResponseCreateParams,
  ): Promise<OpenAI.Responses.Response> {
    return (await this.client.responses.create({
      ...params,
      stream: false,
    })) as OpenAI.Responses.Response;
  }

  /**
   * Extracts the reasoning summary text from a non-streaming response's
   * `reasoning` output items (joined across summary parts).
   */
  extractReasoningSummary(
    response: OpenAI.Responses.Response,
  ): string | undefined {
    const parts: string[] = [];
    for (const item of response.output ?? []) {
      if (item.type === 'reasoning') {
        for (const summary of item.summary ?? []) {
          if (summary.type === 'summary_text' && summary.text) {
            parts.push(summary.text);
          }
        }
      }
    }
    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }

  private flattenToText(content: Message['content']): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((c) =>
          c.type === 'text' && 'text' in c
            ? (c as TextMessageContent).text
            : '',
        )
        .filter(Boolean)
        .join('\n');
    }
    if (
      content &&
      typeof content === 'object' &&
      'text' in (content as object)
    ) {
      return (content as TextMessageContent).text;
    }
    return String(content ?? '');
  }
}

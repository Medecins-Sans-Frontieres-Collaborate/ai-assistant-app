import { Message } from '@/types/chat';

import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

import {
  GENERATED_FILE_MANIFEST_MAX_ENTRIES,
  formatGeneratedFileSize,
} from '@/lib/constants/generatedFiles';
import type { GeneratedFileRef } from '@/lib/streamMarkers';

interface ManifestEntry {
  file: GeneratedFileRef;
  /** 1-based ordinal of the assistant reply that produced it. */
  replyOrdinal: number;
}

/**
 * Tells the model which files it generated earlier in this conversation
 * (issue #126).
 *
 * A code-interpreter run leaves only a download reference on the assistant
 * message (`toolCalls[].generated_files`), and the prompt tells the model
 * not to re-print file contents, so the transcript of "here is script.vbs"
 * carries nothing the next turn can read. The client auto-activates
 * text-like generated files (their text then arrives through
 * `[[Active Files Context]]`); this stage covers the rest — binaries,
 * files that fell out of the 5-slot active list, or an older client — by
 * naming every generated file so the model never asks the user to
 * "provide" a file it wrote itself.
 */
export class GeneratedFileManifestEnricher extends BasePipelineStage {
  readonly name = 'GeneratedFileManifestEnricher';

  shouldRun(context: ChatContext): boolean {
    return collectGeneratedFiles(context.messages).length > 0;
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    const entries = collectGeneratedFiles(context.messages);
    if (entries.length === 0) return context;
    const activeUrls = new Set(
      (context.activeFiles ?? [])
        .filter((f) => f.status !== 'error')
        .map((f) => f.url),
    );
    const section = buildManifestSection(entries, activeUrls);
    return {
      ...context,
      systemPrompt: context.systemPrompt
        ? `${context.systemPrompt}\n\n${section}`
        : section,
    };
  }
}

/** Generated files across the transcript, most recent reply first. */
export function collectGeneratedFiles(messages: Message[]): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  let ordinal = 0;
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    ordinal += 1;
    for (const record of message.toolCalls ?? []) {
      for (const file of record.generated_files ?? []) {
        if (!file?.filename || !file.url) continue;
        entries.push({ file, replyOrdinal: ordinal });
      }
    }
  }
  // Newest first; one line per distinct URL (a re-run that rewrote the same
  // bytes lands on the same content hash).
  const seen = new Set<string>();
  return entries
    .reverse()
    .filter((entry) => {
      if (seen.has(entry.file.url)) return false;
      seen.add(entry.file.url);
      return true;
    })
    .slice(0, GENERATED_FILE_MANIFEST_MAX_ENTRIES);
}

export function buildManifestSection(
  entries: ManifestEntry[],
  activeUrls: ReadonlySet<string>,
): string {
  const lines = entries.map(({ file, replyOrdinal }) => {
    const size = formatGeneratedFileSize(file.size_bytes);
    const where = activeUrls.has(file.url)
      ? 'active — its text is in the Active Files Context below'
      : file.is_image
        ? 'image, shown to the user'
        : 'not currently active — ask the user to activate it from the file panel if you need its contents';
    return `- ${file.filename}${size ? ` (${size})` : ''} — from your reply #${replyOrdinal}; ${where}`;
  });
  return (
    '## Files you generated earlier in this conversation\n' +
    'You created these files with the code interpreter. The user already has them; ' +
    'never claim they do not exist or ask the user to provide them. To change one, ' +
    'work from its contents (active text below, or re-run the interpreter on it) and produce an updated file.\n' +
    lines.join('\n')
  );
}

/**
 * Whether the answering model can reach the full text of an attachment it
 * was shown only in part, and how. An attachment is shortened for the
 * prompt (excerpted) only when the answer is one: otherwise its full text
 * stays inline exactly as before.
 */
import {
  interpreterRequested,
  nativeInterpreterCapable,
} from '@/lib/services/chat/enrichers/interpreterCapability';

import type { ChatContext } from '../pipeline/ChatContext';
import type { FullTextAccess } from './mountedFileExcerpt';

/**
 * Whether the attachment reader tools can be offered on this turn. Same
 * constraints as tool-delivered skills (SkillEnricher.skillDeliveryMode):
 * a streaming, tool-capable model on the app's own clients, and never a
 * turn that would leave the Responses path (native interpreter, reasoning
 * summaries) just to carry this tool.
 */
export function attachmentToolsAvailable(context: ChatContext): boolean {
  const model = context.model;
  if (context.stream === false) return false;
  if (model?.supportsTools !== true) return false;
  if (model.isCustomSourceModel) return false;
  if (nativeInterpreterCapable(context) && interpreterRequested(context))
    return false;
  if (
    model.supportsResponsesApi === true &&
    model.sdk === 'azure-openai' &&
    !context.mcpServers?.length
  )
    return false;
  return true;
}

/**
 * How this turn's answering model could reach a full attachment, if at
 * all: by code (native interpreter turn, file mounted), by the reader
 * tools, or not at all.
 */
export function fullTextAccess(context: ChatContext): FullTextAccess | null {
  if (nativeInterpreterCapable(context) && interpreterRequested(context))
    return 'code';
  return attachmentToolsAvailable(context) ? 'tool' : null;
}

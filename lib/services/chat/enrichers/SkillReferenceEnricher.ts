import { retrieveSkillReferences } from '@/lib/services/skills/skillReferences';
import { auxiliaryRegion } from '@/lib/services/skills/skillRegion';
import { SKILL_LIMITS } from '@/lib/services/skills/types';

import type { Citation } from '@/types/rag';

import type { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

import { emitToolCallRecord } from '@/lib/streamMarkers';
import { randomUUID } from 'crypto';

/** Separately bounded retrieval: a document outage must not remove skill instructions. */
export class SkillReferenceEnricher extends BasePipelineStage {
  readonly name = 'SkillReferenceEnricher';
  shouldRun(context: ChatContext): boolean {
    return !!context.activeSkills?.some((skill) => skill.documents.length);
  }
  onTimeout(context: ChatContext): ChatContext {
    this.emit(context, 0, true);
    return {
      ...context,
      systemPrompt: `${context.systemPrompt}\n\nSkill reference retrieval is unavailable this turn. Do not claim to have read those documents or invent document-specific details.`,
    };
  }
  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    try {
      const query = context.messages
        .slice(-6)
        .map((message) =>
          typeof message.content === 'string' ? message.content : '',
        )
        .join('\n')
        .slice(-6000);
      const metadata = context.processedContent?.metadata ?? {};
      const evidence = await retrieveSkillReferences(
        context.activeSkills ?? [],
        query,
        (metadata.citations ?? []) as Citation[],
        context.stageSignal,
        false,
        Math.max(
          0,
          SKILL_LIMITS.injectedTokensPerTurn - (context.skillTokensUsed ?? 0),
        ),
        auxiliaryRegion(context.user.region, context.hostedRegion),
      );
      if (context.stageSignal?.aborted) return context;
      this.emit(
        context,
        evidence.citations.length,
        evidence.unavailable.length > 0,
      );
      return {
        ...context,
        systemPrompt: context.systemPrompt + evidence.text,
        processedContent: {
          ...context.processedContent,
          metadata: {
            ...metadata,
            citations: [
              ...((metadata.citations ?? []) as Citation[]),
              ...evidence.citations,
            ],
            citationQuoteSources: {
              ...((metadata.citationQuoteSources as Record<string, string>) ??
                {}),
              ...evidence.quoteSources,
            },
          },
        },
      };
    } catch {
      return context.stageSignal?.aborted ? context : this.onTimeout(context);
    }
  }
  private emit(context: ChatContext, count: number, unavailable: boolean) {
    context.emitMarker?.(
      emitToolCallRecord({
        id: `skill-references-${randomUUID()}`,
        name: 'skill_references',
        server_label: 'Skills',
        arguments: null,
        status: unavailable ? 'incomplete' : 'completed',
        output: `${count} reference passages retrieved.`,
        error: unavailable
          ? 'Some skill documents are not ready or could not be retrieved.'
          : null,
      }),
    );
  }
}

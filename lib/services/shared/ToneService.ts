import { Tone } from '@/types/tone';

import { SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * Service responsible for applying tones to system prompts.
 *
 * Handles:
 * - Applying tone voice rules to system prompt
 */
export class ToneService {
  private tracer = trace.getTracer('tone-service');

  /**
   * Applies tone to the system prompt if a tone is provided.
   *
   * @param tone - The tone object (sent from client)
   * @param systemPrompt - The base system prompt
   * @returns The system prompt with tone applied (if applicable)
   */
  public applyTone(tone: Tone | undefined, systemPrompt: string): string {
    return this.tracer.startActiveSpan(
      'tone.apply',
      {
        attributes: {
          'tone.provided': !!tone,
        },
      },
      (span) => {
        try {
          if (!tone) {
            span.setAttribute('tone.applied', false);
            span.setAttribute('tone.reason', 'no_tone_provided');
            span.setStatus({ code: SpanStatusCode.OK });
            return systemPrompt;
          }

          span.setAttribute('tone.id', tone.id);
          span.setAttribute('tone.name', tone.name);

          if (tone.voiceRules) {
            const enhancedPrompt = `${systemPrompt}\n\n# Writing Style\n${tone.voiceRules}`;
            console.log('[ToneService] Applied tone:', tone.name);

            span.setAttribute('tone.applied', true);
            span.setAttribute(
              'tone.voice_rules_length',
              tone.voiceRules.length,
            );
            span.setStatus({ code: SpanStatusCode.OK });

            return enhancedPrompt;
          }

          span.setAttribute('tone.applied', false);
          span.setAttribute('tone.reason', 'no_voice_rules');
          span.setStatus({ code: SpanStatusCode.OK });

          return systemPrompt;
        } catch (error) {
          console.error('[ToneService] Failed to apply tone:', error);
          span.recordException(error as Error);
          span.setAttribute('tone.applied', false);
          span.setAttribute('tone.reason', 'error');
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'Unknown error',
          });
          // Continue without tone if there's an error
          return systemPrompt;
        } finally {
          span.end();
        }
      },
    );
  }
}

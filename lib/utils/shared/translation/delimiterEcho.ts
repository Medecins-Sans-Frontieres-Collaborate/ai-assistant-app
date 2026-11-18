/**
 * Removal of prompt delimiters a model echoed back.
 *
 * The translation prompts fence the source text in triple quotes. Models
 * sometimes reproduce the fence around their answer, so the translation
 * arrives wrapped in `"""` lines that were never part of the text. The
 * prompt asks for that not to happen; this module guarantees it.
 *
 * A fence is removed only when the source text does not itself start (or
 * end) with one: a source that really opens with `"""`, such as a Python
 * docstring, keeps it in translation.
 */

/** The fence the translation prompts put around the text they quote. */
export const PROMPT_TEXT_DELIMITER = '"""';

/** Which ends of the output may carry an echoed fence. */
interface EchoedEnds {
  leading: boolean;
  trailing: boolean;
}

function echoableEnds(sourceText: string): EchoedEnds {
  const source = sourceText.trim();
  return {
    leading: !source.startsWith(PROMPT_TEXT_DELIMITER),
    trailing: !source.endsWith(PROMPT_TEXT_DELIMITER),
  };
}

/**
 * Removes a fence the model echoed at the start and/or end of its output,
 * along with the whitespace between the fence and the text.
 *
 * @param output - The model's complete output.
 * @param sourceText - The text the model was given, to tell an echoed
 *   fence from one that belongs to the content.
 * @returns The output without echoed fences, trimmed.
 */
export function stripEchoedDelimiters(
  output: string,
  sourceText: string,
): string {
  const ends = echoableEnds(sourceText);
  return stripTrailingFence(
    stripLeadingFence(output, ends.leading),
    ends.trailing,
  );
}

/** Trims the start and, when `echoed`, drops a fence found there. */
function stripLeadingFence(text: string, echoed: boolean): string {
  const trimmed = text.trimStart();
  return echoed && trimmed.startsWith(PROMPT_TEXT_DELIMITER)
    ? trimmed.slice(PROMPT_TEXT_DELIMITER.length).trimStart()
    : trimmed;
}

/** Trims the end and, when `echoed`, drops a fence found there. */
function stripTrailingFence(text: string, echoed: boolean): string {
  const trimmed = text.trimEnd();
  return echoed && trimmed.endsWith(PROMPT_TEXT_DELIMITER)
    ? trimmed.slice(0, -PROMPT_TEXT_DELIMITER.length).trimEnd()
    : trimmed;
}

/** Characters a fence, and the whitespace around it, are made of. */
const FENCE_CHARS = /^[\s"]*$/;
const TRAILING_FENCE_CHARS = /[\s"]*$/;

/**
 * Removes echoed fences from output that arrives in pieces, so they never
 * reach the screen while a translation streams.
 *
 * It withholds only what could still turn out to be a fence: leading
 * whitespace and quotes until real text arrives, and a trailing run of
 * whitespace and quotes until more text follows it or the stream ends.
 * Everything else passes straight through.
 *
 * @example
 * const filter = createDelimiterEchoFilter(sourceText);
 * onDelta: (delta) => writer.text(filter.push(delta)),
 * // after the stream:
 * writer.text(filter.end());
 */
export function createDelimiterEchoFilter(sourceText: string): {
  /** Feeds a piece of output; returns the part that is safe to show. */
  push: (delta: string) => string;
  /** Ends the stream; returns whatever was withheld and is real text. */
  end: () => string;
} {
  const ends = echoableEnds(sourceText);
  let started = false;
  let held = '';

  return {
    push(delta) {
      held += delta;
      if (!started) {
        // Only whitespace and quotes so far: it may yet be an opening fence.
        if (FENCE_CHARS.test(held)) return '';
        started = true;
        held = stripLeadingFence(held, ends.leading);
      }
      // Hold back a trailing run that could be the closing fence.
      const tailLength = held.match(TRAILING_FENCE_CHARS)?.[0].length ?? 0;
      const safe = held.slice(0, held.length - tailLength);
      held = held.slice(held.length - tailLength);
      return safe;
    },
    end() {
      // Whatever is left is the end of the output (or all of it, if no
      // real text ever arrived): strip it as a complete string.
      const rest = started
        ? stripTrailingFence(held, ends.trailing)
        : stripEchoedDelimiters(held, sourceText);
      started = true;
      held = '';
      return rest;
    },
  };
}

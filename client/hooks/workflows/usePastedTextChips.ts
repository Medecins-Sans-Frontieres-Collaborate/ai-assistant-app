import { useCallback, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  pastedTextHash,
  pastedTextTitle,
} from '@/lib/utils/shared/paste/pastedText';

export interface PastedTextChip {
  id: string;
  /** Short label for the chip, derived from the paste's opening words. */
  name: string;
  text: string;
  chars: number;
}

/**
 * Holds oversized pastes alongside a workflow composer instead of inside it.
 *
 * The workflow rail sends plain strings — `WorkflowRail`'s generic path and
 * the `railSend` overrides both take `(conversation, text)` — so there is no
 * file pipeline to attach to the way chat has one. Keeping the text beside
 * the composer and folding it back in at submit gets the actual benefit (a
 * 40k-character paste stops swallowing a two-row textarea) without rebuilding
 * the rail's message contract.
 */
export function usePastedTextChips() {
  const t = useTranslations('pastedText');
  const [chips, setChips] = useState<PastedTextChip[]>([]);

  const attachPastedText = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) return;

      const id = pastedTextHash(text);
      setChips((prev) =>
        // The same text pasted twice is a repeat, not a second source.
        prev.some((chip) => chip.id === id)
          ? prev
          : [
              ...prev,
              {
                id,
                name: pastedTextTitle(text, t('fallbackName')),
                text,
                chars: text.length,
              },
            ],
      );
    },
    [t],
  );

  const removeChip = useCallback((id: string) => {
    setChips((prev) => prev.filter((chip) => chip.id !== id));
  }, []);

  const clearChips = useCallback(() => setChips([]), []);

  /**
   * Folds the held pastes back into the outgoing text. Each is fenced and
   * labeled so the model can tell the user's instruction from the material
   * it refers to, and so a paste containing its own delimiters can't be
   * mistaken for the surrounding structure.
   */
  const composeWithChips = useCallback(
    (instruction: string): string => {
      if (chips.length === 0) return instruction;

      const blocks = chips.map(
        (chip) =>
          `--- ${t('blockLabel', { name: chip.name })} ---\n${chip.text}`,
      );

      return [instruction.trim(), ...blocks].filter(Boolean).join('\n\n');
    },
    [chips, t],
  );

  /** True when there is something to send even with an empty composer. */
  const hasChips = chips.length > 0;

  return useMemo(
    () => ({
      chips,
      hasChips,
      attachPastedText,
      removeChip,
      clearChips,
      composeWithChips,
    }),
    [
      chips,
      hasChips,
      attachPastedText,
      removeChip,
      clearChips,
      composeWithChips,
    ],
  );
}

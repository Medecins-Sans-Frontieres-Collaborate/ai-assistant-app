'use client';

import { FC } from 'react';

import { useTranslations } from 'next-intl';

import type { ConversationCostSummary } from '@/client/hooks/chat/useConversationCost';

import { PRICING_AS_OF } from '@/types/openai';

interface CostFootnoteProps {
  summary: ConversationCostSummary;
}

/**
 * The cost caveats under the impact rows (docs/CHAT_COST_CHIP.md): what the
 * dollar column is (list price, upper bound), what it leaves out (every
 * service billed outside model tokens), and which requests could not be
 * priced. The figures themselves live in the rows' second column so a label
 * never appears twice in the popover.
 */
export const CostFootnote: FC<CostFootnoteProps> = ({ summary }) => {
  const t = useTranslations('emissions.chip.cost');
  return (
    <div className="mt-2 border-t border-gray-200 pt-2 text-[10px] leading-snug text-gray-500 dark:border-gray-700 dark:text-gray-400">
      {summary.pricedRequests === 0 ? (
        <p>{t('noPriceData')}</p>
      ) : (
        <>
          {summary.unpricedRequests > 0 && (
            <p className="mb-1">
              {t('unpriced', { count: summary.unpricedRequests })}
            </p>
          )}
          <p>{t('note', { asOf: PRICING_AS_OF })}</p>
        </>
      )}
    </div>
  );
};

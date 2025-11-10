// components/FAQ.tsx
import { IconArrowRight } from '@tabler/icons-react';
import { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import { FAQData } from '@/types/faq';

type FAQProps = {
  faq: FAQData['faq'];
};

export const FAQ: FC<FAQProps> = ({ faq }) => {
  const t = useTranslations();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');

  const handleExpand = (index: number) => {
    setExpanded(expanded === index ? null : index);
  };

  const handleSearch = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(event.target.value);
  };

  const filteredFAQ = faq.filter(
    (item) =>
      item.question.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.answer.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  return (
    <div>
      <input
        type="text"
        placeholder={t('common.searchEllipsis')}
        value={searchQuery}
        onChange={handleSearch}
        className="w-full mb-10 rounded-lg border bg-transparent border-neutral-200 px-4 py-3 text-neutral-900 dark:text-neutral-100 dark:border-neutral-600"
      />
      {filteredFAQ.map((item, index) => (
        <div key={index} className="mb-4">
          <button
            className="w-full rounded-lg border border-neutral-200 bg-transparent px-4 py-3 text-neutral-900 dark:border-neutral-600 dark:text-neutral-100 text-left"
            onClick={() => handleExpand(index)}
          >
            {item.question}
          </button>
          {expanded === index && (
            <div className="mt-2 px-4 py-2 bg-transparent text-black dark:text-white whitespace-pre-line leading-relaxed">
              {item.answer}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

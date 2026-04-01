import { IconX } from '@tabler/icons-react';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

interface Props {
  placeholder: string;
  searchTerm: string;
  onSearch: (searchTerm: string) => void;
}
const Search: FC<Props> = ({ placeholder, searchTerm, onSearch }) => {
  const t = useTranslations();

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onSearch(e.target.value);
  };

  const clearSearch = () => {
    onSearch('');
  };

  return (
    <div className="relative flex items-center mx-2">
      <input
        className="w-full flex-1 rounded-md border border-gray-600 bg-white dark:bg-surface-dark-base px-4 py-3 pr-10 text-[14px] leading-3 text-black dark:text-white"
        type="text"
        placeholder={t(placeholder) || ''}
        value={searchTerm}
        onChange={handleSearchChange}
        aria-label={t(placeholder) || ''}
      />

      {searchTerm && (
        <button
          onClick={clearSearch}
          aria-label={t('common.clearSearch')}
          className="absolute right-4 hover:text-gray-400 text-black dark:text-gray-300"
        >
          <IconX size={18} />
        </button>
      )}
    </div>
  );
};

export default Search;

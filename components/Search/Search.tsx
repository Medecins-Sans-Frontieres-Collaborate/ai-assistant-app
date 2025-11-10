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
        className="w-full flex-1 rounded-md border border-neutral-600 bg-white dark:bg-[#171717] px-4 py-3 pr-10 text-[14px] leading-3 text-black dark:text-white"
        type="text"
        placeholder={t(placeholder) || ''}
        value={searchTerm}
        onChange={handleSearchChange}
      />

      {searchTerm && (
        <IconX
          className="absolute right-4 cursor-pointer hover:text-neutral-400 text-black dark:text-neutral-300"
          size={18}
          onClick={clearSearch}
        />
      )}
    </div>
  );
};

export default Search;

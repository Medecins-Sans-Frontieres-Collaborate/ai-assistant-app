import { PiSidebarSimple } from 'react-icons/pi';

import Image from 'next/image';

import lightTextLogo from '@/public/international_logo_black.png';
import darkTextLogo from '@/public/international_logo_white.png';

interface SidebarHeaderProps {
  showChatbar: boolean;
  toggleChatbar: () => void;
  theme: string;
  t: (key: string) => string;
}

export const SidebarHeader: React.FC<SidebarHeaderProps> = ({
  showChatbar,
  toggleChatbar,
  theme,
  t,
}) => {
  return (
    <div
      className={`flex items-center px-3 py-2 border-b transition-all duration-300 ${showChatbar ? 'justify-between border-neutral-300 dark:border-neutral-700' : 'justify-center border-transparent'}`}
    >
      <div
        className={`transition-all duration-300 overflow-hidden ${showChatbar ? 'opacity-100 w-auto' : 'opacity-0 w-0'}`}
      >
        <Image
          src={theme === 'light' ? lightTextLogo : darkTextLogo}
          alt={t('common.msfLogo')}
          priority
          style={{
            maxWidth: '75px',
            height: 'auto',
          }}
        />
      </div>
      <button
        className="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded text-black dark:text-white"
        onClick={toggleChatbar}
        title={
          showChatbar
            ? t('sidebar.collapseSidebar')
            : t('sidebar.expandSidebar')
        }
      >
        <PiSidebarSimple size={22} />
      </button>
    </div>
  );
};

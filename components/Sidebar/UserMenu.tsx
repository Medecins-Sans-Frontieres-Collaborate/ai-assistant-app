import {
  IconChevronDown,
  IconHelp,
  IconLogout,
  IconSettings,
} from '@tabler/icons-react';
import { signOut, useSession } from 'next-auth/react';
import { FC, useEffect, useRef, useState } from 'react';

import Image from 'next/image';
import Link from 'next/link';

interface UserMenuProps {
  showChatbar: boolean;
  onSettingsClick: () => void;
  t: (key: string) => string;
  userPhotoUrl?: string | null;
  isLoadingPhoto?: boolean;
}

/**
 * User menu with avatar, name, settings, and logout
 * Extracted from Sidebar for better organization
 */
export const UserMenu: FC<UserMenuProps> = ({
  showChatbar,
  onSettingsClick,
  t,
  userPhotoUrl,
  isLoadingPhoto = false,
}) => {
  const { data: session } = useSession();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Get user initials for avatar
  const getInitials = (name: string) => {
    const cleanName = name
      .replace(/\(.*?\)/g, '')
      .replace(/[^a-zA-Z\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const names = cleanName.split(' ');
    const firstInitial = names[0] ? names[0][0].toUpperCase() : '';
    const lastInitial =
      names.length > 1 ? names[names.length - 1][0].toUpperCase() : '';
    return firstInitial + lastInitial;
  };

  // Close menu on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        userMenuRef.current &&
        !userMenuRef.current.contains(event.target as Node)
      ) {
        setShowUserMenu(false);
      }
    };

    if (showUserMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () =>
        document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showUserMenu]);

  const handleSettingsClick = () => {
    setShowUserMenu(false);
    onSettingsClick();
  };

  const handleLogout = () => {
    setShowUserMenu(false);
    signOut({ callbackUrl: '/' });
  };

  return (
    <div
      ref={userMenuRef}
      className={`border-t transition-all duration-300 relative ${showChatbar ? 'border-neutral-300 dark:border-neutral-700' : 'border-transparent'}`}
    >
      {/* User button */}
      <button
        className={`flex w-full items-center p-3 text-sm text-neutral-700 transition-all duration-300 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800 ${showChatbar ? 'gap-3' : 'justify-center'}`}
        onClick={() => {
          if (showChatbar) {
            setShowUserMenu(!showUserMenu);
          } else {
            onSettingsClick();
          }
        }}
        title={session?.user?.displayName || t('Settings')}
      >
        {/* Avatar */}
        {isLoadingPhoto ? (
          <div
            className={`rounded-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center shrink-0 animate-pulse transition-all duration-300 ${showChatbar ? 'h-10 w-10' : 'h-8 w-8'}`}
          >
            <div
              className={`border-2 border-gray-400 dark:border-gray-500 border-t-transparent rounded-full animate-spin ${showChatbar ? 'w-5 h-5' : 'w-4 h-4'}`}
            />
          </div>
        ) : userPhotoUrl ? (
          <div
            className={`relative rounded-full shrink-0 transition-all duration-300 ${showChatbar ? 'h-10 w-10' : 'h-8 w-8'}`}
          >
            <Image
              src={userPhotoUrl}
              alt={session?.user?.displayName || 'User'}
              fill
              className="rounded-full object-cover"
            />
          </div>
        ) : session?.user?.displayName ? (
          <div
            className={`rounded-full bg-[#D7211E] flex items-center justify-center text-white font-semibold shrink-0 transition-all duration-300 ${showChatbar ? 'h-10 w-10' : 'h-8 w-8'}`}
            style={{ fontSize: showChatbar ? '16px' : '14px' }}
          >
            {getInitials(session.user.displayName)}
          </div>
        ) : (
          <IconSettings size={18} />
        )}

        {/* Name */}
        <span
          className={`whitespace-nowrap transition-all duration-300 flex-1 text-left truncate ${showChatbar ? 'opacity-100 w-auto' : 'opacity-0 w-0 overflow-hidden'}`}
        >
          {session?.user?.displayName || t('Settings')}
        </span>

        {/* Chevron */}
        {showChatbar && (
          <IconChevronDown
            size={16}
            className={`transition-transform shrink-0 ${showUserMenu ? 'rotate-180' : ''}`}
          />
        )}
      </button>

      {/* Dropdown menu */}
      {showUserMenu && showChatbar && (
        <div className="absolute bottom-full left-0 right-0 mb-1 mx-2 rounded-lg border border-neutral-300 bg-white shadow-lg dark:border-neutral-600 dark:bg-[#212121] overflow-hidden">
          <button
            className="w-full text-left px-4 py-3 text-sm text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800 flex items-center gap-3"
            onClick={handleSettingsClick}
          >
            <IconSettings size={18} className="shrink-0" />
            <span>{t('Settings')}</span>
          </button>
          <Link
            href="/info/help"
            className="w-full text-left px-4 py-3 text-sm text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800 flex items-center gap-3 border-t border-neutral-200 dark:border-neutral-700"
            onClick={() => setShowUserMenu(false)}
          >
            <IconHelp size={18} className="shrink-0" />
            <span>{t('Help Center')}</span>
          </Link>
          <button
            className="w-full text-left px-4 py-3 text-sm text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800 flex items-center gap-3 border-t border-neutral-200 dark:border-neutral-700"
            onClick={handleLogout}
          >
            <IconLogout size={18} className="shrink-0" />
            <span>{t('Logout')}</span>
          </button>
        </div>
      )}
    </div>
  );
};

import { FC, useEffect, useState } from 'react';

import { Session } from 'next-auth';
import { useTranslations } from 'next-intl';
import Image from 'next/image';

import { SignInSignOut } from '../SignInSignOut';

interface AccountSectionProps {
  user?: Session['user'];
  prefetchedProfile?: FullUserProfile | null;
}

interface FullUserProfile {
  id: string;
  displayName: string;
  givenName?: string;
  surname?: string;
  mail?: string;
  jobTitle?: string;
  department?: string;
  companyName?: string;
  photoUrl?: string | null;
}

export const AccountSection: FC<AccountSectionProps> = ({
  user,
  prefetchedProfile,
}) => {
  const t = useTranslations();
  const [fullProfile, setFullProfile] = useState<FullUserProfile | null>(
    prefetchedProfile || null,
  );

  // Use prefetched profile or fetch if not available (fallback)
  useEffect(() => {
    const fetchFullProfile = async () => {
      if (!user || prefetchedProfile) return;

      try {
        const response = await fetch('/api/user/profile');
        if (response.ok) {
          const profile = await response.json();
          setFullProfile(profile);
        }
      } catch (error) {
        console.error('Failed to fetch full profile:', error);
      }
    };

    fetchFullProfile();
  }, [user, prefetchedProfile]);

  // Update local state when prefetched profile becomes available
  useEffect(() => {
    if (prefetchedProfile) {
      setTimeout(() => {
        setFullProfile(prefetchedProfile);
      }, 0);
    }
  }, [prefetchedProfile]);

  return (
    <div className="p-4">
      <h2 className="hidden md:block text-xl font-bold mb-6 text-black dark:text-white">
        {t('Account')}
      </h2>

      <div className="space-y-6">
        {/* User Profile Information */}
        {user && (
          <div className="mt-4 bg-gray-50 dark:bg-gray-800/40 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
            <div className="grid grid-cols-2 gap-2">
              {(user?.displayName || fullProfile?.displayName) && (
                <div className="col-span-2 mb-2">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-full bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center overflow-hidden flex-shrink-0 relative">
                      {fullProfile?.photoUrl ? (
                        <Image
                          src={fullProfile.photoUrl}
                          alt={user?.displayName || 'User'}
                          fill
                          className="rounded-full object-cover"
                        />
                      ) : (
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="h-6 w-6 text-blue-600 dark:text-blue-300"
                          viewBox="0 0 20 20"
                          fill="currentColor"
                        >
                          <path
                            fillRule="evenodd"
                            d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"
                            clipRule="evenodd"
                          />
                        </svg>
                      )}
                    </div>
                    <div className="text-sm font-medium text-black dark:text-white">
                      {user?.displayName || fullProfile?.displayName}
                    </div>
                  </div>
                </div>
              )}
              {fullProfile?.jobTitle && (
                <div className="col-span-2 sm:col-span-1 mt-2">
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {t('Job Title')}
                  </div>
                  <div className="text-sm font-medium text-black dark:text-white">
                    {fullProfile.jobTitle}
                  </div>
                </div>
              )}
              {fullProfile?.department && (
                <div className="col-span-2 sm:col-span-1 mt-2">
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {t('Department')}
                  </div>
                  <div className="text-sm font-medium text-black dark:text-white">
                    {fullProfile.department}
                  </div>
                </div>
              )}
              {(user?.mail || fullProfile?.mail) && (
                <div className="col-span-2 mt-2">
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {t('Email')}
                  </div>
                  <div className="text-sm font-medium text-black dark:text-white">
                    {user?.mail || fullProfile?.mail}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Sign In/Sign Out */}
        <div>
          <h3 className="text-sm font-bold mb-3 text-black dark:text-neutral-200">
            {t('Authentication')}
          </h3>
          <SignInSignOut />
        </div>
      </div>
    </div>
  );
};

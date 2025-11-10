/**
 * Privacy Policy Section
 *
 * Links to the help page where users can view the full privacy policy
 */
import {
  IconExternalLink,
  IconFileText,
  IconShield,
} from '@tabler/icons-react';
import React from 'react';

import { useTranslations } from 'next-intl';
import Link from 'next/link';

/**
 * Component props
 */
interface PrivacyControlSectionProps {
  onClose: () => void;
}

/**
 * Privacy Control Section component
 */
export const PrivacyControlSection: React.FC<PrivacyControlSectionProps> = ({
  onClose,
}) => {
  const t = useTranslations();

  return (
    <div className="p-4">
      <h2 className="hidden md:block text-xl font-bold mb-6 text-black dark:text-white">
        {t('Privacy & Data')}
      </h2>

      <div className="space-y-4">
        {/* Privacy Policy Link */}
        <Link
          href="/info/help"
          className="flex items-start gap-4 p-4 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800 hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors"
        >
          <IconShield
            size={24}
            className="text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                Privacy Policy & Data Protection
              </h3>
              <IconExternalLink
                size={14}
                className="text-gray-500 dark:text-gray-400"
              />
            </div>
            <p className="text-xs text-gray-600 dark:text-gray-400">
              Learn how your data is protected and what information should not
              be entered
            </p>
          </div>
        </Link>

        {/* Terms of Use Link */}
        <Link
          href="/info/help"
          className="flex items-start gap-4 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors"
        >
          <IconFileText
            size={24}
            className="text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                Terms of Use
              </h3>
              <IconExternalLink
                size={14}
                className="text-gray-500 dark:text-gray-400"
              />
            </div>
            <p className="text-xs text-gray-600 dark:text-gray-400">
              Review responsible use guidelines and prohibited uses
            </p>
          </div>
        </Link>

        {/* Key Privacy Highlights */}
        <div className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
            Key Privacy Points
          </h3>
          <ul className="space-y-2 text-xs text-gray-700 dark:text-gray-300">
            <li className="flex items-start gap-2">
              <span className="text-green-600 dark:text-green-400 mt-0.5">
                ✓
              </span>
              <span>Your conversations are stored locally on your device</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-600 dark:text-green-400 mt-0.5">
                ✓
              </span>
              <span>
                All data processing happens within MSF systems using Azure
                infrastructure
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-red-600 dark:text-red-400 mt-0.5">✗</span>
              <span>
                Do not enter personal data (names, phone numbers, etc.)
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-red-600 dark:text-red-400 mt-0.5">✗</span>
              <span>Do not enter highly sensitive operational details</span>
            </li>
          </ul>
        </div>

        {/* Contact for Privacy Concerns */}
        <div className="p-4 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">
            Privacy Concerns or Incidents?
          </h3>
          <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
            Contact us immediately if you have privacy concerns:
          </p>
          <a
            href="mailto:ai.team@amsterdam.msf.org"
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline font-medium"
          >
            ai.team@amsterdam.msf.org
          </a>
        </div>
      </div>
    </div>
  );
};

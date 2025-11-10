'use client';

import {
  IconBrandAndroid,
  IconBrandApple,
  IconCheck,
  IconDeviceMobile,
  IconExternalLink,
} from '@tabler/icons-react';
import { QRCodeSVG } from 'qrcode.react';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

export const MobileAppSection: FC = () => {
  const t = useTranslations();
  // Get the current origin dynamically, fallback to production URL for SSR
  const installUrl =
    typeof window !== 'undefined'
      ? window.location.origin
      : 'https://ai.msf.org';

  return (
    <div className="p-4">
      {/* Header */}
      <div className="flex items-center gap-2 mb-6">
        <IconDeviceMobile size={24} className="text-black dark:text-white" />
        <h2 className="text-xl font-bold text-black dark:text-white">
          {t('settings.Mobile App')}
        </h2>
      </div>

      <div className="space-y-6">
        {/* QR Code Section */}
        <div className="flex flex-col items-center p-6 bg-gray-50 dark:bg-[#212121] rounded-lg border border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-semibold mb-4 text-black dark:text-white">
            {t('settings.Scan to Install')}
          </h3>
          <div className="bg-white p-4 rounded-lg">
            <QRCodeSVG value={installUrl} size={200} level="H" />
          </div>
          <p className="mt-4 text-sm text-gray-600 dark:text-gray-400 text-center">
            {t(
              'settings.Scan this QR code with your mobile device to start the install process',
            )}
          </p>
        </div>

        {/* Benefits Section */}
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 border border-blue-200 dark:border-blue-800">
          <h3 className="text-sm font-bold mb-3 text-black dark:text-white">
            {t('settings.Why Install?')}
          </h3>
          <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-300">
            <li className="flex items-start">
              <IconCheck
                className="mr-2 mt-0.5 text-blue-600 dark:text-blue-400 shrink-0"
                size={16}
              />
              <span>
                {t('settings.Access the app directly from your home screen')}
              </span>
            </li>
            <li className="flex items-start">
              <IconCheck
                className="mr-2 mt-0.5 text-blue-600 dark:text-blue-400 shrink-0"
                size={16}
              />
              <span>
                {t('settings.Works offline with cached conversations')}
              </span>
            </li>
            <li className="flex items-start">
              <IconCheck
                className="mr-2 mt-0.5 text-blue-600 dark:text-blue-400 shrink-0"
                size={16}
              />
              <span>{t('settings.Faster loading and better performance')}</span>
            </li>
            <li className="flex items-start">
              <IconCheck
                className="mr-2 mt-0.5 text-blue-600 dark:text-blue-400 shrink-0"
                size={16}
              />
              <span>{t('settings.Native app-like experience')}</span>
            </li>
          </ul>
        </div>

        {/* iOS Instructions */}
        <div className="bg-white dark:bg-[#212121] rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center mb-3">
            <IconBrandApple
              className="mr-2 text-gray-700 dark:text-gray-300"
              size={24}
            />
            <h3 className="text-sm font-bold text-black dark:text-white">
              {t('settings.iOS (iPhone/iPad)')}
            </h3>
          </div>
          <div className="mb-3 p-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-md">
            <p className="text-xs text-amber-800 dark:text-amber-200 font-semibold">
              {t('settings.PWA Safari Warning')}
            </p>
          </div>
          <div className="mb-3 p-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
            <p className="text-xs text-blue-800 dark:text-blue-200 font-semibold">
              {t('settings.PWA Install Tip')}
            </p>
          </div>
          <ol className="space-y-2 text-sm text-gray-700 dark:text-gray-300 list-decimal list-inside">
            <li>
              <strong>{t('settings.Open this page in Safari')}</strong>{' '}
              {t('settings.(not Chrome or other browsers)')}
            </li>
            <li>
              {t('settings.Tap the')} <strong>{t('settings.Share')}</strong>{' '}
              {t('settings.button (square with arrow)')}
            </li>
            <li>
              {t('settings.Scroll down and tap')}{' '}
              <strong>{t('settings.Add to Home Screen')}</strong>
            </li>
            <li>
              {t('settings.Tap')} <strong>{t('settings.Add')}</strong>{' '}
              {t('settings.to confirm')}
            </li>
          </ol>
        </div>

        {/* Android Instructions */}
        <div className="bg-white dark:bg-[#212121] rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center mb-3">
            <IconBrandAndroid
              className="mr-2 text-gray-700 dark:text-gray-300"
              size={24}
            />
            <h3 className="text-sm font-bold text-black dark:text-white">
              {t('settings.Android')}
            </h3>
          </div>
          <div className="mb-3 p-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
            <p className="text-xs text-blue-800 dark:text-blue-200 font-semibold">
              {t('settings.PWA Install Tip')}
            </p>
          </div>
          <ol className="space-y-2 text-sm text-gray-700 dark:text-gray-300 list-decimal list-inside">
            <li>{t('settings.Open this page in Chrome')}</li>
            <li>
              {t('settings.Tap the')} <strong>{t('settings.Menu')}</strong>{' '}
              {t('settings.(three dots)')}
            </li>
            <li>
              {t('settings.Tap')} <strong>{t('settings.Install app')}</strong>{' '}
              {t('settings.or')}{' '}
              <strong>{t('settings.Add to Home screen')}</strong>
            </li>
            <li>
              {t('settings.Tap')} <strong>{t('settings.Install')}</strong>{' '}
              {t('settings.to confirm')}
            </li>
          </ol>
        </div>

        {/* Note & PWA Info Link */}
        <div className="space-y-2">
          <div className="text-xs text-gray-500 dark:text-gray-400 italic">
            {t('settings.PWA Note')}
          </div>
          <a
            href="https://web.dev/what-are-pwas/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
          >
            <IconExternalLink size={14} className="mr-1" />
            {t('settings.Learn more about Progressive Web Apps')}
          </a>
        </div>
      </div>
    </div>
  );
};

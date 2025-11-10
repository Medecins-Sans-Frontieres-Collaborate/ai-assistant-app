'use client';

import { IconArrowLeft, IconHome } from '@tabler/icons-react';

import Image from 'next/image';
import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex h-screen w-full items-center justify-center bg-white dark:bg-[#212121] p-4">
      <div className="relative rounded-xl bg-white dark:bg-[#171717] p-8 shadow-xl border border-gray-200 dark:border-gray-700 w-full max-w-xl">
        {/* Dog Image */}
        <div className="flex justify-center mb-6">
          <div className="relative w-32 h-32">
            <Image
              src="/dog-404.png"
              alt="Lost dog"
              fill
              className="object-contain"
              priority
            />
          </div>
        </div>

        {/* Title */}
        <div className="text-center mb-8">
          <h1 className="text-6xl font-bold text-gray-900 dark:text-white mb-3">
            404
          </h1>
          <h2 className="text-2xl font-semibold text-gray-700 dark:text-gray-300 mb-3">
            Oops! Page Not Found
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Looks like this page got lost. Cooper will guide you back.
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row gap-3">
          <button
            onClick={() => window.history.back()}
            className="flex-1 rounded-lg bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 px-4 py-3 text-gray-700 dark:text-gray-300 text-sm font-medium transition-colors flex items-center justify-center gap-2 group border border-gray-200 dark:border-gray-700"
          >
            <IconArrowLeft
              size={18}
              className="group-hover:-translate-x-1 transition-transform duration-200"
            />
            Go Back
          </button>

          <Link
            href="/"
            className="flex-1 rounded-lg bg-blue-600 hover:bg-blue-700 px-4 py-3 text-white text-sm font-medium transition-colors flex items-center justify-center gap-2 group"
          >
            <IconHome
              size={18}
              className="group-hover:scale-110 transition-transform duration-200"
            />
            Go Home
          </Link>
        </div>
      </div>
    </div>
  );
}

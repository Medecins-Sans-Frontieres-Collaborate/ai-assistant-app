'use client';

import React from 'react';

import { useTranslations } from 'next-intl';

const BetaBadge = () => {
  const t = useTranslations('common');
  return (
    <span className="items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
      {t('beta')}
    </span>
  );
};

export default BetaBadge;

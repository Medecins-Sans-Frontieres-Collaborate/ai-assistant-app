import React, { FC } from 'react';

import { useTranslations } from 'next-intl';

import { DEFAULT_TEMPERATURE } from '@/lib/utils/app/const';

interface Props {
  temperature: number;
  onChangeTemperature: (temperature: number) => void;
}

export const TemperatureSlider: FC<Props> = ({
  temperature,
  onChangeTemperature,
}) => {
  const t = useTranslations();
  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = parseFloat(event.target.value);
    onChangeTemperature(newValue);
  };

  return (
    <div className="flex flex-col mt-5">
      <span className="text-[12px] text-black/50 dark:text-white/50 text-sm">
        {t('temperatureDescription')}
      </span>
      <span className="mt-2 mb-1 text-center text-neutral-900 dark:text-neutral-100">
        {temperature.toFixed(1)}
      </span>
      <input
        className="cursor-pointer accent-[#D7211E]"
        type="range"
        min={0}
        max={1}
        step={0.1}
        value={temperature}
        onChange={handleChange}
      />
      <ul className="mt-2 pb-8 flex justify-between px-[5px] text-neutral-900 dark:text-neutral-100">
        <li className="flex justify-start w-1/3">
          <span>{t('Precise')}</span>
        </li>
        <li className="flex justify-center w-1/3">
          <span>{t('Neutral')}</span>
        </li>
        <li className="flex justify-end w-1/3">
          <span>{t('Creative')}</span>
        </li>
      </ul>
    </div>
  );
};

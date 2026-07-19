'use client';

import { IconDeviceDesktop, IconRefresh } from '@tabler/icons-react';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { useLocalRuntimeModels } from '@/client/hooks/useLocalRuntimeModels';

import {
  LOCAL_RUNTIMES,
  LOCAL_RUNTIME_DEFAULTS,
  LocalRuntime,
  LocalRuntimeStatus,
  isValidPort,
} from '@/types/localRuntime';

import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * "Local models" settings section: detect local runtimes, see why one isn't
 * usable, and adjust its port.
 *
 * This is the ONLY place detection is triggered. Probing loopback raises
 * Chrome's Local Network Access permission prompt, and a prompt the user
 * didn't ask for invites a reflexive "Block" that is sticky and awkward to
 * reverse — so it happens here, right after an explicit click, and nowhere
 * else. The chat picker only reads the cached result.
 *
 * Visibility is gated by the LaunchDarkly `localModels` flag in
 * SettingsSidebar.
 */
export const LocalModelsSection: FC = () => {
  const t = useTranslations('localModels');

  const ports = useSettingsStore((s) => s.localRuntimePorts);
  const setLocalRuntimePort = useSettingsStore((s) => s.setLocalRuntimePort);
  const { statusByRuntime, detecting, detect } = useLocalRuntimeModels();

  const statusLine = (
    runtime: LocalRuntime,
    status: LocalRuntimeStatus | undefined,
  ): { text: string; tone: 'ok' | 'warn' | 'muted' } => {
    const label = LOCAL_RUNTIME_DEFAULTS[runtime].label;
    switch (status?.state) {
      case 'ready':
        return {
          text: t('statusReady', { count: status.models.length }),
          tone: 'ok',
        };
      case 'checking':
        return { text: t('statusChecking'), tone: 'muted' };
      case 'error':
        switch (status.reason) {
          case 'cors_blocked':
            // Per-runtime copy: the fix differs for each (env var, a settings
            // toggle, a server flag), so a generic message would be useless.
            return { text: t(`corsHelp.${runtime}`), tone: 'warn' };
          case 'not_running':
            return { text: t('statusNotRunning', { label }), tone: 'muted' };
          default:
            return { text: t('statusHttpError', { label }), tone: 'warn' };
        }
      default:
        return { text: t('statusUnknown'), tone: 'muted' };
    }
  };

  return (
    <div className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <IconDeviceDesktop size={24} className="text-black dark:text-white" />
        <h2 className="text-xl font-bold text-black dark:text-white">
          {t('title')}
        </h2>
      </div>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        {t('description')}
      </p>

      <button
        type="button"
        onClick={() => void detect()}
        disabled={detecting}
        className="mb-6 flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm text-black hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:text-white dark:hover:bg-gray-800"
      >
        <IconRefresh size={16} className={detecting ? 'animate-spin' : ''} />
        {detecting ? t('detecting') : t('detect')}
      </button>

      <ul className="flex flex-col gap-4">
        {LOCAL_RUNTIMES.map((runtime) => {
          const definition = LOCAL_RUNTIME_DEFAULTS[runtime];
          const status = statusByRuntime[runtime];
          const { text, tone } = statusLine(runtime, status);
          const port = ports[runtime] ?? definition.defaultPort;

          return (
            <li
              key={runtime}
              className="rounded-lg border border-gray-300 p-3 dark:border-gray-700"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-sm font-medium text-black dark:text-white">
                    {definition.label}
                  </span>
                  {definition.experimental && (
                    <span className="ml-2 rounded bg-gray-200 px-1.5 py-0.5 text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-300">
                      {t('experimental')}
                    </span>
                  )}
                </div>

                <label className="flex shrink-0 items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                  {t('portLabel')}
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      // An out-of-range entry clears the override rather than
                      // being stored — the store would reject it anyway, and
                      // falling back to the default is the useful behavior.
                      setLocalRuntimePort(
                        runtime,
                        isValidPort(next) ? next : undefined,
                      );
                    }}
                    className="w-20 rounded border border-gray-300 bg-transparent px-2 py-1 text-black dark:border-gray-600 dark:text-white"
                  />
                </label>
              </div>

              <p
                className={
                  'mt-2 text-xs ' +
                  (tone === 'ok'
                    ? 'text-green-700 dark:text-green-400'
                    : tone === 'warn'
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-gray-500 dark:text-gray-400')
                }
              >
                {text}
              </p>
            </li>
          );
        })}
      </ul>

      <p className="mt-6 text-xs text-gray-500 dark:text-gray-400">
        {t('privacyNote')}
      </p>
    </div>
  );
};

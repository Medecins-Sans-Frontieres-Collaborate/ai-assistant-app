'use client';

import { FC, useId } from 'react';

import { useTranslations } from 'next-intl';

interface OwnOauthAppFieldsProps {
  /** Provider display name for the hint copy. */
  providerName: string;
  clientId: string;
  clientSecret: string;
  onClientIdChange: (value: string) => void;
  onClientSecretChange: (value: string) => void;
}

/**
 * "Bring your own OAuth app" inputs: users register an app in THEIR provider
 * account (their org/workspace/enterprise instance) with the callback URL
 * shown here, then paste its credentials. Both values follow the same
 * on-device posture as PATs (memory + encrypted credential vault; redacted
 * from the persisted settings blob); the secret is relayed per request and
 * never persisted server-side.
 */
export const OwnOauthAppFields: FC<OwnOauthAppFieldsProps> = ({
  providerName,
  clientId,
  clientSecret,
  onClientIdChange,
  onClientSecretChange,
}) => {
  const t = useTranslations('connectors');
  // One row per connector renders these, so ids must be instance-scoped.
  const fieldId = useId();
  const redirectUri =
    typeof window !== 'undefined'
      ? `${window.location.origin}/mcp-oauth-callback`
      : '/mcp-oauth-callback';

  const inputClass =
    'w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 focus:border-blue-500 focus:outline-none';

  return (
    <div className="space-y-2 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t('ownAppHint', { name: providerName })}
      </p>
      <div>
        <label
          htmlFor={`${fieldId}-redirect`}
          className="mb-0.5 block text-xs font-medium text-gray-900 dark:text-white"
        >
          {t('redirectUriLabel')}
        </label>
        <input
          id={`${fieldId}-redirect`}
          type="text"
          readOnly
          value={redirectUri}
          onFocus={(e) => e.target.select()}
          className={`${inputClass} font-mono text-xs`}
        />
      </div>
      <div>
        <label
          htmlFor={`${fieldId}-client-id`}
          className="mb-0.5 block text-xs font-medium text-gray-900 dark:text-white"
        >
          {t('clientIdLabel')}
        </label>
        <input
          id={`${fieldId}-client-id`}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={clientId}
          onChange={(e) => onClientIdChange(e.target.value)}
          className={inputClass}
        />
      </div>
      <div>
        <label
          htmlFor={`${fieldId}-client-secret`}
          className="mb-0.5 block text-xs font-medium text-gray-900 dark:text-white"
        >
          {t('clientSecretLabel')}
        </label>
        <input
          id={`${fieldId}-client-secret`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={clientSecret}
          onChange={(e) => onClientSecretChange(e.target.value)}
          className={inputClass}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('localOnlyNote')}
        </p>
      </div>
    </div>
  );
};

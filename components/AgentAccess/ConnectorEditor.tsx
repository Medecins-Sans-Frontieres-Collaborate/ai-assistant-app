'use client';

import { FC, useId, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { AdminStoredConnector } from './types';

import { MCP_CONNECTOR_PRESETS } from '@/config/mcpConnectorPresets';

interface ConnectorEditorProps {
  /** null = create (POST); otherwise edit (PUT with If-Match). */
  existing: AdminStoredConnector | null;
  /**
   * False when the deployment cannot seal client secrets. The oauth style is
   * then disabled with an explanation — the server would reject it with 503,
   * so offering it would only produce a confusing failure.
   */
  secretSealingAvailable: boolean;
  onSaved: () => void;
  onCancel: () => void;
  /** 409 conflict acknowledged — parent refetches and closes. */
  onConflictReload: () => void;
}

type AuthStyle = 'none' | 'bearer' | 'oauth';

/**
 * Inline create/edit card for one admin-authored MCP connector. Follows the
 * RuleEditor/PromptAgentEditor idiom: bordered card, Cancel/Save footer,
 * 409 → conflict banner + reload, remounted by the parent on etag change.
 *
 * The client secret is write-only by construction: the server never sends it
 * back (only `hasClientSecret`), so an empty field on edit means "keep what
 * is stored" rather than "clear it". That is stated in the UI, because a
 * blank password box otherwise reads as "there is nothing set".
 */
export const ConnectorEditor: FC<ConnectorEditorProps> = ({
  existing,
  secretSealingAvailable,
  onSaved,
  onCancel,
  onConflictReload,
}) => {
  const t = useTranslations('agentAccess');

  const [name, setName] = useState(existing?.connector.name ?? '');
  const [description, setDescription] = useState(
    existing?.connector.description ?? '',
  );
  const [url, setUrl] = useState(existing?.connector.url ?? '');
  const [transport, setTransport] = useState<'streamable-http' | 'sse'>(
    existing?.connector.transport ?? 'streamable-http',
  );
  const [authStyle, setAuthStyle] = useState<AuthStyle>(
    existing?.connector.authStyle ?? 'bearer',
  );
  const [tokenHelpUrl, setTokenHelpUrl] = useState(
    existing?.connector.tokenHelpUrl ?? '',
  );
  const [oauthClientId, setOauthClientId] = useState(
    existing?.connector.oauthClientId ?? '',
  );
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [scopes, setScopes] = useState(
    (existing?.connector.oauthScopes ?? []).join(' '),
  );
  const [setupHint, setSetupHint] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isConflict, setIsConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const baseId = useId();

  const hasStoredSecret = existing?.connector.hasClientSecret ?? false;

  const applyPreset = (key: string) => {
    const preset = MCP_CONNECTOR_PRESETS.find((p) => p.key === key);
    if (!preset) return;
    // Prefill only — the admin still replaces the {placeholder}, and the
    // server re-validates the final URL.
    setName((current) => current || preset.label);
    setDescription((current) => current || preset.description);
    setUrl(preset.urlTemplate);
    setTransport(preset.transport);
    setAuthStyle(
      preset.authStyle === 'oauth' && !secretSealingAvailable
        ? 'bearer'
        : preset.authStyle,
    );
    setTokenHelpUrl(preset.tokenHelpUrl ?? '');
    setSetupHint(preset.setupHint);
  };

  const urlStillTemplated = /\{[^}]+\}/.test(url);
  const canSave =
    name.trim().length > 0 &&
    url.trim().length > 0 &&
    !urlStillTemplated &&
    (authStyle !== 'oauth' ||
      (oauthClientId.trim().length > 0 &&
        // On create the secret is mandatory; on edit an empty box keeps the
        // stored one, so it is only mandatory when none is stored yet.
        (oauthClientSecret.trim().length > 0 || hasStoredSecret)));

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      const isOauth = authStyle === 'oauth';
      const response = await fetch('/api/agent-access/connectors', {
        method: existing ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(existing ? { 'If-Match': existing.etag } : {}),
        },
        body: JSON.stringify({
          ...(existing ? { id: existing.connector.id } : {}),
          name: name.trim(),
          description: description.trim(),
          url: url.trim(),
          transport,
          authStyle,
          ...(tokenHelpUrl.trim() ? { tokenHelpUrl: tokenHelpUrl.trim() } : {}),
          ...(isOauth ? { oauthClientId: oauthClientId.trim() } : {}),
          // Omit entirely when blank so the server keeps the stored secret.
          ...(isOauth && oauthClientSecret.trim()
            ? { oauthClientSecret: oauthClientSecret.trim() }
            : {}),
          ...(isOauth
            ? { oauthScopes: scopes.split(/\s+/).filter(Boolean) }
            : {}),
        }),
      });
      if (response.status === 409) {
        setIsConflict(true);
        return;
      }
      // Update-path 404: deleted while this editor was open. A PUT can never
      // mint a new record, so retrying is a dead end — route it to the
      // conflict banner whose Reload drops the stale row.
      if (existing && response.status === 404) {
        setIsConflict(true);
        return;
      }
      if (!response.ok) {
        // The server's message is the actionable part here (rejected URL
        // shape, missing client id, sealing unavailable) — show it verbatim
        // rather than a generic retry prompt.
        const body = (await response.json().catch(() => ({}))) as {
          error?: unknown;
        };
        setSaveError(
          typeof body.error === 'string' ? body.error : t('saveError'),
        );
        return;
      }
      toast.success(
        t(existing ? 'connectorSaveSuccess' : 'connectorCreateSuccess'),
      );
      onSaved();
    } catch {
      setSaveError(t('saveError'));
    } finally {
      setIsSaving(false);
    }
  };

  const inputClass =
    'w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-black dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500';
  const labelClass =
    'mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300';

  if (isConflict) {
    return (
      <div className="mt-2 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-300">
        <p>{t('conflictError')}</p>
        <button
          type="button"
          className="mt-2 rounded-md bg-amber-600 px-3 py-1 text-sm font-medium text-white hover:bg-amber-700"
          onClick={onConflictReload}
        >
          {t('reload')}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-4">
      <p className="mb-3 text-sm font-semibold text-black dark:text-white">
        {existing ? t('editConnectorTitle') : t('newConnectorTitle')}
      </p>

      <div className="space-y-4">
        {!existing && (
          <div>
            <label className={labelClass} htmlFor={`${baseId}-preset`}>
              {t('connectorPresetLabel')}
            </label>
            <select
              id={`${baseId}-preset`}
              className={inputClass}
              defaultValue=""
              onChange={(e) => applyPreset(e.target.value)}
            >
              <option value="">{t('connectorPresetNone')}</option>
              {MCP_CONNECTOR_PRESETS.map((preset) => (
                <option key={preset.key} value={preset.key}>
                  {preset.label}
                </option>
              ))}
            </select>
            {setupHint && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {setupHint}
              </p>
            )}
          </div>
        )}

        <div>
          <label className={labelClass} htmlFor={`${baseId}-name`}>
            {t('connectorNameLabel')}
          </label>
          <input
            id={`${baseId}-name`}
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <label className={labelClass} htmlFor={`${baseId}-description`}>
            {t('connectorDescriptionLabel')}
          </label>
          <input
            id={`${baseId}-description`}
            className={inputClass}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div>
          <label className={labelClass} htmlFor={`${baseId}-url`}>
            {t('connectorUrlLabel')}
          </label>
          <input
            id={`${baseId}-url`}
            className={inputClass}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
          />
          {urlStillTemplated && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              {t('connectorUrlPlaceholderWarning')}
            </p>
          )}
        </div>

        <div className="flex gap-4">
          <div className="flex-1">
            <label className={labelClass} htmlFor={`${baseId}-transport`}>
              {t('connectorTransportLabel')}
            </label>
            <select
              id={`${baseId}-transport`}
              className={inputClass}
              value={transport}
              onChange={(e) =>
                setTransport(e.target.value as 'streamable-http' | 'sse')
              }
            >
              <option value="streamable-http">HTTP</option>
              <option value="sse">SSE</option>
            </select>
          </div>
          <div className="flex-1">
            <label className={labelClass} htmlFor={`${baseId}-auth`}>
              {t('connectorAuthLabel')}
            </label>
            <select
              id={`${baseId}-auth`}
              className={inputClass}
              value={authStyle}
              onChange={(e) => setAuthStyle(e.target.value as AuthStyle)}
            >
              <option value="none">{t('connectorAuthNone')}</option>
              <option value="bearer">{t('connectorAuthBearer')}</option>
              <option value="oauth" disabled={!secretSealingAvailable}>
                {t('connectorAuthOauth')}
              </option>
            </select>
            {!secretSealingAvailable && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                {t('connectorSealingUnavailable')}
              </p>
            )}
          </div>
        </div>

        {authStyle === 'bearer' && (
          <div>
            <label className={labelClass} htmlFor={`${baseId}-tokenHelp`}>
              {t('connectorTokenHelpLabel')}
            </label>
            <input
              id={`${baseId}-tokenHelp`}
              className={inputClass}
              value={tokenHelpUrl}
              onChange={(e) => setTokenHelpUrl(e.target.value)}
              spellCheck={false}
            />
          </div>
        )}

        {authStyle === 'oauth' && (
          <>
            <div>
              <label className={labelClass} htmlFor={`${baseId}-clientId`}>
                {t('connectorClientIdLabel')}
              </label>
              <input
                id={`${baseId}-clientId`}
                className={inputClass}
                value={oauthClientId}
                onChange={(e) => setOauthClientId(e.target.value)}
                spellCheck={false}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor={`${baseId}-clientSecret`}>
                {t('connectorClientSecretLabel')}
              </label>
              <input
                id={`${baseId}-clientSecret`}
                type="password"
                autoComplete="off"
                className={inputClass}
                value={oauthClientSecret}
                onChange={(e) => setOauthClientSecret(e.target.value)}
                spellCheck={false}
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {hasStoredSecret
                  ? t('connectorClientSecretStored')
                  : t('connectorClientSecretHint')}
              </p>
            </div>
            <div>
              <label className={labelClass} htmlFor={`${baseId}-scopes`}>
                {t('connectorScopesLabel')}
              </label>
              <input
                id={`${baseId}-scopes`}
                className={inputClass}
                value={scopes}
                onChange={(e) => setScopes(e.target.value)}
                spellCheck={false}
              />
            </div>
          </>
        )}
      </div>

      {saveError && (
        <p className="mt-3 text-xs text-red-600 dark:text-red-400">
          {saveError}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          className="rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          onClick={handleSave}
          disabled={!canSave || isSaving}
        >
          {t('save')}
        </button>
        <button
          type="button"
          className="rounded-md px-3 py-1 text-sm text-gray-700 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
          onClick={onCancel}
          disabled={isSaving}
        >
          {t('cancel')}
        </button>
      </div>
    </div>
  );
};

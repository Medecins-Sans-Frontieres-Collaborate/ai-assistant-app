'use client';

import { IconAlertCircle, IconCheck, IconX } from '@tabler/icons-react';
import { FC, useState } from 'react';
import { createPortal } from 'react-dom';

import { useTranslations } from 'next-intl';

import { connectMcpOauth } from '@/client/services/mcp/mcpOauth';

import { OwnOauthAppFields } from './OwnOauthAppFields';
import { validateMcpServer } from './validateMcpServer';

import { McpAuthMode, McpServerConfig } from '@/client/stores/settingsStore';

interface McpServerFormProps {
  onSave: (server: McpServerConfig) => void;
  onClose: () => void;
  /** Present ⇒ edit mode (id/createdAt/token preserved unless replaced). */
  existingServer?: McpServerConfig;
}

/**
 * Add/edit modal for ARBITRARY MCP servers (curated connectors use the
 * inline row instead — one field doesn't need a modal). Mirrors
 * AgentSourceForm: portal, per-field errors, validate-on-submit against
 * POST /api/mcp/tools. In edit mode the existing token is never echoed;
 * leaving the field blank keeps it.
 */
export const McpServerForm: FC<McpServerFormProps> = ({
  onSave,
  onClose,
  existingServer,
}) => {
  const t = useTranslations('connectors');
  const tCommon = useTranslations('common');

  const [name, setName] = useState(existingServer?.name ?? '');
  const [url, setUrl] = useState(existingServer?.url ?? '');
  const [authMode, setAuthMode] = useState<Exclude<McpAuthMode, 'header'>>(
    existingServer?.authMode === 'oauth'
      ? 'oauth'
      : existingServer?.authToken
        ? 'bearer'
        : 'none',
  );
  const [token, setToken] = useState('');
  // Optional user-supplied OAuth app (oauth mode). Blank = try dynamic
  // client registration against the server's published metadata.
  const [ownClientId, setOwnClientId] = useState(
    existingServer?.oauthApp?.clientId ?? '',
  );
  const [ownClientSecret, setOwnClientSecret] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{
    name?: string;
    url?: string;
  }>({});
  const [error, setError] = useState<string | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [toolCount, setToolCount] = useState<number | null>(null);

  const validateFields = () => {
    const errors: { name?: string; url?: string } = {};
    if (!name.trim()) errors.name = t('nameRequired');
    if (!url.trim()) {
      errors.url = t('urlRequired');
    } else {
      try {
        const parsed = new URL(url.trim());
        if (parsed.protocol !== 'https:') errors.url = t('invalidUrl');
      } catch {
        errors.url = t('invalidUrl');
      }
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validateFields()) return;

    const serverId = existingServer?.id ?? globalThis.crypto.randomUUID();
    const base = {
      id: serverId,
      name: name.trim(),
      url: url.trim(),
      enabled: existingServer?.enabled ?? true,
      createdAt: existingServer?.createdAt ?? new Date().toISOString(),
    };

    setIsValidating(true);
    setError(null);
    setToolCount(null);

    // OAuth custom servers: run the popup flow first (discovery + DCR go
    // through the same env-gated, SSRF-guarded proxy as catalog servers),
    // then validate with the fresh access token.
    if (authMode === 'oauth') {
      // Own-app precedence mirrors CuratedConnectorRow: entered app →
      // saved app → prior client → fresh DCR.
      const ownApp = ownClientId.trim()
        ? {
            clientId: ownClientId.trim(),
            ...(ownClientSecret.trim()
              ? { clientSecret: ownClientSecret.trim() }
              : {}),
          }
        : existingServer?.oauthApp;
      try {
        const oauth = await connectMcpOauth(
          { id: serverId, name: base.name, url: base.url },
          ownApp?.clientId ?? existingServer?.oauth?.clientId,
          ownApp?.clientSecret ?? existingServer?.oauth?.clientSecret,
        );
        const result = await validateMcpServer({
          id: serverId,
          name: base.name,
          url: base.url,
          authToken: oauth.accessToken,
        });
        setIsValidating(false);
        if (!result.ok) {
          setError(t('validationFailed'));
          return;
        }
        setToolCount(result.toolCount);
        onSave({ ...base, authMode: 'oauth', oauth, oauthApp: ownApp });
      } catch (flowError) {
        setIsValidating(false);
        const kind =
          flowError instanceof Error ? flowError.message : 'oauth_failed';
        setError(
          kind === 'oauth_denied'
            ? t('oauthDenied')
            : kind === 'oauth_timeout'
              ? t('oauthTimeout')
              : kind === 'oauth_cancelled'
                ? t('oauthCancelled')
                : kind === 'oauth_unavailable'
                  ? t('oauthUnavailable')
                  : t('oauthFailed'),
        );
      }
      return;
    }

    const effectiveToken =
      authMode === 'none'
        ? undefined
        : token.trim() || existingServer?.authToken || undefined;

    const result = await validateMcpServer({
      id: serverId,
      name: base.name,
      url: base.url,
      ...(effectiveToken ? { authToken: effectiveToken } : {}),
    });
    setIsValidating(false);

    if (!result.ok) {
      setError(
        result.errorKind === 'auth' ? t('authFailed') : t('validationFailed'),
      );
      return;
    }
    setToolCount(result.toolCount);

    onSave({
      ...base,
      authMode: effectiveToken ? 'bearer' : 'none',
      authToken: effectiveToken,
    });
  };

  // No SSR-mount guard needed: this modal only renders after a user click,
  // so document is always available for the portal.
  const fieldBorder = (hasError?: string) =>
    hasError
      ? 'border-red-400 dark:border-red-500'
      : 'border-gray-200 dark:border-gray-700';
  const inputClass = (hasError?: string) =>
    `w-full rounded-lg border ${fieldBorder(hasError)} bg-gray-50 dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:outline-none`;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="relative mx-4 w-full max-w-lg rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-6 shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            {existingServer ? t('editServer') : t('addServer')}
          </h3>
          <button
            onClick={onClose}
            aria-label={tCommon('close')}
            className="rounded-lg p-1 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <IconX size={20} />
          </button>
        </div>
        <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">
          {t('arbitraryWarning')}
        </p>

        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-400">
            <IconAlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {toolCount !== null && (
          <div className="mb-4 flex items-start gap-2 rounded-lg bg-green-50 dark:bg-green-900/20 p-3 text-sm text-green-700 dark:text-green-400">
            <IconCheck size={16} className="mt-0.5 shrink-0" />
            <span>{t('toolCount', { count: toolCount })}</span>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">
              {t('serverName')} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setFieldErrors((prev) => ({ ...prev, name: undefined }));
              }}
              placeholder={t('namePlaceholder')}
              className={inputClass(fieldErrors.name)}
            />
            {fieldErrors.name && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                {fieldErrors.name}
              </p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">
              {t('serverUrl')} <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setFieldErrors((prev) => ({ ...prev, url: undefined }));
              }}
              placeholder={t('urlPlaceholder')}
              className={inputClass(fieldErrors.url)}
            />
            {fieldErrors.url && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                {fieldErrors.url}
              </p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">
              {t('authModeLabel')}
            </label>
            <select
              value={authMode}
              onChange={(e) =>
                setAuthMode(e.target.value as Exclude<McpAuthMode, 'header'>)
              }
              className={inputClass()}
            >
              <option value="none">{t('authModeNone')}</option>
              <option value="bearer">{t('authModeBearer')}</option>
              <option value="oauth">{t('authModeOauth')}</option>
            </select>
          </div>

          {authMode === 'bearer' && (
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">
                {t('tokenOptionalLabel')}
              </label>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={
                  existingServer?.authToken ? t('keepTokenPlaceholder') : ''
                }
                className={inputClass()}
              />
            </div>
          )}
          {authMode === 'oauth' && (
            <>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t('oauthCustomHint')} {t('ownAppCustomHint')}
              </p>
              <OwnOauthAppFields
                providerName={name.trim() || t('serverName')}
                clientId={ownClientId}
                clientSecret={ownClientSecret}
                onClientIdChange={setOwnClientId}
                onClientSecretChange={setOwnClientSecret}
              />
            </>
          )}
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('localOnlyNote')}
          </p>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            {tCommon('cancel')}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isValidating}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isValidating
              ? authMode === 'oauth'
                ? t('oauthWaiting')
                : t('validating')
              : authMode === 'oauth'
                ? t('saveAndSignIn')
                : t('save')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

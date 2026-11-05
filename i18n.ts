import { getRequestConfig } from 'next-intl/server';

import { routing } from './config/i18n';

type MessageTree = { [key: string]: string | MessageTree };

/** Fill only missing auxiliary UI translations, retaining localized values at every nesting level. */
function auxiliaryMessages(
  base: MessageTree,
  translated?: MessageTree,
): MessageTree {
  return Object.fromEntries(
    Object.entries(base).map(([key, value]) => [
      key,
      typeof value === 'string'
        ? typeof translated?.[key] === 'string'
          ? translated[key]
          : value
        : auxiliaryMessages(
            value,
            typeof translated?.[key] === 'object'
              ? (translated[key] as MessageTree)
              : undefined,
          ),
    ]),
  );
}

export default getRequestConfig(async ({ requestLocale }) => {
  // Get locale from request or use default
  let locale = await requestLocale;

  // Ensure the locale is supported
  if (!locale || !routing.locales.includes(locale as any)) {
    locale = routing.defaultLocale;
  }

  // Load flat messages from messages directory
  try {
    const messages = (await import(`./messages/${locale}.json`)).default;
    // Newly introduced admin controls remain usable while locale translations
    // roll out. Existing translated namespaces are never replaced.
    const english = (await import('./messages/en.json')).default;

    return {
      locale,
      messages: {
        ...messages,
        permissionCache: messages.permissionCache ?? english.permissionCache,
        auxiliaryModels: auxiliaryMessages(
          english.auxiliaryModels,
          messages.auxiliaryModels,
        ),
        admin: {
          ...messages.admin,
          area: {
            ...messages.admin?.area,
            models: messages.admin?.area?.models ?? english.admin.area.models,
          },
          areaDescription: {
            ...messages.admin?.areaDescription,
            models:
              messages.admin?.areaDescription?.models ??
              english.admin.areaDescription.models,
          },
        },
      },
    };
  } catch (error) {
    console.error(`Failed to load messages for ${locale}`, error);

    // Fallback to English if locale file doesn't exist
    if (locale !== 'en') {
      try {
        const fallbackMessages = (await import(`./messages/en.json`)).default;
        return {
          locale,
          messages: fallbackMessages,
        };
      } catch {
        // Return empty messages if English also fails
        return {
          locale,
          messages: {},
        };
      }
    }

    return {
      locale,
      messages: {},
    };
  }
});

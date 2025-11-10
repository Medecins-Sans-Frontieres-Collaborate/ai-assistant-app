import { getRequestConfig } from 'next-intl/server';
import { routing } from './config/i18n';

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

    return {
      locale,
      messages,
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

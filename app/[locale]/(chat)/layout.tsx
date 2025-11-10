import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { DEFAULT_UI_PREFERENCES, validateUIPreferences } from '@/types/ui';

import { AppProviders } from '@/components/Providers/AppProviders';

import { ChatShell } from './ChatShell';

import { auth } from '@/auth';

/**
 * Layout for authenticated chat pages
 * Server component that handles auth and provides session/providers
 * ChatShell is the client component that manages the UI structure
 */
export default async function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session) {
    redirect('/signin');
  }

  // Read UI preferences from cookie for SSR
  const cookieStore = await cookies();
  const uiPrefsCookie = cookieStore.get('ui-prefs');

  let initialUIPreferences = DEFAULT_UI_PREFERENCES;
  if (uiPrefsCookie?.value) {
    try {
      const parsed = JSON.parse(decodeURIComponent(uiPrefsCookie.value));
      // Validate and ensure correct shape
      initialUIPreferences = validateUIPreferences(parsed);
    } catch (e) {
      // Fall back to defaults on parse error
      console.error('Failed to parse ui-prefs cookie:', e);
    }
  }

  return (
    <AppProviders
      session={session}
      launchDarklyClientId={process.env.LAUNCHDARKLY_CLIENT_ID}
      userContext={{
        id: session.user?.id || 'anonymous',
        email: session.user?.mail,
        givenName: session.user?.givenName,
        surname: session.user?.surname,
        displayName: session.user?.displayName,
        jobTitle: session.user?.jobTitle,
        department: session.user?.department,
        companyName: session.user?.companyName,
      }}
      initialUIPreferences={initialUIPreferences}
    >
      <ChatShell>{children}</ChatShell>
    </AppProviders>
  );
}

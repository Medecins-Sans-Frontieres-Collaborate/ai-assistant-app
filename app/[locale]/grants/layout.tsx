import { canAccessGrants } from '@/lib/services/grants/access';

import { OrganizationSupportWrapper } from '@/components/Support/OrganizationSupportWrapper';

import { auth } from '@/auth';

/**
 * Layout for the Grants Processing route segment.
 *
 * The grants pages live outside the (chat) route group for now, so they don't inherit
 * AppProviders / SessionProvider. This layout:
 *   1. Enforces access server-side — non-allowlisted users never receive the
 *      grants UI or its client bundle.
 *   2. Provides a SessionProvider (via OrganizationSupportWrapper) so the
 *      client pages can use useSession().
 */
export default async function GrantsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!canAccessGrants(session?.user)) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-gray-200 bg-white p-8 text-center dark:border-gray-700 dark:bg-gray-800">
          <h1 className="mb-2 text-xl font-semibold text-gray-900 dark:text-white">
            Access restricted
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            The Grants Processing tool is limited to authorized users. If you
            believe you should have access, please contact the grants team.
          </p>
        </div>
      </div>
    );
  }

  return (
    <OrganizationSupportWrapper session={session}>
      {children}
    </OrganizationSupportWrapper>
  );
}

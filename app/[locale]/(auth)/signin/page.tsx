'use client';

import { IconAlertCircle, IconHelp, IconMail } from '@tabler/icons-react';
import { signIn } from 'next-auth/react';
import { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';
import Image from 'next/image';
import { useSearchParams } from 'next/navigation';

import packageJson from '@/package.json';
import logo from '@/public/logo_light.png';
import microsoftLogo from '@/public/microsoft-logo.svg';

/**
 * Modern sign-in page with glassmorphism and micro-interactions
 */
export default function SignInPage() {
  const t = useTranslations();
  const [isLoading, setIsLoading] = useState(false);
  const [showAccessInfo, setShowAccessInfo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchParams = useSearchParams();

  const version = packageJson.version;
  const build = process.env.NEXT_PUBLIC_BUILD;
  const env = process.env.NEXT_PUBLIC_ENV;
  const email = process.env.NEXT_PUBLIC_EMAIL;

  // Check for errors in URL params (from NextAuth redirects or cookie cleanup)
  useEffect(() => {
    const urlError = searchParams.get('error');
    if (urlError) {
      const errorMessages: Record<string, string> = {
        Configuration: t('auth.errorConfigurationServer'),
        AccessDenied: t('auth.errorAccessDeniedPermissions'),
        Verification: t('auth.errorVerification'),
        OAuthSignin: t('auth.errorOAuthSignin'),
        OAuthCallback: t('auth.errorOAuthCallback'),
        OAuthCreateAccount: t('auth.errorOAuthCreateAccount'),
        EmailCreateAccount: t('auth.errorEmailCreateAccount'),
        Callback: t('auth.errorCallback'),
        OAuthAccountNotLinked: t('auth.errorOAuthAccountNotLinked'),
        EmailSignin: t('auth.errorEmailSignin'),
        CredentialsSignin: t('auth.errorCredentialsSignin'),
        SessionRequired: t('auth.errorSessionRequired'),
        SessionExpired: t('auth.errorSessionExpired'),
        // Cookie cleanup errors
        CookiesCleared: t('auth.errorCookiesCleared'),
        HeadersTooLarge: t('auth.errorHeadersTooLarge'),
      };
      setTimeout(() => {
        setError(errorMessages[urlError] || t('auth.errorFallback'));
      }, 0);
    }
  }, [searchParams, t]);

  const handleSignIn = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const result = await signIn('microsoft-entra-id', {
        callbackUrl: '/',
        redirect: false,
      });

      // If sign in didn't redirect and returned an error
      if (result?.error) {
        setError(t('auth.errorFallback'));
        setIsLoading(false);
      } else if (result?.ok) {
        // Successful sign in, redirect
        window.location.href = result.url || '/';
      }
    } catch (err) {
      console.error('Sign in error:', err);
      setError(t('auth.errorFallback'));
      setIsLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-black">
      {/* Dark overlay for depth */}
      <div className="absolute inset-0 bg-black/40 z-[1]" />

      {/* Background SVG Map */}
      <div
        className="absolute left-1/2 -translate-x-1/2 md:-left-[12%] md:translate-x-0 top-1/2 -translate-y-1/2 w-[90%] md:w-[85%] h-[60%] md:h-[95%] bg-no-repeat opacity-40 md:opacity-60 z-0"
        style={{
          backgroundImage: `url(/msf-map-background.svg)`,
          backgroundPosition: 'center',
          backgroundSize: 'contain',
        }}
      >
        {/* Subtle vignette effect */}
        <div className="absolute inset-0 bg-gradient-to-b md:bg-gradient-to-r from-transparent via-transparent to-black" />
      </div>

      {/* Content */}
      <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-4 py-8 pb-24 md:py-12 md:pr-[5%]">
        {/* Container for logo and card */}
        <div className="w-full max-w-md lg:max-w-lg 2xl:max-w-2xl opacity-0 animate-fade-in-bottom md:ml-auto md:mr-8 space-y-6 md:space-y-8">
          {/* Logo and Title - Outside glass card */}
          <div className="text-center">
            <div className="flex flex-col md:flex-row items-center justify-center gap-2 md:gap-3">
              <Image
                src={logo}
                alt={t('common.msfLogo')}
                className="h-10 md:h-12 w-auto opacity-95"
              />
              <h1 className="text-2xl md:text-3xl font-light tracking-wide text-white/95">
                MSF AI Assistant
              </h1>
            </div>
          </div>

          {/* Glass Card - Fade in animation with delay */}
          <div className="relative overflow-hidden rounded-2xl md:rounded-3xl bg-white/[0.015] backdrop-blur-3xl border border-white/[0.1] shadow-[0_8px_32px_0_rgba(0,0,0,0.4)] flex flex-col">
            {/* Multi-layer glass effect */}
            <div className="absolute inset-0 bg-gradient-to-br from-white/[0.07] via-white/[0.015] to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-tl from-zinc-800/[0.05] to-transparent" />

            {/* Frosted glass edge highlight */}
            <div className="absolute inset-0 rounded-2xl md:rounded-3xl border-t border-l border-white/[0.1]" />

            {/* Noise texture overlay for glass effect */}
            <div
              className="absolute inset-0 opacity-[0.02] mix-blend-soft-light pointer-events-none"
              style={{
                backgroundImage:
                  "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' /%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' /%3E%3C/svg%3E\")",
              }}
            />

            {/* Card Content */}
            <div className="relative px-6 py-8 md:px-12 md:py-12">
              {/* Welcome Section */}
              <div className="mb-6 md:mb-8 text-center">
                <div className="space-y-2 md:space-y-3">
                  <h2 className="text-2xl md:text-3xl font-medium text-white/95">
                    {t('auth.welcomeBack')}
                  </h2>
                  <p className="text-gray-300/70 text-sm md:text-base font-light">
                    {t('auth.signInToContinue')}
                  </p>
                </div>
              </div>

              {/* Sign In Button */}
              <button
                onClick={handleSignIn}
                disabled={isLoading}
                className="group relative w-full flex items-center justify-center gap-2 md:gap-3 bg-white/90 hover:bg-white text-gray-900 font-medium py-3.5 md:py-4 px-4 md:px-6 rounded-xl transition-all duration-200 shadow-lg hover:shadow-xl hover:scale-[1.01] active:scale-[0.99] disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100 text-sm md:text-base"
              >
                {isLoading ? (
                  <>
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-gray-900" />
                    <span>{t('auth.signingIn')}</span>
                  </>
                ) : (
                  <>
                    <Image
                      src={microsoftLogo}
                      alt={t('auth.microsoft')}
                      width={20}
                      height={20}
                      className="transition-transform group-hover:scale-110"
                    />
                    <span>{t('auth.signInWithMsfAccount')}</span>
                  </>
                )}
              </button>

              {/* Error Message */}
              {error && (
                <div className="mt-4 md:mt-6 rounded-xl bg-red-500/10 border border-red-500/30 p-3 md:p-4 animate-fade-in">
                  <div className="flex items-start gap-2 md:gap-3">
                    <IconAlertCircle className="h-4 w-4 md:h-5 md:w-5 text-red-400 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 space-y-2">
                      <p className="text-xs md:text-sm text-red-200 leading-relaxed">
                        {error}
                      </p>
                      <div className="flex flex-wrap items-center gap-2 md:gap-3">
                        <button
                          onClick={handleSignIn}
                          disabled={isLoading}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-200 hover:text-red-100 border border-red-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {t('auth.tryAgain')}
                        </button>
                        {email && (
                          <a
                            href={`mailto:${email}`}
                            className="inline-flex items-center gap-1.5 text-xs text-red-300 hover:text-red-100 underline underline-offset-2 transition-colors"
                          >
                            <IconMail className="h-3 w-3" />
                            {t('auth.contactSupport')}
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Divider */}
              <div className="my-6 md:my-8 flex items-center gap-3 md:gap-4">
                <div className="h-px flex-1 bg-white/[0.12]" />
                <span className="text-[10px] md:text-xs text-gray-400/70 uppercase tracking-widest font-light">
                  {t('auth.secureSso')}
                </span>
                <div className="h-px flex-1 bg-white/[0.12]" />
              </div>

              {/* Access Info Toggle */}
              <button
                onClick={() => setShowAccessInfo(!showAccessInfo)}
                className="w-full flex items-center justify-center gap-2 text-xs md:text-sm text-gray-300/80 hover:text-white/90 transition-colors duration-200 group"
              >
                <IconHelp className="h-3.5 w-3.5 md:h-4 md:w-4 transition-transform group-hover:scale-110 opacity-70 group-hover:opacity-100" />
                <span className="font-normal">{t('auth.howToGetAccess')}</span>
              </button>

              {/* Access Info Panel - Animated */}
              {showAccessInfo && (
                <div className="mt-6 md:mt-8 rounded-xl bg-white/[0.06] border border-white/[0.08] p-4 md:p-6 animate-fade-in">
                  <p className="text-xs md:text-sm text-gray-300/90 leading-relaxed">
                    {t('auth.accessLimitedText')}
                  </p>
                  <p className="text-xs md:text-sm text-gray-400/80 mt-3 md:mt-4">
                    {t('auth.expandAccessSoon')}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Footer - Version Info and Contact */}
      <div className="absolute bottom-0 right-0 left-0 p-3 md:p-6 z-20">
        <div className="flex items-center justify-between gap-2 md:gap-4">
          {/* Version info */}
          <span className="text-[10px] md:text-xs text-gray-400/70">
            v{version}.{build}.{env}
          </span>

          {/* Contact button */}
          {email && (
            <a
              href={`mailto:${email}`}
              className="flex items-center gap-1.5 md:gap-2 px-2.5 md:px-3 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.15] border border-white/[0.15] text-[10px] md:text-xs text-gray-400 hover:text-gray-200 transition-all duration-200 group"
            >
              <IconMail className="h-3 w-3 md:h-3.5 md:w-3.5" />
              <span>{t('common.contact')}</span>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

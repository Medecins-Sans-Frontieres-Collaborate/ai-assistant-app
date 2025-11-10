'use client';

import { useEffect } from 'react';

/**
 * Client component that handles theme initialization before hydration
 * This prevents the flash of light theme on dark mode
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // This runs after hydration, but we also need to sync with any theme changes
    const updateTheme = () => {
      try {
        const theme = localStorage.getItem('theme');
        const parsedTheme = theme ? JSON.parse(theme) : 'dark';

        if (parsedTheme === 'dark') {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }
      } catch (e) {
        document.documentElement.classList.add('dark');
      }
    };

    updateTheme();

    // Listen for storage changes (e.g., from other tabs)
    window.addEventListener('storage', updateTheme);
    return () => window.removeEventListener('storage', updateTheme);
  }, []);

  return <>{children}</>;
}

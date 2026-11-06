import { Capacitor } from '@capacitor/core';
import { App as CapApp, URLOpenListenerEvent } from '@capacitor/app';
import { supabase } from '../supabaseClient';

/**
 * Initializes native Deep Link handlers (e.g. oneteam://).
 * Handles Supabase auth tokens, invitation callbacks, and password recovery.
 */
export function setupNativeDeepLinks() {
  if (!Capacitor.isNativePlatform()) {
    return;
  }

  CapApp.addListener('appUrlOpen', async (data: URLOpenListenerEvent) => {
    try {
      const url = data.url;
      if (!url) return;

      // Check if URL matches our custom scheme
      if (url.startsWith('oneteam://')) {
        // Parse url into fragments and query
        const urlObj = new URL(url.replace('oneteam://', 'https://placeholder.domain/'));

        // Case 1: Supabase auth tokens in hash (#access_token=...&refresh_token=...)
        const hash = urlObj.hash;
        if (hash && (hash.includes('access_token=') || hash.includes('refresh_token='))) {
          const hashParams = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
          const accessToken = hashParams.get('access_token');
          const refreshToken = hashParams.get('refresh_token');

          if (accessToken && refreshToken) {
            await supabase.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken,
            });
          }
        }

        // Case 2: Supabase auth code in search query (?code=...)
        const code = urlObj.searchParams.get('code');
        if (code) {
          await supabase.auth.exchangeCodeForSession(code);
        }

        // Case 3: Password recovery hash/param
        if (hash.includes('type=recovery') || hash.includes('reset-password') || urlObj.searchParams.get('type') === 'recovery') {
          if (typeof window !== 'undefined') {
            window.location.hash = '#reset-password';
          }
        }
      }
    } catch (err) {
      console.warn('Error handling native deep link:', err);
    }
  });
}

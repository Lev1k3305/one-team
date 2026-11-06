import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'kz.oneteam.app',
  appName: 'ONE TEAM',
  webDir: 'dist',
  backgroundColor: '#0B0F19',
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
  },
};

export default config;

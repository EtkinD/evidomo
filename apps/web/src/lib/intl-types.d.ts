import type { AppLocale, Messages } from './i18n';

declare module 'use-intl' {
  interface AppConfig {
    Locale: AppLocale;
    Messages: Messages;
  }
}

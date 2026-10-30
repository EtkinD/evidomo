import { useId, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import {
  THEME_CHOICES,
  applyTheme,
  currentTheme,
  subscribeToTheme,
  writeStoredTheme,
  type ThemeChoice,
} from '../../lib/theme';

const LABEL_KEYS = {
  system: 'themeSystem',
  light: 'themeLight',
  dark: 'themeDark',
} as const satisfies Record<ThemeChoice, string>;

/**
 * System / Light / Dark as a native radio group (arrow keys, announced as "1 of 3, selected").
 * The server and the first client render show System; the real choice (already applied to <html>
 * by the inline script in _document) is picked up right after hydration.
 */
export function ThemeSwitch() {
  const t = useTranslations('shell');
  const name = useId();
  const choice = useSyncExternalStore(subscribeToTheme, currentTheme, () => 'system' as const);

  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-sm text-base-content/70">{t('theme')}</legend>
      <div className="join">
        {THEME_CHOICES.map((option) => (
          <input
            key={option}
            type="radio"
            name={name}
            value={option}
            aria-label={t(LABEL_KEYS[option])}
            checked={choice === option}
            onChange={() => {
              applyTheme(option);
              writeStoredTheme(option);
            }}
            className="btn join-item min-h-11 min-w-20"
          />
        ))}
      </div>
    </fieldset>
  );
}

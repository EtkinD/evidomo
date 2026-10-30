import { useId, useSyncExternalStore } from 'react';
import {
  THEME_CHOICES,
  applyTheme,
  currentTheme,
  subscribeToTheme,
  writeStoredTheme,
  type ThemeChoice,
} from '../../lib/theme';

const LABELS: Record<ThemeChoice, string> = { system: 'System', light: 'Light', dark: 'Dark' };

/**
 * System / Light / Dark as a native radio group (arrow keys, announced as "1 of 3, selected").
 * The server and the first client render show System; the real choice (already applied to <html>
 * by the inline script in _document) is picked up right after hydration.
 */
export function ThemeSwitch() {
  const name = useId();
  const choice = useSyncExternalStore(subscribeToTheme, currentTheme, () => 'system' as const);

  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-sm text-base-content/70">Theme</legend>
      <div className="join">
        {THEME_CHOICES.map((option) => (
          <input
            key={option}
            type="radio"
            name={name}
            value={option}
            aria-label={LABELS[option]}
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

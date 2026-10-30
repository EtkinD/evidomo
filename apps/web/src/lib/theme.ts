/**
 * Light/dark theme preference. The DOM is the source of truth: `data-theme` on `<html>` is either
 * `evidomo-light`, `evidomo-dark`, or absent (System: the `prefers-color-scheme` rule in
 * globals.css applies). The choice is stored per viewer in localStorage; every storage access is
 * guarded, because it throws in some private modes and when the user blocks site data.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];
export const THEME_STORAGE_KEY = 'evidomo-theme';

const THEME_NAMES = { light: 'evidomo-light', dark: 'evidomo-dark' } as const;

/** Token hex values of base-100 in evidomo-light / evidomo-dark (the phone's browser bar colour). */
export const THEME_COLORS = { light: '#fefbf5', dark: '#28201a' } as const;
const THEME_COLOR_SELECTOR = 'meta[name="theme-color"]';

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function readStoredTheme(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** Returns false when the choice could not be persisted (it still applies for this page view). */
export function writeStoredTheme(choice: ThemeChoice): boolean {
  try {
    if (choice === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice);
    return true;
  } catch {
    return false;
  }
}

/**
 * `_document` ships two `theme-color` tags, one per `prefers-color-scheme`. That pair only tracks
 * the OS setting, so an explicit Light or Dark choice points both at the chosen colour, and System
 * gives each tag back the colour of its own media query.
 */
function syncThemeColor(choice: ThemeChoice): void {
  for (const meta of document.querySelectorAll<HTMLMetaElement>(THEME_COLOR_SELECTOR)) {
    const ownScheme = meta.getAttribute('media')?.includes('dark') === true ? 'dark' : 'light';
    meta.setAttribute('content', THEME_COLORS[choice === 'system' ? ownScheme : choice]);
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', THEME_NAMES[choice]);
  syncThemeColor(choice);
}

/** The theme currently applied to the page, read from the DOM. */
export function currentTheme(): ThemeChoice {
  const name = document.documentElement.getAttribute('data-theme');
  if (name === THEME_NAMES.light) return 'light';
  if (name === THEME_NAMES.dark) return 'dark';
  return 'system';
}

/**
 * Runs from `<head>` after the `theme-color` tags (see `pages/_document.tsx`) and before the body is
 * parsed, so the stored theme and bar colour are set before first paint. It is plain, static text (no per-request data), so a future
 * Content-Security-Policy can allow it with a hash instead of `'unsafe-inline'`.
 */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme','evidomo-'+t);var c=${JSON.stringify(THEME_COLORS)}[t],m=document.querySelectorAll(${JSON.stringify(THEME_COLOR_SELECTOR)});for(var i=0;i<m.length;i++)m[i].setAttribute('content',c)}}catch(e){}`;

/** Subscribes to theme changes made here (attribute) or in another tab (storage event). */
export function subscribeToTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === THEME_STORAGE_KEY) applyTheme(readStoredTheme());
  };
  window.addEventListener('storage', onStorage);
  return () => {
    observer.disconnect();
    window.removeEventListener('storage', onStorage);
  };
}

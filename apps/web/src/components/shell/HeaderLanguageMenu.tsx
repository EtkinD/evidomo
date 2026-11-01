import { useRouter } from 'next/router';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { LOCALES, LOCALE_NAMES, isLocale } from '../../lib/i18n';
import { localizedHref, rememberLocale } from './LanguageSwitch';

/**
 * A compact language menu for the masthead ("EN" and a chevron), so a visitor on a deep link in the
 * wrong language finds theirs without scrolling to the footer. Same behaviour as the footer's
 * `LanguageSwitch`: plain links with a full page load (see there for why) and the NEXT_LOCALE
 * cookie. Built like `AccountMenu`, a disclosure button rather than an ARIA menu: the native
 * `<details>` neither closes on Escape nor returns focus to its button.
 */
export function HeaderLanguageMenu() {
  const t = useTranslations('shell');
  const current = useLocale();
  const { asPath, pathname, isReady } = useRouter();
  // Before the router is ready the path has no query string yet; using it keeps the first client
  // render identical to the server's HTML.
  const path = isReady ? asPath : pathname;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && open) {
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    }
  }

  function onFocusOut(next: EventTarget | null) {
    if (open && next instanceof Node && !rootRef.current?.contains(next)) setOpen(false);
  }

  const currentName = isLocale(current) ? LOCALE_NAMES[current] : current;

  return (
    <div
      ref={rootRef}
      className={`dropdown dropdown-end ${open ? 'dropdown-open' : ''}`}
      onKeyDown={onKeyDown}
      onBlur={(event) => onFocusOut(event.relatedTarget)}
    >
      <button
        ref={buttonRef}
        type="button"
        className="btn btn-ghost min-h-11 min-w-11 gap-1 px-2 text-sm font-semibold"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={t('languageCurrent', { language: currentName })}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden className="uppercase">
          {current}
        </span>
        <svg viewBox="0 0 16 16" className="size-3" fill="none" aria-hidden focusable="false">
          <path
            d="M3 6l5 5 5-5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <ul
          id={menuId}
          className="menu dropdown-content z-10 mt-1 w-48 rounded-box border border-base-300 bg-base-100 p-2 shadow-sm"
        >
          {LOCALES.map((locale) => (
            <li key={locale}>
              <a
                href={localizedHref(locale, path)}
                lang={locale}
                hrefLang={locale}
                aria-current={locale === current ? 'true' : undefined}
                onClick={() => rememberLocale(locale)}
                className={`min-h-11! ${locale === current ? 'font-semibold underline decoration-accent decoration-4 underline-offset-8' : ''}`}
              >
                {LOCALE_NAMES[locale]}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

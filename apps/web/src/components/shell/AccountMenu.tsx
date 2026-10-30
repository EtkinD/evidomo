import { useTranslations } from 'use-intl';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useLogout } from '../../lib/auth';

/**
 * A disclosure button (`aria-expanded`) that reveals the account details and "Log out". It is
 * not an ARIA `role="menu"`: that role promises arrow-key navigation, and two items do not need
 * it. daisyUI's `dropdown` supplies the placement and look; the open state is ours, because the
 * native `<details>` / CSS-focus dropdowns neither close on Escape nor return focus to the button,
 * and a CSS focus dropdown breaks in Safari, which does not focus a tapped button.
 */
export function AccountMenu({ email }: { email: string }) {
  const t = useTranslations('shell');
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    // A tap or click anywhere else closes it. Focus is not used for this: Safari does not focus
    // a tapped button, so a blur check would close the menu before the tap reached "Log out".
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
    // Tabbing out of the menu closes it. A null target (tap, window blur) is left to pointerdown.
    if (open && next instanceof Node && !rootRef.current?.contains(next)) setOpen(false);
  }

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
        className="btn btn-ghost min-h-11 gap-2 px-2 sm:px-4"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
      >
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-selector bg-secondary font-semibold text-secondary-content uppercase"
        >
          {email.charAt(0)}
        </span>
        <span aria-hidden className="hidden max-w-40 truncate text-sm sm:inline">
          {email}
        </span>
        <span className="sr-only">{t('accountMenu')}</span>
      </button>
      {open && (
        <ul
          id={menuId}
          className="menu dropdown-content z-10 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-box border border-base-300 bg-base-100 p-2 shadow-sm"
        >
          <li className="menu-title break-all">{email}</li>
          <li>
            <button
              type="button"
              className="min-h-11!"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              {logout.isPending && (
                <span className="loading loading-spinner loading-xs" aria-hidden />
              )}
              {t('logOut')}
            </button>
          </li>
          {logout.isError && (
            <li role="alert" className="px-3 py-1 text-sm text-error">
              {t('logOutFailed')}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

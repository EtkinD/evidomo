import { Logo } from '../brand/Logo';
import { ThemeSwitch } from './ThemeSwitch';

export const REPOSITORY_URL = 'https://github.com/EtkinD/evidomo';

// A colophon, as at the back of a printed book: who made it, where the source is, and the
// reader's one setting.
export function AppFooter() {
  return (
    <footer className="grain border-t border-base-content/25 bg-base-200">
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 pt-10 pb-10 md:grid-cols-12 md:pt-14">
        <div className="flex flex-col gap-2 md:col-span-5">
          <Logo />
          <p className="max-w-xs font-display text-lg text-base-content/70 italic">
            Evidence-linked listing packs for estate agents.
          </p>
        </div>
        <div className="flex flex-col gap-1 md:col-span-4">
          <p className="max-w-xs text-sm text-base-content/70">
            Built during the Meta hackathon, Oct 26 – Nov 4, 2026.
          </p>
          <a
            href={REPOSITORY_URL}
            rel="noreferrer"
            className="inline-flex min-h-11 w-fit items-center text-sm underline underline-offset-4"
          >
            Evidomo on GitHub
          </a>
        </div>
        <div className="md:col-span-3 md:justify-self-end">
          <ThemeSwitch />
        </div>
      </div>
    </footer>
  );
}

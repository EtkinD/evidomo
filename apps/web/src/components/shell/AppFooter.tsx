import { Logo } from '../brand/Logo';
import { ThemeSwitch } from './ThemeSwitch';

export const REPOSITORY_URL = 'https://github.com/EtkinD/evidomo';

export function AppFooter() {
  return (
    <footer className="border-t border-base-300 bg-base-200">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-2">
          <Logo />
          <p className="max-w-xs text-sm text-base-content/70">
            Evidence-linked listing packs for estate agents.
          </p>
          <p className="max-w-xs text-sm text-base-content/70">
            Built during the Meta hackathon, Oct 26 – Nov 4, 2026.
          </p>
          <a
            href={REPOSITORY_URL}
            rel="noreferrer"
            className="inline-flex min-h-11 w-fit items-center text-sm underline"
          >
            Evidomo on GitHub
          </a>
        </div>
        <ThemeSwitch />
      </div>
    </footer>
  );
}

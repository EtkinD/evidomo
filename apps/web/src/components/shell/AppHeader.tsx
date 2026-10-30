import Link from 'next/link';
import { useRouter } from 'next/router';
import { useTranslations } from 'use-intl';
import { useMe } from '../../lib/auth';
import { Logo } from '../brand/Logo';
import { AccountMenu } from './AccountMenu';

interface NavItem {
  label: 'projects' | 'demo';
  href: string;
}

// The public demo replay is open to everyone, so it is in both navigations.
const DEMO_NAV: NavItem = { label: 'demo', href: '/demo' };

// Primary navigation for signed-in agents. Add an entry here; the header lays it out.
const AGENT_NAV: readonly NavItem[] = [{ label: 'projects', href: '/projects' }, DEMO_NAV];

// Links shown to signed-out visitors before the auth actions.
const PUBLIC_NAV: readonly NavItem[] = [DEMO_NAV];

function NavLink({ item }: { item: NavItem }) {
  const t = useTranslations('shell');
  const { pathname } = useRouter();
  const exact = pathname === item.href;
  const inside = pathname.startsWith(`${item.href}/`);
  return (
    <Link
      href={item.href}
      // "page" on the page itself, "true" on a page inside that section (a single project).
      aria-current={exact ? 'page' : inside ? 'true' : undefined}
      className={`inline-flex min-h-11 items-center px-2 underline-offset-8 hover:underline hover:decoration-base-content/40 hover:decoration-1 sm:px-3 ${exact || inside ? 'font-semibold underline decoration-accent decoration-4' : ''}`}
    >
      {t(item.label)}
    </Link>
  );
}

function HeaderActions() {
  const t = useTranslations('shell');
  const me = useMe();

  // Nothing while the session check runs, so the header does not flash the wrong controls.
  if (me.isPending) return null;

  if (me.data) {
    return (
      <>
        <nav aria-label={t('navMain')} className="flex items-center gap-1">
          {AGENT_NAV.map((item) => (
            <NavLink key={item.href} item={item} />
          ))}
        </nav>
        <AccountMenu email={me.data.email} />
      </>
    );
  }

  return (
    <nav aria-label={t('navAccount')} className="flex items-center gap-1">
      {PUBLIC_NAV.map((item) => (
        <NavLink key={item.href} item={item} />
      ))}
      <Link
        href="/login"
        className="inline-flex min-h-11 items-center px-2 underline-offset-8 hover:underline hover:decoration-base-content/40 hover:decoration-1 sm:px-3"
      >
        {t('logIn')}
      </Link>
      <Link href="/register" className="btn btn-outline min-h-11 px-3 sm:px-4">
        {t('createAccount')}
      </Link>
    </nav>
  );
}

export function AppHeader() {
  const t = useTranslations('shell');
  return (
    // A masthead: a double rule under the running head (.rule-double), on the paper-grain page
    // colour. z-20 keeps the account menu above page content.
    <header className="rule-double grain relative z-20 border-b border-base-content/25 bg-base-200">
      {/* flex-wrap is the safety net: whatever the controls add up to, the row wraps instead of
          overflowing the viewport. */}
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-2 gap-y-1 px-4 py-2">
        <Link href="/" className="inline-flex min-h-11 items-center">
          <Logo size="sm" />
        </Link>
        <p aria-hidden className="hidden font-display text-lg text-base-content/70 italic lg:block">
          {t('mastheadLine')}
        </p>
        <div className="flex items-center gap-1">
          <HeaderActions />
        </div>
      </div>
    </header>
  );
}

import Link from 'next/link';
import { useRouter } from 'next/router';
import { useMe } from '../../lib/auth';
import { Logo } from '../brand/Logo';
import { AccountMenu } from './AccountMenu';

interface NavItem {
  label: string;
  href: string;
}

// Primary navigation for signed-in agents. Add an entry here; the header lays it out.
const AGENT_NAV: readonly NavItem[] = [{ label: 'Projects', href: '/projects' }];

// Extension point for links shown to signed-out visitors before the auth actions. The public demo
// (P4-09) goes here once its page exists; it stays empty so the header never links to a 404.
const PUBLIC_NAV: readonly NavItem[] = [];

function NavLink({ item }: { item: NavItem }) {
  const { pathname } = useRouter();
  const exact = pathname === item.href;
  const inside = pathname.startsWith(`${item.href}/`);
  return (
    <Link
      href={item.href}
      // "page" on the page itself, "true" on a page inside that section (a single project).
      aria-current={exact ? 'page' : inside ? 'true' : undefined}
      className={`btn btn-ghost min-h-11 px-3 sm:px-4 ${exact || inside ? 'font-semibold underline' : ''}`}
    >
      {item.label}
    </Link>
  );
}

function HeaderActions() {
  const me = useMe();

  // Nothing while the session check runs, so the header does not flash the wrong controls.
  if (me.isPending) return null;

  if (me.data) {
    return (
      <>
        <nav aria-label="Main" className="flex items-center gap-1">
          {AGENT_NAV.map((item) => (
            <NavLink key={item.href} item={item} />
          ))}
        </nav>
        <AccountMenu email={me.data.email} />
      </>
    );
  }

  return (
    <nav aria-label="Account" className="flex items-center gap-1">
      {PUBLIC_NAV.map((item) => (
        <NavLink key={item.href} item={item} />
      ))}
      <Link href="/login" className="btn btn-ghost min-h-11 px-3 sm:px-4">
        Log in
      </Link>
      <Link href="/register" className="btn btn-primary min-h-11 px-3 sm:px-4">
        Create account
      </Link>
    </nav>
  );
}

export function AppHeader() {
  return (
    <header className="border-b border-base-300 bg-base-100">
      {/* flex-wrap is the safety net: whatever the controls add up to, the row wraps instead of
          overflowing the viewport. */}
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-2 gap-y-1 px-4 py-2">
        <Link href="/" className="inline-flex min-h-11 items-center">
          <Logo size="sm" />
        </Link>
        <div className="flex items-center gap-1">
          <HeaderActions />
        </div>
      </div>
    </header>
  );
}

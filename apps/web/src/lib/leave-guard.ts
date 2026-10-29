import { useRouter } from 'next/router';
import { useEffect } from 'react';

export const LEAVE_MESSAGE =
  'Uploads or a recording are still in progress. If you leave now they will be lost. Leave anyway?';

/**
 * While `active`, asks before the page is left: a reload or tab close (`beforeunload`) and a
 * Pages Router navigation (`routeChangeStart`, which covers every link and the back button).
 */
export function useLeaveGuard(active: boolean): void {
  const router = useRouter();
  const { events } = router;

  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // Some browsers only show their prompt when returnValue is set.
      event.returnValue = '';
    };
    const onRouteChangeStart = (url: string): void => {
      if (window.confirm(LEAVE_MESSAGE)) return;
      // Next treats a thrown error with `cancelled: true` as a cancelled navigation, not a crash.
      const cancelled = Object.assign(new Error('Route change cancelled'), { cancelled: true });
      events.emit('routeChangeError', cancelled, url, { shallow: false });
      throw cancelled;
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    events.on('routeChangeStart', onRouteChangeStart);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      events.off('routeChangeStart', onRouteChangeStart);
    };
  }, [active, events]);
}

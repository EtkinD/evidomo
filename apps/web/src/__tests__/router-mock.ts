import { vi, type Mock } from 'vitest';

type Navigate = (url: string) => Promise<boolean>;

type RouteHandler = (...args: never[]) => void;

/** The part of `router.events` the guards use; handlers that throw reject the navigation. */
const handlers = new Map<string, Set<RouteHandler>>();
export const mockRouterEvents = {
  on(event: string, handler: RouteHandler): void {
    handlers.set(event, (handlers.get(event) ?? new Set()).add(handler));
  },
  off(event: string, handler: RouteHandler): void {
    handlers.get(event)?.delete(handler);
  },
  emit(event: string, ...args: unknown[]): void {
    for (const handler of handlers.get(event) ?? []) {
      Reflect.apply(handler, undefined, args);
    }
  },
};

interface MockRouter {
  events: typeof mockRouterEvents;
  isReady: boolean;
  pathname: string;
  asPath: string;
  query: Record<string, string | string[] | undefined>;
  replace: Mock<Navigate>;
  push: Mock<Navigate>;
}

/**
 * Stand-in for the Pages Router, installed per test file with
 * `vi.mock('next/router', () => import('./router-mock'))`. Holds no component imports, so the
 * mock factory cannot form an import cycle with the code under test.
 */
export const mockRouter: MockRouter = {
  events: mockRouterEvents,
  isReady: true,
  pathname: '/',
  asPath: '/',
  query: {},
  replace: vi.fn<Navigate>(() => Promise.resolve(true)),
  push: vi.fn<Navigate>(() => Promise.resolve(true)),
};

export function setRoute(asPath: string): void {
  const url = new URL(asPath, 'http://localhost');
  mockRouter.asPath = asPath;
  mockRouter.pathname = url.pathname;
  mockRouter.query = Object.fromEntries(url.searchParams);
  mockRouter.isReady = true;
}

export function useRouter(): MockRouter {
  return mockRouter;
}

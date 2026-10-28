import { vi, type Mock } from 'vitest';

type Navigate = (url: string) => Promise<boolean>;

interface MockRouter {
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

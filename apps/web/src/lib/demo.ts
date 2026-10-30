import { demoRunListResponseSchema, demoRunsUrl, type DemoRunListResponse } from '@evidomo/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiJson } from './api';

export const DEMO_PATH = '/demo';

/** Replay speeds on offer; the API accepts 0.25 to 10. */
export const REPLAY_SPEEDS = [1, 2, 4] as const;

export const demoRunsKey = ['demo', 'runs'] as const;

/** The published demo runs. The list is short and changes only with a deployment's settings. */
export function useDemoRuns(): UseQueryResult<DemoRunListResponse> {
  return useQuery({
    queryKey: demoRunsKey,
    queryFn: ({ signal }) => apiJson(demoRunsUrl(), demoRunListResponseSchema, { signal }),
  });
}

function displayName(type: 'region' | 'language', code: string): string {
  try {
    return (
      new Intl.DisplayNames(['en'], { type }).of(type === 'region' ? code.toUpperCase() : code) ??
      code
    );
  } catch {
    // Not a well-formed region or language code: show it as it is.
    return code;
  }
}

export const marketLabel = (marketProfileId: string): string =>
  displayName('region', marketProfileId);
export const languageLabel = (code: string): string => displayName('language', code);

/** "30 Oct 2026"; the stored time is UTC, and a day is all the list needs. */
export function formatDemoDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

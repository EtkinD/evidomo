import { demoRunListResponseSchema, demoRunsUrl, type DemoRunListResponse } from '@evidomo/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiJson } from './api';
import type { Formatter } from './i18n';

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

function displayName(type: 'region' | 'language', code: string, locale: string): string {
  try {
    return (
      new Intl.DisplayNames([locale], { type }).of(type === 'region' ? code.toUpperCase() : code) ??
      code
    );
  } catch {
    // Not a well-formed region or language code: show it as it is.
    return code;
  }
}

export const marketLabel = (marketProfileId: string, locale: string): string =>
  displayName('region', marketProfileId, locale);
export const languageLabel = (code: string, locale: string): string =>
  displayName('language', code, locale);

/** "30 Oct 2026" in the reader's locale; the stored time is UTC, and a day is all the list needs. */
export function formatDemoDate(format: Formatter, iso: string): string {
  return format.dateTime(new Date(iso), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

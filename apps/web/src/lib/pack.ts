import type { RunExportResponse } from '@evidomo/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiJson, isClientError } from './api';
import type { Formatter, Translator } from './i18n';
import { runScopedKey, useRunSource } from './run-source';

export const exportKey = (runId: string) => ['runs', runId, 'export'] as const;

/** The stored export manifest; 409 `export_not_ready` and 404 surface as `ApiRequestError`. */
export function useExportManifest(runId: string): UseQueryResult<RunExportResponse> {
  const source = useRunSource();
  return useQuery({
    queryKey: runScopedKey(source, runId, 'export'),
    queryFn: ({ signal }) => apiJson(source.exportUrl(runId), source.exportSchema, { signal }),
    retry: (failureCount, error) => !isClientError(error) && failureCount < 2,
  });
}

/** "412 B", "38.4 KB", "2.1 MB", with the number written the way the locale writes it. */
export function formatBytes(t: Translator<'pack'>, format: Formatter, bytes: number): string {
  if (bytes < 1024) return t('size.bytes', { value: format.number(bytes) });
  const oneDecimal = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  if (bytes < 1024 * 1024) return t('size.kb', { value: format.number(bytes / 1024, oneDecimal) });
  return t('size.mb', { value: format.number(bytes / (1024 * 1024), oneDecimal) });
}

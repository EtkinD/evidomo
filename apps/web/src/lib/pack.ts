import type { RunExportResponse } from '@evidomo/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiJson, isClientError } from './api';
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

/** "412 B", "38.4 KB", "2.1 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

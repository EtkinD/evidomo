import { QueryClient } from '@tanstack/react-query';
import { isClientError } from './api';

const MAX_QUERY_RETRIES = 2;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Network failures and 5xx get a couple of retries; a 4xx answer will not change.
        retry: (failureCount, error) => !isClientError(error) && failureCount < MAX_QUERY_RETRIES,
      },
    },
  });
}

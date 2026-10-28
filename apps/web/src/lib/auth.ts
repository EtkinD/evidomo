import {
  authUserResponseSchema,
  type AuthUser,
  type AuthUserResponse,
  type LoginRequest,
  type RegisterRequest,
} from '@evidomo/shared';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useRouter } from 'next/router';
import { ApiRequestError, apiJson, apiNoContent } from './api';

export const meQueryKey = ['auth', 'me'] as const;

/** The signed-in user, or `null` when the API answers 401 (no or expired session). */
export async function fetchMe(signal?: AbortSignal): Promise<AuthUser | null> {
  try {
    const { user } = await apiJson(
      '/api/auth/me',
      authUserResponseSchema,
      signal === undefined ? {} : { signal },
    );
    return user;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) return null;
    throw error;
  }
}

/**
 * The single source of truth for "who is signed in". The session cookie is httpOnly, so the
 * browser cannot inspect it; only the API can say whether it is valid. A 401 resolves to `null`
 * (a normal state, not an error), so it is never retried.
 */
export function useMe(): UseQueryResult<AuthUser | null> {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: ({ signal }) => fetchMe(signal),
    staleTime: 30_000,
  });
}

export function useLogin(): UseMutationResult<AuthUserResponse, Error, LoginRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) =>
      apiJson('/api/auth/login', authUserResponseSchema, { method: 'POST', body }),
    onSuccess: ({ user }) => {
      queryClient.setQueryData<AuthUser | null>(meQueryKey, user);
    },
  });
}

/** Registration also signs the user in (the API sets the session cookie). */
export function useRegister(): UseMutationResult<AuthUserResponse, Error, RegisterRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RegisterRequest) =>
      apiJson('/api/auth/register', authUserResponseSchema, { method: 'POST', body }),
    onSuccess: ({ user }) => {
      queryClient.setQueryData<AuthUser | null>(meQueryKey, user);
    },
  });
}

export const AFTER_LOGOUT_PATH = '/';

export function useLogout(): UseMutationResult<void, Error, void> {
  const queryClient = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: () => apiNoContent('/api/auth/logout', { method: 'POST' }),
    onSuccess: async () => {
      try {
        // Leave first: clearing the user while a protected page is mounted would make its guard
        // redirect to the login page with `next` pointing back at it.
        await router.replace(AFTER_LOGOUT_PATH);
      } finally {
        // Everything cached belonged to the previous user.
        queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== meQueryKey[0] });
        queryClient.setQueryData<AuthUser | null>(meQueryKey, null);
      }
    },
  });
}

import {
  marketFormResponseSchema,
  marketListResponseSchema,
  projectDetailResponseSchema,
  projectListResponseSchema,
  startRunResponseSchema,
  type CreateProjectRequest,
  type DefinitionRef,
  type MarketFormResponse,
  type MarketListResponse,
  type ProjectDetailResponse,
  type ProjectListResponse,
  type PutFactFormRequest,
  type StartRunRequest,
  type StartRunResponse,
  type UpdateProjectRequest,
} from '@evidomo/shared';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { apiJson } from './api';

export const projectsKey = ['projects'] as const;
export const projectKey = (projectId: string) => ['projects', projectId] as const;
export const marketsKey = ['markets'] as const;
export const marketKey = (ref: DefinitionRef) => ['markets', ref.id, ref.version] as const;

// Definitions only change with a deploy, so a long-lived cache avoids refetching on every visit.
const DEFINITION_STALE_MS = 5 * 60_000;

export function useProjects(): UseQueryResult<ProjectListResponse> {
  return useQuery({
    queryKey: projectsKey,
    queryFn: ({ signal }) => apiJson('/api/projects', projectListResponseSchema, { signal }),
  });
}

export function useProject(projectId: string | undefined): UseQueryResult<ProjectDetailResponse> {
  return useQuery({
    queryKey: projectKey(projectId ?? ''),
    queryFn: ({ signal }) =>
      apiJson(`/api/projects/${projectId}`, projectDetailResponseSchema, { signal }),
    enabled: projectId !== undefined,
  });
}

export function useMarkets(): UseQueryResult<MarketListResponse> {
  return useQuery({
    queryKey: marketsKey,
    queryFn: ({ signal }) => apiJson('/api/markets', marketListResponseSchema, { signal }),
    staleTime: DEFINITION_STALE_MS,
  });
}

export function useMarketForm(ref: DefinitionRef | undefined): UseQueryResult<MarketFormResponse> {
  return useQuery({
    queryKey: ref === undefined ? ['markets', 'none'] : marketKey(ref),
    queryFn: ({ signal }) =>
      apiJson(`/api/markets/${ref?.id}/${ref?.version}`, marketFormResponseSchema, { signal }),
    enabled: ref !== undefined,
    staleTime: DEFINITION_STALE_MS,
  });
}

/** Every project mutation answers with the full detail, which replaces the cached copy. */
function useStoreDetail(): (detail: ProjectDetailResponse) => void {
  const queryClient = useQueryClient();
  return (detail) => {
    queryClient.setQueryData(projectKey(detail.project.id), detail);
    // `exact`: the list key is a prefix of every project's key.
    void queryClient.invalidateQueries({ queryKey: projectsKey, exact: true });
  };
}

export function useCreateProject(): UseMutationResult<
  ProjectDetailResponse,
  Error,
  CreateProjectRequest
> {
  const store = useStoreDetail();
  return useMutation({
    mutationFn: (body: CreateProjectRequest) =>
      apiJson('/api/projects', projectDetailResponseSchema, { method: 'POST', body }),
    onSuccess: store,
  });
}

export function useUpdateProject(
  projectId: string,
): UseMutationResult<ProjectDetailResponse, Error, UpdateProjectRequest> {
  const store = useStoreDetail();
  return useMutation({
    mutationFn: (body: UpdateProjectRequest) =>
      apiJson(`/api/projects/${projectId}`, projectDetailResponseSchema, {
        method: 'PATCH',
        body,
      }),
    onSuccess: store,
  });
}

export function useSaveFactForm(
  projectId: string,
): UseMutationResult<ProjectDetailResponse, Error, PutFactFormRequest> {
  const store = useStoreDetail();
  return useMutation({
    mutationFn: (body: PutFactFormRequest) =>
      apiJson(`/api/projects/${projectId}/fact-form`, projectDetailResponseSchema, {
        method: 'PUT',
        body,
      }),
    onSuccess: store,
  });
}

export function useStartRun(
  projectId: string,
): UseMutationResult<StartRunResponse, Error, StartRunRequest> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request) =>
      apiJson(`/api/projects/${projectId}/runs`, startRunResponseSchema, {
        method: 'POST',
        body: request,
      }),
    // Returned, so the mutation stays pending until the refetch lands: success changes the lock
    // and the active run; not_ready and run_active mean our copy of the readiness was stale.
    onSettled: async () => {
      void queryClient.invalidateQueries({ queryKey: projectsKey, exact: true });
      await queryClient.invalidateQueries({ queryKey: projectKey(projectId) });
    },
  });
}

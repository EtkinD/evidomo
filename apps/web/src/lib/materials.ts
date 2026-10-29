import { type ProjectDetailResponse } from '@evidomo/shared';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { apiNoContent } from './api';
import { projectKey, projectsKey } from './projects';
import { uploadMaterial } from './upload';

/**
 * Refetches the project detail (materials and readiness) and the project list. Resolves when the
 * detail is fresh, so a caller can wait for the new readiness before moving on.
 */
export function useRefreshProject(projectId: string): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    void queryClient.invalidateQueries({ queryKey: projectsKey, exact: true });
    await queryClient.invalidateQueries({ queryKey: projectKey(projectId) });
  };
}

export function useDeleteMaterial(projectId: string): UseMutationResult<void, Error, string> {
  const refresh = useRefreshProject(projectId);
  return useMutation({
    mutationFn: (materialId: string) =>
      apiNoContent(`/api/projects/${projectId}/materials/${materialId}`, { method: 'DELETE' }),
    // Returned so the mutation stays pending until the new readiness is in.
    onSettled: refresh,
  });
}

export interface VoiceMemoUpload {
  blob: Blob;
  contentType: string;
  onProgress: (fraction: number) => void;
  signal?: AbortSignal;
}

/** `PUT` replaces an existing walkthrough, so there is one upload path for record and re-record. */
export function useUploadVoiceMemo(
  projectId: string,
): UseMutationResult<ProjectDetailResponse['materials'][number], Error, VoiceMemoUpload> {
  const refresh = useRefreshProject(projectId);
  return useMutation({
    mutationFn: async (upload: VoiceMemoUpload) => {
      const { material } = await uploadMaterial({
        path: `/api/projects/${projectId}/materials/voice-memo`,
        method: 'PUT',
        body: upload.blob,
        contentType: upload.contentType,
        onProgress: upload.onProgress,
        ...(upload.signal === undefined ? {} : { signal: upload.signal }),
      });
      return material;
    },
    onSettled: refresh,
  });
}

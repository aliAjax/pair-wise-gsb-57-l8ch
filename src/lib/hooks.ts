'use client'

import { useEffect } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query'
import { trpc } from './trpc'
import { loadWorkspace, saveWorkspace } from './localStore'
import type { WorkspaceState } from '@/types/domain'

export const workspaceQueryKey = ['privacy-workspace'] as const

export function useWorkspaceQuery() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: workspaceQueryKey,
    queryFn: () => trpc.workspace.defaults.query(),
    staleTime: Number.POSITIVE_INFINITY,
  })

  useEffect(() => {
    const cached = loadWorkspace()
    if (cached) queryClient.setQueryData(workspaceQueryKey, cached)
  }, [queryClient])

  useEffect(() => {
    if (query.data) saveWorkspace(query.data)
  }, [query.data])

  return query
}

type FullInput<TClient> = TClient & {
  state: WorkspaceState
  expectedRevision: number
}

/**
 * 所有写操作自动携带读取时的 revision；服务端若发现期间工作区已变化会拒绝写入，
 * 避免后到动作覆盖已经回执的项。
 */
function useWorkspaceMutation<TClient>(
  sender: (input: FullInput<TClient>) => Promise<WorkspaceState>,
): UseMutationResult<WorkspaceState, Error, TClient> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (clientInput: TClient) => {
      const state =
        queryClient.getQueryData<WorkspaceState>(workspaceQueryKey) ?? loadWorkspace()
      if (!state) throw new Error('本地工作区尚未加载')
      return sender({
        ...(clientInput as object),
        state,
        expectedRevision: state.revision,
      } as FullInput<TClient>)
    },
    onSuccess: (state) => {
      saveWorkspace(state)
      queryClient.setQueryData(workspaceQueryKey, state)
    },
  })
}

type ClientOf<TProcedure> = Omit<
  Parameters<TProcedure extends (...args: never[]) => unknown ? TProcedure : never>[0],
  'state' | 'expectedRevision'
>

export function useCreateRequestMutation() {
  return useWorkspaceMutation<ClientOf<typeof trpc.request.create.mutate>>((input) =>
    trpc.request.create.mutate(input),
  )
}

export function useSaveRequestMutation() {
  return useWorkspaceMutation<ClientOf<typeof trpc.request.save.mutate>>((input) =>
    trpc.request.save.mutate(input),
  )
}

export function useVerifyIdentityMutation() {
  return useWorkspaceMutation<ClientOf<typeof trpc.request.verifyIdentity.mutate>>((input) =>
    trpc.request.verifyIdentity.mutate(input),
  )
}

export function useAssignTaskMutation() {
  return useWorkspaceMutation<ClientOf<typeof trpc.request.assignTask.mutate>>((input) =>
    trpc.request.assignTask.mutate(input),
  )
}

export function useTaskActionMutation() {
  return useWorkspaceMutation<ClientOf<typeof trpc.request.taskAction.mutate>>((input) =>
    trpc.request.taskAction.mutate(input),
  )
}

export function useAddEvidenceMutation() {
  return useWorkspaceMutation<ClientOf<typeof trpc.request.addEvidence.mutate>>((input) =>
    trpc.request.addEvidence.mutate(input),
  )
}

export function useAddConflictMutation() {
  return useWorkspaceMutation<ClientOf<typeof trpc.request.addConflict.mutate>>((input) =>
    trpc.request.addConflict.mutate(input),
  )
}

export function useResolveConflictMutation() {
  return useWorkspaceMutation<ClientOf<typeof trpc.request.resolveConflict.mutate>>((input) =>
    trpc.request.resolveConflict.mutate(input),
  )
}

export function useExtendRequestMutation() {
  return useWorkspaceMutation<ClientOf<typeof trpc.request.extend.mutate>>((input) =>
    trpc.request.extend.mutate(input),
  )
}

export function useCloseRequestMutation() {
  return useWorkspaceMutation<ClientOf<typeof trpc.request.close.mutate>>((input) =>
    trpc.request.close.mutate(input),
  )
}

export function useLiftRestrictionMutation() {
  return useWorkspaceMutation<ClientOf<typeof trpc.request.liftRestriction.mutate>>((input) =>
    trpc.request.liftRestriction.mutate(input),
  )
}

export function useAddCommentMutation() {
  return useWorkspaceMutation<ClientOf<typeof trpc.request.comment.mutate>>((input) =>
    trpc.request.comment.mutate(input),
  )
}

export function useRecordExportMutation() {
  return useWorkspaceMutation<ClientOf<typeof trpc.request.recordExport.mutate>>((input) =>
    trpc.request.recordExport.mutate(input),
  )
}

export function useCreateDispatchBatchMutation() {
  return useWorkspaceMutation<{ operator: string }>(({ operator, state, expectedRevision }) =>
    trpc.dispatch.createBatch.mutate({ operator, state, expectedRevision }),
  )
}

export function useRetryDispatchBatchMutation() {
  return useWorkspaceMutation<ClientOf<typeof trpc.dispatch.retryBatch.mutate>>((input) =>
    trpc.dispatch.retryBatch.mutate(input),
  )
}

export function useSetSystemStatusMutation() {
  return useWorkspaceMutation<ClientOf<typeof trpc.dispatch.setSystemStatus.mutate>>((input) =>
    trpc.dispatch.setSystemStatus.mutate(input),
  )
}

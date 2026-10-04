import { TRPCError, initTRPC } from '@trpc/server'
import {
  addComment,
  addConflict,
  addEvidence,
  assignTask,
  closeRequest,
  createRequest,
  extendRequest,
  liftRestriction,
  recordExport,
  resolveConflict,
  saveRequest,
  taskAction,
  verifyIdentity,
  RevisionConflictError,
} from '@/services/requestService'
import {
  createDispatchBatch,
  retryDispatchBatch,
  setSystemStatus,
} from '@/services/scheduler'
import { createInitialState } from '@/services/mockData'
import {
  assignTaskInputSchema,
  closeRequestInputSchema,
  commentInputSchema,
  conflictInputSchema,
  createDispatchBatchInputSchema,
  createRequestInputSchema,
  evidenceInputSchema,
  extendRequestInputSchema,
  identityInputSchema,
  liftRestrictionInputSchema,
  recordExportInputSchema,
  resolveConflictInputSchema,
  retryDispatchBatchInputSchema,
  saveRequestInputSchema,
  setSystemStatusInputSchema,
  taskActionInputSchema,
} from '@/lib/schemas'
import type { WorkspaceState } from '@/types/domain'

const t = initTRPC.create()
const publicProcedure = t.procedure

function execute(operation: () => WorkspaceState): WorkspaceState {
  try {
    return operation()
  } catch (error) {
    if (error instanceof RevisionConflictError) {
      throw new TRPCError({ code: 'CONFLICT', message: error.message })
    }
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: error instanceof Error ? error.message : '请求处理失败',
    })
  }
}

export const appRouter = t.router({
  workspace: t.router({
    defaults: publicProcedure.query(() => createInitialState()),
  }),
  request: t.router({
    create: publicProcedure
      .input(createRequestInputSchema)
      .mutation(({ input }) =>
        execute(() => createRequest(input.state, input.input, input.operator)),
      ),
    save: publicProcedure
      .input(saveRequestInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          saveRequest(
            input.state,
            input.requestId,
            input.patch,
            input.operator,
            input.expectedRevision,
          ),
        ),
      ),
    verifyIdentity: publicProcedure
      .input(identityInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          verifyIdentity(
            input.state,
            input.requestId,
            input.status,
            input.note,
            input.operator,
            input.expectedRevision,
          ),
        ),
      ),
    assignTask: publicProcedure
      .input(assignTaskInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          assignTask(
            input.state,
            input.requestId,
            input.taskId,
            input.assignee,
            input.operator,
            input.expectedRevision,
          ),
        ),
      ),
    taskAction: publicProcedure
      .input(taskActionInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          taskAction(
            input.state,
            input.requestId,
            input.taskId,
            input.action,
            input.note,
            input.operator,
            input.expectedRevision,
          ),
        ),
      ),
    addEvidence: publicProcedure
      .input(evidenceInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          addEvidence(
            input.state,
            input.requestId,
            input.taskId,
            input.name,
            input.evidenceType,
            input.operator,
            input.expectedRevision,
          ),
        ),
      ),
    addConflict: publicProcedure
      .input(conflictInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          addConflict(
            input.state,
            input.requestId,
            input.conflict,
            input.operator,
            input.expectedRevision,
          ),
        ),
      ),
    resolveConflict: publicProcedure
      .input(resolveConflictInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          resolveConflict(
            input.state,
            input.requestId,
            input.conflictIndex,
            input.resolution,
            input.operator,
            input.expectedRevision,
          ),
        ),
      ),
    extend: publicProcedure
      .input(extendRequestInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          extendRequest(
            input.state,
            input.requestId,
            input.days,
            input.reason,
            input.operator,
            input.expectedRevision,
          ),
        ),
      ),
    close: publicProcedure
      .input(closeRequestInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          closeRequest(
            input.state,
            input.requestId,
            input.resultSummary,
            input.closureReason,
            input.operator,
            input.expectedRevision,
          ),
        ),
      ),
    liftRestriction: publicProcedure
      .input(liftRestrictionInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          liftRestriction(
            input.state,
            input.requestId,
            input.reason,
            input.operator,
            input.expectedRevision,
          ),
        ),
      ),
    comment: publicProcedure
      .input(commentInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          addComment(
            input.state,
            input.requestId,
            input.content,
            input.operator,
            input.expectedRevision,
          ),
        ),
      ),
    recordExport: publicProcedure
      .input(recordExportInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          recordExport(input.state, input.scope, input.count, input.operator),
        ),
      ),
  }),
  dispatch: t.router({
    createBatch: publicProcedure
      .input(createDispatchBatchInputSchema)
      .mutation(({ input }) =>
        execute(() => createDispatchBatch(input.state, input.operator)),
      ),
    retryBatch: publicProcedure
      .input(retryDispatchBatchInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          retryDispatchBatch(input.state, input.batchId, input.operator),
        ),
      ),
    setSystemStatus: publicProcedure
      .input(setSystemStatusInputSchema)
      .mutation(({ input }) =>
        execute(() =>
          setSystemStatus(
            input.state,
            input.systemId,
            input.status,
            input.operator,
          ),
        ),
      ),
  }),
})

export type AppRouter = typeof appRouter

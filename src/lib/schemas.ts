import { z } from 'zod'

export const requestTypeSchema = z.enum([
  'access',
  'rectification',
  'deletion',
  'withdraw-consent',
  'restriction',
])

export const requestStatusSchema = z.enum([
  'registered',
  'identity-review',
  'processing',
  'review-required',
  'pending-close',
  'completed',
  'rejected',
  'extended',
])

export const regionSchema = z.enum(['cn', 'eu', 'us', 'sg'])

export const identitySchema = z.object({
  status: z.enum(['pending', 'verified', 'insufficient']),
  materialType: z.enum(['masked-id', 'account-ownership', 'authorization-letter', 'none']),
  maskedReference: z.string(),
  protectedDigest: z.string(),
  note: z.string(),
  reviewedAt: z.string().optional(),
})

export const taskStatusSchema = z.enum([
  'pending',
  'active',
  'completed',
  'blocked',
  'suspended',
])

export const workflowStepSchema = z.object({
  id: z.string(),
  order: z.number(),
  name: z.string(),
  role: z.string(),
  systemId: z.string().optional(),
  status: taskStatusSchema,
  assignee: z.string(),
  dueAt: z.string(),
  completedAt: z.string().optional(),
  exceptionReason: z.string(),
  // 排程：该任务在数据主体任务序列中的登记顺序（按原登记时间稳定排序）。
  registeredSequence: z.number().optional(),
  // 暂缓依据：非空表示任务当前被限制处理请求挂起，停在待复核，禁止下发数据系统。
  heldByRequestId: z.string().optional(),
  heldByRequestCode: z.string().optional(),
  heldReason: z.string().optional(),
  heldAt: z.string().optional(),
  // 下发批次与回执：已成功回执的项不可被后续动作覆盖。
  dispatchBatchId: z.string().optional(),
  dispatchedAt: z.string().optional(),
  deliveryAttempts: z.number().optional(),
  acknowledged: z.boolean().optional(),
  acknowledgedAt: z.string().optional(),
  receiptReference: z.string().optional(),
})

export const evidenceSchema = z.object({
  id: z.string(),
  stepId: z.string(),
  name: z.string(),
  evidenceType: z.enum(['execution-log', 'screenshot', 'signed-record', 'system-response']),
  digest: z.string(),
  uploadedBy: z.string(),
  uploadedAt: z.string(),
  protected: z.literal(true),
})

export const commentSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  author: z.string(),
  content: z.string(),
  createdAt: z.string(),
})

export const auditEntrySchema = z.object({
  id: z.string(),
  requestId: z.string().optional(),
  action: z.string(),
  operator: z.string(),
  detail: z.string(),
  createdAt: z.string(),
})

export const dataSystemSchema = z.object({
  id: z.string(),
  name: z.string(),
  owner: z.string(),
  dataDomain: z.string(),
  transferMethod: z.string(),
  slaDays: z.number(),
  requestTypes: z.array(requestTypeSchema),
  status: z.enum(['active', 'maintenance', 'retired']),
})

// 限制处理请求的生命周期：未生效、生效中、到期解除、撤回解除。
export const restrictionStatusSchema = z.enum([
  'pending',
  'active',
  'expired',
  'withdrawn',
])

export const restrictionLifecycleSchema = z.object({
  status: restrictionStatusSchema,
  effectiveAt: z.string().optional(),
  expiresAt: z.string().optional(),
  durationDays: z.number().int().positive(),
  liftedAt: z.string().optional(),
  liftReason: z.string().optional(),
  liftedBy: z.string().optional(),
  // 因该限制被暂缓的任务（保留历史，解除后保留记录以维持可追溯）。
  suspendedTaskRefs: z
    .array(
      z.object({
        requestId: z.string(),
        requestCode: z.string(),
        taskId: z.string(),
        taskName: z.string(),
        heldAt: z.string(),
        releasedAt: z.string().optional(),
      }),
    )
    .default([]),
})

export const privacyRequestSchema = z.object({
  id: z.string(),
  code: z.string(),
  requesterName: z.string(),
  requesterContact: z.string(),
  region: regionSchema,
  type: requestTypeSchema,
  status: requestStatusSchema,
  identity: identitySchema,
  requestedAt: z.string(),
  dueAt: z.string(),
  extendedDays: z.number(),
  duplicateOf: z.string().optional(),
  affectedSystemIds: z.array(z.string()),
  tasks: z.array(workflowStepSchema),
  evidence: z.array(evidenceSchema),
  conflicts: z.array(z.string()),
  resultSummary: z.string(),
  closureReason: z.string(),
  restriction: restrictionLifecycleSchema.optional(),
  audit: z.array(
    auditEntrySchema.omit({ requestId: true }),
  ),
})

export const dispatchItemStatusSchema = z.enum([
  'pending', // 在批次中，尚未成功送达（含失败待补送）
  'delivered', // 已送达并取得回执，不再重发
  'held', // 下发时发现限制处理生效，暂缓待复核
  'failed', // 系统维护/接口失败，等待按检查点补送
])

export const dispatchItemSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  requestCode: z.string(),
  taskId: z.string(),
  taskName: z.string(),
  systemId: z.string(),
  systemName: z.string(),
  subjectContact: z.string(),
  status: dispatchItemStatusSchema,
  registeredSequence: z.number(),
  attempts: z.number(),
  lastAttemptAt: z.string().optional(),
  deliveredAt: z.string().optional(),
  receiptReference: z.string().optional(),
  failureReason: z.string().optional(),
  heldByRequestCode: z.string().optional(),
})

export const dispatchBatchSchema = z.object({
  id: z.string(),
  code: z.string(),
  createdAt: z.string(),
  createdBy: z.string(),
  status: z.enum(['open', 'completed']),
  // 检查点：记录已送达/未送达/暂缓项，维护或接口失败后据此只补未送达项。
  checkpointUpdatedAt: z.string(),
  items: z.array(dispatchItemSchema),
  audit: z.array(
    z.object({
      at: z.string(),
      operator: z.string(),
      detail: z.string(),
    }),
  ),
})

export const workspaceStateSchema = z.object({
  requests: z.array(privacyRequestSchema),
  systems: z.array(dataSystemSchema),
  comments: z.array(commentSchema),
  audit: z.array(auditEntrySchema),
  dispatchBatches: z.array(dispatchBatchSchema).default([]),
  revision: z.number(),
})

const stateRevisionShape = {
  state: workspaceStateSchema,
  expectedRevision: z.number().int().optional(),
}

export const saveRequestInputSchema = z.object({
  ...stateRevisionShape,
  requestId: z.string(),
  patch: privacyRequestSchema.partial(),
  operator: z.string().default('当前用户'),
})

export const createRequestInputSchema = z.object({
  state: workspaceStateSchema,
  input: z.object({
    requesterName: z.string().min(2),
    requesterContact: z.string().min(5),
    region: regionSchema,
    type: requestTypeSchema,
    affectedSystemIds: z.array(z.string()).min(1),
    identityMaterialType: identitySchema.shape.materialType,
    identityReference: z.string(),
    note: z.string(),
    restrictionDurationDays: z.number().int().min(1).max(180).optional(),
  }),
  operator: z.string().default('客服专员'),
})

export const identityInputSchema = z.object({
  ...stateRevisionShape,
  requestId: z.string(),
  status: z.enum(['verified', 'insufficient']),
  note: z.string(),
  operator: z.string(),
})

export const assignTaskInputSchema = z.object({
  ...stateRevisionShape,
  requestId: z.string(),
  taskId: z.string(),
  assignee: z.string().min(2),
  operator: z.string(),
})

export const taskActionInputSchema = z.object({
  ...stateRevisionShape,
  requestId: z.string(),
  taskId: z.string(),
  action: z.enum(['start', 'complete', 'block']),
  note: z.string(),
  operator: z.string(),
})

export const evidenceInputSchema = z.object({
  ...stateRevisionShape,
  requestId: z.string(),
  taskId: z.string(),
  name: z.string().min(2),
  evidenceType: evidenceSchema.shape.evidenceType,
  operator: z.string(),
})

export const conflictInputSchema = z.object({
  ...stateRevisionShape,
  requestId: z.string(),
  conflict: z.string().min(4),
  operator: z.string(),
})

export const resolveConflictInputSchema = z.object({
  ...stateRevisionShape,
  requestId: z.string(),
  conflictIndex: z.number().int().nonnegative(),
  resolution: z.string().min(4),
  operator: z.string(),
})

export const closeRequestInputSchema = z.object({
  ...stateRevisionShape,
  requestId: z.string(),
  resultSummary: z.string().min(4),
  closureReason: z.string(),
  operator: z.string(),
})

export const extendRequestInputSchema = z.object({
  ...stateRevisionShape,
  requestId: z.string(),
  days: z.number().int().min(1).max(90),
  reason: z.string().min(4),
  operator: z.string(),
})

export const commentInputSchema = z.object({
  ...stateRevisionShape,
  requestId: z.string(),
  content: z.string().min(2),
  operator: z.string(),
})

export const recordExportInputSchema = z.object({
  state: workspaceStateSchema,
  scope: z.string(),
  count: z.number().int().nonnegative(),
  operator: z.string(),
})

export const liftRestrictionInputSchema = z.object({
  ...stateRevisionShape,
  requestId: z.string(),
  reason: z.string().min(4),
  operator: z.string(),
})

export const createDispatchBatchInputSchema = z.object({
  ...stateRevisionShape,
  operator: z.string(),
})

export const retryDispatchBatchInputSchema = z.object({
  ...stateRevisionShape,
  batchId: z.string(),
  operator: z.string(),
})

export const setSystemStatusInputSchema = z.object({
  ...stateRevisionShape,
  systemId: z.string(),
  status: dataSystemSchema.shape.status,
  operator: z.string(),
})

export type RequestType = z.infer<typeof requestTypeSchema>
export type RequestStatus = z.infer<typeof requestStatusSchema>
export type Region = z.infer<typeof regionSchema>
export type IdentityCheck = z.infer<typeof identitySchema>
export type TaskStatus = z.infer<typeof taskStatusSchema>
export type WorkflowStep = z.infer<typeof workflowStepSchema>
export type ExecutionEvidence = z.infer<typeof evidenceSchema>
export type ReviewComment = z.infer<typeof commentSchema>
export type AuditEntry = z.infer<typeof auditEntrySchema>
export type DataSystem = z.infer<typeof dataSystemSchema>
export type RestrictionLifecycle = z.infer<typeof restrictionLifecycleSchema>
export type PrivacyRequest = z.infer<typeof privacyRequestSchema>
export type DispatchItemStatus = z.infer<typeof dispatchItemStatusSchema>
export type DispatchItem = z.infer<typeof dispatchItemSchema>
export type DispatchBatch = z.infer<typeof dispatchBatchSchema>
export type WorkspaceState = z.infer<typeof workspaceStateSchema>

export const requestTypeLabels: Record<RequestType, string> = {
  access: '访问',
  rectification: '更正',
  deletion: '删除',
  'withdraw-consent': '撤回同意',
  restriction: '限制处理',
}

export const requestStatusLabels: Record<RequestStatus, string> = {
  registered: '已登记',
  'identity-review': '身份核验中',
  processing: '履约处理中',
  'review-required': '复核队列',
  'pending-close': '待关闭',
  completed: '已完成',
  rejected: '已拒绝',
  extended: '已延期',
}

export const taskStatusLabels: Record<TaskStatus, string> = {
  pending: '待下发',
  active: '执行中',
  completed: '已完成',
  blocked: '已阻断',
  suspended: '暂缓待复核',
}

export const restrictionStatusLabels: Record<RestrictionLifecycle['status'], string> = {
  pending: '未生效',
  active: '限制生效中',
  expired: '到期解除',
  withdrawn: '撤回解除',
}

export const dispatchItemStatusLabels: Record<DispatchItemStatus, string> = {
  pending: '待送达',
  delivered: '已送达回执',
  held: '限制暂缓',
  failed: '送达失败',
}

export const regionLabels: Record<Region, string> = {
  cn: '中国大陆',
  eu: '欧盟',
  us: '美国加州',
  sg: '新加坡',
}

export const systemStatusLabels: Record<DataSystem['status'], string> = {
  active: '在用',
  maintenance: '维护中',
  retired: '已退役',
}

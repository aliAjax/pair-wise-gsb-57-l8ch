import type {
  IdentityCheck,
  PrivacyRequest,
  RequestStatus,
  RequestType,
  WorkspaceState,
} from '@/types/domain'
import { addDays, buildWorkflowSteps, responseDays } from './workflow'
import {
  assignRegisteredSequences,
  releaseHeldTasks,
  synchronizeScheduling,
} from './scheduler'

const cloneState = (state: WorkspaceState): WorkspaceState => structuredClone(state)
const now = () => new Date().toISOString()
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`
const DEFAULT_RESTRICTION_DAYS = 30

function digest(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `PD-${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

export class RevisionConflictError extends Error {}

/**
 * 并发保护：后到动作必须识别新状态。调用方携带读取时的 revision，
 * 期间工作区被其他操作改动则拒绝本次写入，避免覆盖已经回执的项。
 */
function prepareState(
  state: WorkspaceState,
  expectedRevision?: number,
): WorkspaceState {
  if (expectedRevision !== undefined && state.revision !== expectedRevision) {
    throw new RevisionConflictError(
      `工作区版本已变化（当前 ${state.revision}，操作基于 ${expectedRevision}），请刷新后重试，已回执项不会被覆盖。`,
    )
  }
  const draft = cloneState(state)
  if (!draft.dispatchBatches) draft.dispatchBatches = []
  // 每个变更操作前先同步排程：限制到期/生效、批次检查点对齐。
  synchronizeScheduling(draft)
  return draft
}

function appendAudit(
  state: WorkspaceState,
  request: PrivacyRequest,
  action: string,
  operator: string,
  detail: string,
) {
  const entry = {
    id: id('audit'),
    requestId: request.id,
    action,
    operator,
    detail,
    createdAt: now(),
  }
  state.audit.unshift(entry)
  request.audit.unshift({
    id: entry.id,
    action,
    operator,
    detail,
    createdAt: entry.createdAt,
  })
}

function mutateRequest(
  state: WorkspaceState,
  requestId: string,
  mutation: (request: PrivacyRequest, draft: WorkspaceState) => void,
  audit: { action: string; operator: string; detail: string },
  expectedRevision?: number,
): WorkspaceState {
  const draft = prepareState(state, expectedRevision)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  mutation(request, draft)
  synchronizeScheduling(draft, { operator: audit.operator })
  appendAudit(draft, request, audit.action, audit.operator, audit.detail)
  draft.revision += 1
  return draft
}

/** 解除限制后，按请求当前冲突/核验情况重算复核状态。 */
function recomputeStatus(request: PrivacyRequest): void {
  if (['completed', 'rejected'].includes(request.status)) return
  const stillHeld = request.tasks.some((task) => task.heldByRequestId)
  request.status =
    request.conflicts.length || request.identity.status === 'insufficient' || stillHeld
      ? 'review-required'
      : request.identity.status === 'verified'
        ? 'processing'
        : 'identity-review'
}

export interface CreateRequestInput {
  requesterName: string
  requesterContact: string
  region: keyof typeof responseDays
  type: RequestType
  affectedSystemIds: string[]
  identityMaterialType: IdentityCheck['materialType']
  identityReference: string
  note: string
  restrictionDurationDays?: number
}

export function createRequest(
  state: WorkspaceState,
  input: CreateRequestInput,
  operator: string,
): WorkspaceState {
  const draft = prepareState(state)
  const requestedAt = now()
  const dueAt = addDays(new Date(requestedAt), responseDays[input.region]).toISOString()
  const duplicate = draft.requests.find(
    (request) =>
      request.requesterContact === input.requesterContact &&
      request.type === input.type &&
      !['completed', 'rejected'].includes(request.status),
  )
  const identityInsufficient =
    input.identityMaterialType === 'none' || input.identityReference.trim().length < 6
  const status: RequestStatus = identityInsufficient || duplicate ? 'review-required' : 'identity-review'
  const nextNumber =
    Math.max(
      0,
      ...draft.requests.map((request) => Number(request.code.split('-').at(-1)) || 0),
    ) + 1
  const requestId = id('request')
  const durationDays = input.restrictionDurationDays ?? DEFAULT_RESTRICTION_DAYS
  const request: PrivacyRequest = {
    id: requestId,
    code: `DSR-2026-${String(nextNumber).padStart(3, '0')}`,
    requesterName: input.requesterName.trim(),
    requesterContact: input.requesterContact.trim(),
    region: input.region,
    type: input.type,
    status,
    identity: {
      status: identityInsufficient ? 'insufficient' : 'pending',
      materialType: input.identityMaterialType,
      maskedReference: input.identityReference.trim(),
      protectedDigest: digest(input.identityReference),
      note: input.note.trim(),
    },
    requestedAt,
    dueAt,
    extendedDays: 0,
    duplicateOf: duplicate?.code,
    affectedSystemIds: [...input.affectedSystemIds],
    tasks: buildWorkflowSteps({
      requestId,
      type: input.type,
      systemIds: input.affectedSystemIds,
      requestedAt,
      dueAt,
      initialStatus: 'identity-review',
      systems: draft.systems,
    }),
    evidence: [],
    conflicts: [],
    resultSummary: '',
    closureReason: '',
    restriction:
      input.type === 'restriction'
        ? {
            status: 'pending',
            durationDays,
            suspendedTaskRefs: [],
          }
        : undefined,
    audit: [],
  }
  if (identityInsufficient) {
    request.conflicts.push('身份材料不足：需要补充可核验的身份或授权关系证明。')
    const identityTask = request.tasks.find((task) => task.id.endsWith('-identity'))
    if (identityTask) {
      identityTask.status = 'blocked'
      identityTask.exceptionReason = '身份材料不足，等待复核。'
    }
  }
  if (duplicate) {
    request.conflicts.push(`疑似重复请求：与 ${duplicate.code} 的请求人和请求类型相同。`)
  }
  draft.requests.unshift(request)
  assignRegisteredSequences(draft)
  synchronizeScheduling(draft, { operator })
  appendAudit(
    draft,
    request,
    '登记隐私请求',
    operator,
    `按 ${responseDays[input.region]} 日模板登记，涉及 ${input.affectedSystemIds.length} 个系统${
      input.type === 'restriction' ? `；限制期限预登记为 ${durationDays} 天，身份核验通过后生效。` : ''
    }。`,
  )
  draft.revision += 1
  return draft
}

export function saveRequest(
  state: WorkspaceState,
  requestId: string,
  patch: Partial<PrivacyRequest>,
  operator: string,
  expectedRevision?: number,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      Object.assign(request, patch)
      request.audit = request.audit
    },
    { action: '更新请求信息', operator, detail: '更新申请人、地区、请求类型或涉及系统。' },
    expectedRevision,
  )
}

export function verifyIdentity(
  state: WorkspaceState,
  requestId: string,
  status: 'verified' | 'insufficient',
  note: string,
  operator: string,
  expectedRevision?: number,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request, draft) => {
      request.identity.status = status
      request.identity.note = note
      request.identity.reviewedAt = now()
      const identityTask = request.tasks.find((task) => task.id.endsWith('-identity'))
      if (status === 'verified') {
        if (identityTask) {
          identityTask.status = 'completed'
          identityTask.completedAt = now()
          identityTask.exceptionReason = ''
        }
        request.conflicts = request.conflicts.filter(
          (conflict) => !conflict.startsWith('身份材料不足'),
        )
        if (request.type === 'restriction') {
          // 身份核验通过，限制处理即时生效，排程同步会挂起同一数据主体的清除/更正任务。
          const effectiveAt = now()
          request.restriction = {
            status: 'active',
            effectiveAt,
            expiresAt: addDays(
              new Date(effectiveAt),
              request.restriction?.durationDays ?? DEFAULT_RESTRICTION_DAYS,
            ).toISOString(),
            durationDays: request.restriction?.durationDays ?? DEFAULT_RESTRICTION_DAYS,
            suspendedTaskRefs: request.restriction?.suspendedTaskRefs ?? [],
          }
        }
        const nextTask = request.tasks.find(
          (task) => task.status === 'pending' || task.status === 'suspended',
        )
        if (nextTask && nextTask.status === 'pending') nextTask.status = 'active'
        recomputeStatus(request)
        if (request.type === 'restriction' && request.restriction?.status === 'active') {
          appendAudit(
            draft,
            request,
            '限制处理生效',
            operator,
            `限制处理请求生效至 ${request.restriction.expiresAt}；同一数据主体的清除和更正任务停在待复核，不向数据系统下发。`,
          )
        }
      } else {
        if (identityTask) {
          identityTask.status = 'blocked'
          identityTask.exceptionReason = note
        }
        if (request.type === 'restriction' && request.restriction) {
          request.restriction.status = 'pending'
          request.restriction.effectiveAt = undefined
          request.restriction.expiresAt = undefined
          request.restriction.liftedAt = undefined
        }
        request.status = 'review-required'
        if (!request.conflicts.some((conflict) => conflict.startsWith('身份材料不足'))) {
          request.conflicts.push(`身份材料不足：${note}`)
        }
      }
    },
    {
      action: status === 'verified' ? '身份核验通过' : '身份材料退回',
      operator,
      detail: note,
    },
    expectedRevision,
  )
}

export function assignTask(
  state: WorkspaceState,
  requestId: string,
  taskId: string,
  assignee: string,
  operator: string,
  expectedRevision?: number,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      const task = request.tasks.find((item) => item.id === taskId)
      if (!task) throw new Error('任务不存在')
      if (task.acknowledged) {
        throw new Error('该任务已取得数据系统回执，责任人随回执锁定，不能再分派。')
      }
      // 暂缓任务允许分派给复核人员，但不能下发数据系统。
      task.assignee = assignee
    },
    { action: '分派履约任务', operator, detail: `任务 ${taskId} 分派给 ${assignee}。` },
    expectedRevision,
  )
}

export function taskAction(
  state: WorkspaceState,
  requestId: string,
  taskId: string,
  action: 'start' | 'complete' | 'block',
  note: string,
  operator: string,
  expectedRevision?: number,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      if (request.identity.status !== 'verified') {
        throw new Error('身份未核验通过，不能推进履约任务')
      }
      const task = request.tasks.find((item) => item.id === taskId)
      if (!task) throw new Error('任务不存在')
      if (action === 'start') {
        if (task.status === 'suspended') {
          throw new Error(
            `任务被限制处理请求 ${task.heldByRequestCode ?? ''} 暂缓，停在待复核，限制解除前不能开始或下发。`,
          )
        }
        if (task.acknowledged) {
          throw new Error('任务已取得数据系统回执，无需重复开始。')
        }
        task.status = 'active'
        task.exceptionReason = ''
      } else if (action === 'complete') {
        if (task.status === 'suspended') {
          throw new Error(
            `任务被限制处理请求 ${task.heldByRequestCode ?? ''} 暂缓，限制解除前不能完成或下发。`,
          )
        }
        if (task.status === 'completed' || task.acknowledged) {
          // 后到动作识别新状态：不能覆盖已经回执的项。
          throw new Error(
            `任务已于 ${task.acknowledgedAt ?? task.completedAt ?? '此前'} 完成${task.receiptReference ? `并取得回执 ${task.receiptReference}` : ''}，重复提交被拒绝，回执不被覆盖。`,
          )
        }
        task.status = 'completed'
        task.completedAt = now()
        task.exceptionReason = ''
        // 仅当所有更早的任务已完成（且无暂缓）时推进下一任务，保证顺序。
        const earlierPending = request.tasks.some(
          (item) => item.order < task.order && item.status !== 'completed',
        )
        const nextTask = request.tasks.find(
          (item) => item.order > task.order && item.status === 'pending' && !earlierPending,
        )
        if (nextTask) nextTask.status = 'active'
      } else {
        task.status = 'blocked'
        task.exceptionReason = note
        request.status = 'review-required'
        request.conflicts.push(`任务阻塞：${task.name}，${note}`)
      }
      const executableTasks = request.tasks.filter((item) => !item.id.endsWith('-close'))
      if (executableTasks.every((item) => item.status === 'completed')) {
        request.status = 'pending-close'
      } else if (action !== 'block') {
        recomputeStatus(request)
      }
    },
    {
      action:
        action === 'start' ? '开始履约任务' : action === 'complete' ? '完成履约任务' : '阻断履约任务',
      operator,
      detail: note || `${taskId} 状态更新为 ${action}。`,
    },
    expectedRevision,
  )
}

export function addEvidence(
  state: WorkspaceState,
  requestId: string,
  taskId: string,
  name: string,
  evidenceType: 'execution-log' | 'screenshot' | 'signed-record' | 'system-response',
  operator: string,
  expectedRevision?: number,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      const task = request.tasks.find((item) => item.id === taskId)
      if (!task) throw new Error('任务不存在')
      request.evidence.push({
        id: id('evidence'),
        stepId: taskId,
        name,
        evidenceType,
        digest: digest(`${name}-${now()}`),
        uploadedBy: operator,
        uploadedAt: now(),
        protected: true,
      })
    },
    {
      action: '上传执行证据',
      operator,
      detail: `${name} 已按受保护附件登记，保存摘要而非明文材料。`,
    },
    expectedRevision,
  )
}

export function addConflict(
  state: WorkspaceState,
  requestId: string,
  conflict: string,
  operator: string,
  expectedRevision?: number,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      request.conflicts.push(conflict)
      request.status = 'review-required'
    },
    { action: '标记冲突或例外', operator, detail: conflict },
    expectedRevision,
  )
}

export function resolveConflict(
  state: WorkspaceState,
  requestId: string,
  conflictIndex: number,
  resolution: string,
  operator: string,
  expectedRevision?: number,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      const conflict = request.conflicts[conflictIndex]
      if (!conflict) throw new Error('冲突项不存在')
      request.conflicts.splice(conflictIndex, 1)
      recomputeStatus(request)
    },
    { action: '复核处理冲突', operator, detail: resolution },
    expectedRevision,
  )
}

export function extendRequest(
  state: WorkspaceState,
  requestId: string,
  days: number,
  reason: string,
  operator: string,
  expectedRevision?: number,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      const base = new Date(request.dueAt) > new Date() ? new Date(request.dueAt) : new Date()
      request.dueAt = addDays(base, days).toISOString()
      request.extendedDays += days
      request.status = 'extended'
    },
    { action: '延期请求处理', operator, detail: `延期 ${days} 天：${reason}` },
    expectedRevision,
  )
}

export function closeRequest(
  state: WorkspaceState,
  requestId: string,
  resultSummary: string,
  closureReason: string,
  operator: string,
  expectedRevision?: number,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      if (request.identity.status !== 'verified') {
        throw new Error('身份核验尚未通过，不能关闭请求')
      }
      const requiredTasks = request.tasks.filter((task) => !task.id.endsWith('-close'))
      if (requiredTasks.some((task) => task.status !== 'completed')) {
        throw new Error('仍有未完成任务，不能关闭请求')
      }
      if (request.tasks.some((task) => task.heldByRequestId)) {
        throw new Error('仍存在被限制处理暂缓的任务，不能关闭请求')
      }
      if (request.conflicts.length) {
        throw new Error('仍有未解决冲突，不能关闭请求')
      }
      if (new Date(request.dueAt) > new Date() && !closureReason.trim()) {
        throw new Error('截止时间前关闭必须填写提前关闭理由')
      }
      request.resultSummary = resultSummary
      request.closureReason = closureReason
      request.status = 'completed'
      const closeTask = request.tasks.find((task) => task.id.endsWith('-close'))
      if (closeTask) {
        closeTask.status = 'completed'
        closeTask.completedAt = now()
      }
    },
    {
      action: '完成并关闭请求',
      operator,
      detail: closureReason ? `提前关闭理由：${closureReason}` : '截止时间后完成关闭。',
    },
    expectedRevision,
  )
}

/**
 * 管理员撤回限制处理。解除后等待任务按原登记顺序重新下发，
 * 已成功回执的清除/更正不受影响、不回滚。
 */
export function liftRestriction(
  state: WorkspaceState,
  requestId: string,
  reason: string,
  operator: string,
  expectedRevision?: number,
): WorkspaceState {
  const draft = prepareState(state, expectedRevision)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  if (request.type !== 'restriction' || !request.restriction) {
    throw new Error('该请求不是限制处理请求')
  }
  if (request.restriction.status !== 'active') {
    throw new Error(
      `限制处理当前状态为「${request.restriction.status}」，仅生效中的限制可以撤回解除。`,
    )
  }
  const at = now()
  request.restriction.status = 'withdrawn'
  request.restriction.liftedAt = at
  request.restriction.liftReason = reason
  request.restriction.liftedBy = operator
  releaseHeldTasks(draft, request, false, at)
  synchronizeScheduling(draft, { operator })
  appendAudit(
    draft,
    request,
    '撤回解除限制处理',
    operator,
    `限制处理请求被撤回解除：${reason} 等待任务按原登记顺序恢复下发，已回执项不受影响。`,
  )
  draft.revision += 1
  return draft
}

export function addComment(
  state: WorkspaceState,
  requestId: string,
  content: string,
  operator: string,
  expectedRevision?: number,
): WorkspaceState {
  const draft = prepareState(state, expectedRevision)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  draft.comments.unshift({
    id: id('comment'),
    requestId,
    author: operator,
    content,
    createdAt: now(),
  })
  appendAudit(draft, request, '提交处理意见', operator, content)
  draft.revision += 1
  return draft
}

export function recordExport(
  state: WorkspaceState,
  scope: string,
  count: number,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  draft.audit.unshift({
    id: id('audit'),
    action: '导出处理包',
    operator,
    detail: `导出范围：${scope}，包含 ${count} 条请求。`,
    createdAt: now(),
  })
  draft.revision += 1
  return draft
}

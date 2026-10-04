import type {
  DispatchBatch,
  DispatchItem,
  IdentityCheck,
  PrivacyRequest,
  RequestStatus,
  RequestType,
  WorkflowStep,
  WorkspaceState,
} from '@/types/domain'
import { addDays, buildWorkflowSteps, responseDays } from './workflow'

const cloneState = (state: WorkspaceState): WorkspaceState => structuredClone(state)
const now = () => new Date().toISOString()
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

/** 限制处理生效期间，以下请求类型的系统任务必须停在待复核，不下发数据系统。 */
const RESTRICTED_TYPES: RequestType[] = ['deletion', 'rectification']

function digest(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `PD-${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
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

// ---------------------------------------------------------------------------
// 排程引擎：限制处理请求、系统任务与对账批次共同决定任务是否下发数据系统。
// ---------------------------------------------------------------------------

/** 生效中的限制处理请求：未关闭、未拒绝且未到期。 */
export function activeRestrictionFor(
  state: WorkspaceState,
  requesterContact: string,
  excludeRequestId?: string,
  at: Date = new Date(),
): PrivacyRequest | undefined {
  return state.requests.find(
    (request) =>
      request.type === 'restriction' &&
      request.requesterContact === requesterContact &&
      request.id !== excludeRequestId &&
      !['completed', 'rejected'].includes(request.status) &&
      new Date(request.dueAt).getTime() >= at.getTime(),
  )
}

function holdTask(
  draft: WorkspaceState,
  request: PrivacyRequest,
  task: WorkflowStep,
  restriction: PrivacyRequest,
  logAudit = true,
) {
  task.status = 'held'
  task.hold = {
    restrictionRequestId: restriction.id,
    restrictionCode: restriction.code,
    heldAt: now(),
    reason: `依据限制处理请求 ${restriction.code} 暂缓，未下发数据系统。`,
  }
  task.exceptionReason = ''
  if (logAudit) {
    appendAudit(
      draft,
      request,
      '任务暂缓下发',
      '系统调度',
      `任务「${task.name}」依据限制处理请求 ${restriction.code} 停在待复核，未下发数据系统。`,
    )
  }
}

function findDispatchItem(draft: WorkspaceState, taskId: string) {
  for (const batch of draft.batches) {
    const item = batch.items.find((entry) => entry.taskId === taskId)
    if (item) return { batch, item }
  }
  return undefined
}

function ensureOpenBatch(draft: WorkspaceState): DispatchBatch {
  const latest = draft.batches[0]
  if (latest && latest.status === 'open') return latest
  const batch: DispatchBatch = {
    id: id('batch'),
    label: `BATCH-2026-${String(draft.batches.length + 1).padStart(3, '0')}`,
    createdAt: now(),
    status: 'open',
    checkpointNote: '',
    items: [],
  }
  draft.batches.unshift(batch)
  return batch
}

/** 登记下发项；已送达或已回执的项复用原记录，绝不重复登记。 */
function queueDispatch(
  draft: WorkspaceState,
  request: PrivacyRequest,
  task: WorkflowStep,
): DispatchItem | undefined {
  if (!task.systemId) return undefined
  const existing = findDispatchItem(draft, task.id)
  if (existing) return existing.item
  const system = draft.systems.find((item) => item.id === task.systemId)
  const batch = ensureOpenBatch(draft)
  const item: DispatchItem = {
    id: id('dispatch'),
    requestId: request.id,
    requestCode: request.code,
    taskId: task.id,
    taskName: task.name,
    systemId: task.systemId,
    systemName: system?.name ?? task.systemId,
    status: 'queued',
    attempts: 0,
    registeredAt: now(),
    failureReason: '',
  }
  batch.items.push(item)
  return item
}

/** 尝试送达单个下发项；系统维护或接口异常时保留批次检查点。 */
function attemptDelivery(draft: WorkspaceState, batch: DispatchBatch, item: DispatchItem) {
  if (item.status === 'delivered' || item.status === 'acknowledged') return
  const system = draft.systems.find((entry) => entry.id === item.systemId)
  item.attempts += 1
  if (!system || system.status !== 'active') {
    item.status = 'failed'
    item.failureReason = system ? `${system.name} 维护中，接口暂停下发` : '目标系统不存在或已退役'
    batch.status = 'checkpointed'
    batch.checkpointAt = now()
    batch.checkpointNote = `批次在「${item.systemName}」遇到${system ? '系统维护' : '接口异常'}，已保留检查点；重试仅补未送达项，已成功回执不重发。`
    return
  }
  item.status = 'delivered'
  item.deliveredAt = now()
  item.failureReason = ''
  const request = draft.requests.find((entry) => entry.id === item.requestId)
  const task = request?.tasks.find((entry) => entry.id === item.taskId)
  if (task?.status === 'completed') {
    item.status = 'acknowledged'
    item.acknowledgedAt = now()
  }
}

function refreshBatchStatus(batch: DispatchBatch) {
  if (batch.items.length && batch.items.every((item) => item.status === 'acknowledged')) {
    batch.status = 'settled'
  } else if (batch.items.some((item) => item.status === 'failed')) {
    batch.status = 'checkpointed'
  } else {
    batch.status = 'open'
  }
}

/** 顺序激活：排在前面的任务仍被暂缓时，后续任务不提前激活。 */
function nextActivatableTask(request: PrivacyRequest) {
  return request.tasks.find(
    (task) =>
      task.status === 'pending' &&
      !request.tasks.some((other) => other.order < task.order && other.status === 'held'),
  )
}

function activateNextPending(request: PrivacyRequest) {
  if (request.identity.status !== 'verified') return
  if (request.tasks.some((task) => task.status === 'active')) return
  const next = nextActivatableTask(request)
  if (next) next.status = 'active'
}

/**
 * 重算排程：限制期内的清除/更正系统任务停在待复核；限制解除或到期后，
 * 等待任务按原登记顺序（请求登记时间 + 任务序号）重新下发。
 * 已完成、已阻断和已回执的项一律不覆盖。
 */
export function reconcileSchedule(draft: WorkspaceState): boolean {
  let changed = false
  const at = new Date()
  const released: Array<{ request: PrivacyRequest; task: WorkflowStep }> = []

  for (const request of draft.requests) {
    if (!RESTRICTED_TYPES.includes(request.type)) continue
    if (['completed', 'rejected'].includes(request.status)) continue
    const restriction = activeRestrictionFor(draft, request.requesterContact, request.id, at)
    for (const task of request.tasks) {
      if (!task.systemId) continue
      if (task.status === 'completed' || task.status === 'blocked') continue
      if (restriction) {
        if (task.status !== 'held') {
          holdTask(draft, request, task, restriction)
          changed = true
        }
      } else if (task.status === 'held') {
        task.status = 'pending'
        task.hold = undefined
        released.push({ request, task })
        changed = true
      }
    }
  }

  released.sort(
    (left, right) =>
      left.request.requestedAt.localeCompare(right.request.requestedAt) ||
      left.task.order - right.task.order,
  )
  for (const { request, task } of released) {
    appendAudit(
      draft,
      request,
      '暂缓任务恢复排程',
      '系统调度',
      `限制已解除或到期，任务「${task.name}」按原登记顺序重新下发。`,
    )
    if (request.identity.status !== 'verified') continue
    const item = queueDispatch(draft, request, task)
    if (item) {
      const batch = draft.batches.find((entry) => entry.items.some((entry2) => entry2.id === item.id))
      if (batch) attemptDelivery(draft, batch, item)
    }
  }
  for (const batch of draft.batches) refreshBatchStatus(batch)

  const affected = new Set(released.map((entry) => entry.request.id))
  for (const request of draft.requests) {
    if (affected.has(request.id)) activateNextPending(request)
  }
  return changed
}

function mutateRequest(
  state: WorkspaceState,
  requestId: string,
  mutation: (request: PrivacyRequest, draft: WorkspaceState) => void,
  audit: { action: string; operator: string; detail: string },
): WorkspaceState {
  const draft = cloneState(state)
  // 每次变更前先按最新限制处理状态重算排程，后到动作始终基于新状态执行。
  reconcileSchedule(draft)
  const request = draft.requests.find((item) => item.id === requestId)
  if (!request) throw new Error('请求不存在')
  mutation(request, draft)
  // 变更可能关闭限制请求或改动主体信息，再次重算让暂缓/恢复立即生效。
  reconcileSchedule(draft)
  appendAudit(draft, request, audit.action, audit.operator, audit.detail)
  draft.revision += 1
  return draft
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
}

export function createRequest(
  state: WorkspaceState,
  input: CreateRequestInput,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
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
  // 新登记的清除/更正请求若处于同主体限制期内，系统任务立即停在待复核。
  reconcileSchedule(draft)
  appendAudit(
    draft,
    request,
    '登记隐私请求',
    operator,
    `按 ${responseDays[input.region]} 日模板登记，涉及 ${input.affectedSystemIds.length} 个系统。`,
  )
  draft.revision += 1
  return draft
}

export function saveRequest(
  state: WorkspaceState,
  requestId: string,
  patch: Partial<PrivacyRequest>,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      Object.assign(request, patch)
      request.audit = request.audit
    },
    { action: '更新请求信息', operator, detail: '更新申请人、地区、请求类型或涉及系统。' },
  )
}

export function verifyIdentity(
  state: WorkspaceState,
  requestId: string,
  status: 'verified' | 'insufficient',
  note: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
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
        const nextTask = nextActivatableTask(request)
        if (nextTask) nextTask.status = 'active'
        request.status = request.conflicts.length ? 'review-required' : 'processing'
      } else {
        if (identityTask) {
          identityTask.status = 'blocked'
          identityTask.exceptionReason = note
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
  )
}

export function assignTask(
  state: WorkspaceState,
  requestId: string,
  taskId: string,
  assignee: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      const task = request.tasks.find((item) => item.id === taskId)
      if (!task) throw new Error('任务不存在')
      task.assignee = assignee
    },
    { action: '分派履约任务', operator, detail: `任务 ${taskId} 分派给 ${assignee}。` },
  )
}

export function taskAction(
  state: WorkspaceState,
  requestId: string,
  taskId: string,
  action: 'start' | 'complete' | 'block',
  note: string,
  operator: string,
): WorkspaceState {
  const audit = {
    action:
      action === 'start' ? '开始履约任务' : action === 'complete' ? '完成履约任务' : '阻断履约任务',
    operator,
    detail: note || `${taskId} 状态更新为 ${action}。`,
  }
  return mutateRequest(
    state,
    requestId,
    (request, draft) => {
      if (request.identity.status !== 'verified') {
        throw new Error('身份未核验通过，不能推进履约任务')
      }
      const task = request.tasks.find((item) => item.id === taskId)
      if (!task) throw new Error('任务不存在')
      if (task.status === 'held') {
        // 不抛错而返回重算后的状态：让后到动作拿到已暂缓的最新排程。
        audit.action = '任务暂缓下发'
        audit.detail = `任务「${task.name}」${task.hold?.reason ?? '存在生效中的限制处理请求'}不能下发数据系统。`
        return
      }
      if (task.status === 'completed') {
        throw new Error('任务已完成并取得回执，不能重复执行或覆盖。')
      }
      if (action === 'start') {
        // 派发前再次评估限制处理状态，不符合条件的任务停在待复核。
        const restriction =
          RESTRICTED_TYPES.includes(request.type) && task.systemId
            ? activeRestrictionFor(draft, request.requesterContact, request.id)
            : undefined
        if (restriction) {
          holdTask(draft, request, task, restriction, false)
          audit.action = '任务暂缓下发'
          audit.detail = `任务「${task.name}」依据限制处理请求 ${restriction.code} 停在待复核，未下发数据系统。`
          return
        }
        task.status = 'active'
        task.exceptionReason = ''
        if (task.systemId) {
          const item = queueDispatch(draft, request, task)
          if (item) {
            const batch = draft.batches.find((entry) =>
              entry.items.some((entry2) => entry2.id === item.id),
            )
            if (batch) {
              attemptDelivery(draft, batch, item)
              refreshBatchStatus(batch)
            }
          }
        }
      } else if (action === 'complete') {
        task.status = 'completed'
        task.completedAt = now()
        task.exceptionReason = ''
        const dispatched = findDispatchItem(draft, task.id)
        if (dispatched && dispatched.item.status === 'delivered') {
          dispatched.item.status = 'acknowledged'
          dispatched.item.acknowledgedAt = now()
          refreshBatchStatus(dispatched.batch)
        }
        const nextTask = nextActivatableTask(request)
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
        request.status = 'processing'
      }
    },
    audit,
  )
}

export function addEvidence(
  state: WorkspaceState,
  requestId: string,
  taskId: string,
  name: string,
  evidenceType: 'execution-log' | 'screenshot' | 'signed-record' | 'system-response',
  operator: string,
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
  )
}

export function addConflict(
  state: WorkspaceState,
  requestId: string,
  conflict: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      request.conflicts.push(conflict)
      request.status = 'review-required'
    },
    { action: '标记冲突或例外', operator, detail: conflict },
  )
}

export function resolveConflict(
  state: WorkspaceState,
  requestId: string,
  conflictIndex: number,
  resolution: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request) => {
      const conflict = request.conflicts[conflictIndex]
      if (!conflict) throw new Error('冲突项不存在')
      request.conflicts.splice(conflictIndex, 1)
      if (!request.conflicts.length && request.identity.status === 'verified') {
        request.status = 'processing'
      } else {
        request.status = 'review-required'
      }
    },
    { action: '复核处理冲突', operator, detail: resolution },
  )
}

export function extendRequest(
  state: WorkspaceState,
  requestId: string,
  days: number,
  reason: string,
  operator: string,
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
  )
}

export function closeRequest(
  state: WorkspaceState,
  requestId: string,
  resultSummary: string,
  closureReason: string,
  operator: string,
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
  )
}

export function liftRestriction(
  state: WorkspaceState,
  requestId: string,
  note: string,
  operator: string,
): WorkspaceState {
  return mutateRequest(
    state,
    requestId,
    (request, draft) => {
      if (request.type !== 'restriction') {
        throw new Error('仅限制处理请求支持解除操作')
      }
      if (['completed', 'rejected'].includes(request.status)) {
        throw new Error('限制处理请求已关闭，不能重复解除')
      }
      request.status = 'completed'
      request.resultSummary = note
      request.closureReason = note
      for (const task of request.tasks) {
        if (task.status !== 'completed') {
          task.status = 'completed'
          task.completedAt = now()
        }
      }
      // 限制解除后，同主体暂缓任务按原登记顺序重新下发。
      reconcileSchedule(draft)
    },
    {
      action: '解除限制处理',
      operator,
      detail: `${note}（同主体暂缓任务按原登记顺序恢复下发）`,
    },
  )
}

export function retryBatch(
  state: WorkspaceState,
  batchId: string,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
  // 重试前先对齐限制处理状态，限制期内的项保持暂缓，不补发。
  reconcileSchedule(draft)
  const batch = draft.batches.find((item) => item.id === batchId)
  if (!batch) throw new Error('对账批次不存在')
  const pendingItems = batch.items.filter(
    (item) => item.status === 'failed' || item.status === 'queued',
  )
  if (!pendingItems.length) {
    throw new Error('批次没有待补发项，已回执项不会重发')
  }
  let retried = 0
  let heldBack = 0
  for (const item of pendingItems) {
    const request = draft.requests.find((entry) => entry.id === item.requestId)
    const task = request?.tasks.find((entry) => entry.id === item.taskId)
    if (task?.status === 'held') {
      heldBack += 1
      continue
    }
    attemptDelivery(draft, batch, item)
    retried += 1
  }
  refreshBatchStatus(batch)
  draft.audit.unshift({
    id: id('audit'),
    action: '重试对账批次',
    operator,
    detail: `批次 ${batch.label} 依据检查点补发 ${retried} 项未送达任务，${heldBack} 项因限制处理继续暂缓，已成功回执项不重发。`,
    createdAt: now(),
  })
  draft.revision += 1
  return draft
}

export function syncSchedule(state: WorkspaceState, operator: string): WorkspaceState {
  const draft = cloneState(state)
  const changed = reconcileSchedule(draft)
  draft.audit.unshift({
    id: id('audit'),
    action: '重算排程',
    operator,
    detail: changed
      ? '已按限制处理请求、系统任务和对账批次重算排程，暂缓与恢复动作均已记录。'
      : '排程已是最新，无待调整项。',
    createdAt: now(),
  })
  draft.revision += 1
  return draft
}

export function addComment(
  state: WorkspaceState,
  requestId: string,
  content: string,
  operator: string,
): WorkspaceState {
  const draft = cloneState(state)
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

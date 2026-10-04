import type {
  DataSystem,
  DispatchBatch,
  DispatchItem,
  PrivacyRequest,
  RequestType,
  WorkflowStep,
  WorkspaceState,
} from '@/types/domain'

const nowIso = () => new Date().toISOString()
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

/** 限制处理只挂起清除（删除）与更正两类下游任务。 */
export const restrictedRequestTypes: RequestType[] = ['deletion', 'rectification']

function receiptCode(): string {
  let hash = 2166136261
  const seed = `${crypto.randomUUID()}-${Date.now()}`
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `RC-${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

export function isSystemTask(task: WorkflowStep): boolean {
  return Boolean(task.systemId)
}

/** 同一数据主体以掩码后的联系方式作为归并键（登记时已做掩码与摘要保护）。 */
export function subjectKey(contact: string): string {
  return contact.trim().toLowerCase()
}

export function isOpenRequest(request: PrivacyRequest): boolean {
  return !['completed', 'rejected'].includes(request.status)
}

/** 找到该数据主体当前生效中的限制处理请求。 */
export function findActiveRestrictions(
  state: WorkspaceState,
  contact: string,
  at = new Date(),
): PrivacyRequest[] {
  const key = subjectKey(contact)
  const ts = at.getTime()
  return state.requests.filter((request) => {
    if (request.type !== 'restriction' || subjectKey(request.requesterContact) !== key) return false
    const lifecycle = request.restriction
    if (!lifecycle || lifecycle.status !== 'active') return false
    const effective = lifecycle.effectiveAt ? new Date(lifecycle.effectiveAt).getTime() : 0
    const expires = lifecycle.expiresAt ? new Date(lifecycle.expiresAt).getTime() : Number.POSITIVE_INFINITY
    return effective <= ts && ts < expires
  })
}

/** 已取得成功回执的项受保护：任何后到动作都不能覆盖或重发。 */
export function hasReceipt(task: WorkflowStep): boolean {
  return task.acknowledged === true || task.status === 'completed'
}

interface AuditInput {
  requestId?: string
  action: string
  operator: string
  detail: string
  at?: string
}

function pushAudit(draft: WorkspaceState, entry: AuditInput, silent: boolean) {
  if (silent) return
  const at = entry.at ?? nowIso()
  draft.audit.unshift({
    id: uid('audit'),
    requestId: entry.requestId,
    action: entry.action,
    operator: entry.operator,
    detail: entry.detail,
    createdAt: at,
  })
  if (entry.requestId) {
    const request = draft.requests.find((item) => item.id === entry.requestId)
    request?.audit.unshift({
      id: uid('audit'),
      action: entry.action,
      operator: entry.operator,
      detail: entry.detail,
      createdAt: at,
    })
  }
}

/**
 * 登记顺序：按请求登记时间（相同则按请求 id、任务 order）给出稳定的全局序号。
 * 限制解除后等待任务按该序号重新下发，保证“原登记顺序”不被打乱。
 */
export function assignRegisteredSequences(state: WorkspaceState): void {
  const orderedRequests = [...state.requests].sort((left, right) => {
    const diff = new Date(left.requestedAt).getTime() - new Date(right.requestedAt).getTime()
    return diff !== 0 ? diff : left.id.localeCompare(right.id)
  })
  let sequence = 1
  for (const request of orderedRequests) {
    const tasks = [...request.tasks].sort((left, right) => left.order - right.order)
    for (const task of tasks) {
      if (task.registeredSequence !== sequence) task.registeredSequence = sequence
      sequence += 1
    }
  }
}

function applyRestriction(
  draft: WorkspaceState,
  restriction: PrivacyRequest,
  silent: boolean,
  at: string,
) {
  const key = subjectKey(restriction.requesterContact)
  for (const request of draft.requests) {
    if (request.id === restriction.id) continue
    if (!isOpenRequest(request)) continue
    if (subjectKey(request.requesterContact) !== key) continue
    if (!restrictedRequestTypes.includes(request.type)) continue
    for (const task of request.tasks) {
      if (!isSystemTask(task)) continue
      if (task.heldByRequestId) continue
      if (hasReceipt(task)) continue // 已成功回执的清除/更正不再回滚
      if (task.status !== 'pending' && task.status !== 'active') continue
      task.status = 'suspended'
      task.heldByRequestId = restriction.id
      task.heldByRequestCode = restriction.code
      task.heldReason = `同一数据主体的限制处理请求 ${restriction.code} 生效，停止向数据系统下发。`
      task.heldAt = at
      request.status = 'review-required'
      restriction.restriction?.suspendedTaskRefs.push({
        requestId: request.id,
        requestCode: request.code,
        taskId: task.id,
        taskName: task.name,
        heldAt: at,
      })
      pushAudit(
        draft,
        {
          requestId: request.id,
          action: '限制处理生效，任务暂缓',
          operator: '排程服务',
          detail: `任务「${task.name}」依据限制处理请求 ${restriction.code} 暂缓，停在待复核，不向数据系统下发。`,
          at,
        },
        silent,
      )
    }
  }
}

export function releaseHeldTasks(
  draft: WorkspaceState,
  restriction: PrivacyRequest,
  silent: boolean,
  at: string,
) {
  for (const request of draft.requests) {
    let released = 0
    for (const task of request.tasks) {
      if (task.heldByRequestId !== restriction.id) continue
      task.heldByRequestId = undefined
      task.heldByRequestCode = undefined
      task.heldReason = undefined
      task.heldAt = undefined
      if (task.status === 'suspended') task.status = 'pending' // 回到等待队列，顺序不变
      released += 1
      const ref = restriction.restriction?.suspendedTaskRefs.find(
        (item) => item.taskId === task.id && !item.releasedAt,
      )
      if (ref) ref.releasedAt = at
    }
    if (released > 0) {
      const stillHeld = request.tasks.some((task) => task.heldByRequestId)
      if (
        request.status === 'review-required' &&
        !stillHeld &&
        request.identity.status === 'verified' &&
        request.conflicts.length === 0
      ) {
        request.status = 'processing'
      }
      pushAudit(
        draft,
        {
          requestId: request.id,
          action: '限制解除，等待任务恢复排程',
          operator: '排程服务',
          detail: `限制处理请求 ${restriction.code} 已解除，${released} 项暂缓任务按原登记顺序恢复下发等待。`,
          at,
        },
        silent,
      )
    }
  }

  // 批次中被该限制挂起的项回到待送达，后续按检查点补送，不新增重复项。
  for (const batch of draft.dispatchBatches) {
    for (const item of batch.items) {
      if (item.status === 'held' && item.heldByRequestCode === restriction.code) {
        item.status = 'pending'
        item.heldByRequestCode = undefined
        item.failureReason = undefined
        batch.checkpointUpdatedAt = at
      }
    }
  }
}

/**
 * 排程同步：限制到期自动解除、新生效限制挂起、批次项与任务状态对齐。
 * 在每个变更操作前调用，保证“后到动作识别新状态”。
 */
export function synchronizeScheduling(
  draft: WorkspaceState,
  options: { silent?: boolean; operator?: string; at?: Date } = {},
): WorkspaceState {
  const silent = options.silent ?? false
  const operator = options.operator ?? '排程服务'
  const atDate = options.at ?? new Date()
  const at = atDate.toISOString()
  if (!draft.dispatchBatches) draft.dispatchBatches = []

  assignRegisteredSequences(draft)

  // 1. 到期的限制处理请求自动解除。
  for (const request of draft.requests) {
    const lifecycle = request.restriction
    if (lifecycle?.status !== 'active' || !lifecycle.expiresAt) continue
    if (new Date(lifecycle.expiresAt).getTime() <= atDate.getTime()) {
      lifecycle.status = 'expired'
      lifecycle.liftedAt = at
      lifecycle.liftReason = '限制期限届满，系统自动解除。'
      lifecycle.liftedBy = operator
      pushAudit(
        draft,
        {
          requestId: request.id,
          action: '限制处理到期自动解除',
          operator,
          detail: `限制处理请求 ${request.code} 到期，等待任务按原登记顺序恢复下发。`,
          at,
        },
        silent,
      )
      releaseHeldTasks(draft, request, silent, at)
    }
  }

  // 2. 生效中的限制挂起同一数据主体的清除/更正任务。
  for (const request of draft.requests) {
    if (request.restriction?.status === 'active') {
      applyRestriction(draft, request, silent, at)
    }
  }

  // 3. 批次检查点与任务暂缓状态对齐（限制可能在批次建立后才生效/解除）。
  for (const batch of draft.dispatchBatches) {
    let changed = false
    for (const item of batch.items) {
      const task = draft.requests
        .find((request) => request.id === item.requestId)
        ?.tasks.find((candidate) => candidate.id === item.taskId)
      if (task && task.registeredSequence && item.registeredSequence !== task.registeredSequence) {
        item.registeredSequence = task.registeredSequence
        changed = true
      }
      if (!task) continue
      if (item.status === 'delivered') {
        // 回执以批次项为准回写任务，保证已回执任务不会被任何新批次重复纳入。
        if (!task.acknowledged) {
          task.acknowledged = true
          task.acknowledgedAt = item.deliveredAt
          task.receiptReference = item.receiptReference
          task.dispatchedAt = item.deliveredAt
          task.dispatchBatchId = batch.id
          task.deliveryAttempts = item.attempts
          if (task.status === 'pending') task.status = 'active'
        }
        continue
      }
      if (task.heldByRequestId && task.status === 'suspended') {
        if (item.status !== 'held') {
          item.status = 'held'
          item.heldByRequestCode = task.heldByRequestCode
          item.failureReason = undefined
          changed = true
        }
      } else if (item.status === 'held') {
        item.status = 'pending'
        item.heldByRequestCode = undefined
        changed = true
      }
    }
    if (changed) batch.checkpointUpdatedAt = at
  }

  return draft
}

function prerequisitesCompleted(request: PrivacyRequest, task: WorkflowStep): boolean {
  const identityDone = request.tasks.find((item) => item.id.endsWith('-identity'))?.status === 'completed'
  if (!identityDone) return false
  const earlier = [...request.tasks]
    .filter((item) => item.order < task.order)
    .sort((left, right) => right.order - left.order)
  return earlier.every((item) => item.status === 'completed')
}

/** 新建批次时可下发的系统任务，按登记顺序排列。 */
export function listDispatchableTasks(
  state: WorkspaceState,
  at = new Date(),
): Array<{ request: PrivacyRequest; task: WorkflowStep; system: DataSystem }> {
  synchronizeScheduling(state, { silent: true, at })
  const openBatchTaskIds = new Set(
    state.dispatchBatches
      .filter((batch) => batch.status === 'open')
      .flatMap((batch) =>
        batch.items
          .filter((item) => item.status === 'pending' || item.status === 'failed' || item.status === 'held')
          .map((item) => item.taskId),
      ),
  )
  const candidates: Array<{ request: PrivacyRequest; task: WorkflowStep; system: DataSystem }> = []
  for (const request of state.requests) {
    if (!isOpenRequest(request) || request.identity.status !== 'verified') continue
    for (const task of request.tasks) {
      if (!isSystemTask(task)) continue
      if (hasReceipt(task)) continue
      if (task.status === 'suspended' || task.status === 'blocked') continue
      if (task.status !== 'pending' && task.status !== 'active') continue
      if (openBatchTaskIds.has(task.id)) continue
      if (!prerequisitesCompleted(request, task)) continue
      const system = state.systems.find((item) => item.id === task.systemId)
      if (!system) continue
      candidates.push({ request, task, system })
    }
  }
  return candidates.sort(
    (left, right) =>
      (left.task.registeredSequence ?? 0) - (right.task.registeredSequence ?? 0),
  )
}

function attemptDelivery(
  draft: WorkspaceState,
  batch: DispatchBatch,
  item: DispatchItem,
  at: string,
) {
  const system = draft.systems.find((candidate) => candidate.id === item.systemId)
  const request = draft.requests.find((candidate) => candidate.id === item.requestId)
  const task = request?.tasks.find((candidate) => candidate.id === item.taskId)

  item.attempts += 1
  item.lastAttemptAt = at

  // 下发瞬间再次识别限制状态：限制生效则项保持暂缓，不送达数据系统。
  const activeRestriction = request
    ? findActiveRestrictions(draft, request.requesterContact, new Date(at)).find(
        (restriction) => restriction.id !== request.id,
      )
    : undefined
  if (request && restrictedRequestTypes.includes(request.type) && activeRestriction) {
    item.status = 'held'
    item.heldByRequestCode = activeRestriction.code
    item.failureReason = undefined
    if (task && task.status !== 'suspended') {
      task.status = 'suspended'
      task.heldByRequestId = activeRestriction.id
      task.heldByRequestCode = activeRestriction.code
      task.heldReason = `同一数据主体的限制处理请求 ${activeRestriction.code} 生效，停止向数据系统下发。`
      task.heldAt = at
    }
    batch.audit.push({
      at,
      operator: batch.createdBy,
      detail: `${item.taskName} 因限制处理请求 ${activeRestriction.code} 暂缓，未送达。`,
    })
    return
  }

  if (!system || system.status !== 'active') {
    item.status = 'failed'
    item.failureReason = !system
      ? '目标系统不存在。'
      : system.status === 'maintenance'
        ? `系统「${system.name}」维护中，接口不可达，保留检查点待补送。`
        : `系统「${system.name}」已退役，接口不可达。`
    if (task) task.deliveryAttempts = item.attempts
    batch.audit.push({
      at,
      operator: batch.createdBy,
      detail: `${item.taskName} 下发失败：${item.failureReason}`,
    })
    return
  }

  item.status = 'delivered'
  item.deliveredAt = at
  item.failureReason = undefined
  item.receiptReference = receiptCode()
  if (task) {
    if (task.status === 'pending') task.status = 'active'
    task.dispatchedAt = at
    task.dispatchBatchId = batch.id
    task.deliveryAttempts = item.attempts
    task.acknowledged = true
    task.acknowledgedAt = at
    task.receiptReference = item.receiptReference
  }
  batch.audit.push({
    at,
    operator: batch.createdBy,
    detail: `${item.taskName} 已送达「${system.name}」，回执 ${item.receiptReference}。`,
  })
}

function nextBatchCode(state: WorkspaceState): string {
  const next =
    Math.max(
      0,
      ...state.dispatchBatches.map((batch) => Number(batch.code.split('-').at(-1)) || 0),
    ) + 1
  return `BATCH-2026-${String(next).padStart(3, '0')}`
}

export function createDispatchBatch(
  state: WorkspaceState,
  operator: string,
): WorkspaceState {
  const draft = structuredClone(state)
  synchronizeScheduling(draft, { operator })
  const candidates = listDispatchableTasks(draft)
  if (!candidates.length) {
    throw new Error('当前没有可下发的任务：任务可能已暂缓、已回执或仍在等待前置步骤。')
  }
  const at = nowIso()
  const batchId = uid('batch')
  const items: DispatchItem[] = candidates.map(({ request, task, system }) => ({
    id: uid('dispatch-item'),
    requestId: request.id,
    requestCode: request.code,
    taskId: task.id,
    taskName: task.name,
    systemId: system.id,
    systemName: system.name,
    subjectContact: request.requesterContact,
    status: 'pending',
    registeredSequence: task.registeredSequence ?? 0,
    attempts: 0,
  }))
  const batch: DispatchBatch = {
    id: batchId,
    code: nextBatchCode(draft),
    createdAt: at,
    createdBy: operator,
    status: 'open',
    checkpointUpdatedAt: at,
    items,
    audit: [],
  }
  for (const item of items) {
    attemptDelivery(draft, batch, item, at)
    const delivered = item.status === 'delivered'
    pushAudit(
      draft,
      {
        requestId: item.requestId,
        action:
          item.status === 'delivered'
            ? '任务下发并取得回执'
            : item.status === 'held'
              ? '任务下发被限制暂缓'
              : '任务下发失败，等待补送',
        operator,
        detail: delivered
          ? `批次 ${batch.code}：${item.taskName} 已送达 ${item.systemName}，回执 ${item.receiptReference}。`
          : item.status === 'held'
            ? `批次 ${batch.code}：${item.taskName} 依据限制处理请求 ${item.heldByRequestCode} 暂缓。`
            : `批次 ${batch.code}：${item.taskName} 未送达 ${item.systemName}，检查点已保留。`,
        at,
      },
      false,
    )
  }
  batch.status = batch.items.every((item) => item.status === 'delivered') ? 'completed' : 'open'
  batch.checkpointUpdatedAt = at
  draft.dispatchBatches.unshift(batch)
  pushAudit(
    draft,
    {
      action: '建立下发批次',
      operator,
      detail: `批次 ${batch.code} 含 ${items.length} 项：${batch.items.filter((i) => i.status === 'delivered').length} 项送达、${batch.items.filter((i) => i.status === 'failed').length} 项失败、${batch.items.filter((i) => i.status === 'held').length} 项暂缓。`,
      at,
    },
    false,
  )
  draft.revision += 1
  return draft
}

/** 检查点重试：只补未送达（pending/failed）项，已成功回执不重发，暂缓项待限制解除后补送。 */
export function retryDispatchBatch(
  state: WorkspaceState,
  batchId: string,
  operator: string,
): WorkspaceState {
  const draft = structuredClone(state)
  synchronizeScheduling(draft, { operator })
  const batch = draft.dispatchBatches.find((item) => item.id === batchId)
  if (!batch) throw new Error('下发批次不存在')
  const retryable = batch.items.filter((item) => item.status === 'pending' || item.status === 'failed')
  if (!retryable.length) {
    const heldCount = batch.items.filter((item) => item.status === 'held').length
    throw new Error(
      heldCount
        ? `批次中仅剩 ${heldCount} 项限制暂缓任务，需先解除限制处理请求后再补送；已回执项不会重发。`
        : '批次没有未送达项，已成功回执的任务不会重发。',
    )
  }
  const at = nowIso()
  for (const item of retryable) attemptDelivery(draft, batch, item, at)
  batch.audit.push({
    at,
    operator,
    detail: `检查点重试：仅补送 ${retryable.length} 项未送达任务，已成功回执项不重发。`,
  })
  batch.status = batch.items.every((item) => item.status === 'delivered') ? 'completed' : 'open'
  batch.checkpointUpdatedAt = at
  for (const item of retryable) {
    pushAudit(
      draft,
      {
        requestId: item.requestId,
        action: item.status === 'delivered' ? '批次补送成功' : '批次补送仍未送达',
        operator,
        detail:
          item.status === 'delivered'
            ? `批次 ${batch.code} 补送 ${item.taskName} 成功，回执 ${item.receiptReference}。`
            : item.status === 'held'
              ? `批次 ${batch.code} 补送时 ${item.taskName} 被限制处理请求 ${item.heldByRequestCode} 暂缓。`
              : `批次 ${batch.code} 补送 ${item.taskName} 仍失败：${item.failureReason}`,
        at,
      },
      false,
    )
  }
  pushAudit(
    draft,
    {
      action: '批次检查点重试',
      operator,
      detail: `批次 ${batch.code} 按检查点补送 ${retryable.length} 项，未重发任何已回执任务。`,
      at,
    },
    false,
  )
  draft.revision += 1
  return draft
}

export function setSystemStatus(
  state: WorkspaceState,
  systemId: string,
  status: DataSystem['status'],
  operator: string,
): WorkspaceState {
  const draft = structuredClone(state)
  const system = draft.systems.find((item) => item.id === systemId)
  if (!system) throw new Error('系统不存在')
  const previous = system.status
  system.status = status
  synchronizeScheduling(draft, { operator })
  pushAudit(
    draft,
    {
      action: '系统状态变更',
      operator,
      detail: `「${system.name}」状态由 ${previous} 变更为 ${status}；开放批次保留检查点，需手动补送未送达项。`,
    },
    false,
  )
  draft.revision += 1
  return draft
}

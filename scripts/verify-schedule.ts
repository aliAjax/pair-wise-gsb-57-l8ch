import { createInitialState } from '../src/services/mockData'
import {
  closeRequest,
  createRequest,
  liftRestriction,
  reconcileSchedule,
  retryBatch,
  syncSchedule,
  taskAction,
  verifyIdentity,
} from '../src/services/requestService'
import type { WorkspaceState } from '../src/types/domain'

let failures = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  PASS ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}`, extra === undefined ? '' : JSON.stringify(extra, null, 2))
  }
}

const state = createInitialState()

console.log('--- 初始状态：限制生效期间的暂缓 ---')
const req002 = state.requests.find((r) => r.id === 'req-002')!
const req007 = state.requests.find((r) => r.id === 'req-007')!
check('req-002 删除系统任务全部暂缓', req002.tasks.filter((t) => t.systemId).every((t) => t.status === 'held'))
check('req-002 暂缓依据为 DSR-2026-006', req002.tasks.every((t) => !t.systemId || t.hold?.restrictionCode === 'DSR-2026-006'))
check('req-007 电子档案库任务暂缓', req007.tasks.filter((t) => t.systemId === 'sys-archive').every((t) => t.status === 'held'))
check('req-007 已完成任务不受影响', req007.tasks.find((t) => t.id === 'req-007-execute-sys-crm')?.status === 'completed')
check('批次处于检查点状态', state.batches[0].status === 'checkpointed')

console.log('--- reconcile 幂等：初始状态无变更 ---')
const clone = structuredClone(state)
check('reconcile 无变更', reconcileSchedule(clone) === false)

console.log('--- 限制期内派发删除/更正任务被拦下 ---')
const s1 = structuredClone(state)
// 已 held 任务 start：不抛错，返回已暂缓的最新状态，审计记录拦截
const heldResult = taskAction(s1, 'req-007', 'req-007-locate-sys-archive', 'start', '尝试派发', '数据管理员')
const stillHeld = heldResult.requests.find((r) => r.id === 'req-007')!.tasks.find((t) => t.id === 'req-007-locate-sys-archive')!
check('已暂缓任务 start 后仍停在待复核', stillHeld.status === 'held')
check('拦截动作写入审计', heldResult.requests.find((r) => r.id === 'req-007')!.audit[0].action === '任务暂缓下发')
check('未产生新的下发项', heldResult.batches.flatMap((b) => b.items).filter((i) => i.taskId === 'req-007-locate-sys-archive').length === 1)

// 未暂缓的同主体删除任务在 start 时被转为 held（模拟另一名客服派发）
const s2 = structuredClone(state)
const r2 = s2.requests.find((r) => r.id === 'req-002')!
r2.identity.status = 'verified'
const target = r2.tasks.find((t) => t.id === 'req-002-locate-sys-crm')!
target.status = 'pending'
target.hold = undefined
const after2 = taskAction(s2, 'req-002', 'req-002-locate-sys-crm', 'start', '另一名客服派发', '客服专员')
const heldAgain = after2.requests.find((r) => r.id === 'req-002')!.tasks.find((t) => t.id === 'req-002-locate-sys-crm')!
check('限制期内派发被停在待复核', heldAgain.status === 'held' && heldAgain.hold?.restrictionCode === 'DSR-2026-006', heldAgain)
check('未生成新的下发项', !after2.batches.some((b) => b.items.some((i) => i.taskId === 'req-002-locate-sys-crm')))

console.log('--- 已完成任务不可覆盖 ---')
let threw2 = ''
try {
  taskAction(structuredClone(state), 'req-007', 'req-007-execute-sys-crm', 'complete', '重复完成', '数据管理员')
} catch (error) {
  threw2 = (error as Error).message
}
check('已完成回执任务拒绝重复执行', threw2.includes('回执'), threw2)

console.log('--- 解除限制：按原登记顺序重新下发 ---')
const lifted = liftRestriction(structuredClone(state), 'req-006', '数据主体撤回限制处理要求。', '隐私负责人')
const liftedReq006 = lifted.requests.find((r) => r.id === 'req-006')!
check('限制请求已关闭', liftedReq006.status === 'completed')
const liftedReq002 = lifted.requests.find((r) => r.id === 'req-002')!
check('req-002 暂缓任务释放为待办（身份未核验不下发）',
  liftedReq002.tasks.filter((t) => t.systemId).every((t) => t.status === 'pending' && !t.hold))
check('req-002 未核验身份不产生下发项',
  !lifted.batches.some((b) => b.items.some((i) => i.requestId === 'req-002')))
const liftedReq007 = lifted.requests.find((r) => r.id === 'req-007')!
const archiveTasks = liftedReq007.tasks.filter((t) => t.systemId === 'sys-archive')
check('req-007 档案库任务已释放', archiveTasks.every((t) => t.status !== 'held'))
const batch1 = lifted.batches.find((b) => b.id === 'batch-001')!
const d3 = batch1.items.find((i) => i.id === 'dispatch-003')!
const d4 = batch1.items.find((i) => i.id === 'dispatch-004')!
check('维护中系统重发仍失败并保留检查点', d3.status === 'failed' && d3.attempts === 2 && batch1.status === 'checkpointed', d3)
check('原待发送项已尝试补发', d4.attempts === 1 && d4.status === 'failed', d4)
const d1 = batch1.items.find((i) => i.id === 'dispatch-001')!
check('已回执项未被重发', d1.status === 'acknowledged' && d1.attempts === 1 && d1.acknowledgedAt === '2026-09-27T02:00:00.000Z')
const releaseAudits = lifted.audit.filter((a) => a.action === '暂缓任务恢复排程')
check('恢复排程审计按登记顺序记录', releaseAudits.length >= 4, releaseAudits.map((a) => a.detail))

console.log('--- 解除限制与执行动作先后到达：后到动作识别新状态 ---')
// 第一个动作：解除限制；第二个动作基于返回的新状态完成任务
const step1 = liftRestriction(structuredClone(state), 'req-006', '限制到期解除。', '隐私负责人')
// req-007 释放后首个 pending 任务被激活；档案库任务重发失败但任务本身可推进
const active = step1.requests.find((r) => r.id === 'req-007')!.tasks.find((t) => t.status === 'active')
check('释放后 req-007 有活动任务', Boolean(active), active?.id)
if (active) {
  const step2 = taskAction(step1, 'req-007', active.id, 'complete', '完成定位。', '数据管理员')
  const done = step2.requests.find((r) => r.id === 'req-007')!.tasks.find((t) => t.id === active.id)!
  check('后到完成动作基于新状态生效', done.status === 'completed')
  const item = step2.batches.flatMap((b) => b.items).find((i) => i.taskId === active.id)
  check('未送达时不登记回执', item?.status === 'failed', item)
  // 系统恢复后重试：补发成功且因任务已完成自动登记回执
  const recovered = structuredClone(step2)
  recovered.systems.find((s) => s.id === 'sys-archive')!.status = 'active'
  const step3 = retryBatch(recovered, 'batch-001', '隐私运营')
  const redelivered = step3.batches.flatMap((b) => b.items).find((i) => i.taskId === active.id)
  check('恢复后补发并自动回执', redelivered?.status === 'acknowledged' && redelivered.attempts === 3, redelivered)
}

console.log('--- 批次重试：只补未送达项，已回执不重发 ---')
const retryState: WorkspaceState = structuredClone(state)
const retried = retryBatch(retryState, 'batch-001', '隐私运营')
const rb = retried.batches.find((b) => b.id === 'batch-001')!
const r1 = rb.items.find((i) => i.id === 'dispatch-001')!
const r3 = rb.items.find((i) => i.id === 'dispatch-003')!
const r4 = rb.items.find((i) => i.id === 'dispatch-004')!
check('已回执项不重发', r1.status === 'acknowledged' && r1.attempts === 1)
check('限制期内失败项保持暂缓不补发', r3.status === 'failed' && r3.attempts === 1, r3)
check('限制期内 queued 项保持暂缓不补发', r4.status === 'queued' && r4.attempts === 0, r4)
check('检查点保留', rb.status === 'checkpointed' && rb.checkpointNote.includes('检查点'))

// 限制解除后重试：维护中的系统仍失败并累加尝试次数
const liftedForRetry = liftRestriction(structuredClone(state), 'req-006', '撤回限制。', '隐私负责人')
const retried2 = retryBatch(liftedForRetry, 'batch-001', '隐私运营')
const rb2 = retried2.batches.find((b) => b.id === 'batch-001')!
const r3b = rb2.items.find((i) => i.id === 'dispatch-003')!
check('解除后重试补发未送达项', r3b.status === 'failed' && r3b.attempts === 3, r3b)
check('重试后已回执项仍不重发', rb2.items.find((i) => i.id === 'dispatch-001')!.attempts === 1)

console.log('--- 限制到期自动释放 ---')
const expired = structuredClone(state)
const r006 = expired.requests.find((r) => r.id === 'req-006')!
r006.dueAt = '2026-09-30T00:00:00.000Z' // 已到期
const synced = syncSchedule(expired, '隐私运营')
const syncedReq002 = synced.requests.find((r) => r.id === 'req-002')!
check('到期后暂缓任务释放', syncedReq002.tasks.filter((t) => t.systemId).every((t) => t.status !== 'held'))

console.log('--- 暂缓期间不提前激活后续任务 ---')
const idState = structuredClone(state)
const verified = verifyIdentity(idState, 'req-002', 'verified', '补充材料核验通过。', '隐私负责人')
const vReq002 = verified.requests.find((r) => r.id === 'req-002')!
check('身份通过后系统任务仍暂缓', vReq002.tasks.filter((t) => t.systemId).every((t) => t.status === 'held'))
check('后续合并任务未被提前激活', !vReq002.tasks.some((t) => t.status === 'active'), vReq002.tasks.map((t) => `${t.id}:${t.status}`))

console.log('--- 限制期内新登记删除请求：系统任务立即暂缓 ---')
const created = createRequest(
  structuredClone(state),
  {
    requesterName: '王宁',
    requesterContact: 'wa***@example.com',
    region: 'eu',
    type: 'deletion',
    affectedSystemIds: ['sys-crm'],
    identityMaterialType: 'masked-id',
    identityReference: '310***********8832',
    note: '限制期内新登记',
  },
  '客服专员',
)
const newReq = created.requests.find((r) => r.code === 'DSR-2026-008')!
check('新请求系统任务立即暂缓', newReq.tasks.filter((t) => t.systemId).every((t) => t.status === 'held' && t.hold?.restrictionCode === 'DSR-2026-006'), newReq.tasks)
check('新请求无下发项', !created.batches.some((b) => b.items.some((i) => i.requestId === newReq.id)))

console.log('--- 解除后按原登记顺序重新下发 ---')
const verifiedNew = verifyIdentity(created, newReq.id, 'verified', '身份材料核验通过。', '隐私运营')
const lifted2 = liftRestriction(verifiedNew, 'req-006', '数据主体撤回限制。', '隐私负责人')
const newReqAfter = lifted2.requests.find((r) => r.code === 'DSR-2026-008')!
const newItems = lifted2.batches.flatMap((b) => b.items).filter((i) => i.requestId === newReq.id)
check('新请求任务已释放并下发', newReqAfter.tasks.filter((t) => t.systemId).every((t) => t.status !== 'held') && newItems.length === 2, newItems)
const newReqTaskOrder = newReqAfter.tasks.filter((t) => t.systemId).map((t) => t.id)
check('下发顺序与任务登记顺序一致', newItems.map((i) => i.taskId).join(',') === newReqTaskOrder.join(','), { items: newItems.map((i) => i.taskId), tasks: newReqTaskOrder })
check('新请求首个任务已激活', newReqAfter.tasks.find((t) => t.systemId)?.status === 'active', newReqAfter.tasks.map((t) => `${t.id}:${t.status}`))
check('新请求下发项已送达（系统在用）', newItems.every((i) => i.status === 'delivered' && i.attempts === 1), newItems)

console.log('--- 正常关闭限制请求同样释放暂缓 ---')
let closeFlow = structuredClone(state)
for (const taskId of [
  'req-006-locate-sys-crm',
  'req-006-execute-sys-crm',
  'req-006-locate-sys-marketing',
  'req-006-execute-sys-marketing',
  'req-006-merge',
  'req-006-review',
]) {
  closeFlow = taskAction(closeFlow, 'req-006', taskId, 'complete', '完成。', '隐私运营')
}
closeFlow = closeRequest(closeFlow, 'req-006', '限制处理完成，主体确认撤回。', '数据主体确认撤回限制要求。', '隐私负责人')
const closedReq007 = closeFlow.requests.find((r) => r.id === 'req-007')!
check(
  '关闭限制后 req-007 暂缓释放',
  closedReq007.tasks.filter((t) => t.systemId).every((t) => t.status !== 'held'),
  closedReq007.tasks.map((t) => `${t.id}:${t.status}`),
)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)

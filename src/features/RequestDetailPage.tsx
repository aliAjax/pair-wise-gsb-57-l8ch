'use client'

import { useMemo, useState } from 'react'
import NextLink from 'next/link'
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Divider,
  Flex,
  FormControl,
  FormLabel,
  HStack,
  Heading,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  Progress,
  Select,
  SimpleGrid,
  Table,
  TableContainer,
  Tbody,
  Td,
  Text,
  Textarea,
  Th,
  Thead,
  Tr,
  VStack,
  useDisclosure,
  useToast,
} from '@chakra-ui/react'
import { ArrowLeft, FileCheck2, Link2Off, ShieldAlert, PauseCircle } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { StatusBadge, TaskStatusBadge, TypeBadge } from '@/components/StatusBadge'
import {
  useAddCommentMutation,
  useAddConflictMutation,
  useAddEvidenceMutation,
  useAssignTaskMutation,
  useCloseRequestMutation,
  useExtendRequestMutation,
  useLiftRestrictionMutation,
  useResolveConflictMutation,
  useSaveRequestMutation,
  useTaskActionMutation,
  useVerifyIdentityMutation,
  useWorkspaceQuery,
} from '@/lib/hooks'
import {
  regionLabels,
  requestTypeLabels,
  restrictionStatusLabels,
  dispatchItemStatusLabels,
  type Region,
  type RequestType,
  type WorkflowStep,
} from '@/lib/schemas'
import { deadlineState } from '@/services/workflow'

type DialogType =
  | 'edit'
  | 'identity'
  | 'assign'
  | 'evidence'
  | 'block'
  | 'conflict'
  | 'resolve'
  | 'extend'
  | 'close'
  | 'lift'
  | null

export function RequestDetailPage({ requestId }: { requestId: string }) {
  const { data, isLoading } = useWorkspaceQuery()
  const toast = useToast()
  const { isOpen, onOpen, onClose } = useDisclosure()
  const request = data?.requests.find((item) => item.id === requestId)
  const [dialog, setDialog] = useState<DialogType>(null)
  const [selectedTask, setSelectedTask] = useState<WorkflowStep>()
  const [conflictIndex, setConflictIndex] = useState(0)
  const [content, setContent] = useState('')
  const [assignee, setAssignee] = useState('')
  const [identityStatus, setIdentityStatus] = useState<'verified' | 'insufficient'>('verified')
  const [evidenceType, setEvidenceType] = useState<
    'execution-log' | 'screenshot' | 'signed-record' | 'system-response'
  >('execution-log')
  const [extendDays, setExtendDays] = useState(15)
  const [editForm, setEditForm] = useState({
    requesterName: '',
    requesterContact: '',
    region: 'cn' as Region,
    type: 'access' as RequestType,
    affectedSystemIds: [] as string[],
  })

  const saveRequest = useSaveRequestMutation()
  const verifyIdentity = useVerifyIdentityMutation()
  const assignTask = useAssignTaskMutation()
  const taskAction = useTaskActionMutation()
  const addEvidence = useAddEvidenceMutation()
  const addConflict = useAddConflictMutation()
  const resolveConflict = useResolveConflictMutation()
  const extendRequest = useExtendRequestMutation()
  const closeRequest = useCloseRequestMutation()
  const addComment = useAddCommentMutation()
  const liftRestriction = useLiftRestrictionMutation()

  const comments = useMemo(
    () => data?.comments.filter((comment) => comment.requestId === requestId) ?? [],
    [data, requestId],
  )

  const suspension = useMemo(() => {
    if (!data || !request) return null
    if (!request.tasks.some((task) => task.heldByRequestId)) return null
    const held = request.tasks.find((task) => task.heldByRequestId)
    const basis = held?.heldByRequestId
      ? data.requests.find((item) => item.id === held.heldByRequestId)
      : undefined
    return { held, basis }
  }, [data, request])

  const ownRestriction = request?.type === 'restriction' ? request.restriction : undefined

  const batchItems = useMemo(
    () =>
      (data?.dispatchBatches ?? []).flatMap((batch) =>
        batch.items
          .filter((item) => item.requestId === requestId)
          .map((item) => ({ batch, item })),
      ),
    [data, requestId],
  )

  if (isLoading || !data) return <Box className="panel">正在加载请求详情...</Box>
  if (!request) return <Box className="panel">请求不存在或已从工作区移除。</Box>

  const deadline = deadlineState(request.dueAt)
  const completedTasks = request.tasks.filter((task) => task.status === 'completed').length
  const currentTask =
    request.tasks.find((task) => task.status === 'active') ??
    request.tasks.find((task) => task.status === 'suspended')
  const systems = data.systems.filter((system) => request.affectedSystemIds.includes(system.id))

  function openDialog(type: DialogType, task?: WorkflowStep, index = 0) {
    if (!request) return
    setSelectedTask(task)
    setConflictIndex(index)
    setDialog(type)
    setContent('')
    if (type === 'assign') setAssignee(task?.assignee ?? '')
    if (type === 'edit') {
      setEditForm({
        requesterName: request.requesterName,
        requesterContact: request.requesterContact,
        region: request.region,
        type: request.type,
        affectedSystemIds: [...request.affectedSystemIds],
      })
    }
    onOpen()
  }

  async function run(action: () => Promise<unknown>, success: string) {
    try {
      await action()
      toast({ title: success, status: 'success' })
      onClose()
    } catch (error) {
      toast({
        title: '操作未完成',
        description: error instanceof Error ? error.message : '请检查输入和流程状态',
        status: 'error',
      })
    }
  }

  async function submitDialog() {
    if (!dialog) return
    if (dialog === 'edit') {
      await run(
        () =>
          saveRequest.mutateAsync({
            requestId,
            patch: editForm,
            operator: '隐私运营',
          }),
        '请求信息已保存',
      )
    } else if (dialog === 'identity') {
      await run(
        () =>
          verifyIdentity.mutateAsync({
            requestId,
            status: identityStatus,
            note: content,
            operator: '隐私运营',
          }),
        identityStatus === 'verified' ? '身份核验已通过' : '身份材料已退回复核',
      )
    } else if (dialog === 'assign' && selectedTask) {
      await run(
        () =>
          assignTask.mutateAsync({
            requestId,
            taskId: selectedTask.id,
            assignee,
            operator: '隐私运营',
          }),
        '任务已分派',
      )
    } else if (dialog === 'evidence' && selectedTask) {
      await run(
        () =>
          addEvidence.mutateAsync({
            requestId,
            taskId: selectedTask.id,
            name: content,
            evidenceType,
            operator: '数据管理员',
          }),
        '执行证据已受保护登记',
      )
    } else if (dialog === 'block' && selectedTask) {
      await run(
        () =>
          taskAction.mutateAsync({
            requestId,
            taskId: selectedTask.id,
            action: 'block',
            note: content,
            operator: '数据管理员',
          }),
        '任务已阻断并进入复核',
      )
    } else if (dialog === 'conflict') {
      await run(
        () =>
          addConflict.mutateAsync({
            requestId,
            conflict: content,
            operator: '数据管理员',
          }),
        '冲突或例外已进入复核队列',
      )
    } else if (dialog === 'resolve') {
      await run(
        () =>
          resolveConflict.mutateAsync({
            requestId,
            conflictIndex,
            resolution: content,
            operator: '隐私负责人',
          }),
        '复核结论已记录',
      )
    } else if (dialog === 'extend') {
      await run(
        () =>
          extendRequest.mutateAsync({
            requestId,
            days: extendDays,
            reason: content,
            operator: '隐私负责人',
          }),
        `已延期 ${extendDays} 天`,
      )
    } else if (dialog === 'close') {
      await run(
        () =>
          closeRequest.mutateAsync({
            requestId,
            resultSummary: content,
            closureReason: deadline.overdue ? '' : '已完成全部系统任务，经复核后提前关闭。',
            operator: '隐私负责人',
          }),
        '请求已完成并关闭',
      )
    } else if (dialog === 'lift') {
      await run(
        () =>
          liftRestriction.mutateAsync({
            requestId,
            reason: content,
            operator: '隐私负责人',
          }),
        '限制处理已撤回解除，等待任务按原顺序恢复下发',
      )
    }
  }

  async function taskMutation(task: WorkflowStep, action: 'start' | 'complete') {
    try {
      await taskAction.mutateAsync({
        requestId,
        taskId: task.id,
        action,
        note: action === 'start' ? '开始执行任务。' : '任务结果已提交。',
        operator: task.assignee || '数据管理员',
      })
      toast({ title: action === 'start' ? '任务已开始' : '任务已完成', status: 'success' })
    } catch (error) {
      toast({
        title: '任务状态未更新',
        description: error instanceof Error ? error.message : '请检查前置条件',
        status: 'error',
      })
    }
  }

  const dialogTitle: Record<Exclude<DialogType, null>, string> = {
    edit: '编辑请求基本信息',
    identity: '身份核验结论',
    assign: '分派履约任务',
    evidence: '登记执行证据',
    block: '阻断任务并说明原因',
    conflict: '新增冲突或例外',
    resolve: '记录冲突复核结论',
    extend: '延期处理请求',
    close: '关闭请求并合并结果',
    lift: '撤回解除限制处理',
  }

  return (
    <Box>
      <PageHeader
        title={`${request.code} · ${request.requesterName}`}
        description="身份核验、跨系统任务、证据、冲突复核、期限控制和结果合并均在当前工作区完成。"
        actions={
          <>
            <NextLink href="/requests">
              <Button variant="outline" leftIcon={<ArrowLeft size={16} />}>
                返回列表
              </Button>
            </NextLink>
            <Button variant="outline" onClick={() => openDialog('edit')}>
              编辑信息
            </Button>
            <Button colorScheme="brand" onClick={() => openDialog('close')}>
              完成并关闭
            </Button>
          </>
        }
      />

      <SimpleGrid columns={4} spacing="4" mb="5">
        <Box className="metric">
          <Text color="gray.600" fontSize="sm">
            当前状态
          </Text>
          <Box mt="2">
            <StatusBadge status={request.status} />
          </Box>
          <Text mt="2" color="gray.500" fontSize="xs">
            第 {request.extendedDays ? `延期 ${request.extendedDays} 天` : '原期限'}
          </Text>
        </Box>
        <Box className="metric warning">
          <Text color="gray.600" fontSize="sm">
            剩余期限
          </Text>
          <Heading mt="2" color={deadline.color} size="md">
            {deadline.label}
          </Heading>
          <Text mt="1" color="gray.500" fontSize="xs">
            {new Date(request.dueAt).toLocaleString('zh-CN')}
          </Text>
        </Box>
        <Box className="metric info">
          <Text color="gray.600" fontSize="sm">
            任务完成
          </Text>
          <Heading mt="2" size="md">
            {completedTasks} / {request.tasks.length}
          </Heading>
          <Progress
            mt="2"
            size="sm"
            value={(completedTasks / request.tasks.length) * 100}
            colorScheme="brand"
          />
        </Box>
        <Box className={`metric ${request.conflicts.length ? 'danger' : ''}`}>
          <Text color="gray.600" fontSize="sm">
            冲突与例外
          </Text>
          <Heading mt="2" size="md">
            {request.conflicts.length}
          </Heading>
          <Text mt="1" color="gray.500" fontSize="xs">
            未解决时禁止关闭
          </Text>
        </Box>
      </SimpleGrid>

      {request.conflicts.length ? (
        <Alert status="error" mb="4" borderRadius="5px">
          当前请求处于复核状态：{request.conflicts.join('；')}
        </Alert>
      ) : null}
      {request.duplicateOf ? (
        <Alert status="warning" mb="4" borderRadius="5px">
          系统检测到与 {request.duplicateOf} 疑似重复，已保留原请求证据并要求人工复核。
        </Alert>
      ) : null}
      {suspension ? (
        <Alert status="warning" mb="4" borderRadius="5px">
          <PauseCircle size={18} style={{ marginRight: 8, flexShrink: 0 }} />
          <Box>
            <Text fontWeight="600">
              本请求有 {request.tasks.filter((task) => task.heldByRequestId).length} 项清除/更正任务暂缓，停在待复核，未向数据系统下发。
            </Text>
            <Text mt="1" fontSize="sm">
              暂缓依据：限制处理请求
              {suspension.basis ? ` ${suspension.basis.code}` : ` ${suspension.held?.heldByRequestCode ?? ''}`}
              {suspension.basis?.restriction?.expiresAt
                ? `（生效至 ${new Date(suspension.basis.restriction.expiresAt).toLocaleString('zh-CN')} 到期）`
                : ''}
              ；限制到期或撤回后按原登记顺序恢复下发。
            </Text>
          </Box>
        </Alert>
      ) : null}

      <div className={ownRestriction ? 'three-column' : 'two-column'}>
        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">请求与身份核验</Heading>
            <HStack>
              <TypeBadge type={request.type} />
              <Button size="xs" onClick={() => openDialog('identity')}>
                身份结论
              </Button>
            </HStack>
          </Flex>
          <SimpleGrid columns={2} spacing="4">
            <Box>
              <Text color="gray.500" fontSize="xs">
                请求人
              </Text>
              <Text mt="1" fontWeight="600">
                {request.requesterName}
              </Text>
            </Box>
            <Box>
              <Text color="gray.500" fontSize="xs">
                联系方式
              </Text>
              <Text mt="1">{request.requesterContact}</Text>
            </Box>
            <Box>
              <Text color="gray.500" fontSize="xs">
                地区与模板
              </Text>
              <Text mt="1">
                {regionLabels[request.region]} · {requestTypeLabels[request.type]}
              </Text>
            </Box>
            <Box>
              <Text color="gray.500" fontSize="xs">
                身份核验状态
              </Text>
              <Box mt="1">
                <Badge
                  colorScheme={
                    request.identity.status === 'verified'
                      ? 'green'
                      : request.identity.status === 'insufficient'
                        ? 'red'
                        : 'orange'
                  }
                >
                  {request.identity.status === 'verified'
                    ? '已通过'
                    : request.identity.status === 'insufficient'
                      ? '材料不足'
                      : '待核验'}
                </Badge>
              </Box>
            </Box>
          </SimpleGrid>
          <Divider my="4" />
          <HStack align="flex-start" spacing="3">
            <FileCheck2 size={19} color="#237b78" />
            <Box>
              <Text fontWeight="600">受保护身份摘要</Text>
              <Text mt="1" color="gray.600" fontSize="sm">
                {request.identity.maskedReference || '未提供引用'} ·{' '}
                <span className="mono">{request.identity.protectedDigest}</span>
              </Text>
              <Text mt="2" color="gray.600" fontSize="sm">
                {request.identity.note || '暂无核验说明'}
              </Text>
            </Box>
          </HStack>
        </Box>

        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">涉及系统与流程模板</Heading>
            <Badge colorScheme="blue">{systems.length} 个系统</Badge>
          </Flex>
          <VStack align="stretch" spacing="3">
            {systems.map((system) => (
              <Box key={system.id} p="3" bg="gray.50" borderRadius="5px">
                <Flex justify="space-between">
                  <Text fontWeight="600">{system.name}</Text>
                  <Badge>{system.owner}</Badge>
                </Flex>
                <Text mt="1" color="gray.600" fontSize="sm">
                  {system.dataDomain} · {system.transferMethod}
                </Text>
              </Box>
            ))}
          </VStack>
          <Alert status="info" mt="4" borderRadius="5px">
            每个系统分别执行并登记证据，合并结果时不得覆盖原始时间点。
          </Alert>
        </Box>

        {ownRestriction ? (
          <Box className="panel">
            <Flex className="panel-title">
              <Heading size="sm">限制处理生命周期</Heading>
              <Badge
                colorScheme={
                  ownRestriction.status === 'active'
                    ? 'purple'
                    : ownRestriction.status === 'pending'
                      ? 'orange'
                      : 'green'
                }
              >
                {restrictionStatusLabels[ownRestriction.status]}
              </Badge>
            </Flex>
            <VStack align="stretch" spacing="3">
              <Box p="3" bg="purple.50" borderRadius="5px">
                <Text fontWeight="600">生效时间</Text>
                <Text mt="1" color="gray.600" fontSize="sm">
                  {ownRestriction.effectiveAt
                    ? new Date(ownRestriction.effectiveAt).toLocaleString('zh-CN')
                    : '身份核验通过后生效'}
                </Text>
              </Box>
              <Box p="3" bg="purple.50" borderRadius="5px">
                <Text fontWeight="600">到期时间</Text>
                <Text mt="1" color="gray.600" fontSize="sm">
                  {ownRestriction.expiresAt
                    ? new Date(ownRestriction.expiresAt).toLocaleString('zh-CN')
                    : `期限 ${ownRestriction.durationDays} 天`}
                </Text>
              </Box>
              <Box p="3" bg="gray.50" borderRadius="5px">
                <Text fontWeight="600">
                  暂缓任务（{ownRestriction.suspendedTaskRefs.length}）
                </Text>
                <VStack align="stretch" mt="2" spacing="1">
                  {ownRestriction.suspendedTaskRefs.length ? (
                    ownRestriction.suspendedTaskRefs.map((ref) => (
                      <Box key={ref.taskId} fontSize="sm">
                        <Text>
                          {ref.requestCode} · {ref.taskName}
                        </Text>
                        <Text color={ref.releasedAt ? 'green.600' : 'purple.600'} fontSize="xs">
                          {ref.releasedAt
                            ? `已于 ${new Date(ref.releasedAt).toLocaleString('zh-CN')} 恢复下发`
                            : `自 ${new Date(ref.heldAt).toLocaleString('zh-CN')} 暂缓待复核`}
                        </Text>
                      </Box>
                    ))
                  ) : (
                    <Text color="gray.500" fontSize="sm">
                      暂无需暂缓的同一数据主体清除/更正任务。
                    </Text>
                  )}
                </VStack>
              </Box>
              {ownRestriction.status === 'active' ? (
                <Button
                  size="sm"
                  colorScheme="purple"
                  variant="outline"
                  onClick={() => openDialog('lift')}
                >
                  撤回解除限制
                </Button>
              ) : (
                <Alert status="success" borderRadius="5px" fontSize="sm">
                  {ownRestriction.liftReason ??
                    restrictionStatusLabels[ownRestriction.status]}
                </Alert>
              )}
            </VStack>
          </Box>
        ) : null}
      </div>

      <div className="three-column">
        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">当前动作</Heading>
            <Badge colorScheme={request.identity.status === 'verified' ? 'green' : 'red'}>
              {request.identity.status === 'verified' ? '可执行' : '身份阻断'}
            </Badge>
          </Flex>
          {currentTask ? (
            currentTask.status === 'suspended' ? (
              <VStack align="stretch" spacing="3">
                <Text fontWeight="600">{currentTask.name}</Text>
                <Alert status="warning" borderRadius="5px">
                  <PauseCircle size={16} style={{ marginRight: 8, flexShrink: 0 }} />
                  <Box>
                    <Text fontWeight="600" fontSize="sm">
                      暂缓待复核，不向数据系统下发
                    </Text>
                    <Text mt="1" fontSize="xs">
                      依据：限制处理请求 {currentTask.heldByRequestCode}
                    </Text>
                    <Text mt="1" fontSize="xs" color="gray.600">
                      {currentTask.heldReason}
                    </Text>
                  </Box>
                </Alert>
                <Button
                  size="sm"
                  colorScheme="red"
                  variant="outline"
                  onClick={() => openDialog('block', currentTask)}
                >
                  标记其他阻断
                </Button>
              </VStack>
            ) : (
            <VStack align="stretch" spacing="3">
              <Text fontWeight="600">{currentTask.name}</Text>
              <Text color="gray.600" fontSize="sm">
                责任人：{currentTask.assignee}
              </Text>
              <Button
                size="sm"
                colorScheme="brand"
                isDisabled={request.identity.status !== 'verified'}
                onClick={() => void taskMutation(currentTask, 'start')}
              >
                开始任务
              </Button>
              <Button
                size="sm"
                colorScheme="green"
                isDisabled={request.identity.status !== 'verified'}
                onClick={() => void taskMutation(currentTask, 'complete')}
              >
                完成任务
              </Button>
              <Button
                size="sm"
                colorScheme="red"
                variant="outline"
                onClick={() => openDialog('block', currentTask)}
              >
                阻断并复核
              </Button>
            </VStack>
            )
          ) : (
            <Alert status="success" borderRadius="5px">
              当前没有活动任务，可检查冲突并关闭请求。
            </Alert>
          )}
          <Divider my="4" />
          <VStack align="stretch" spacing="2">
            <Button size="sm" onClick={() => openDialog('conflict')} leftIcon={<Link2Off size={15} />}>
              标记冲突或例外
            </Button>
            <Button size="sm" onClick={() => openDialog('extend')} leftIcon={<ShieldAlert size={15} />}>
              申请延期
            </Button>
          </VStack>
        </Box>

        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">履约任务</Heading>
            <Text color="gray.500" fontSize="sm">
              {request.tasks.length} 项
            </Text>
          </Flex>
          <VStack align="stretch" spacing="0">
            {request.tasks.map((task) => (
              <Box
                key={task.id}
                className={`timeline-item ${task.status === 'active' ? 'active' : ''} ${task.status === 'blocked' ? 'blocked' : ''} ${task.status === 'suspended' ? 'suspended' : ''}`}
              >
                <Flex justify="space-between" gap="4">
                  <Box>
                    <HStack>
                      <Badge>{task.order}</Badge>
                      <Text fontWeight="600">{task.name}</Text>
                    </HStack>
                    <Text mt="1" color="gray.600" fontSize="sm">
                      {task.role} · {task.assignee}
                    </Text>
                    {task.status === 'suspended' && task.heldByRequestCode ? (
                      <Box mt="1" color="purple.700" fontSize="sm">
                        <HStack>
                          <PauseCircle size={14} />
                          <Text fontWeight="600">暂缓待复核</Text>
                        </HStack>
                        <Text mt="1">依据：限制处理请求 {task.heldByRequestCode}</Text>
                        <Text color="gray.600">{task.heldReason}</Text>
                      </Box>
                    ) : task.exceptionReason ? (
                      <Text mt="1" color="red.600" fontSize="sm">
                        {task.exceptionReason}
                      </Text>
                    ) : null}
                    {task.receiptReference ? (
                      <Text mt="1" color="green.700" fontSize="xs">
                        已成功回执：<span className="mono">{task.receiptReference}</span>
                        {task.acknowledgedAt
                          ? ` · ${new Date(task.acknowledgedAt).toLocaleString('zh-CN')}`
                          : ''}
                      </Text>
                    ) : null}
                  </Box>
                  <VStack align="flex-end" spacing="2">
                    <TaskStatusBadge status={task.status} />
                    <HStack spacing="1">
                      <Button
                        size="xs"
                        variant="ghost"
                        isDisabled={task.status === 'suspended'}
                        onClick={() => openDialog('assign', task)}
                      >
                        分派
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => openDialog('evidence', task)}>
                        证据
                      </Button>
                    </HStack>
                  </VStack>
                </Flex>
              </Box>
            ))}
          </VStack>
        </Box>

        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">冲突复核与证据</Heading>
            <Badge colorScheme={request.conflicts.length ? 'red' : 'green'}>
              {request.conflicts.length} 项冲突
            </Badge>
          </Flex>
          <VStack align="stretch" spacing="3">
            {request.conflicts.map((conflict, index) => (
              <Alert key={`${conflict}-${index}`} status="error" borderRadius="5px">
                <Text fontSize="sm">{conflict}</Text>
                <Button
                  mt="2"
                  size="xs"
                  variant="outline"
                  colorScheme="red"
                  onClick={() => openDialog('resolve', undefined, index)}
                >
                  记录复核结论
                </Button>
              </Alert>
            ))}
            {!request.conflicts.length ? (
              <Alert status="success" borderRadius="5px">
                当前没有未解决冲突。
              </Alert>
            ) : null}
          </VStack>
          <Divider my="4" />
          <Heading size="xs" mb="3">
            执行证据
          </Heading>
          <VStack align="stretch" spacing="2">
            {request.evidence.map((evidence) => (
              <Box key={evidence.id} className="timeline-item">
                <Text fontWeight="600">{evidence.name}</Text>
                <Text mt="1" color="gray.600" fontSize="xs">
                  {evidence.evidenceType} · {evidence.digest}
                </Text>
                <Text mt="1" color="gray.500" fontSize="xs">
                  {evidence.uploadedBy} · {new Date(evidence.uploadedAt).toLocaleString('zh-CN')}
                </Text>
              </Box>
            ))}
            {!request.evidence.length ? (
              <Text color="gray.500" fontSize="sm">
                暂无执行证据。
              </Text>
            ) : null}
          </VStack>
          <Divider my="4" />
          <Heading size="xs" mb="3">
            下发批次与回执
          </Heading>
          <VStack align="stretch" spacing="2">
            {batchItems.length ? (
              batchItems.map(({ batch, item }) => (
                <Box key={item.id} className="summary-box">
                  <Flex justify="space-between">
                    <Text fontWeight="600" fontSize="sm">
                      {batch.code} · {item.taskName}
                    </Text>
                    <Badge
                      colorScheme={
                        item.status === 'delivered'
                          ? 'green'
                          : item.status === 'held'
                            ? 'purple'
                            : item.status === 'failed'
                              ? 'red'
                              : 'gray'
                      }
                    >
                      {dispatchItemStatusLabels[item.status]}
                    </Badge>
                  </Flex>
                  <Text mt="1" color="gray.600" fontSize="xs">
                    {item.systemName} · 尝试 {item.attempts} 次 · 登记顺序 #{item.registeredSequence}
                  </Text>
                  {item.status === 'delivered' && item.receiptReference ? (
                    <Text mt="1" color="green.700" fontSize="xs">
                      回执 <span className="mono">{item.receiptReference}</span>，成功项不重发。
                    </Text>
                  ) : null}
                  {item.status === 'held' ? (
                    <Text mt="1" color="purple.700" fontSize="xs">
                      依据限制处理请求 {item.heldByRequestCode} 暂缓，限制解除后按检查点补送。
                    </Text>
                  ) : null}
                  {item.status === 'failed' ? (
                    <Text mt="1" color="red.600" fontSize="xs">
                      {item.failureReason}
                    </Text>
                  ) : null}
                </Box>
              ))
            ) : (
              <Text color="gray.500" fontSize="sm">
                尚未加入下发批次。
              </Text>
            )}
          </VStack>
        </Box>
      </div>

      <div className="two-column">
        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">处理意见</Heading>
          </Flex>
          <HStack align="flex-start" mb="3">
            <Textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="填写跨系统处理说明、例外分析或补充要求"
            />
            <Button
              colorScheme="brand"
              isDisabled={!content.trim()}
              isLoading={addComment.isPending}
              onClick={async () => {
                try {
                  await addComment.mutateAsync({
                    requestId,
                    content: content.trim(),
                    operator: '隐私运营',
                  })
                  setContent('')
                  toast({ title: '处理意见已记录', status: 'success' })
                } catch (error) {
                  toast({
                    title: '意见提交失败',
                    description: error instanceof Error ? error.message : '请重试',
                    status: 'error',
                  })
                }
              }}
            >
              提交意见
            </Button>
          </HStack>
          <VStack align="stretch" spacing="2">
            {comments.map((comment) => (
              <Box key={comment.id} className="summary-box">
                <Text>{comment.content}</Text>
                <Text mt="2" color="gray.500" fontSize="xs">
                  {comment.author} · {new Date(comment.createdAt).toLocaleString('zh-CN')}
                </Text>
              </Box>
            ))}
          </VStack>
        </Box>

        <Box className="panel">
          <Flex className="panel-title">
            <Heading size="sm">操作审计</Heading>
            <Badge>{request.audit.length} 条</Badge>
          </Flex>
          <VStack align="stretch" spacing="2" maxH="360px" overflowY="auto">
            {request.audit.map((entry) => (
              <Box key={entry.id} className="timeline-item">
                <Text fontWeight="600">{entry.action}</Text>
                <Text mt="1" color="gray.600" fontSize="sm">
                  {entry.detail}
                </Text>
                <Text mt="1" color="gray.500" fontSize="xs">
                  {entry.operator} · {new Date(entry.createdAt).toLocaleString('zh-CN')}
                </Text>
              </Box>
            ))}
          </VStack>
        </Box>
      </div>

      <Modal isOpen={isOpen} onClose={onClose} size={dialog === 'edit' ? 'xl' : 'lg'}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>{dialog ? dialogTitle[dialog] : ''}</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            {dialog === 'edit' ? (
              <VStack align="stretch" spacing="4">
                <FormControl isRequired>
                  <FormLabel>请求人</FormLabel>
                  <Input
                    value={editForm.requesterName}
                    onChange={(event) =>
                      setEditForm({ ...editForm, requesterName: event.target.value })
                    }
                  />
                </FormControl>
                <FormControl isRequired>
                  <FormLabel>联系方式</FormLabel>
                  <Input
                    value={editForm.requesterContact}
                    onChange={(event) =>
                      setEditForm({ ...editForm, requesterContact: event.target.value })
                    }
                  />
                </FormControl>
                <Flex gap="4">
                  <FormControl>
                    <FormLabel>地区</FormLabel>
                    <Select
                      value={editForm.region}
                      onChange={(event) =>
                        setEditForm({ ...editForm, region: event.target.value as Region })
                      }
                    >
                      {Object.entries(regionLabels).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </Select>
                  </FormControl>
                  <FormControl>
                    <FormLabel>请求类型</FormLabel>
                    <Select
                      value={editForm.type}
                      onChange={(event) =>
                        setEditForm({ ...editForm, type: event.target.value as RequestType })
                      }
                    >
                      {Object.entries(requestTypeLabels).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </Select>
                  </FormControl>
                </Flex>
                <FormControl>
                  <FormLabel>相关系统</FormLabel>
                  <HStack wrap="wrap">
                    {data.systems.map((system) => (
                      <Checkbox
                        key={system.id}
                        isChecked={editForm.affectedSystemIds.includes(system.id)}
                        onChange={(event) =>
                          setEditForm({
                            ...editForm,
                            affectedSystemIds: event.target.checked
                              ? [...editForm.affectedSystemIds, system.id]
                              : editForm.affectedSystemIds.filter((id) => id !== system.id),
                          })
                        }
                      >
                        {system.name}
                      </Checkbox>
                    ))}
                  </HStack>
                </FormControl>
              </VStack>
            ) : null}

            {dialog === 'identity' ? (
              <VStack align="stretch" spacing="4">
                <FormControl>
                  <FormLabel>核验结论</FormLabel>
                  <Select
                    value={identityStatus}
                    onChange={(event) =>
                      setIdentityStatus(event.target.value as 'verified' | 'insufficient')
                    }
                  >
                    <option value="verified">核验通过</option>
                    <option value="insufficient">材料不足，进入复核</option>
                  </Select>
                </FormControl>
                <FormControl isRequired>
                  <FormLabel>核验说明</FormLabel>
                  <Textarea
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    placeholder="说明核验依据、材料保护方式或不足项"
                  />
                </FormControl>
              </VStack>
            ) : null}

            {dialog === 'assign' && selectedTask ? (
              <FormControl isRequired>
                <FormLabel>责任人或团队</FormLabel>
                <Input value={assignee} onChange={(event) => setAssignee(event.target.value)} />
              </FormControl>
            ) : null}

            {dialog === 'evidence' && selectedTask ? (
              <VStack align="stretch" spacing="4">
                <Alert status="info" borderRadius="5px">
                  证据只登记名称、类型、摘要和时间，不保存原附件内容。
                </Alert>
                <FormControl isRequired>
                  <FormLabel>证据名称</FormLabel>
                  <Input
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    placeholder="例如 删除执行回执"
                  />
                </FormControl>
                <FormControl>
                  <FormLabel>证据类型</FormLabel>
                  <Select
                    value={evidenceType}
                    onChange={(event) =>
                      setEvidenceType(
                        event.target.value as
                          | 'execution-log'
                          | 'screenshot'
                          | 'signed-record'
                          | 'system-response',
                      )
                    }
                  >
                    <option value="execution-log">执行日志</option>
                    <option value="screenshot">截图</option>
                    <option value="signed-record">签署记录</option>
                    <option value="system-response">系统回执</option>
                  </Select>
                </FormControl>
              </VStack>
            ) : null}

            {['block', 'conflict', 'resolve', 'close'].includes(dialog ?? '') ? (
              <FormControl isRequired>
                <FormLabel>{dialog === 'close' ? '结果合并说明' : '原因与说明'}</FormLabel>
                <Textarea
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder={
                    dialog === 'close'
                      ? '说明各系统处理结果、保留的例外和最终结论'
                      : '填写可审计的原因和处理依据'
                  }
                />
              </FormControl>
            ) : null}

            {dialog === 'extend' ? (
              <VStack align="stretch" spacing="4">
                <FormControl isRequired>
                  <FormLabel>延期天数</FormLabel>
                  <Input
                    type="number"
                    min={1}
                    max={90}
                    value={extendDays}
                    onChange={(event) => setExtendDays(Number(event.target.value))}
                  />
                </FormControl>
                <FormControl isRequired>
                  <FormLabel>延期原因</FormLabel>
                  <Textarea value={content} onChange={(event) => setContent(event.target.value)} />
                </FormControl>
              </VStack>
            ) : null}

            {dialog === 'lift' ? (
              <VStack align="stretch" spacing="4">
                <Alert status="warning" borderRadius="5px">
                  撤回解除后，同一数据主体被暂缓的清除/更正任务将按原登记顺序重新下发；
                  已成功回执的项不受影响、不会重发。
                </Alert>
                <FormControl isRequired>
                  <FormLabel>撤回解除原因</FormLabel>
                  <Textarea
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    placeholder="说明撤回限制处理的依据，例如争议已解决、数据主体书面请求等"
                  />
                </FormControl>
              </VStack>
            ) : null}
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr="3" onClick={onClose}>
              取消
            </Button>
            <Button colorScheme="brand" onClick={submitDialog}>
              确认提交
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  )
}

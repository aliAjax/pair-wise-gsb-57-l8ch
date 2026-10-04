'use client'

import {
  Alert,
  Badge,
  Box,
  Button,
  Flex,
  Heading,
  HStack,
  Input,
  Select,
  SimpleGrid,
  Table,
  TableContainer,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
  VStack,
  useToast,
} from '@chakra-ui/react'
import { Layers, RefreshCw, Wrench } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import {
  useCreateDispatchBatchMutation,
  useRetryDispatchBatchMutation,
  useSetSystemStatusMutation,
  useWorkspaceQuery,
} from '@/lib/hooks'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import {
  dispatchItemStatusLabels,
  requestTypeLabels,
  systemStatusLabels,
  type DataSystem,
} from '@/lib/schemas'

export function SystemsPage() {
  const { data, isLoading } = useWorkspaceQuery()
  const store = useWorkspaceStore()
  const toast = useToast()
  const createBatch = useCreateDispatchBatchMutation()
  const retryBatch = useRetryDispatchBatchMutation()
  const setSystemStatus = useSetSystemStatusMutation()

  if (isLoading || !data) return <Box className="panel">正在加载系统清单...</Box>

  const systems = data.systems.filter((system) =>
    `${system.name}${system.owner}${system.dataDomain}`
      .toLowerCase()
      .includes(store.systemSearch.toLowerCase()),
  )
  const activeRequests = data.requests.filter(
    (request) => !['completed', 'rejected'].includes(request.status),
  )
  const batches = data.dispatchBatches ?? []

  async function changeSystemStatus(system: DataSystem, status: DataSystem['status']) {
    if (system.status === status) return
    try {
      await setSystemStatus.mutateAsync({
        systemId: system.id,
        status,
        operator: '隐私运营',
      })
      toast({
        title: `「${system.name}」已切换为${systemStatusLabels[status]}`,
        description:
          status === 'active'
            ? '可在对账批次中按检查点补送此前未送达项。'
            : '开放批次已保留检查点，未送达项不会重发，恢复后手动补送。',
        status: 'success',
      })
    } catch (error) {
      toast({
        title: '系统状态未更新',
        description: error instanceof Error ? error.message : '请重试',
        status: 'error',
      })
    }
  }

  async function buildBatch() {
    try {
      const next = await createBatch.mutateAsync({ operator: '隐私运营' })
      const batch = next.dispatchBatches[0]
      toast({
        title: `批次 ${batch.code} 已建立`,
        description: `送达 ${batch.items.filter((item) => item.status === 'delivered').length} 项，失败 ${batch.items.filter((item) => item.status === 'failed').length} 项，暂缓 ${batch.items.filter((item) => item.status === 'held').length} 项。`,
        status: 'success',
      })
    } catch (error) {
      toast({
        title: '批次未建立',
        description: error instanceof Error ? error.message : '请重试',
        status: 'error',
      })
    }
  }

  async function retry(batchId: string) {
    try {
      const next = await retryBatch.mutateAsync({ batchId, operator: '隐私运营' })
      const batch = next.dispatchBatches.find((item) => item.id === batchId)
      toast({
        title: `批次 ${batch?.code ?? ''} 检查点重试完成`,
        description: '仅补送未送达项，已成功回执的任务未重发。',
        status: 'success',
      })
    } catch (error) {
      toast({
        title: '补送未执行',
        description: error instanceof Error ? error.message : '请重试',
        status: 'error',
      })
    }
  }

  return (
    <Box>
      <PageHeader
        title="系统清单与处理映射"
        description="维护隐私数据所在系统、责任团队、传输方式、处理时限和可支持的请求类型。"
      />

      <SimpleGrid columns={4} spacing="4" mb="5">
        <Box className="metric">
          <Text color="gray.600" fontSize="sm">
            系统总数
          </Text>
          <Heading mt="2" size="md">
            {data.systems.length}
          </Heading>
        </Box>
        <Box className="metric info">
          <Text color="gray.600" fontSize="sm">
            在用系统
          </Text>
          <Heading mt="2" size="md">
            {data.systems.filter((system) => system.status === 'active').length}
          </Heading>
        </Box>
        <Box className="metric warning">
          <Text color="gray.600" fontSize="sm">
            维护中
          </Text>
          <Heading mt="2" size="md">
            {data.systems.filter((system) => system.status === 'maintenance').length}
          </Heading>
        </Box>
        <Box className="metric danger">
          <Text color="gray.600" fontSize="sm">
            受影响请求
          </Text>
          <Heading mt="2" size="md">
            {activeRequests.length}
          </Heading>
        </Box>
      </SimpleGrid>

      <Box className="toolbar">
        <Input
          width="320px"
          value={store.systemSearch}
          onChange={(event) => store.setSystemSearch(event.target.value)}
          placeholder="搜索系统、责任团队或数据域"
        />
        <Box className="grow" />
        <Text color="gray.600" fontSize="sm">
          共 {systems.length} 个系统
        </Text>
      </Box>

      <Box className="panel">
        <TableContainer>
          <Table size="sm">
            <Thead>
              <Tr>
                <Th>系统名称</Th>
                <Th>责任团队</Th>
                <Th>数据域</Th>
                <Th>传输方式</Th>
                <Th>处理时限</Th>
                <Th>支持请求类型</Th>
                <Th>状态与维护</Th>
              </Tr>
            </Thead>
            <Tbody>
              {systems.map((system) => (
                <Tr key={system.id}>
                  <Td fontWeight="600">{system.name}</Td>
                  <Td>{system.owner}</Td>
                  <Td maxW="300px">{system.dataDomain}</Td>
                  <Td>{system.transferMethod}</Td>
                  <Td>{system.slaDays} 天</Td>
                  <Td>
                    <HStack wrap="wrap" spacing="1">
                      {system.requestTypes.map((type) => (
                        <Badge key={type} colorScheme="blue">
                          {requestTypeLabels[type]}
                        </Badge>
                      ))}
                    </HStack>
                  </Td>
                  <Td>
                    <VStack align="flex-start" spacing="1">
                      <Badge colorScheme={system.status === 'active' ? 'green' : 'orange'}>
                        {systemStatusLabels[system.status]}
                      </Badge>
                      {system.status === 'active' ? (
                        <Button
                          size="xs"
                          variant="link"
                          colorScheme="orange"
                          leftIcon={<Wrench size={12} />}
                          onClick={() => void changeSystemStatus(system, 'maintenance')}
                        >
                          切到维护
                        </Button>
                      ) : (
                        <Button
                          size="xs"
                          variant="link"
                          colorScheme="green"
                          onClick={() => void changeSystemStatus(system, 'active')}
                        >
                          恢复在用并补送
                        </Button>
                      )}
                    </VStack>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </TableContainer>
      </Box>

      <Box className="panel">
        <Flex className="panel-title">
          <Heading size="sm">系统处理负载</Heading>
          <Button size="xs" variant="ghost">
            按 SLA 排序
          </Button>
        </Flex>
        <SimpleGrid columns={3} spacing="4">
          {data.systems.map((system) => {
            const requestCount = activeRequests.filter((request) =>
              request.affectedSystemIds.includes(system.id),
            ).length
            return (
              <Box key={system.id} p="4" bg="gray.50" borderRadius="5px">
                <Flex justify="space-between">
                  <Text fontWeight="600">{system.name}</Text>
                  <Badge colorScheme={requestCount > 1 ? 'orange' : 'green'}>
                    {requestCount} 个未完成请求
                  </Badge>
                </Flex>
                <VStack align="stretch" mt="3" spacing="1">
                  <Text color="gray.600" fontSize="sm">
                    责任人：{system.owner}
                  </Text>
                  <Text color="gray.600" fontSize="sm">
                    结果传输：{system.transferMethod}
                  </Text>
                  <Text color="gray.600" fontSize="sm">
                    SLA：{system.slaDays} 天
                  </Text>
                </VStack>
              </Box>
            )
          })}
        </SimpleGrid>
      </Box>

      <Box className="panel">
        <Flex className="panel-title">
          <HStack>
            <Layers size={17} color="#237b78" />
            <Heading size="sm">下发对账批次与检查点</Heading>
          </HStack>
          <Button
            size="sm"
            colorScheme="brand"
            isLoading={createBatch.isPending}
            onClick={buildBatch}
          >
            按登记顺序建立批次
          </Button>
        </Flex>
        <Alert status="info" mb="4" borderRadius="5px">
          批次只纳入身份核验通过、前置步骤完成且尚未回执的系统任务，按原登记顺序下发；
          限制生效项暂缓，维护/接口失败项保留检查点，重试只补未送达项，已成功回执不重发。
        </Alert>

        {batches.length === 0 ? (
          <Text color="gray.500" fontSize="sm">
            尚未建立下发批次。
          </Text>
        ) : (
          <VStack align="stretch" spacing="4">
            {batches.map((batch) => {
              const delivered = batch.items.filter((item) => item.status === 'delivered').length
              const failed = batch.items.filter((item) => item.status === 'failed').length
              const held = batch.items.filter((item) => item.status === 'held').length
              const pending = batch.items.filter((item) => item.status === 'pending').length
              const retryable = batch.items.filter(
                (item) => item.status === 'pending' || item.status === 'failed',
              ).length
              return (
                <Box key={batch.id} p="4" bg="gray.50" borderRadius="5px">
                  <Flex justify="space-between" align="center">
                    <HStack>
                      <Text fontWeight="700">{batch.code}</Text>
                      <Badge colorScheme={batch.status === 'completed' ? 'green' : 'orange'}>
                        {batch.status === 'completed' ? '全部送达' : '检查点开放'}
                      </Badge>
                    </HStack>
                    <HStack>
                      <Text color="gray.500" fontSize="xs">
                        检查点更新：{new Date(batch.checkpointUpdatedAt).toLocaleString('zh-CN')}
                      </Text>
                      <Button
                        size="xs"
                        colorScheme="brand"
                        variant="outline"
                        leftIcon={<RefreshCw size={12} />}
                        isDisabled={retryable === 0}
                        isLoading={retryBatch.isPending}
                        onClick={() => void retry(batch.id)}
                      >
                        补送未送达（{retryable}）
                      </Button>
                    </HStack>
                  </Flex>
                  <HStack mt="2" spacing="3">
                    <Badge colorScheme="green">已回执 {delivered}</Badge>
                    <Badge colorScheme="red">失败 {failed}</Badge>
                    <Badge colorScheme="purple">暂缓 {held}</Badge>
                    <Badge colorScheme="gray">待送达 {pending}</Badge>
                  </HStack>
                  <TableContainer mt="3">
                    <Table size="xs">
                      <Thead>
                        <Tr>
                          <Th>顺序</Th>
                          <Th>请求 / 任务</Th>
                          <Th>数据系统</Th>
                          <Th>状态</Th>
                          <Th>尝试</Th>
                          <Th>回执 / 依据</Th>
                        </Tr>
                      </Thead>
                      <Tbody>
                        {[...batch.items]
                          .sort((left, right) => left.registeredSequence - right.registeredSequence)
                          .map((item) => (
                            <Tr key={item.id}>
                              <Td>#{item.registeredSequence}</Td>
                              <Td>
                                <Text fontWeight="600">{item.requestCode}</Text>
                                <Text color="gray.500">{item.taskName}</Text>
                              </Td>
                              <Td>{item.systemName}</Td>
                              <Td>
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
                              </Td>
                              <Td>{item.attempts}</Td>
                              <Td>
                                {item.status === 'delivered' ? (
                                  <Text color="green.700" className="mono">
                                    {item.receiptReference}
                                  </Text>
                                ) : item.status === 'held' ? (
                                  <Text color="purple.700">
                                    依据 {item.heldByRequestCode}
                                  </Text>
                                ) : item.status === 'failed' ? (
                                  <Text color="red.600">{item.failureReason}</Text>
                                ) : (
                                  <Text color="gray.500">等待补送</Text>
                                )}
                              </Td>
                            </Tr>
                          ))}
                      </Tbody>
                    </Table>
                  </TableContainer>
                </Box>
              )
            })}
          </VStack>
        )}
      </Box>
    </Box>
  )
}

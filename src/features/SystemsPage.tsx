'use client'

import {
  Badge,
  Box,
  Button,
  Flex,
  Heading,
  HStack,
  Input,
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
import { PageHeader } from '@/components/PageHeader'
import {
  useRetryBatchMutation,
  useSyncScheduleMutation,
  useWorkspaceQuery,
} from '@/lib/hooks'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import {
  batchStatusLabels,
  requestTypeLabels,
  systemStatusLabels,
} from '@/lib/schemas'

export function SystemsPage() {
  const toast = useToast()
  const { data, isLoading } = useWorkspaceQuery()
  const retryBatch = useRetryBatchMutation()
  const syncSchedule = useSyncScheduleMutation()
  const store = useWorkspaceStore()

  if (isLoading || !data) return <Box className="panel">正在加载系统清单...</Box>

  const systems = data.systems.filter((system) =>
    `${system.name}${system.owner}${system.dataDomain}`
      .toLowerCase()
      .includes(store.systemSearch.toLowerCase()),
  )
  const activeRequests = data.requests.filter(
    (request) => !['completed', 'rejected'].includes(request.status),
  )

  async function runSyncSchedule() {
    try {
      await syncSchedule.mutateAsync({ operator: '隐私运营' })
      toast({ title: '排程已按限制处理与批次状态重算', status: 'success' })
    } catch (error) {
      toast({
        title: '重算排程失败',
        description: error instanceof Error ? error.message : '请重试',
        status: 'error',
      })
    }
  }

  async function runRetry(batchId: string) {
    try {
      await retryBatch.mutateAsync({ batchId, operator: '隐私运营' })
      toast({
        title: '批次重试完成',
        description: '仅补发未送达项，已成功回执项未重发。',
        status: 'success',
      })
    } catch (error) {
      toast({
        title: '批次重试未完成',
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
                <Th>状态</Th>
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
                    <Badge colorScheme={system.status === 'active' ? 'green' : 'orange'}>
                      {systemStatusLabels[system.status]}
                    </Badge>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </TableContainer>
      </Box>

      <Box className="panel">
        <Flex className="panel-title">
          <Heading size="sm">调度批次与检查点</Heading>
          <Button
            size="xs"
            variant="ghost"
            isLoading={syncSchedule.isPending}
            onClick={() => void runSyncSchedule()}
          >
            重算排程
          </Button>
        </Flex>
        {data.batches.length ? (
          <TableContainer>
            <Table size="sm">
              <Thead>
                <Tr>
                  <Th>对账批次</Th>
                  <Th>状态</Th>
                  <Th>待发送</Th>
                  <Th>已送达</Th>
                  <Th>已回执</Th>
                  <Th>失败</Th>
                  <Th>检查点说明</Th>
                  <Th>操作</Th>
                </Tr>
              </Thead>
              <Tbody>
                {data.batches.map((batch) => {
                  const count = (status: string) =>
                    batch.items.filter((item) => item.status === status).length
                  const retryable = count('failed') + count('queued')
                  return (
                    <Tr key={batch.id}>
                      <Td>
                        <Text fontWeight="600" className="mono">
                          {batch.label}
                        </Text>
                        <Text color="gray.500" fontSize="xs">
                          {new Date(batch.createdAt).toLocaleString('zh-CN')}
                        </Text>
                      </Td>
                      <Td>
                        <Badge
                          colorScheme={
                            batch.status === 'settled'
                              ? 'green'
                              : batch.status === 'checkpointed'
                                ? 'orange'
                                : 'blue'
                          }
                        >
                          {batchStatusLabels[batch.status]}
                        </Badge>
                      </Td>
                      <Td>{count('queued')}</Td>
                      <Td>{count('delivered')}</Td>
                      <Td>{count('acknowledged')}</Td>
                      <Td color={count('failed') ? 'red.600' : undefined} fontWeight="600">
                        {count('failed')}
                      </Td>
                      <Td maxW="320px" whiteSpace="normal">
                        <Text fontSize="sm">{batch.checkpointNote || '—'}</Text>
                      </Td>
                      <Td>
                        <Button
                          size="xs"
                          variant="link"
                          colorScheme="brand"
                          isDisabled={!retryable}
                          isLoading={retryBatch.isPending}
                          onClick={() => void runRetry(batch.id)}
                        >
                          重试未送达项
                        </Button>
                      </Td>
                    </Tr>
                  )
                })}
              </Tbody>
            </Table>
          </TableContainer>
        ) : (
          <Text color="gray.500" fontSize="sm">
            暂无调度批次：任务下发数据系统后会生成对账批次与检查点。
          </Text>
        )}
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
    </Box>
  )
}

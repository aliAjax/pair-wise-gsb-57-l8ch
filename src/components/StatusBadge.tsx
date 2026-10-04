import { Badge, type BadgeProps } from '@chakra-ui/react'
import {
  requestStatusLabels,
  requestTypeLabels,
  taskStatusLabels,
  type RequestStatus,
  type RequestType,
  type TaskStatus,
} from '@/lib/schemas'

const statusColor: Record<RequestStatus, string> = {
  registered: 'gray',
  'identity-review': 'purple',
  processing: 'blue',
  'review-required': 'red',
  'pending-close': 'orange',
  completed: 'green',
  rejected: 'gray',
  extended: 'yellow',
}

const typeColor: Record<RequestType, string> = {
  access: 'blue',
  rectification: 'cyan',
  deletion: 'red',
  'withdraw-consent': 'orange',
  restriction: 'purple',
}

const taskStatusColor: Record<TaskStatus, string> = {
  pending: 'gray',
  active: 'blue',
  completed: 'green',
  blocked: 'red',
  suspended: 'purple',
}

export function StatusBadge({ status }: { status: RequestStatus }) {
  return <Badge colorScheme={statusColor[status]}>{requestStatusLabels[status]}</Badge>
}

export function TypeBadge({ type, ...props }: { type: RequestType } & BadgeProps) {
  return (
    <Badge colorScheme={typeColor[type]} {...props}>
      {requestTypeLabels[type]}
    </Badge>
  )
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return (
    <Badge colorScheme={taskStatusColor[status]}>{taskStatusLabels[status]}</Badge>
  )
}

# 用户隐私权利请求履约工作台

覆盖访问、更正、删除、撤回同意和限制处理请求的多页面履约工作台。项目使用 Next.js App Router、Chakra UI、Zustand、TanStack Query、tRPC、Zod 和 TypeScript 构建。

## 功能

- 客服登记请求，根据地区、身份核验状态和请求类型生成处理步骤与期限。
- 定位相关系统、分派任务、登记执行证据、合并跨系统结果并记录处理意见。
- 身份材料只保存掩码引用和摘要，不保存材料明文。
- 重复请求、身份材料不足、跨系统结果冲突自动进入复核队列。
- 支持任务开始、完成和阻断，冲突逐项复核，延期必须填写原因。
- 截止时间前关闭必须记录提前关闭理由，未完成任务或存在冲突时服务端拒绝关闭。
- 限制处理请求、系统任务与对账批次共同决定排程：同一数据主体在限制期内，清除和更正任务的系统步骤停在待复核，不下发数据系统；限制解除、撤回或到期后按原登记顺序重新下发。
- 任务下发登记对账批次与检查点；系统维护或接口失败后保留检查点，重试只补未送达项，已成功回执项不重发、不覆盖。
- 变更操作串行执行，后到动作基于最新状态重算排程，不会覆盖已回执或已暂缓的项。
- 请求详情、复核队列和导出处理包展示被暂缓的任务及其依据的限制处理请求。
- 汇总登记、核验、分派、证据、冲突、延期和关闭审计，导出脱敏处理包。

tRPC 路由使用 Zod 校验操作输入；TanStack Query 管理服务数据；Zustand 管理工作区筛选状态；每次成功操作都会把完整工作区写入浏览器 `localStorage`。

## 运行

```bash
npm install
npm run dev
```

开发服务地址：`http://localhost:18457`

## 构建

```bash
npm run build
npm run start
```

## 排程规则验证

```bash
npx tsx scripts/verify-schedule.ts
```

覆盖限制期内拦截派发、解除/到期后按登记顺序重发、批次检查点重试和已回执项保护等 40 项断言。

## 目录

```text
src/
  app/          Next App Router 页面与 tRPC API Handler
  components/   应用外壳、页面头、状态标签
  features/     总览、请求列表、请求详情、复核、系统、审计
  lib/          Zod Schema、tRPC 客户端、TanStack Query Hooks、本地存储
  server/       tRPC 服务路由
  services/     流程模板和履约业务规则
  stores/       Zustand 工作区状态
  types/        领域类型
```

# 用户隐私权利请求履约工作台

覆盖访问、更正、删除、撤回同意和限制处理请求的多页面履约工作台。项目使用 Next.js App Router、Chakra UI、Zustand、TanStack Query、tRPC、Zod 和 TypeScript 构建。

## 功能

- 客服登记请求，根据地区、身份核验状态和请求类型生成处理步骤与期限。
- 定位相关系统、分派任务、登记执行证据、合并跨系统结果并记录处理意见。
- 身份材料只保存掩码引用和摘要，不保存材料明文。
- 重复请求、身份材料不足、跨系统结果冲突自动进入复核队列。
- 支持任务开始、完成和阻断，冲突逐项复核，延期必须填写原因。
- 截止时间前关闭必须记录提前关闭理由，未完成任务或存在冲突时服务端拒绝关闭。
- 限制处理请求、系统任务与对账批次共同决定排程：同一数据主体限制期内的清除（删除）和更正任务停在「暂缓待复核」，不向数据系统下发；限制到期或撤回后，等待任务按原登记顺序重新下发。
- 下发按对账批次执行并保留检查点：系统维护或接口失败只标记未送达项，重试只补未送达项，已成功回执的任务不重发；后到动作基于工作区版本号做并发保护，不能覆盖已经回执的项。
- 请求详情、复核队列与导出包显示每项暂缓任务及其依据的限制处理请求编号。
- 汇总登记、核验、分派、证据、冲突、延期、暂缓/恢复和关闭审计，导出脱敏处理包。

tRPC 路由使用 Zod 校验操作输入（含乐观并发用的 `expectedRevision`，过期返回冲突错误）；TanStack Query 管理服务数据；Zustand 管理工作区筛选状态；每次成功操作都会把完整工作区写入浏览器 `localStorage`。

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

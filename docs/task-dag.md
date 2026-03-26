# 任务依赖图（Task DAG）系统

## 概述

任务依赖图系统将原来的内存数组 TodoManager 升级为**基于文件持久化的有向无环图（DAG）任务管理器**。每个任务是一个独立的 JSON 文件，支持依赖关系声明和自动解锁，即使上下文被压缩也能从磁盘恢复状态。

## 核心数据结构

每个任务存储为 `.tasks/task_N.json`，结构如下：

```typescript
interface Task {
  id: number;          // 自增 ID
  subject: string;     // 任务标题
  description: string; // 详细描述
  status: "pending" | "in_progress" | "completed";
  blockedBy: number[]; // 依赖的前置任务 ID 列表
  blocks: number[];    // 被当前任务阻塞的后续任务 ID 列表
}
```

`blockedBy` 和 `blocks` 是一对**双向引用**：如果任务 2 的 `blockedBy` 包含 1，那么任务 1 的 `blocks` 也会包含 2。

## DAG 依赖机制

### 依赖建立

通过 `task_update` 工具的 `blocked_by` 或 `blocks` 参数添加依赖。系统会自动维护双向关系：

```
task_update(task_id=2, blocked_by=[1])
```

执行后：
- 任务 2 的 `blockedBy` 加入 1
- 任务 1 的 `blocks` 加入 2

### 自动解锁

当一个任务被标记为 `completed` 时，`clearDependency()` 方法会：

1. 遍历 `.tasks/` 目录下所有任务文件
2. 从每个任务的 `blockedBy` 数组中移除已完成任务的 ID
3. 将修改后的任务写回磁盘

当某个任务的 `blockedBy` 变为空数组且 `status === "pending"` 时，该任务即为可执行状态。

### 示例流程

```
创建任务：
  #1: 设计 API      → pending, blockedBy: []
  #2: 实现后端      → pending, blockedBy: [1]
  #3: 编写测试      → pending, blockedBy: [2]
  #4: 编写文档      → pending, blockedBy: [1]

完成任务 1 后自动解锁：
  #1: 设计 API      → completed
  #2: 实现后端      → pending, blockedBy: []    ← 已解锁，可执行
  #3: 编写测试      → pending, blockedBy: [2]   ← 仍被阻塞
  #4: 编写文档      → pending, blockedBy: []    ← 已解锁，可执行

任务 2 和 4 可以并行执行。
```

## 文件持久化

### 存储位置

所有任务文件存放在项目根目录的 `.tasks/` 下：

```
.tasks/
├── task_1.json
├── task_2.json
└── task_3.json
```

### ID 分配

`nextId()` 方法扫描 `.tasks/` 目录下所有 `task_N.json` 文件，取最大 ID + 1 作为新任务 ID。

### 持久化的意义

Agent 对话的上下文窗口有限，当上下文被压缩时，内存中的状态会丢失。文件持久化保证 agent 可以随时通过 `task_list` 或 `task_get` 从磁盘重新读取任务状态，不依赖对话历史。

## 工具接口

原来的单一 `todo` 工具被拆分为 4 个细粒度工具：

| 工具 | 参数 | 说明 |
|------|------|------|
| `task_create` | `subject`, `description?` | 创建新任务 |
| `task_update` | `task_id`, `status?`, `blocked_by?`, `blocks?` | 更新状态或依赖 |
| `task_list` | 无 | 列出全部任务（带状态和依赖信息） |
| `task_get` | `task_id` | 获取单个任务的完整 JSON |

拆分为多个工具的好处：
- LLM 调用意图更明确，减少参数构造错误
- 每个工具的 token 开销更小
- `task_list` 无参数，调用零成本

## Nag（催促）机制

### 目的

防止 agent 在执行过程中忘记更新任务状态。

### 工作原理

`AgentState` 中维护一个计数器 `roundsSinceTask`：

1. 每当 agent 调用了任何 `task_*` 开头的工具，计数器归零
2. 每一轮如果没有调用 `task_*` 工具，计数器 +1
3. 当计数器达到阈值（`NAG_THRESHOLD = 3`）**且**存在未完成任务（`hasActiveTasks()` 返回 true）时，系统在工具输出中注入一条提醒：

```xml
<reminder>Update your tasks with task_list or task_update.</reminder>
```

### 两个触发条件缺一不可

- **连续 3 轮未调用 task 工具** — 说明 agent 可能忘了维护任务
- **存在活跃任务** — 如果没有待办任务，催促没有意义

### 注入方式

根据 API 模式不同，注入方式有区别：

- **Responses API**：将提醒文本拼接到最后一个工具输出的前面
- **Chat Completions API**：向 `chatHistory` 追加一条 `role: "user"` 的消息

两种方式都能让 LLM 在下一轮推理时看到提醒，从而想起更新任务状态。

## 文件变更清单

| 文件 | 变更 |
|------|------|
| `src/task-manager.ts` | 新建，TaskManager 类实现 |
| `src/tools.ts` | TodoManager → TaskManager，todo → 4 个 task_* 工具 |
| `src/agent.ts` | nag 机制适配，todo 检测 → task_* 前缀检测 |
| `src/types.ts` | `roundsSinceTodo` → `roundsSinceTask` |
| `src/index.tsx` | 字段重命名同步 |
| `src/todo.ts` | 已删除 |

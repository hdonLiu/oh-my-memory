# Oh My Memory 最新记忆架构

Status: `Canonical target architecture`

Date: `2026-07-21`

Supersedes:

- `docs/architecture/oh-my-memory-architecture-v2.md`
- `docs/architecture/oh-my-memory-architecture-v2.1.md`
- ADR-0001 中将在线 Topic、Provisional L1 和 Canonical L1 分成不同阶段实体的旧表述

本文记录当前已经讨论确认的目标架构。核心原则是：Turn 是唯一不可变的原始事实；Topic、L2 和 L3 都是可覆盖、可删除和可重建的派生数据。实时流程和离线流程操作同一套 Topic，不再额外创建 Provisional L1 或 Canonical L1。

文档优先级：

1. 本文定义目标架构和状态所有权。
2. `PROJECT_ISSUES.md` 记录从当前实现迁移到目标架构的任务和讨论结论。
3. `README.md` 记录当前可运行方式，并明确标记迁移期差异。
4. `docs/` 中旧版本架构、ADR、roadmap、spec 和 plan 仅作为历史记录。

## 1. 项目目标与租户模型

Oh My Memory 的目标是成为一个云端多租户 Memory 服务，为多个 Agent 提供可持久、可追溯、可修正和分层 Recall 的记忆能力。本文中，每个 `uid + agentId` 是一个默认独立的 Memory 租户 namespace。

### 1.1 租户与记忆空间

本文使用以下租户与隔离概念：

- `uid`：顶层用户/账户和安全边界。任何 Turn、Topic、L2、L3、Correction、evidence 和 Recall 都不得跨 `uid` 读写或聚合。
- `agentId`：同一 `uid` 下的 Memory 租户身份。每个 Agent 默认拥有完全独立的记忆 namespace。
- `memorySpaceId`：L2/L3 的聚合、存储、重建和 Recall 隔离单元。每个 Agent 默认使用自己的 private Memory Space。

同一 `uid` 可显式创建 shared Memory Space，并将多个 Agent 加入该空间。共享默认关闭，必须通过明确配置开启；不允许将不同 `uid` 的 Agent 加入同一 Memory Space。

### 1.2 Session 标识

Agent 端和 Memory 层使用两种不同的 Session 标识：

- `externalSessionId`：由 Agent 端生成并传入，只要求在同一 `uid + agentId` 内唯一，不要求全局唯一。
- `sessionId`：由 Memory 层生成的内部全局唯一 ID。Turn、Topic 和内部关联只引用这个 ID。

建议的 Session 模型为：

```ts
interface Session {
  id: string; // Memory 层分配的内部 sessionId
  uid: string;
  agentId: string;
  externalSessionId: string;
  source: string;
  channel?: string;
}
```

Memory 层必须使用以下完整 key 查找或创建 Session：

```text
uid + agentId + externalSessionId
```

其中 `uid` 应从认证上下文派生，不信任请求体中的同名字段；`agentId` 必须已被授权给当前 `uid`。不得只根据 `externalSessionId` 查询，否则会导致不同用户或 Agent 的 Session 串联。

`source` 和 `channel` 是 provenance、筛选和审计属性，不是默认的 Session identity 或记忆隔离边界。如果一个 Agent 从多个上游系统接收可能重复的会话 ID，Agent 应生成在自己 namespace 内唯一的 `externalSessionId`，例如加入来源前缀。

查找不存在的 external Session 时，Memory 层应原子地创建 Session 并分配内部 `sessionId`。数据库必须对 `uid + agentId + externalSessionId` 建立唯一约束，以避免并发请求创建重复 Session。

即使调用方已经持有内部 `sessionId`，读写 Session、Turn 或 Topic 时仍必须校验其 `uid + agentId`，不能把全局唯一 ID 当作授权凭证。

Session 是会话身份和归属对象，不是新的记忆层。

### 1.3 分层隔离规则

1. Turn 和 Topic 始终归属于单一 `uid + agentId`，不在 Agent 之间直接共享。
2. Turn 和 Topic 归属于 Memory 层内部 `sessionId`；Session 归属于唯一 `uid + agentId`。`source` 和 `channel` 不参与 Topic identity。
3. processed Topic 可以按显式的 Memory Space 配置进入 L2。默认只进入所属 Agent 的 private Memory Space；开启共享后，才可进入当前 Agent 有权写入的 shared Memory Space。
4. shared L2 可聚合同一 `uid` 下多个成员 Agent 的 processed Topic；shared L3 只从该 shared L2 提取。
5. Agent Recall 只能读取自己的 Turn/Topic、private L2/L3，以及当前显式授权的 shared L2/L3。其他 Agent 的 Topic 不得作为 Topic 级 Recall 结果返回。
6. L2/L3 中每条 evidence 必须保留原始 `uid`、`agentId` 和 Turn 引用，不得因进入 shared Memory Space 而丢失来源 Agent。
7. Memory Space 成员和授权变化是需要审计和下游重新整理的配置变更，不能只改 Recall 过滤条件而保留不再合法的派生记忆。

Memory Space 是 namespace 和权限控制对象，不是新的记忆层。

## 2. 总体流程

```text
Turn（uid + agentId + 内部 sessionId）
  ↓
Topic
  ├─ 实时流程：轻量地闭合 Topic 区间
  └─ 离线流程：在同一 session 内整理、拆分、合并和去噪
  ↓
L2 Aggregate（Memory Space）
  └─ 跨 session 聚合稳定事实和项目知识，shared 空间可跨 Agent
  ↓
L3 Profile（Memory Space）
  └─ 从稳定 L2 中提取用户画像、偏好等持久化信息
```

系统只有四种核心记忆对象：

1. `Turn`：不可变的原始对话证据。
2. `Topic`：从 Turn 派生的同 session 话题分组，实时和离线流程共同维护。
3. `L2 Aggregate`：从当前 processed Topic 快照派生的跨 session 稳定知识。
4. `L3 Profile`：从当前 L2 快照派生的用户画像、偏好等长期信息。

以下概念不再作为独立数据层：

- `Provisional L1`：由“已闭合但待离线整理的 Topic”直接承担。
- `Canonical L1`：由“已经过离线整理的 processed Topic”直接承担。

`provisional`、`processed` 等词描述的是 Topic 当前所处的处理状态，不代表新的记忆实体。

## 3. Turn

Turn 是整个系统唯一不可变的原始证据。

要求：

- 写入后不直接修改或覆盖。
- 写入 Turn 前，Memory 层先通过 `uid + agentId + externalSessionId` 解析或创建内部 Session；Turn 只保存内部 `sessionId` 作为会话关联。
- Correction 不修改原始 Turn，而是记录修正事实，并触发下游重新整理。
- Topic、L2 和 L3 都必须能够向下追溯到 Turn。
- 当前尚未闭合的对话上下文直接使用 Turn，不需要为了当前会话额外创建临时记忆层。

## 4. Topic

### 4.1 Topic 的职责

Topic 是从 Turn 派生的同 session 话题分组，不是原始事实。它可以被原地更新、合并、拆分、删除或从 Turn 重建。

实时和离线流程操作同一张 Topic 表：

```ts
interface Topic {
  id: string;
  sessionId: string;
  status: "open" | "pending" | "processed";
  turnIds: string[];
  title?: string;
  summary?: string;
  structuredContent?: TopicContent;
  updatedAt: string;
}
```

`turnIds` 保留 Topic 区间对应的原始 Turn。标题、摘要、向量和结构化内容都属于 Topic 派生结果，不回写 Turn。

### 4.2 实时流程

实时流程只负责持久化 Turn 和估算大致 Topic 边界：

1. 先原样持久化 Turn。Turn 写入不得被 embedding 或模型失败阻断。
2. 使用高精度规则临时识别纯问候、纯标点、确认语等低信息内容。这些 Turn 仍保留，但不影响 Topic 向量和 Recall 文本。
3. 对有效新 Turn 与当前 open Topic 进行向量相似度判断。
4. 高相似时追加到当前 Topic，低相似时闭合当前 Topic 并创建新 Topic。
5. 相似度处于模糊区时，可在严格延迟预算内使用小模型做 `continue | split` 二级判断。超时或不可用时回退到轻量规则。
6. Topic 闭合时将状态从 `open` 改为 `pending`，并立即以 provisional 形式参与 Recall。

硬边界信号仍然优先于向量判断，包括：

- 显式话题切换表达。
- Topic 达到最大 Turn 或 token 数量。
- 显式调用 session/topic flush。
- 会话空闲超过配置时间。

实时判断只是临时计算，不在 Turn 上保存 annotation。如果一个区间只包含问候、确认或噪声，flush 时可以不保留可 Recall 的 Topic。

### 4.3 哪些 Topic 参与 Recall

只保留三种 Topic 状态：

| Topic 状态 | 含义 | 是否参与 Recall | Recall 标记 |
| --- | --- | --- | --- |
| `open` | 当前仍在追加 Turn | 否 | 当前会话直接使用 Turn |
| `pending` | 已闭合，尚未离线整理 | 是 | `provisional` |
| `processed` | 已经过离线整理 | 是 | `stable` |

不再使用 `active`、`merged`、`superseded` 或 `deleted` 表示 Topic 历史。不再有效的 Topic 直接从当前派生数据中删除。

### 4.4 离线 Topic 维护

离线任务只在同一个 session 内整理 Topic，主要操作包括：

- 修正标题和摘要。
- 在 Topic 派生内容中忽略噪声，不删除原始 Turn。
- 调整 Turn 所属的 Topic 区间。
- 拆分错误 Topic。
- 合并重复或连续 Topic。
- 提取供 Recall 和 L2 使用的结构化内容，例如事实、决策、约束、任务和偏好。

离线任务读取当前 Session 的 Turn 和 Topic 快照，计算出新的完整 Topic 集合，然后在一个数据库事务中替换该 Session 的旧结果：

```text
当前 Session Turns + Topics
            ↓
      离线 Topic 维护
            ↓
    计算完整新 Topic 集合
            ↓
       原子替换旧结果
```

普通整理直接更新 Topic；合并时创建或更新结果 Topic 并删除旧 Topic；拆分时删除原 Topic 并创建新 Topic。不保留 Topic revision、lineage、tombstone 或历史状态。

`processed` 只表示当前 Topic 已经过离线整理，不表示永久冻结。同 session 出现新 Turn 或 Correction 时，可以再次重建。新结果提交失败时，原有 Topic 集合保持不变。

## 5. L2 Aggregate

### 5.1 职责

L2 是单个 Memory Space 内的当前聚合快照，可以从 processed Topic 重建。private Memory Space 只聚合单个 Agent；shared Memory Space 可聚合同一 `uid` 下已授权成员 Agent 的输入。

- 将多个 session 中相关 Topic 聚合到同一知识对象。
- 合并重复信息。
- 处理更新、冲突、决策和约束。
- 保留直接的 Turn evidence 和来源 Agent；Topic ID 可作为辅助来源，但不是永久存在的强依赖。

### 5.2 输入约束

L2 只消费：

```text
status = processed 的当前 Topic
```

`pending` Topic 可以参与 provisional Recall，但不能进入 L2。

L2 还必须验证 Topic 的 `uid` 与 Memory Space 一致，且 Topic 的 `agentId` 在该 Memory Space 的当前写入授权中。

Topic 内的结构化事实、决策、约束等是 Topic 的派生内容。它们可以使用独立表实现，但不构成新的记忆层。

### 5.3 重建策略

Topic 变化后，受影响的 Memory Space 标记为待重建。L2 任务以该空间的当前 processed Topic 快照为输入，产生完整的目标 Aggregate 集合，并在一个事务中 upsert 新结果、删除不再出现的旧结果。

```text
Memory Space 当前 processed Topics
                 ↓
             重建 L2
                 ↓
       原子替换 Aggregate 集合
```

不使用 Topic revision、change sequence 或历史 membership 作为正确性基础。简单的 dirty 标记或 `updatedAt` 只用于调度；当前 Topic 快照才是 L2 重建的事实输入。重建失败时保留上一份完整 L2 结果。
 
## 6. L3 Profile

### 6.1 职责

L3 是当前 L2 快照之上的可重建投影，主要保存：

- 用户画像。
- 长期偏好。
- 稳定习惯。
- 长期约束。
- 稳定关系等跨时间信息。

L2 已经负责跨 session 聚合、冲突和修正，因此 L3 不重复建立 session 数、时间跨度或复杂候选状态。

### 6.2 输入与证据

L3 只消费同一 Memory Space 中的当前 L2 Aggregate，不直接消费 Turn 或 Topic，也不得跨 Memory Space 组合 evidence。

每个 L3 Profile 使用稳定 `profileKey`，其唯一性 scope 是 `uid + memorySpaceId + profileKey`。Profile 保存直接支撑它的 `evidenceAggregateIds`，并同时展开保留原始 Turn evidence 和来源 Agent，避免因上游派生对象被替换而丢失追溯能力。

### 6.3 重建策略

L3 任务读取当前 L2 和当前 Profile，生成该 Memory Space 完整的目标 Profile 集合：

```ts
interface L3ExtractionResult {
  profiles: ProfileDraft[];
}
```

服务端先完整验证所有 `profileKey` 和 evidence Aggregate，然后在一个事务中 upsert 新结果并删除不再出现的旧 Profile。任一项非法或处理失败时，保留上一份完整 L3 结果。

L3 不保留 Profile revision、`superseded` 历史或单独的 retire 状态机。`profileKey` 只用于同一 Memory Space 内的当前 Profile upsert。

## 7. Correction 传播

Correction 不直接修改历史 Turn，而是沿记忆链重新整理：

```text
Correction
    ↓
基于原始 Turn 和 Correction 重建受影响 session 的 Topic
    ↓
重建受影响 Memory Space 的 L2
    ↓
重建 L3
```

每一层只负责自己的语义：

- Topic 负责同 session 内的整理。
- L2 负责跨 session 的稳定知识。
- L3 负责用户画像投影。

当前实现中的 `pending_l1` 应理解为“等待 Topic maintenance”的兼容状态名。目标语义是 `pending_topic_maintenance`；是否直接迁移数据库枚举和 API 字段，由实施任务决定，但新文档不再把它解释成独立 Canonical L1 流程。

如果受影响 Topic 已进入一个或多个 Memory Space，Correction 必须将所有受影响空间标记为待重建。不得只更新 private 空间而在 shared 空间中保留已知过期的派生记忆。Recall 可使用简单的 `current | rebuilding` freshness 标记表达当前是否已完成重建，不需要复杂的 revision 水位。

## 8. Recall 策略

Recall 候选包含：

1. `pending` Topic：`provisional`。
2. `processed` Topic：`stable`。
3. 当前 L2 Aggregate：`stable`。
4. 当前 L3 Profile：`stable`。

不应返回：

- open Topic。
- 已经从当前派生数据中删除的 Topic、L2 或 L3 结果。

Recall 应返回证据和状态，使调用方知道某条 Topic 是否仍可能被离线任务调整。

Recall 必须先根据 `uid + agentId` 解析调用方可读的 Memory Space，然后在这些空间内检索 L2/L3。Topic 级候选仍严格限制为调用 Agent 自身的 Topic。共享配置关闭时，Recall 不得自动扩大到其他 Agent 的任何记忆。

Topic、L2 或 L3 重建必须以完整结果原子替换。Recall 只读取已提交的快照，不得看到一半新、一半旧的数据。

## 9. 核心不变量

实现必须保持以下约束：

1. Turn 是不可变原始证据。
2. Turn 不承担 annotation、Topic 边界、内容价值或其他派生逻辑。
3. Topic、L2 和 L3 都是可覆盖、可删除和可重建的派生数据。
4. 实时和离线流程操作同一套 Topic。
5. Topic 只使用 `open | pending | processed` 三种状态。
6. open Topic 不作为 Recall 候选；pending Topic 可立即 Recall，但必须标记 provisional。
7. 问候、确认和噪声过滤只影响 Topic 派生逻辑，不删除或修改 Turn。
8. Topic 离线维护严格限制在同一 session 内，并原子替换该 Session 的当前 Topic 集合。
9. 不保留 Topic revision、lineage、merged/superseded 历史或 tombstone。
10. L2 只消费 processed Topic，并按 Memory Space 原子替换当前 Aggregate 集合。
11. L3 只消费当前 L2，并按 Memory Space 原子替换当前 Profile 集合。
12. Topic、L2 或 L3 重建失败时，必须保留上一份完整结果。
13. Correction 按 Topic → L2 → L3 顺序触发重建。
14. `uid` 是不可跨越的用户和安全边界。
15. Turn 和 Topic 始终归属单一 Agent，不通过 shared Memory Space 直接共享。
16. L2/L3 的当前结果和 `profileKey` 必须按 Memory Space 隔离。
17. 跨 Agent 共享默认关闭，且只允许在同一 `uid` 内通过显式授权开启。
18. 共享 L2/L3 中的 evidence 必须保留来源 Agent 和 Turn 引用，所有读写都要校验 Memory Space 授权。
19. Agent 端的 `externalSessionId` 只在 `uid + agentId` 内唯一；Memory 层的内部 `sessionId` 由服务端分配并全局唯一。
20. external Session 的查找和唯一约束必须同时包含 `uid + agentId + externalSessionId`。
21. 内部 `sessionId` 只是实体标识，不是授权凭证；所有 Session、Turn 和 Topic 读写仍必须校验 `uid + agentId`。

## 10. 与当前实现的主要差异

当前实现中同时存在 `topic_segments`、Provisional L1 和 Canonical L1。目标架构需要逐步收口为一套 Topic 模型：

```text
当前实现：
Turn → topic_segments → provisional l1_topics → canonical l1_topics → L2 → L3

目标架构：
Turn → Topic（实时闭合 + 离线维护）→ L2 → L3
```

主要调整方向：

1. 删除独立 Provisional L1 的持久化和同步逻辑。
2. 删除独立 Canonical L1 Topic；将离线整理结果直接写回当前 Topic。
3. 将现有 L1 Component 视为 Topic 的结构化内容，而不是单独记忆层。
4. 将 L1 maintenance 重命名并收口为 Topic maintenance。
5. 删除 Topic revision、lineage、merged/superseded 状态和 tombstone；Topic maintenance 直接原子替换 Session 当前结果。
6. L2/L3 改为基于当前上游快照的可重建派生数据，不再以 revision、change sequence 或复杂 checkpoint 作为正确性基础。
7. Recall 直接区分 pending Topic、processed Topic、当前 L2 和当前 L3。
8. 实时 Topic 边界以规则和向量为主，模糊区可使用小模型；任何辅助判断都不回写 Turn annotation。
9. 将当前以 `uid + agent` 隔离的 L2/L3 扩展为显式 Memory Space；保持 private 为默认，并支持同 `uid` 下可选的多 Agent 共享。
10. 将 Agent 端的 `externalSessionId` 与 Memory 层内部 `sessionId` 分离，并以 `uid + agentId + externalSessionId` 作为 external Session 的唯一映射 key。

## 11. 最终结论

这套架构的核心是保持一个简单的事实源，并让其他层随时可重建：

```text
Turn：单 Agent 的不可变原始快照
Topic：从 Session Turns 派生的当前话题分组
L2：从 Memory Space 当前 processed Topics 派生的跨 session 知识
L3：从 Memory Space 当前 L2 派生的长期画像
```

Topic 只保留 `open | pending | processed` 三种当前状态。合并、拆分和去噪是对当前派生结果的重算，不需要额外建模 revision、lineage 或新的记忆层。只有在真实出现审计、回滚或大规模增量计算需求时，才重新评估是否引入更复杂的版本模型。

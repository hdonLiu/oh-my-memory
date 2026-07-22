# Memory Architecture 直接替换与 TDD 实施计划

> 日期：2026-07-21  
> 架构基线：`MEMORY_ARCHITECTURE.md`  
> 实施方式：直接替换旧实现，不保留兼容流程、双写、旧 API 别名或旧派生数据模型

## 实施状态

2026-07-21 已按本计划完成核心链路替换：Session/Turn、实时与离线 Topic、MemorySpace、L2/L3 当前快照、Correction、Recall、Scheduler、HTTP/CLI、认证上下文和旧库原始 Turn 迁移均已切换到新模型。HTTP 不再接收 `uid`，而是由 Bearer token 对应的认证上下文提供，并校验 `agentId` 授权。旧 L1 revision/component/lineage/watermark、project/dreaming/search 运行路径及其旧测试已删除。

TDD 验证覆盖：租户身份、Turn 不可变与幂等、向量阈值与 small model 模糊区、模型失败延迟派生、共享空间授权、Topic/L2/L3 原子替换、Correction 级联、真实 provider 请求契约、旧库迁移冲突回滚和新 HTTP 身份参数。最终验证命令见第 8 节。

## 1. 目标与边界

本次改造把当前实现直接替换为 `MEMORY_ARCHITECTURE.md` 中定义的云端多租户 Memory 架构：

- `uid` 是安全边界；`agentId` 是默认 Memory 租户。
- 同一 `uid` 下默认按 Agent 隔离；只有显式加入共享 `MemorySpace` 后，L2/L3 才能跨 Agent 共享。
- Agent 提供 `externalSessionId`；Memory 分配全局唯一的内部 `sessionId`。
- 外部会话查询必须同时携带 `uid + agentId + externalSessionId`。
- `source`、`channel` 只作为来源元数据，不参与 Session 身份定位。
- Turn 是不可变原始快照，不做 annotation，不承载 Topic、记忆或纠错逻辑。
- Topic、L2 Aggregate、L3 Profile 都是当前快照，可覆盖、删除和从上游重建。

本次不做：

- 不新增一条与旧链路并存的新流程。
- 不做新旧双写、灰度开关或兼容读取。
- 不保留 L1 revision、component、lineage、watermark 等旧抽象。
- 不迁移 Topic/L1/L2/L3 等派生数据；它们在新结构中从 Turn 重建。
- 不用规则实现或冒充任何应由 embedding/LLM 完成的语义判断。

## 2. 不可妥协的模型边界

### 2.1 可以使用规则的地方

规则只处理确定性的非语义约束：

- 请求和模型输出的 schema 校验。
- Session、租户、MemorySpace 授权校验。
- Topic 最大 Turn 数、显式 flush、事务边界、幂等键等硬边界。
- 高精度、低召回的低信息输入过滤，例如完全匹配“你好”“谢谢”“OK”；Turn 仍然入库，只是不参与向量和 Recall 文本。
- 超时、重试、熔断、队列状态和失败恢复。

### 2.2 必须使用真实模型能力的地方

以下职责在生产代码中必须调用真实 embedding 或 LLM 实现：

- Turn/Topic 的语义向量生成与相似度计算。
- Topic 相似度模糊区间的 `continue | split` 判断。
- 离线 Topic 全量重整及 title、summary、structured content 生成。
- L2 当前事实集合的提取、合并、冲突处理和完整目标集生成。
- L3 用户画像的归纳和完整目标集生成。
- 需要语义理解的 Recall 查询规划、候选重排或回答生成。

禁止提供 `RuleBased*Model`、关键词分类器或字符串长度判断作为上述模型能力的替代实现。模型不可用时只能：

- 保留已写入的 Turn；
- 将派生层保持为 dirty/pending 并重试；
- 或执行明确标记为非语义的硬边界动作；
- 不能伪造一个“模型已判断”的结果。

### 2.3 测试中的模型

单元测试可以注入 scripted fake/stub，返回测试预先指定的 embedding 或结构化 LLM 输出。测试桩只负责模拟接口响应，不包含关键词、正则、启发式或其他业务判断。至少保留一组契约测试覆盖真实 provider 的请求格式、响应解析、超时和错误映射。

## 3. 替换后的核心数据模型

### 3.1 Session 与 Turn

- `sessions`
  - `id`：Memory 分配的全局唯一 `sessionId`
  - `uid`
  - `agent_id`
  - `external_session_id`
  - `source`、`channel`：元数据
  - 唯一约束：`(uid, agent_id, external_session_id)`
- `turns`
  - `id`、`session_id`、`sequence`、`role`、`content`、`metadata`、`created_at`
  - `event_id` 用于 Agent 内幂等，唯一约束：`(uid, agent_id, event_id)`
  - 更新操作只允许补齐系统级接收状态；不允许对内容做 annotation 或语义改写

### 3.2 Topic

只保留一个 Topic 模型和一张当前表：

- `topics(id, session_id, status, turn_ids, title, summary, structured_content, recall_text, created_at, updated_at)`
- 状态只有 `open | pending | processed`
- 一个 Session 最多一个 `open` Topic
- 在线流程写入 `open/pending`；离线维护一次计算完整目标集并在事务中全量替换为 `processed`
- 不保留 revision、lineage、tombstone 或 historical membership

### 3.3 MemorySpace、L2 与 L3

- `memory_spaces`：每个 Agent 自动拥有 private space；同一 uid 可显式创建 shared space
- `memory_space_members`：共享空间的 Agent 白名单
- `l2_aggregates`：某个 MemorySpace 的当前知识快照，证据直接引用 Turn
- `l3_profiles`：从当前 L2 生成的当前用户画像
- `rebuild_jobs`：只记录 Topic/L2/L3 当前重建状态、原因、重试信息和 freshness
- 完整目标集写入采用同一事务：upsert 仍存在的记录，删除目标集中不存在的旧记录

## 4. 数据替换策略

现有数据库升级时只迁移可验证的原始 Turn：

1. 从旧 `conversation_turns` 按 `uid + agent + session_id` 分组创建新 Session；旧 `session_id` 作为 `externalSessionId`。
2. 为每个 Session 分配新的内部 `sessionId`，按原始时间和稳定次序写入 Turn。
3. `source`、`channel` 下沉为 Session/Turn 元数据，不再构成身份键。
4. 删除旧派生表并创建新 Topic/L2/L3 表。
5. 为所有迁移后的 Session 和 MemorySpace 写入 dirty rebuild job。

如果旧库无法满足无歧义的 Turn 迁移，升级必须失败并报告冲突，不能猜测或悄悄丢弃原始 Turn。

直接删除的旧表包括但不限于：

- `memories`、`topic_segments`、`memory_relations`
- `l1_topics`、`l1_topic_revisions`、`l1_components`、`l1_topic_lineage`
- `l1_maintenance_runs`、`l1_stable_sequence`
- `l2_aggregate_revisions`、`l2_component_memberships`、`l2_aggregate_lineage`
- `namespace_changes`、`statement_lineage_edges`
- `l2_checkpoints`、`l3_profile_checkpoints`

## 5. TDD 执行规则

每个纵向切片严格执行：

1. **Red**：先写会失败的领域/API/迁移测试，并确认失败原因就是待实现行为。
2. **Green**：实现满足该行为的最小生产代码；语义能力通过真实模型接口进入生产路径。
3. **Refactor**：清理旧实现和重复抽象，再运行相关测试与全量 typecheck。
4. 每个切片完成后，旧代码不能继续被入口、导出、定时任务或数据库引用。

不能先保留旧实现让测试继续通过，再在旁边建立新链路。测试套件本身也要直接替换：删除只验证旧 revision/lineage/watermark 语义的测试，新增验证当前架构不变量的测试。

## 6. 实施切片

### Slice 0：恢复可信测试基线

先解决当前 `better-sqlite3` 与本机 Node ABI 不匹配的问题，保证测试失败能反映代码行为而不是原生模块加载失败。

验收：

- `npm run typecheck` 可运行。
- Vitest 能创建内存数据库。
- 新增一个 schema smoke test，并确认旧架构测试将在后续切片被移除而不是作为兼容目标。

### Slice 1：Session、Turn 与租户边界

Red 测试：

- 相同 externalSessionId 在不同 Agent 下得到不同内部 Session。
- `(uid, agentId, externalSessionId)` 能唯一查询；缺少 uid 或 agentId 的 repository/API 不存在。
- source/channel 变化不会创建另一个 Session。
- Turn 创建后内容不可更新。
- eventId 在 `uid + agentId` 内幂等，不跨 Agent 冲突。

Green 实现：

- 替换领域类型和数据库 schema。
- 用 scoped repository 替换旧 `Scope` 和 `recentTurns` 全表过滤。
- API ingest 只接受 `uid + agentId + externalSessionId` 作为身份参数。

清理：删除旧 `Scope`、旧 session 字段语义和基于 `uid + source + eventId` 的幂等逻辑。

### Slice 2：实时 Topic

Red 测试：

- Turn 总是先落库，embedding/LLM 失败不回滚原始 Turn。
- “你好”等低信息 Turn 入库但不进入向量/Recall 文本。
- 高相似度直接继续，低相似度直接切分。
- 只有模糊区调用 small model，模型返回 `continue | split`。
- 模型异常时不调用语义规则 fallback；Topic 保持可重试状态或只由硬边界推进。
- split 后旧 Topic 变为 pending，新 Topic 成为 open；每个 Session 最多一个 open。
- flush 将可用 open Topic 关闭为 pending。

Green 实现：

- 新建 `EmbeddingProvider`、`AmbiguousTopicModel` 的生产实现和可注入接口。
- 以向量阈值 + 模糊区模型实现唯一在线边界判断器。
- Topic 只存当前快照，不创建 L1 副本。

清理：删除 `SlidingTopicBuilder`、`RuleBasedTopicBoundaryDetector`、旧 `TopicSegment`、`TopicMemoryGenerator` 和 provisional L1 双写。

### Slice 3：离线 Topic 全量维护

Red 测试：

- 维护器以 Session 的完整 Turn 与当前 Topic 为输入调用真实 LLM 接口。
- 模型完整目标集在一个事务中替换旧 Topic；失败时旧快照保持不变。
- 模型输出必须覆盖有效 Turn、保持顺序、不跨 Session，非法输出整体拒绝。
- processed Topic 可以被再次全量重建，不产生 revision/lineage。

Green 实现：

- 实现结构化 `TopicMaintenanceModel` provider。
- 实现校验器和 repository 的 transactional replace。
- Scheduler 只扫描 dirty/pending Session。

清理：删除 L1 planner、revision、component、lineage、stable sequence、watermark 和旧维护任务。

### Slice 4：MemorySpace 与共享授权

Red 测试：

- 新 Agent 默认只能看到自己的 private space。
- shared space 必须同 uid 且显式添加成员。
- L2/L3 才能通过 shared space 跨 Agent，Session/Turn/Topic 始终按 Agent 隔离。
- 跨 uid 加入、读取或写入全部拒绝。

Green 实现：

- 创建 private/shared MemorySpace 和成员 repository。
- 所有 L2/L3 读写入口强制执行授权。

### Slice 5：L2 当前 Aggregate

Red 测试：

- 只消费目标 MemorySpace 内当前 processed Topic。
- LLM 返回完整目标事实集；事务 upsert 新事实并删除缺失旧事实。
- 每条事实保存直接 Turn evidence 和来源 Agent。
- 模型/事务失败时保留上一份 L2 快照并保持 dirty。
- Topic 改写、删除或 correction 会重新标记相关 space dirty。

Green 实现：

- 实现结构化 `L2AggregationModel` 的真实 LLM provider。
- 实现 current-snapshot repository、dirty job 与全量替换事务。

清理：删除 L2 revision、component membership、lineage、watermark 和 checkpoint。

### Slice 6：L3 当前 Profile

Red 测试：

- L3 只读取授权 MemorySpace 的当前 L2。
- LLM 返回完整 profile 集并由事务全量替换。
- L2 改变会标记 L3 dirty；失败保留上一快照。

Green 实现：

- 实现结构化 `L3ProfilingModel` 的真实 LLM provider。
- 接入相同的 rebuild job/freshness 机制。

清理：删除旧 L3 checkpoint、revision/superseded/retire 语义。

### Slice 7：Correction 与 Recall

Red 测试：

- Correction 不修改 Turn，只触发包含相关证据的 Topic -> L2 -> L3 重建。
- Recall 只读取调用者 Session 和已授权 MemorySpace。
- pending/processed Topic、L2、L3 都是当前快照；不会返回被完整替换删除的旧对象。
- 需要语义规划/重排时调用真实 LLM 接口，测试使用 scripted fake；不存在规则版语义 planner。
- 返回 freshness 和 provenance，能追溯到原始 Turn。

Green 实现：

- 实现 correction command、级联 dirty 标记和当前快照 recall。
- 替换 HTTP API、CLI 和 Scheduler 入口。

清理：删除旧 resolver、project memory/eval/dreaming、legacy search/recall 和旧 scheduler。

### Slice 8：删除面与最终验证

必须确认：

- 源码中不存在旧 L1 revision/component/lineage/watermark 运行路径。
- 数据库 schema 中不存在旧派生表。
- HTTP/CLI 不再接受 `source + channel + sessionId` 作为会话身份。
- 不存在 `legacyCompatibility`、dual-write 开关或旧 endpoint 别名。
- 不存在任何规则实现了 embedding/LLM 的语义职责。

最终命令：

```bash
npm run typecheck
npm test
```

另加静态扫描：

```bash
rg "L1Revision|L1Component|Lineage|Watermark|legacyCompatibility|RuleBased.*(Model|Planner|Boundary)" src tests
```

上述扫描命中只能是迁移说明或明确允许的非语义规则；生产运行路径必须为零。

## 7. 完成定义

只有以下条件同时成立才算完成：

- 新架构成为唯一运行链路，旧实现已从代码、表、入口、定时任务和测试中删除。
- Session 查询和所有存储访问满足 `uid + agentId` 租户约束。
- 多 Agent 共享只发生在显式授权的 L2/L3 MemorySpace。
- Turn 保持纯快照；所有派生语义位于 Topic/L2/L3。
- Topic 实时模糊判断、离线维护、L2、L3 和语义 Recall 都由真实模型 provider 承担。
- 全量 typecheck、测试和旧符号扫描通过。

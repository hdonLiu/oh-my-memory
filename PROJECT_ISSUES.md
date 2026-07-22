# Oh My Memory 问题与改进台账

> 本台账来自源码、测试和运行入口分析，不依赖 `docs/` 或 README。
>
> 最新目标架构见 `MEMORY_ARCHITECTURE.md`。如本台账中的早期描述与其冲突，以该架构文档为准。
>
> 讨论状态约定：`待讨论`、`讨论中`、`讨论完成`。
>
> 实施状态约定：`待处理`、`处理中`、`已完成`、`已阻塞`。处理某一项时，应同时补充测试并在完成后更新状态和结果。

## 总览

| ID | 优先级 | 讨论状态 | 实施状态 | 问题 |
| --- | --- | --- | --- | --- |
| MEM-001 | P0 | 讨论完成 | 待处理 | L3 画像缺少基于 L2 的更新、明确退休和原子 checkpoint |
| MEM-002 | P0 | 讨论完成 | 待处理 | 实时与离线 Topic 模型需要收口，并移除独立 Provisional/Canonical L1 |
| MEM-003 | P0 | 待讨论 | 待处理 | 后台 Scheduler 会重入，且多实例之间没有任务租约 |
| MEM-004 | P0/P1 | 待讨论 | 待处理 | API 没有身份认证，namespace 由客户端自由声明 |
| MEM-005 | P1 | 待讨论 | 待处理 | 分层 Recall 的候选召回主要依赖字符串匹配，中文和语义召回较弱 |
| MEM-006 | P1 | 待讨论 | 待处理 | 查询、聚合和 Prompt 缺少增量、分页及容量边界 |
| MEM-007 | P1 | 待讨论 | 待处理 | 数据库迁移不是真正的版本迁移，关系完整性主要依赖应用代码 |
| MEM-008 | P1 | 待讨论 | 待处理 | CLI 每次 ingest 都会 flush，破坏 Topic 连续聚合语义 |
| MEM-009 | P1 | 待讨论 | 待处理 | 新旧记忆链路并存，旧接口和旧任务的生命周期不明确 |
| MEM-010 | P1 | 待讨论 | 待处理 | 外部模型调用缺少 timeout、retry、backoff 和熔断 |
| MEM-011 | P1 | 待讨论 | 待处理 | 日志、健康检查、任务积压和 checkpoint lag 不可观测 |
| MEM-012 | P2 | 待讨论 | 待处理 | 向量索引和 Memory 更新/删除不是统一原子链路，可能出现陈旧向量 |
| MEM-013 | P2 | 待讨论 | 待处理 | 输入大小、metadata 深度、批量导入和返回数据缺少资源限制 |
| MEM-014 | P2 | 待讨论 | 待处理 | 工程发布约束不完整：缺少明确 Node 版本、build 脚本和生产运行产物 |
| MEM-015 | P2 | 待讨论 | 待处理 | 测试覆盖偏功能正确性，缺少并发、故障恢复、容量和安全边界测试 |
| MEM-016 | P2 | 待讨论 | 待处理 | API 版本与错误模型不统一，旧路由和 v1 路由行为容易分叉 |
| MEM-017 | P2 | 待讨论 | 待处理 | Topic 在线写入缺少 session 级并发控制，可能发生丢失更新 |

## 当前实现与目标架构

### ARCH-001：当前已实现的分层链路

- 实现状态：`已完成，但目标模型已经过讨论调整`
- 已实现：
  - `Turn -> Topic -> Provisional L1`，Provisional L1 可立即参与 Recall，并带有 provisional 标记。
  - `Provisional L1 -> Canonical L1 -> L2 Aggregate`。
  - `Canonical L1 -> L2 Aggregate -> L3 Profile`。L2 负责跨 session 的稳定知识，L3 负责提取用户画像、偏好等持久化投影。
  - Correction、治理水位、L1/L2 checkpoint 和分层 Recall 证据返回。
- 最新讨论结论：不保留独立 Provisional L1 和 Canonical L1。实时闭合和离线维护应操作同一套 Topic；目标结构为 `Turn -> Topic -> L2 Aggregate -> L3 Profile`。详细定义见 `MEMORY_ARCHITECTURE.md`。
- 后续缺口：Topic 模型收口和在线链路调整由 `MEM-002` 及后续实施任务跟踪；L3 基于 L2 的更新、明确退休和原子 checkpoint 由 `MEM-001` 跟踪。

---

## 详细问题

### MEM-001：L3 画像缺少基于 L2 的更新与退休机制

- 优先级：`P0`
- 讨论状态：`讨论完成`
- 实施状态：`待处理`
- 讨论结论：L2 已负责跨 session 聚合、消歧、冲突和修正；L3 是在稳定 L2 之上的持久化用户画像投影，不应重复建立 session、时间跨度或复杂生命周期治理。
- 代码位置：
  - `src/application/layered-memory-service.ts` 的 `runL3ProfileBuild()`。
  - `src/storage/database.ts` 的 `l3_profile_checkpoints`。
- 当前问题：
  - L3 同时接收 L1 Component 和 L2 Aggregate，重复承担了部分稳定性判断职责。
  - L3 当前只 upsert 模型返回的画像，无法明确退休已经被 L2 修正或推翻的旧画像。
  - 画像更新与 checkpoint 更新不在同一个原子提交中。
  - 非法或部分有效的模型结果可能导致不完整写入或错误推进 checkpoint。
- 已定解决方案：
  1. 继续使用现有 `memories` 表存储 canonical L3，不新增 L3 专用实体表、revision 表或候选状态。
  2. L3 只消费 active L2 Aggregate；不再直接消费 L1 Component，也不再重复校验 session 数和时间跨度。
  3. 每个画像使用稳定 `profileKey`：新 key 创建，已有 key 原地更新，同 key 新值覆盖旧值。
  4. L3 提取结果增加 `retireProfileKeys`。只有明确出现在该字段中的画像才会标记为 `superseded`；模型遗漏不自动删除。
  5. 每个画像只直接保存 `evidenceAggregateIds`。Component 和 Turn 证据通过 L2 Aggregate 向下追溯。
  6. 服务端在写入前一次性验证所有 `evidenceAggregateIds` 都属于当前 `uid + agent` 的 active L2 Aggregate，并验证所有 `retireProfileKeys` 都是已存在的 canonical Profile。
  7. 先完整验证整个模型结果，再在同一数据库事务中执行 Profile upsert、明确退休和 L3 checkpoint 更新。
  8. 任一引用非法或处理失败时，本次整体失败，不写入部分结果，也不推进 checkpoint。
  9. Correction 继续沿 `Correction -> Topic 离线维护 -> L2 -> L3` 传播；L3 不直接解释 Correction。
- 验收标准：
  - L3 提取输入不再包含 L1 Component，只包含 active L2 Aggregate 和现有 canonical Profile。
  - 相同 `profileKey` 重复构建不会产生重复 Profile。
  - `retireProfileKeys` 中的画像会被标记为 `superseded`，不再参与 Recall。
  - 未出现在 `profiles` 或 `retireProfileKeys` 中的已有画像保持不变。
  - 非法 Aggregate ID 或未知 retire key 会使整个构建失败。
  - Profile 变更和 checkpoint 要么全部成功，要么全部回滚。

### MEM-002：实时与离线 Topic 模型收口

- 优先级：`P0`
- 讨论状态：`讨论完成`
- 实施状态：`待处理`
- 讨论结论：实时流程和离线流程操作同一套 Topic。实时流程只负责轻量闭合 Topic 区间；离线流程在同一 session 内重新整理 Topic。Provisional L1 和 Canonical L1 都不再作为独立记忆层。
- 代码位置：
  - `src/application/memory-service.ts` 的 `ingestTurn()` 与 Topic wiring。
  - `src/domain/topics.ts` 的实时 Topic 构建。
  - `src/application/layered-memory-service.ts` 的现有 L1 maintenance。
  - `src/storage/database.ts`、`src/storage/layered-repository.ts` 中并存的 Topic 和 L1 表及同步逻辑。
- 当前问题：
  - 在线 ingest 同步依赖远程 LLM，模型延迟和故障会阻塞 Turn 到 Topic 的实时链路。
  - `topic_segments` 之后又同步创建 Provisional L1，再由离线任务生成 Canonical L1，重复表达了同一个 Topic 的处理阶段。
  - Topic 更新需要同步两套实体，存在重复数据和状态不一致风险。
  - 现有“已整理”结果容易被误解为不可再修改，无法准确表达同一 session 后续 Topic 对已有 Topic 的影响。
- 已定解决方案：
  1. 目标结构收口为 `Turn -> Topic -> L2 Aggregate -> L3 Profile`。
  2. 实时标准链路不调用远程 LLM，只用轻量规则维护同一 session 的 open Topic，并在边界、最大窗口、显式 flush 或空闲超时时闭合。
  3. open Topic 不进入记忆 Recall；当前会话直接使用原始 Turn。
  4. `closed + pending + active` Topic 立即参与 Recall，并标记为 `provisional`。
  5. 离线任务在同一 session 内对 Topic 做修正、拆分、合并、去噪和结构化提取，结果仍写回 Topic 层，不创建 Canonical L1。
  6. Topic 状态拆为 `closureStatus`、`maintenanceStatus` 和 `entityStatus`，避免单一 status 混合表达闭合、维护和实体生命周期。
  7. processed 表示当前 revision 已基于某个快照完成整理，不表示永久冻结。同一 session 后续出现新 closed Topic 时，离线任务可以重新检查已有 processed Topic。
  8. 普通修正产生新的 Topic revision；split/merge 产生同层 Topic 和 lineage，并让旧 Topic 退出 Recall。
  9. `closed + processed + active` Topic 才能进入 L2；Topic 实际变化推进 change sequence，使 L2 checkpoint 能发现并重新处理受影响聚合。
  10. 删除独立 Provisional L1 的持久化和同步逻辑；删除独立 Canonical L1 Topic，将现有 Component 归属到 Topic revision 的结构化内容。
  11. 没有 LLM 配置时，服务和 CLI 仍能完成 Turn 写入、Topic 闭合和 provisional Topic Recall；离线 Topic/L2/L3 维护按需要求 LLM。
- 验收标准：
  - ingest 不发起外部 LLM 请求，模型不可用时仍可写入 Turn 并闭合 Topic。
  - 数据模型中不再同时维护 TopicSegment、Provisional L1 Topic 和 Canonical L1 Topic。
  - open Topic 不进入记忆 Recall；closed pending Topic 以 provisional 参与 Recall。
  - 离线维护直接更新、拆分、合并或删除 Topic，并保留 revision 与 lineage。
  - 同一 session 新 Topic 可以触发已有 processed Topic 的重新整理。
  - Recall 原子切换到最新 active Topic revision，不同时返回被替代的新旧 Topic。
  - L2 只消费 processed active Topic，并能通过变更水位发现 Topic 后续修订。
  - 具体状态、Recall 和下游传播规则与 `MEMORY_ARCHITECTURE.md` 一致。

### MEM-003：Scheduler 重入和多实例并发

- 优先级：`P0`
- 状态：`待处理`
- 代码位置：`src/application/layered-scheduler.ts`、`src/application/project-scheduler.ts`。
- 当前问题：
  - `setInterval` 不等待上次任务完成，慢任务可能重叠。
  - 多进程或多实例会同时发现并处理相同 session/namespace。
  - LLM 生成发生在最终事务之外，现有幂等键不能完整覆盖竞争窗口。
- 解决方案：
  1. 单进程增加每层和每 namespace 的运行锁。
  2. 使用任务完成后再调度的 `setTimeout` 循环。
  3. 增加持久化 lease：`job_key`、`owner`、`lease_expires_at`、`attempt`、`last_error`。
  4. 使用原子 claim；lease 过期后允许其他实例恢复。
  5. 对 run 创建、状态转换和 checkpoint 增加 CAS/唯一约束。
- 验收标准：
  - 同一 namespace 同一时刻最多运行一个 Topic-maintenance/L2/L3 job。
  - 多实例并发测试不会重复创建 revision。
  - 进程在任务中途退出后，任务可在 lease 到期后恢复。

### MEM-004：API 身份与 namespace 隔离不足

- 优先级：对外部署为 `P0`，严格本地服务为 `P1`
- 状态：`待处理`
- 代码位置：`src/server.ts`、`src/index.ts`、`src/storage/repositories.ts`。
- 当前问题：
  - 服务绑定 `0.0.0.0`，同时没有认证中间件。
  - `uid`、`agent` 等 namespace 信息由请求方自由填写。
  - `/memories`、`/topics` 等接口允许宽范围列举。
  - `PATCH /memories/:id` 只按 ID 修改，不验证调用方 namespace。
  - CORS 没有显式限制来源。
- 解决方案：
  1. 本地默认绑定 `127.0.0.1`，提供可选本地 API token。
  2. 对外部署时增加认证，并从认证上下文派生 `uid`。
  3. Repository 的读取、更新和删除方法强制接收 namespace。
  4. 管理接口与普通 Turn/Recall 接口分权。
  5. 明确允许的 CORS origin。
- 验收标准：
  - 用户不能通过修改请求体中的 `uid` 读取或修改其他 namespace。
  - 只知道 Memory ID 不能跨 namespace 更新。
  - 未认证请求按部署模式被拒绝。

### MEM-005：Recall 候选检索质量不足

- 优先级：`P1`
- 状态：`待处理`
- 代码位置：`src/application/layered-memory-service.ts` 的 `scoreText()`，`src/domain/text.ts`。
- 当前问题：
  - 分层 Recall 在 LLM rerank 前只使用完整子串和简单 Jaccard。
  - 连续中文通常被当成一个 token，同义改写很难命中。
  - Topic/L2/L3 没有统一语义索引，相关记忆可能根本进不了候选集。
- 解决方案：
  1. 建立统一的 layered retrieval document。
  2. 使用 SQLite FTS5 提供关键词候选。
  3. 中文采用字符 bigram/trigram 或合适的分词器。
  4. 为 processed Topic、L2、L3 建立向量索引。
  5. 使用 RRF 或等价方法融合关键词、向量和近期会话候选，再交给 LLM rerank。
- 验收标准：
  - 中文同义改写 Recall eval 明显优于当前基线。
  - closed pending Topic 候选被明确标记和降权，但相关内容仍能快速命中。
  - superseded、deleted 和证据失效结果不会进入候选集。

### MEM-006：查询、聚合和 Prompt 缺少容量边界

- 优先级：`P1`
- 状态：`待处理`
- 代码位置：
  - `src/storage/repositories.ts` 的列表查询。
  - `src/storage/layered-repository.ts` 的 L1 view 查询。
  - `src/application/layered-memory-service.ts` 的当前 L1/L2/L3 输入组装，以及目标 Topic/L2/L3 输入组装。
  - `src/domain/embedding.ts` 的 SQLite 向量搜索。
- 当前问题：
  - 多个方法读取整表后在 JavaScript 中过滤。
  - L1 view 存在 N+1 查询。
  - L1 maintenance 可一次读取 10,000 个 Turn。
  - L2/L3 会重复发送大量历史 processed/stable 数据，而不是严格增量。
  - SQLite 向量搜索将全部向量加载到进程内计算。
- 解决方案：
  1. scope/status/session 条件下推到 SQL。
  2. 增加 cursor pagination 和批量 join。
  3. 按 checkpoint 只读取变化范围和受影响邻域。
  4. 引入统一 prompt token budget、批处理和上下文裁剪策略。
  5. 数据量达到阈值后切换原生向量扩展或外部向量服务。
- 验收标准：
  - 常用查询不会执行无条件全表扫描。
  - Topic maintenance、L2、L3 单次模型输入有可配置上限。
  - 万级 Turn、Component 和 Aggregate 的容量测试不会发生内存或 Prompt 爆炸。

### MEM-007：数据库迁移和完整性约束不足

- 优先级：`P1`
- 状态：`待处理`
- 代码位置：`src/storage/database.ts`。
- 当前问题：
  - migration version 被记录，但启动时仍会无条件运行全部 `ensure*`。
  - 整个迁移流程没有统一事务。
  - 主要实体关系没有数据库外键。
  - 状态、置信度等字段缺少 `CHECK` 约束。
- 解决方案：
  1. 建立按版本顺序执行、每版只运行一次的 migrations。
  2. 每个 migration 使用事务并保留升级测试 fixture。
  3. 开启 `PRAGMA foreign_keys = ON`、设置 `busy_timeout`。
  4. 为 revision、component、membership、lineage、checkpoint 增加外键和唯一约束。
  5. 增加状态枚举、置信度和 watermark 范围约束。
- 验收标准：
  - 可从每个历史 schema 版本逐级升级到最新版本。
  - 中途失败不会留下半迁移数据库。
  - 无法写入孤立 revision、component 或 membership。

### MEM-008：CLI 会过早关闭 Topic

- 优先级：`P1`
- 状态：`待处理`
- 代码位置：`src/cli.ts` 的 `ingest` 命令。
- 当前问题：
  - 每次 `ingest` 后立即 `flushSessionTopic()`，连续 CLI Turn 无法自然聚合到同一 Topic。
  - CLI 没有单独的 flush、recall、maintenance 和状态命令。
  - 默认 service wiring 没有 LLM 配置时会直接失败，无法只使用实时 Topic 能力。
- 解决方案：
  1. `ingest` 默认只写 Turn 和更新 partial Topic。
  2. 新增显式 `flush` 命令。
  3. `import` 仅在每个 session 的批次结束后 flush。
  4. 增加 `recall`、`topic-maintenance-run`、`l2-run`、`l3-run`、`status` 命令。
  5. 没有 LLM 配置时仍使用本地实时 Topic 策略。
- 验收标准：
  - 连续 CLI ingest 可以形成一个持续增长的 partial Topic。
  - 只有显式 flush 或边界命中时才关闭 Topic。
  - 无 LLM 环境仍可 ingest，并 Recall 已闭合的 pending Topic。

### MEM-009：新旧记忆链路并存

- 优先级：`P1`
- 状态：`待处理`
- 代码位置：
  - `src/domain/resolver.ts`
  - `src/domain/project-memory.ts`
  - `src/domain/dreaming.ts`
  - `src/application/project-scheduler.ts`
  - `src/server.ts` 中非 `/v1` 的旧接口。
- 当前问题：
  - 默认已关闭 legacy memory 写入，但旧 Project、Dreaming、Search、Recall 代码仍然存在。
  - 部分旧任务依赖不再默认生成的 topic Memory，容易形成看似可用但无数据来源的路径。
  - 两套数据模型会增加修复、测试和迁移成本。
- 解决方案：
  1. 明确 legacy 兼容窗口和删除版本。
  2. 对旧 API 增加 deprecated 标识和调用统计。
  3. 提供旧 Memory、Provisional L1 和 Canonical L1 到统一 Topic/L2 模型的迁移工具。
  4. 完成迁移后删除旧 Project/Dreaming/Resolver 路径。
- 验收标准：
  - 生产链路只有一个明确的数据真相来源。
  - 旧数据可迁移且结果可验证。
  - 删除 legacy 后测试和 API 行为不退化。

### MEM-010：模型和 Embedding 调用缺少韧性

- 优先级：`P1`
- 状态：`待处理`
- 代码位置：`src/domain/extractors.ts`、`src/domain/embedding.ts`。
- 当前问题：
  - 请求没有 timeout 或 AbortSignal。
  - 没有针对 429、5xx 和网络错误的有限重试。
  - 错误响应正文可能很大，且直接进入 Error。
  - 没有熔断或失败预算。
- 解决方案：
  1. 提供统一的模型 HTTP client。
  2. 增加 timeout、AbortController、指数退避和 jitter。
  3. 只重试明确可重试错误，并尊重 `Retry-After`。
  4. 限制错误正文长度并分类错误。
  5. 在线与离线任务使用不同时间预算和重试策略。
- 验收标准：
  - 超时请求能及时取消。
  - 429/5xx 按策略重试，4xx 参数错误不重试。
  - Scheduler 能记录可重试与不可重试失败。

### MEM-011：可观测性不足

- 优先级：`P1`
- 状态：`待处理`
- 代码位置：`src/server.ts`、`src/index.ts`、两个 scheduler。
- 当前问题：
  - Fastify logger 被关闭。
  - `/health` 只返回固定 `{ok: true}`。
  - 缺少 requestId、runId、namespace、模型耗时和 token/候选规模等信息。
  - 无法看到 scheduler backlog、失败率和 checkpoint lag。
- 解决方案：
  1. 开启结构化日志并统一敏感字段脱敏。
  2. 区分 `/live` 和 `/ready`。
  3. 暴露任务运行、积压、失败、耗时和水位差指标。
  4. 将模型调用和每层维护任务关联到 runId/traceId。
- 验收标准：
  - 可以从一次 Recall 追踪到候选生成和模型选择。
  - readiness 能发现数据库或关键配置不可用。
  - 可以查询每个 namespace 的 Topic maintenance/L2/L3 lag。

### MEM-012：向量索引一致性不足

- 优先级：`P2`
- 状态：`待处理`
- 代码位置：`src/application/memory-service.ts`、`src/domain/embedding.ts`。
- 当前问题：
  - 部分创建路径会写向量，但普通 `updateMemory()` 不会同步重建向量。
  - Memory 被删除或 supersede 后，旧向量仍可能保留。
  - 数据库 Memory 和向量写入不是一个可恢复的工作单元。
- 解决方案：
  1. 使用 outbox 记录 index upsert/delete 事件。
  2. 所有 Memory 状态与正文变更统一触发索引更新。
  3. Recall 仍需以数据库当前状态做最终过滤。
  4. 增加定期索引 reconciliation。
- 验收标准：
  - 更新正文后不会使用旧向量。
  - deleted/superseded Memory 不会被向量搜索返回。
  - 可从空索引完整重建。

### MEM-013：资源输入边界不足

- 优先级：`P2`
- 状态：`待处理`
- 代码位置：`src/server.ts`、`src/cli.ts`。
- 当前问题：
  - Turn content、query、metadata 和部分列表请求没有明确最大值。
  - metadata 可任意深度嵌套。
  - import 会把整个 JSON 文件一次性读入内存。
- 解决方案：
  1. 设置 HTTP body、content、query、metadata 和批量条数限制。
  2. metadata 使用可控 schema、深度和序列化大小。
  3. 大批量导入使用 NDJSON/stream。
  4. 对返回列表统一分页和最大 limit。
- 验收标准：
  - 超限请求返回明确的 413/400。
  - 大文件导入不会线性占满进程内存。

### MEM-014：生产构建与 Node 版本约束不完整

- 优先级：`P2`
- 状态：`待处理`
- 代码位置：`package.json`、`bin/oh-my-memory`。
- 当前问题：
  - 没有明确 `engines.node`。
  - 缺少 build/start 脚本。
  - CLI 依赖 `tsx` 直接运行源码，但 `tsx` 位于 devDependencies；生产环境使用 `npm install --omit=dev` 时会失败。
  - `better-sqlite3` 是原生依赖，需要明确支持的 Node/ABI 和安装验证。
- 解决方案：
  1. 固定支持的 Node major，并增加 `.nvmrc` 或等价工具配置。
  2. 增加生产 TypeScript build 和 `dist` 启动入口。
  3. 发布 CLI 时运行编译后的 JavaScript。
  4. CI 覆盖目标 Node 版本和原生依赖安装。
- 验收标准：
  - 全新环境执行 install、build、test、start 均成功。
  - `npm install --omit=dev` 后服务和 CLI 可运行。

### MEM-015：测试缺少故障和容量场景

- 优先级：`P2`
- 状态：`待处理`
- 当前问题：
  - 当前测试主要验证正常功能、Schema 和部分幂等逻辑。
  - 缺少多实例并发、任务崩溃恢复、LLM timeout、数据库锁竞争、超大 Prompt、跨 namespace 攻击等测试。
- 解决方案：
  1. 增加 scheduler 并发和 lease 测试。
  2. 增加 Topic maintenance/L2/L3 写入中途失败及恢复测试。
  3. 增加 Recall 离线评测和回归阈值。
  4. 增加容量、输入限制和 namespace 安全测试。
  5. CI 强制 typecheck、test、build 和 migration upgrade 测试。
- 验收标准：
  - 每个 P0/P1 修复都有失败回归测试。
  - 并发与故障恢复测试可稳定重复运行。

### MEM-016：API 版本和错误模型不统一

- 优先级：`P2`
- 状态：`待处理`
- 代码位置：`src/server.ts`。
- 当前问题：
  - 同时存在 `/turns` 与 `/v1/turns`、旧 `/recall` 与 `/v1/recall` 等接口。
  - 各接口对 not found、冲突、模型失败和内部错误的映射方式不同。
  - 返回体没有统一 error code、requestId 和 retryable 语义。
- 解决方案：
  1. 明确 v1 为唯一稳定接口。
  2. 引入 typed domain error 和全局 Fastify error handler。
  3. 统一错误体：`code`、`message`、`requestId`、`retryable`、`details`。
  4. 为旧接口增加弃用头，最终删除。
- 验收标准：
  - 相同错误在所有接口返回一致的 HTTP 状态和错误码。
  - 内部异常不会泄漏实现细节。

### MEM-017：Topic 在线写入存在 session 并发丢失更新风险

- 优先级：`P2`
- 状态：`待处理`
- 代码位置：`src/domain/topics.ts`、`src/storage/repositories.ts`。
- 当前问题：
  - 两个并发 Turn 可能同时读取同一个 open Topic，然后分别基于旧 turnIds 更新。
  - Topic read、boundary decision 和 Topic update 不在同一个 session 级串行单元中。
  - LLM 调用期间锁不能长期持有，因此不能只靠数据库大事务解决。
- 解决方案：
  1. 每个 session 建立有序 ingest sequence。
  2. Topic revision 增加 version，并使用 compare-and-swap 更新。
  3. CAS 失败时重新读取最新窗口并重算。
  4. 异步 Topic worker 按 session 串行消费 Turn。
- 验收标准：
  - 同一 session 并发写入不会丢 Turn、重复 Turn 或打乱顺序。
  - 多进程并发测试下 Topic turnIds 与数据库 Turn 序列一致。

---

## 推荐处理顺序

1. `MEM-001`：L3 生命周期与稳定性。
2. `MEM-002`：在线路径去除 LLM 阻塞。
3. `MEM-003`：Scheduler lease、防重入和恢复。
4. `MEM-004`：身份与 namespace 隔离。
5. `MEM-005`：混合 Recall 检索。
6. `MEM-006`：SQL、增量维护和 Prompt 预算。
7. `MEM-007`：数据库迁移与关系约束。
8. `MEM-008`：CLI Topic 语义。
9. `MEM-009`：旧链路收口。
10. `MEM-010` 与 `MEM-011`：外部调用韧性和可观测性。
11. `MEM-012` 至 `MEM-017`：索引一致性、资源限制、工程化、测试、API 收口和在线并发。

## 每项处理流程

处理每个问题时统一执行：

1. 将状态改为 `处理中`。
2. 先增加能够复现问题的失败测试。
3. 实现最小完整修复。
4. 运行 typecheck、相关测试和完整测试。
5. 更新本台账中的实际实现结果和剩余限制。
6. 将状态改为 `已完成` 后再开始下一项。

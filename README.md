# oh-my-memory

**A durable, multi-tenant memory service for AI agents.**

把原始对话持续整理为可召回的 Topic、跨会话知识和长期用户画像，同时保持租户隔离、证据可追溯和派生数据可重建。

[快速开始](#快速开始) · [工作原理](#工作原理) · [HTTP API](#http-api) · [CLI](#cli) · [架构文档](./MEMORY_ARCHITECTURE.md)

> [!IMPORTANT]
> 项目目前处于早期开发阶段。当前版本是基于 TypeScript、Fastify 和 SQLite 的 reference implementation，目标是演进为云端多租户 Memory 服务，尚未针对多实例调度和大规模数据完成生产加固。

## 为什么是 oh-my-memory

Agent 不应该把完整聊天记录无限塞回上下文，也不应该把未经处理的每句话都当成长期记忆。oh-my-memory 将事实来源和派生记忆分开管理：

- **Turn-first durability**：Turn 先持久化；embedding 或 LLM 失败不会丢失原始输入。
- **分层记忆**：从会话内 Topic，逐步形成跨会话 L2 知识和长期 L3 画像。
- **多租户隔离**：`uid` 是安全边界，`agentId` 是默认 Memory 租户。
- **显式共享**：Agent 默认互相隔离；只有加入同一 MemorySpace 后才共享 L2/L3。
- **可修正、可重建**：Correction 不修改原始 Turn，而是触发 Topic → L2 → L3 重建。
- **真实模型职责**：语义判断由 embedding/LLM 完成，不用关键词规则伪装成模型 fallback。

## 工作原理

```text
immutable source                         rebuildable current snapshots

Turn  ──▶  Topic  ──▶  L2 Aggregate  ──▶  L3 Profile
           session      memory space       memory space
           context      knowledge          user profile
```

| 层级 | 作用域 | 用途 |
| --- | --- | --- |
| Turn | Session / Agent | 不可变的原始对话快照，不做 annotation |
| Topic | Session / Agent | 会话内连续主题，`open → pending → processed` |
| L2 Aggregate | MemorySpace | 跨 Session 聚合的当前知识，保留原始 Turn evidence |
| L3 Profile | MemorySpace | 从当前 L2 归纳出的长期偏好和用户画像 |

实时 Topic 流程采用三段式判断：

1. 高精度规则仅过滤“你好”“谢谢”等低信息输入；Turn 仍然入库。
2. embedding 相似度落在明确区间时直接 `continue` 或 `split`。
3. 只有模糊区间调用 small LLM 判断 Topic 边界。

离线任务使用 LLM 全量计算目标快照，并在事务中原子替换 Topic、L2 或 L3。模型不可用时保留上一份可用快照，并把任务标记为 dirty 等待重试。

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置并启动

服务兼容 OpenAI 风格的 Chat Completions 和 Embeddings API。

```bash
export LLM_BASE_URL=https://api.openai.com/v1
export LLM_API_KEY=your-llm-api-key
export LLM_MODEL=gpt-4.1-mini

export EMBEDDING_BASE_URL=https://api.openai.com/v1
export EMBEDDING_API_KEY=your-embedding-api-key
export EMBEDDING_MODEL=text-embedding-3-small
export EMBEDDING_DIMENSIONS=1536

export MEMORY_API_TOKENS='{
  "dev-token": {
    "uid": "user-1",
    "agentIds": ["assistant-a", "assistant-b"]
  }
}'

npm run dev
```

默认监听 `http://127.0.0.1:3000`，数据写入 `memory.sqlite`。

### 3. 写入对话

```bash
curl http://127.0.0.1:3000/v1/turns \
  -H 'authorization: Bearer dev-token' \
  -H 'content-type: application/json' \
  -d '{
    "agentId": "assistant-a",
    "externalSessionId": "chat-1",
    "eventId": "turn-1",
    "source": "web",
    "channel": "main",
    "role": "user",
    "content": "项目 A 的预算是一万元",
    "metadata": {}
  }'
```

`externalSessionId` 由 Agent 生成，只需在当前 `uid + agentId` 内唯一；Memory 服务会分配全局唯一的内部 `sessionId`。

### 4. 关闭 Topic 并召回

```bash
curl -X POST http://127.0.0.1:3000/v1/sessions/chat-1/topics/flush \
  -H 'authorization: Bearer dev-token' \
  -H 'content-type: application/json' \
  -d '{"agentId":"assistant-a"}'

curl http://127.0.0.1:3000/v1/recall \
  -H 'authorization: Bearer dev-token' \
  -H 'content-type: application/json' \
  -d '{
    "agentId": "assistant-a",
    "externalSessionId": "chat-1",
    "query": "项目 A 的预算是多少？"
  }'
```

## 多 Agent 与共享 MemorySpace

每个 Agent 首次使用时自动拥有 private MemorySpace。Session、Turn 和 Topic 始终保持 Agent 隔离；共享只发生在 L2/L3。

创建 shared MemorySpace：

```bash
curl -X POST http://127.0.0.1:3000/v1/memory-spaces \
  -H 'authorization: Bearer dev-token' \
  -H 'content-type: application/json' \
  -d '{"agentId":"assistant-a","name":"shared-team-memory"}'
```

把同一 `uid` 下另一个已授权 Agent 加入空间：

```bash
curl -X POST http://127.0.0.1:3000/v1/memory-spaces/<memorySpaceId>/members \
  -H 'authorization: Bearer dev-token' \
  -H 'content-type: application/json' \
  -d '{"agentId":"assistant-a","memberAgentId":"assistant-b"}'
```

不同 `uid` 的 Agent 不能加入同一 MemorySpace。

## 身份与安全边界

- HTTP 请求中的 `uid` 不可信，因此 API 不接收该字段。
- 内置 Bearer provider 从 `MEMORY_API_TOKENS` 解析 `uid` 和允许访问的 `agentId`。
- Session 查询始终使用认证上下文中的 `uid` 加上请求的 `agentId + externalSessionId`。
- 即使调用方知道内部 ID，读写时仍要重新校验租户和 MemorySpace 授权。
- 默认绑定 `127.0.0.1` 且不开启 CORS；生产环境应通过自定义 `AuthenticationProvider` 对接 OIDC 或 API Gateway。

`MEMORY_API_TOKENS` 适合本地开发和简单部署。不要把真实 token 提交到仓库。

## HTTP API

除 `/health` 外，所有接口都需要 `Authorization: Bearer <token>`。

| Method | Endpoint | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 存活检查 |
| `POST` | `/v1/turns` | 幂等写入 Turn，并推进实时 Topic |
| `GET` | `/v1/sessions/:externalSessionId` | 查询外部 Session 对应的内部 Session |
| `GET` | `/v1/sessions/:externalSessionId/topics` | 查看当前 Topic 快照 |
| `POST` | `/v1/sessions/:externalSessionId/topics/flush` | 将 open Topic 关闭为 pending |
| `POST` | `/v1/sessions/:externalSessionId/topics/rebuild` | 离线全量重建当前 Session 的 Topic |
| `GET` | `/v1/memory-spaces` | 列出 Agent 有权访问的 MemorySpace |
| `POST` | `/v1/memory-spaces` | 创建 shared MemorySpace |
| `POST` | `/v1/memory-spaces/:memorySpaceId/members` | 添加共享空间成员 |
| `GET` | `/v1/memory-spaces/:memorySpaceId/l2` | 读取当前 L2 快照 |
| `POST` | `/v1/memory-spaces/:memorySpaceId/l2/rebuild` | 从 processed Topic 重建 L2 |
| `GET` | `/v1/memory-spaces/:memorySpaceId/l3` | 读取当前 L3 快照 |
| `POST` | `/v1/memory-spaces/:memorySpaceId/l3/rebuild` | 从当前 L2 重建 L3 |
| `POST` | `/v1/corrections` | 记录纠正并触发派生层级联重建 |
| `POST` | `/v1/recall` | 在当前 Session 和授权 MemorySpace 中召回 |

详细的字段约束以 [`src/server.ts`](./src/server.ts) 中的 Zod schema 为准。

## CLI

CLI 直接操作本地数据库，因此显式接收 `uid`。`ingest` 不会自动 flush，连续 Turn 可以自然聚合为同一个 Topic。

```bash
./bin/oh-my-memory ingest \
  --db memory.sqlite \
  --uid user-1 \
  --agent-id assistant-a \
  --external-session-id chat-1 \
  --event-id turn-1 \
  --source cli \
  --channel main \
  --role user \
  --content "项目 A 的预算是一万元"

./bin/oh-my-memory flush \
  --db memory.sqlite \
  --uid user-1 \
  --agent-id assistant-a \
  --external-session-id chat-1
```

可用命令：`ingest`、`import`、`flush`、`topics`、`recall`。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MEMORY_API_TOKENS` | 无，必填 | Bearer token 到 `uid + agentIds` 的 JSON 映射 |
| `MEMORY_DB_PATH` | `memory.sqlite` | SQLite 数据库路径 |
| `HOST` | `127.0.0.1` | HTTP 监听地址 |
| `PORT` | `3000` | HTTP 监听端口 |
| `CORS_ORIGINS` | 空 | 允许的来源，多个值用逗号分隔 |
| `LLM_BASE_URL` | OpenAI API | Chat Completions base URL |
| `LLM_API_KEY` | 空 | LLM provider API key |
| `LLM_MODEL` | `gpt-4.1-mini` | Topic 维护、L2/L3 和 Recall 模型 |
| `TOPIC_BOUNDARY_LLM_BASE_URL` | `LLM_BASE_URL` | 模糊区 Topic 判断专用模型地址 |
| `TOPIC_BOUNDARY_LLM_API_KEY` | `LLM_API_KEY` | 模糊区 Topic 判断专用 API key |
| `TOPIC_BOUNDARY_LLM_MODEL` | `LLM_MODEL` | 模糊区 Topic 判断使用的 small model |
| `EMBEDDING_BASE_URL` | OpenAI API | Embeddings base URL |
| `EMBEDDING_API_KEY` | 空 | Embedding provider API key |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding 模型 |
| `EMBEDDING_DIMENSIONS` | `1536` | 必须与 provider 返回向量维度一致 |
| `REBUILD_INTERVAL_MS` | `10000` | dirty 派生任务扫描间隔 |
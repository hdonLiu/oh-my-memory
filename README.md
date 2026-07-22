# oh-my-memory

面向云端 Agent 的多租户 Memory 服务，当前模型为：

```text
Turn -> Topic -> L2 Aggregate -> L3 Profile
```

架构基线见 [`MEMORY_ARCHITECTURE.md`](MEMORY_ARCHITECTURE.md)，直接替换与 TDD 实施记录见 [`docs/superpowers/plans/2026-07-21-memory-architecture-direct-replacement.md`](docs/superpowers/plans/2026-07-21-memory-architecture-direct-replacement.md)。

## 身份与共享模型

- `uid` 是安全边界，`agentId` 是默认 Memory 租户。
- Agent 提供 `externalSessionId`；Memory 分配全局唯一的内部 `sessionId`。
- Session 只能通过 `uid + agentId + externalSessionId` 查询。
- `source`、`channel` 是元数据，不参与 Session 身份定位。
- 每个 Agent 默认拥有独立 private MemorySpace。
- 同一 uid 下只有显式加入 shared MemorySpace 后，Agent 才能共享 L2/L3。
- Session、Turn、Topic 始终按 Agent 隔离，不因共享空间而跨 Agent 暴露。

Turn 是不可变原始快照，不做 annotation。Topic、L2、L3 是当前派生快照，可以原子替换并从上游重建。

## 模型职责

生产链路使用真实模型 provider：

- embedding：实时 Topic 向量相似度。
- small LLM：只判断相似度模糊区间的 `continue | split`。
- LLM：离线 Topic 全量维护、L2 聚合、L3 画像与 Recall 重排。

规则只处理 schema、权限、幂等、最大窗口和高精度低信息输入等非语义约束。代码中没有规则版语义模型 fallback；模型失败时 Turn 仍然保留，派生任务标记为 dirty 等待重试。

## 启动

```bash
npm install

LLM_BASE_URL=https://api.openai.com/v1 \
LLM_API_KEY=... \
LLM_MODEL=gpt-4.1-mini \
TOPIC_BOUNDARY_LLM_MODEL=gpt-4.1-mini \
EMBEDDING_BASE_URL=https://api.openai.com/v1 \
EMBEDDING_API_KEY=... \
EMBEDDING_MODEL=text-embedding-3-small \
EMBEDDING_DIMENSIONS=1536 \
MEMORY_API_TOKENS='{"dev-token":{"uid":"u1","agentIds":["assistant-a"]}}' \
npm run dev
```

服务默认监听 `127.0.0.1:3000`，默认不开放跨域。可通过 `HOST`、`PORT`、`MEMORY_DB_PATH`、`REBUILD_INTERVAL_MS` 和逗号分隔的 `CORS_ORIGINS` 调整。
`uid` 从 Bearer token 的认证上下文派生，HTTP 请求体和 query 不接受 `uid`。生产部署可以通过 `AuthenticationProvider` 接入 OIDC 或 API Gateway 身份；内置 provider 从 `MEMORY_API_TOKENS` 读取 token、uid 和授权 Agent 列表。

## HTTP API

### 写入 Turn

```bash
curl -s http://127.0.0.1:3000/v1/turns \
  -H 'authorization: Bearer dev-token' \
  -H 'content-type: application/json' \
  -d '{
    "agentId": "assistant-a",
    "externalSessionId": "chat-20260721-1",
    "eventId": "turn-1",
    "source": "web",
    "channel": "main",
    "role": "user",
    "content": "项目 A 的预算是一万元",
    "metadata": {}
  }'
```

### 查询 Session 与 Topic

```bash
curl -s -H 'authorization: Bearer dev-token' \
  'http://127.0.0.1:3000/v1/sessions/chat-20260721-1?agentId=assistant-a'
curl -s -H 'authorization: Bearer dev-token' \
  'http://127.0.0.1:3000/v1/sessions/chat-20260721-1/topics?agentId=assistant-a'
```

### 显式关闭或离线重建 Topic

```bash
curl -s -X POST http://127.0.0.1:3000/v1/sessions/chat-20260721-1/topics/flush \
  -H 'authorization: Bearer dev-token' \
  -H 'content-type: application/json' \
  -d '{"agentId":"assistant-a"}'

curl -s -X POST http://127.0.0.1:3000/v1/sessions/chat-20260721-1/topics/rebuild \
  -H 'authorization: Bearer dev-token' \
  -H 'content-type: application/json' \
  -d '{"agentId":"assistant-a"}'
```

### MemorySpace、L2 与 L3

```text
GET  /v1/memory-spaces?uid=...&agentId=...
POST /v1/memory-spaces
POST /v1/memory-spaces/:memorySpaceId/members
GET  /v1/memory-spaces/:memorySpaceId/l2
POST /v1/memory-spaces/:memorySpaceId/l2/rebuild
GET  /v1/memory-spaces/:memorySpaceId/l3
POST /v1/memory-spaces/:memorySpaceId/l3/rebuild
```

### Correction 与 Recall

```text
POST /v1/corrections
POST /v1/recall
```

Correction 不修改原始 Turn，只保存纠正指令并将 Topic、L2、L3 标记为 dirty。

## CLI

CLI 使用与 API 相同的身份字段，不会在每次 ingest 后自动 flush：

```bash
oh-my-memory ingest \
  --db memory.sqlite \
  --uid u1 \
  --agent-id assistant-a \
  --external-session-id chat-1 \
  --event-id turn-1 \
  --source cli \
  --channel main \
  --role user \
  --content "项目 A 的预算是一万元"

oh-my-memory flush \
  --db memory.sqlite \
  --uid u1 \
  --agent-id assistant-a \
  --external-session-id chat-1
```

## 验证

```bash
npm run typecheck
npm test
```

首次打开旧数据库时，只迁移原始 Turn：旧 `session_id` 作为 `externalSessionId`，Memory 分配新的内部 Session ID。旧 Topic/L1/L2/L3 派生表会被删除并标记重建；发生新租户幂等键冲突时迁移整体失败，不做猜测。

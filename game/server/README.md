# NPC 模型调用边界

NPC 模型仅用于持有当前世界 capability 的请求；缺少模型配置或网络不可用时使用本地行为。服务通过 `SAVE_DB_PATH` 指定 SQLite 文件，未设置时使用服务工作目录的 `cloud-isles.sqlite`。

| 环境变量 | 默认值 | 有效范围 | 含义 |
| --- | --- | --- | --- |
| `NPC_LLM_REQUESTS_PER_MINUTE` | 12 | 1–10000 | 每 IP 每分钟允许进入模型流程的操作数 |
| `NPC_LLM_MAX_CONCURRENT` | 2 | 1–100 | 同时执行的实际 provider HTTP 请求数 |
| `NPC_LLM_MAX_TOTAL_CALLS` | 1000 | 1–1000000 | 此 SQLite 数据库累计允许的 provider 调用数，包含聊天内部重试和失败调用 |

无效或越界配置使用默认值。总额度在调用前持久预留，重启不会重置；崩溃后不重发结果未知的操作，已预留次数仍计入额度。需要增加额度时调整 `NPC_LLM_MAX_TOTAL_CALLS` 并重启服务，不清除历史库。匿名请求、无模型密钥、频率/并发/总额度拒绝不消耗 provider 次数。

`llm_operations` 保存最终可重放响应；`llm_attempts` 逐次记录实际 provider 尝试；`llm_records` 保存操作最终审计。结果和审计在同一事务完成后才进入响应缓存。HTTP、网络或输出解析失败记录 failed；尚未调用 provider 的拒绝记录 fallback。聊天重试成功时操作记录 success，先前失败的 attempt 仍保留 failed。

`/api/npc/health` 返回模型是否配置、预算是否可用、速率/并发/总次数上限及模型名，不返回密钥或 capability。模型连接使用 `NPC_LLM_BASE_URL`、`NPC_LLM_API_KEY`、`NPC_LLM_MODEL`、`NPC_LLM_TEMP`。

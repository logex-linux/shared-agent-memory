# 项目、检查与维护

以下命令在仓库目录运行，使用安装器默认数据目录。也可为每条命令显式传 `--config /absolute/path/config.json`。

```sh
export SHARED_MEMORY_CONFIG="$HOME/.local/share/shared-agent-memory/admin.config.json"
npm run cli -- inspect
npm run cli -- check
```

check 要求 `integrity_check` 为 `ok`，`orphan_chunks`、`orphan_vectors`、`missing_vectors`、`unindexed`、`search_mismatch`、`missing_chunk_fts`、`orphan_chunk_fts`、`orphan_identifiers` 均为 0。

## 注册项目

写入项目记录前需注册 UUID 与真实目录别名。同一个项目的多个 worktree 可共用一个 UUID；不根据目录名称猜测身份。默认只读与管理员配置的 `all_projects: true` 让新注册项目自动参与跨项目检索。

```sh
PROJECT_ID=$(node -p 'crypto.randomUUID()')
npm run cli -- project --id "$PROJECT_ID" --name my-project --alias /absolute/path/to/project
npm run cli -- resolve-project --path /absolute/path/to/project
```

这只登记项目，不自动导入文件或聊天，也不创建记忆。需要限制某个连接时，可另外生成 `all_projects: false`、指定 `allowed_projects` 的配置；默认用法不按任务分配可见清单。

## 检查、降级与重建

```sh
npm run cli -- maintenance
npm run cli -- reindex
npm run cli -- check
```

维护前暂停其他写入，保留程序版本、lockfile、schema 与最新撤销清单。reindex 需要整个数据库的管理范围。编码完成后通过 generation 检查切换，失败时保留原正文和索引。

`lexical_degraded` 时先检查 `model_dir`、模型文件和 manifest hash、依赖以及索引完整性。降级读取可继续提供关键词结果；不能因此声称向量检索正常。修复后重新连接、check，并按需要 reindex，不要修改 manifest 接受损坏文件。

## 导出、迁移与撤销

```sh
npm run cli -- export --project "$PROJECT_ID"
npm run cli -- import --input /absolute/path/export.json
npm run cli -- import --mode restore --input /absolute/path/export.json --revocations /absolute/path/latest-revocations.jsonl --commit
```

import 默认只预览。提交必须显式选择 `--mode new`（新的外部原始记录数组，不允许导出身份字段）或 `--mode restore`（恢复导出，可为对象、导出数组或记录正文数组）。为避免改输入结构绕过校验，所有 `--commit` 均须提供外部 `--revocations` 最新清单，连原始正文数组也不例外。全新且没有撤销历史的资料库可显式提供空清单；系统不能凭文件名证明清单最新，操作者必须取得真实最新版本。导出对象重导保留 ID/revision，并要求最新的外部撤销清单，先应用撤销再导入。不能把旧导出自带清单当成最新清单，也不能在有版本冲突时强行覆盖。重复导入保持幂等，已撤销记录不得因旧导出复活。

`sources[].source_hash` 是来源文件 hash；导入预览中的 source_hash 是整个来源描述集合的摘要，二者含义不同。

导出文件登记在库内，遗忘会触发受管理副本清理。文件清理失败返回 pending，可修复权限或路径问题后重跑 maintenance。撤销清单同步失败时，`REVOCATIONS_UNSYNCED_RESTORE_FORBIDDEN` 表示尚不能进行恢复。数据库 tombstone 是权威，外部清单通过可重试维护同步。

本系统不提供覆盖在线数据库的 restore 命令。需要文件级备份时，应停写并完成 checkpoint，且单独保存最新撤销清单。不要把正在写入的 SQLite 文件直接通过网盘同步成多机共享数据库。

## 停用

从客户端配置移除新增的服务器条目或扩展参数，关闭相应 STDIO 子进程。保留数据目录即可在以后重新连接。安装器没有修改客户端原生记忆。

程序和依赖可重新构建；数据库、模型、撤销清单和配置属于用户数据。删除代码不会自动撤回聊天上下文、非托管导出或系统快照。

## 为实际项目生成 Codex 配置

```sh
node scripts/client-configs.mjs --config "$HOME/.local/share/shared-agent-memory/config.json" --project-id "$PROJECT_ID" --project /absolute/path/to/project --output .local/client-configs/my-project
```

生成器校验UUID已注册且当前连接可访问、路径存在且是目录、最长别名映射匹配。失效别名、错误UUID和路径映射冲突会失败，不再使用allowed_projects的第一项猜测身份。安装器自动用实际工作目录及返回UUID生成三种角色的Codex配置。

Schema4→5 的备份、迁移、完整性检查与回滚步骤见[按需检索架构](retrieval-architecture.md)。首次用新版打开库会在事务中迁移；升级前保留备份，旧程序不能打开Schema5。


## 0.4.0 查询状态

canonical仍为Schema5，无新迁移。首次查询会创建database真实路径旁的 `.retrieval.db`、WAL和SHM，仅保存短期查询进度与轻量候选，不保存正文。备份可忽略它；停掉全部实例后才可删除或VACUUM。默认30分钟滑动TTL，后续查询清理到期状态。游标过期或generation变化时重新检索，不强行续取。回滚到0.3无需回滚canonical数据，详见[升级与回滚](adaptive-retrieval.md#升级备份与回滚)。

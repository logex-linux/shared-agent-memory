# 0.2.0 六项修复与验收

## 要求与可核对证据

| 问题 | 结果 | 回归证据 |
|---|---|---|
| P0 标识符压制语义候选 | 默认保留语义候选，标识符匹配只提供有限加权；exact_only显式严格筛选 | `P0 identifier boost retains paraphrases; exact_only is explicit`，含hybrid/vector两种路径 |
| P0 导入绕过撤销 | 提交必须显式new/restore，所有结构都检查外部撤销清单；核心importEntry也拒绝无清单的导入，检查原始正文hash以阻止去掉ID后的旧正文复活 | `P0 object, exported array and raw bodies all require external revocations; old data stays forgotten`，对象、导出数组、裸正文数组、无import_key旧正文均覆盖 |
| P1 权限与身份 | 默认只读；提供项目读写、全局管理两种额外配置；按配置暴露工具并在核心再次检查能力，身份由服务器写入 | `P1 readonly permissions, server identity and verification authority are independent of model labels`、`P1 readonly MCP exposes only recall and rejects hidden write tools` |
| P1 规模增长 | 100/1,000/10,000条真实本地向量库，逐级独立进程测p50/p95、RSS、Recall@5；按结果保留当前精确扫描 | [规模实测](scale-benchmark.md)、`scripts/benchmark-scale.mjs`、冻结的`bench/cases.json` |
| P1 核验状态 | unverified/verified/disputed与相关度独立；verified要求verify能力、审阅依据与证据，reviewer由服务器生成；导入默认unverified | 权限/核验回归与`P1 migration keeps legacy records unverified and marks unknown writer honestly` |
| P2 项目接入 | 必须指定工作目录；配置生成用实际UUID校验目录与最长别名匹配，拒绝缺省猜测、未知UUID、失效或错误映射 | `P2 installer separates work directory; profiles and Codex mapping select actual UUID`；CI还执行完整安装器及管理员CLI检查 |

## 权限边界

默认config.json允许全库检索，但只授予recall。project.config.json授予指定项目的recall/propose/commit/forget；admin.config.json授予全局管理与verify。权限来自本机操作者配置，不来自模型自称的author_client或自然语言授权描述。

written_by、事件connection_id、候选connection_id均来自服务端配置。没有身份字段的旧配置由真实配置路径摘要确定连接身份；旧数据库写入历史无法重新确认身份，明确保留legacy:unknown。相同配置共享同一身份，不把MCP客户端自报名称当作真实用户认证。同一操作系统用户能直接读写文件，这些配置不是对恶意同用户进程的安全沙箱。

持有写配置就拥有该配置的能力；逐次人工确认仍需所用harness实施。服务器不宣称自己能从提示词判断真实的人类意愿。

## 核验语义

verified表示有verify权限的审阅者用user_confirmation、code_review或document_review记录了依据和证据，并留下服务器身份及时间。系统不从自由填写的method/summary、来源数量、source_hash或向量相似度推断事实真实，也不是通用自动事实证明器。模型推断和未复核的来源声明默认unverified；冲突可标disputed。修改已核验记录时，普通写连接需明确作为未核验新版本处理，不能擅自维持verified状态。

## 恢复与升级

`import --commit`现在必须指定`--mode new|restore`并提供`--revocations`；对象、导出数组、去掉ID的正文数组均不能免除检查。new模式不接受导出身份元数据。即使是新外部记录，服务器也不能仅凭结构断定它从未被导出过，因此统一核对外部清单。最新性仍由操作者取得真实最新清单，不能用旧导出自带的清单冒充。

数据库从schema3原地迁移到schema4，仅增加审计身份列，正文与向量保留；并发首次连接会在迁移事务中重查版本。`four clients concurrently migrate a legacy schema without losing records`验证四客户端并发升级。没有迁移向量引擎。

升级前备份SQLite与最新撤销清单及配置，停止或重连旧客户端。旧schema3程序不能打开schema4。新安装默认只读，不要把管理员配置作为日常Agent连接。已有配置不会因为升级代码自动变为最小权限，需按角色显式切换；本机部署另有备份与数据保全验证。

# SeatRelay 项目完整执行计划（2026-10-13 → 2026-11-13）

## 0. Context（背景与目标）

**现状**
- Preliminary report 已提交（5 页，Group 18）。TA 评价「very dense and clear」，给出 3 条意见：(1) 没有市场规模估算；(2) 过期靠 EventBridge 周期性 sweep，sweep 间隔成为 backfill 延迟目标 (p95 ≤ 120 s) 的下限，要么写明间隔，要么改成每个 offer 一个定时器（如 SQS delay message）；(3) 写操作返回 202 Accepted，但没说浏览器如何得知请求已结算（polling 还是 WebSocket）。
- 代码：**0 行**。本机：Node 20.17 / npm 10.8 / git / Python 3.10 / MiKTeX 已有；**Docker、AWS CLI、SAM CLI、k6 均未安装**。
- 团队确认：AWS 账号 + US$120 credits 已激活；本机尚未配置 AWS CLI 凭证；4–6 位学生访谈未做；真实试点 workshop 未定；结算通知采用 **Polling**；on-premise 参照**按报告承诺做全**（Docker Compose + Node + PostgreSQL + Keycloak + Mailpit）。
- 硬性交付（Project Specification）：`Final.pdf` ≤ **10 页**（含封面/目录/图表/参考文献，15 分）、`Slides.pdf`（10 分，15 min 展示 + 10 min Q&A，**每位成员都要讲**，含清晰 demo，11/13 当天完成）、Final 必须含 **Code Explanation + 公开代码 URL**（保持可访问到出分）、AI 使用必须**显式声明**（在哪用、怎么用、学到什么）、final peer assessment（不填 = 0）。
- 报告已做出的承诺（Final 必须逐条兑现）：Scope（组织者管理 2–5 场、统一报名、候补与限时保留、参与者状态页、站内+邮件通知、看板含各场名额/队列长度/回补记录/distinct participants/到场登记/CSV 导出）；规则 R1–R7；约束 C1–C7；Table 3 全部验收目标；机制对照实验（unified vs per-session）；三层成本口径 + on-prem 对比公式；用户评估（12 位非组员、对照条件、SUS ≥ 75、关键任务完成率 ≥ 90%、配对任务时间改善 ≥ 25%）；真实试点两场。

**目标**：在 11/13 前交付一套可公开访问、可演示、已实测的 SaaS；Final.pdf、Slides.pdf、公开仓库；Table 3 每一项都有实测数据；用户评估与试点有真实数据；云 vs on-prem 成本对比有实测依据。

**分工原则（本计划的前提）**
- **我（AI 编码助手；工具名只写在 Final 报告的 AI 使用声明里）负责**：全部代码、IaC、测试、实验脚本、数据分析、图表、Final 报告 LaTeX、幻灯片、README、演示脚本、访谈/用户研究材料。
- **团队负责只有人能做的事**：AWS 凭证与部署批准、GitHub 仓库、SES production 申请、访谈、招募与主持用户测试、办真实试点、演示、AI 声明中「每人学到什么」、peer assessment。（详见 §8 清单。）
- 学术诚信：**不伪造任何实验/用户数据**。所有报告数字来自 `results/` 中可追溯的原始文件。AI 声明如实写明代码由 AI 编码助手生成、团队负责审阅/部署/实验/评估（实际分工以 Final 报告的 AI 使用声明为准）。
- 本计划已经过一次独立架构评审（red-team），评审提出的 14 项坑点与修正已并入 §2（以「评审修正」标注）。关键 AWS 事实已对照官方文档核实。

---

## 1. 针对 TA 反馈的设计调整（改什么、怎么改、写到哪）

### 1.1 市场规模（Market sizing）—— 新增到 Final §1
采用**自底向上**估算 + 访谈佐证，所有计数带来源，明确标注为估算：
1. **组织者总数（新加坡）**：三类——(a) 6 所自主大学 + 5 所理工学院的注册学生组织数（各校官方 club/society 目录逐校计数）；(b) 校内常办 workshop 的部门（图书馆、Career centre、IT 服务、各学院教学支持）；(c) SkillsFuture/CET 培训提供方数量（SSG 官方目录/统计）。
   - 初步检索到的候选数字（执行时逐一回到官方页面核实日期后再引用）：NUS OSA「more than 200 student organisations」；SUTD「over 80 student groups」；SIT「more than 150 student clubs, chapters and interest groups」；SMU「over 100 clubs and societies」；NTU 官方公报（较旧）103 个学生组织；五校合计约 **600+ 学生组织**（未含理工学院）。CET 侧：SSG 2016 年公布 SkillsFuture Credit 课程由「over 700 training providers」提供，MOE 2018 年国会答复「over 30,000 courses funded by SSG」，SSG 2024 年 555,000 名学员参加受资助培训。这些只作数量级依据，报告中标注年份与来源。
   - 多场次现象的直接证据：NUS Libraries / Centre for Future-ready Graduates 的 workshop 日历中「同内容多场次」的条目计数；Eventbrite/Luma 上新加坡 workshop 的一次定日计数（标明日期）。
2. **问题发生率 p**：访谈问「过去一年你办的活动里有多少次是 ≥ 2 个等价场次？」「每次人工协调花多少小时？」→ 得到 p 与每活动人工小时数。
3. **TAM / SAM / SOM**：TAM = 全新加坡组织者 × p × S$120/年（并附一句 ASEAN 高校数量给出区域上限）；SAM = 其中使用免费/SaaS 工具、不被校方封闭系统覆盖的组织者；SOM = 第一年可触达（NUS 学生组织 + 试点院系）。
4. 呈现形式：一个 4 行小表（人群 / 计数 / 来源 / 估算口径）+ 一句「价值来源 = 每活动节省人工小时 × 时薪」，用以支撑 S$10/月定价。约 120 词。

### 1.2 过期机制：「每个 offer 一个定时器」+「tick 语义」—— 改 Final §3 + Fig 2
- **语义（评审修正）**：过期不是「匹配某条消息」而是**按服务端时间判定**。worker 处理任何命令前，先在 `decide()` 里把所有 `expiresAt ≤ now` 的 OFFERED offer 置为 EXPIRED 并释放名额（「tick-first」），再执行命令本身。于是：迟到/重复/陈旧的定时消息都是**无害的空操作**；过了 `expiresAt` 的 ACCEPT 即使定时器尚未到达也会被拒绝；C5 由此以更强的形式成立（报告改写为：过期以处理时刻的服务端时间判定，迟到的 tick 不可能令未到期的新 offer 失效）。
- **主路径（决定延迟）**：worker 为每个新 offer 向**标准 SQS 队列 `expiry-delay`** 发一条 `TICK{workshopId, offerId, expiresAt}`，`DelaySeconds = clamp(expiresAt − now, 0, 900)`；`expiryForwarder` Lambda 到期后把 `TICK{workshopId}` 投入**同一条 FIFO 队列、同一个 MessageGroupId = workshopId**（dedup id `tick#offerId#expiresAt`），worker 处理 TICK = 跑一次 tick-first + allocate。定时消息在**事务提交前**发送（多余的 tick 无害），不再需要「提交后发送失败→重投→重放补发」这条最难测的路径。
- **关键事实（写进报告，已核对 AWS 文档）**：SQS 文档明言 "FIFO queues don't support timers on individual messages"，message timer 上限 15 min；所以定时器放在标准队列再转入 FIFO，保持「释放与新请求共用一条每 workshop 有序路径」。备选方案 EventBridge Scheduler（一次性 `at()`，无 15 min 上限，AWS 推荐用于更长延迟）在报告中作为「已考虑」列出：本项目 hold ≤ 15 min 落在 SQS 上限内，且不必多引入一个服务与 PassRole 权限。
- **安全网（不在延迟路径上）**：workshop META 维护 `nextDueAt = min(最早 live offer 的 expiresAt, 最近一个 session 的 cutoffAt)` 并写入稀疏 GSI（`GSI1PK='DUE'`, `GSI1SK=nextDueAt#wsId`）；EventBridge 每 5 min 触发 `sweep`，查 `nextDueAt ≤ now` 的 workshop 并投 TICK。它同时兑现 R4 的 cut-off（到点后该场不再分配；若某报名所有可接受场次均已过 cut-off → ENDED(CUTOFF)）和「故障后 5 min 内恢复」。正常运行时 sweep 投出的 tick 不应产生任何过期动作，指标 `SweepLateExpiries` 应为 0。报告写明：**sweep 间隔不再约束 backfill 延迟**。
- **hold 时长按 workshop 可配置**（评审修正）：`holdSeconds` 默认 900、下限 30；实验用 60 s 以免每个样本等 15 min；报告写明默认值与实验设置。
- **延迟预算（报告给表）**：SQS delay 精度（秒级）+ forwarder 调用 + FIFO 入队 + worker 事务 ≈ 预期 p95 个位数秒；取消/拒绝导致的回补发生在**同一个事务内**，延迟 ≈ 0，分开报告。120 s 仍作为验收上限，实际值实测给出。

### 1.3 202 结算：**Polling 协议**（明确写入 Final §3 + Fig 2 第 9 步）
- `commandId` 由**客户端生成**（UUID v4，随表单保存，重试时复用）。`POST /workshops/{id}/commands` → API 条件写入 `CommandResult{status: ACCEPTED, acceptedAt}`（`attribute_not_exists(PK)` + `ReturnValuesOnConditionCheckFailure: ALL_OLD`：已存在则直接返回既有结果，无需二次读 → 重复提交幂等，C3）→ 投 FIFO（失败则条件删除该 CMD 并返回 503，避免浏览器轮询孤儿）→ 返回 **202** `{commandId, status:"ACCEPTED", href:"/commands/{id}", pollAfterMs:300}`。
- 浏览器轮询 `GET /commands/{id}`（DynamoDB **ConsistentRead**），退避 300 → 500 → 1000 → 2000 ms（封顶），30 s 预算后降为每 5 s 后台轮询并提示「仍在处理」。终态 `APPLIED{result}` / `REJECTED{reason}`；`result` 自带报名状态与 offer 摘要，UI 仅凭轮询响应即可更新（避免刚结算就读 GSI 的陈旧风险）。
- 参与者状态页在存在 QUEUED/OFFERED 时每 10 s 刷新（页面不可见时暂停），用于接收**非本人触发**的变化（回补得到 offer）。
- UI 必须区分「请求已接收」与「名额已确认」（报告承诺）：toast「已接收，处理中…」→ 结算后「Session 2 名额已为你保留，14:59 内确认」/「已排队，第 3 位」/「被拒绝：原因」。
- 报告写明**为何不做 WebSocket**：试点规模下无收益，且多一类 API、连接表与故障点；性能指标分别报告「服务端结算延迟」(settledAt − acceptedAt，写在 CMD 上) 与「客户端观测延迟」（含轮询量化误差，最多 +2 s）；k6 以固定 200 ms 轮询仅用于探测完成。

### 1.4 顺带改进（以审稿人视角补强）
- 参与者状态显示**队列位置**（支撑 H1）；看板回补记录显示每次回补的延迟（支撑 H3）；组织者「验证」端点一键检查 C1/C2 不变量（演示与实验证据）。
- R2 措辞改为：队列顺序 = FIFO 入队顺序 = worker 分配的 `seq`。
- 明确所有时间以服务端 UTC 为准；明确数据保留（CommandResult 30 天、通知 90 天 TTL）与最小化收集（邮箱 + 显示名）。
- 可用性与 RPO/RTO 一句话：托管服务默认多 AZ，DynamoDB PITR；单 region。单 workshop 内写操作串行化是**有意的设计性质**（顺序保证的代价），在报告中陈述。

---

## 2. 系统设计（实现规格）

### 2.1 仓库结构（pnpm monorepo，`E:\2025 NUS\CS5224\Group Project\seatrelay\`，独立 git 仓库，GitHub 公开）
```
seatrelay/
  package.json  pnpm-workspace.yaml  tsconfig.base.json  .eslintrc.cjs  .prettierrc  .github/workflows/ci.yml
  packages/core/        纯领域逻辑：types、commands、decide()（tick-first）、allocate()、invariants、PER_SESSION 基线策略；vitest + fast-check
  packages/contracts/   zod schema（API 请求/响应、命令 payload），web/aws/local 共用
  services/aws/         SAM：templates/{auth,app,web}.yaml、samconfig.toml、src/handlers/{api,worker,expiryForwarder,sweep,notifier}.ts、src/adapters/dynamo/*、scripts/build.mjs(esbuild)
  services/local/       on-prem 参照：docker-compose.yml、Dockerfile、src/{server,worker,timers,notifier}.ts、src/adapters/postgres/*、sql/schema.sql、keycloak/realm-export.json
  apps/web/             Vite + React + TS：react-oidc-context、TanStack Query、react-router；authAdapter（Cognito / Keycloak 登出差异）；同一构建产物用于 CloudFront 与本地 nginx
  tools/loadtest/       k6 脚本 + Cognito(InitiateAuth JSON)/Keycloak(password grant) 取 token 脚本
  tools/replay/         机制对照仿真（unified vs per-session，纯 core，模拟时钟）
  tools/experiments/    Table 3 各项实验脚本 + 指标抓取（CloudWatch GetMetricData）+ 用量计价 + 分析（Python/pandas/matplotlib）
  tools/scripts/        deploy-web.ps1、seed-demo.ts、create-test-users.ts、teardown.ps1（先清桶）、cost-snapshot.ps1
  docs/                 ARCHITECTURE.md、RUNBOOK.md、EXPERIMENTS.md、COST.md、user-study/*、interviews/*、walkthrough/<line>.md（每位成员讲解稿）、DEMO.md
  results/              每次实验的原始 CSV + summary.md + 图（报告数字唯一来源）
  README.md             = Final §6 Code Explanation 的来源
```

### 2.2 领域模型与命令（packages/core）
- **实体**：`Organization{id, name, ownerUserId, members[]}`；`Workshop{id, orgId, title, description, status: OPEN|CLOSED|CANCELLED, mode: UNIFIED|PER_SESSION, holdSeconds, seq, version, nextDueAt}`；`Session{id, workshopId, title, startsAt, cutoffAt(=startsAt−30 min), capacity, confirmed, held, status: OPEN|CANCELLED}`；`Registration{workshopId, userId, seq, acceptable: sessionId[](偏好序), status: QUEUED|OFFERED|CONFIRMED|CANCELLED|ENDED, endReason?, currentOfferId?, confirmedSessionId?}`；`Offer{id, workshopId, sessionId, userId, status: OFFERED|ACCEPTED|DECLINED|EXPIRED|REVOKED, createdAt, expiresAt}`；`CommandResult{commandId, type, actorUserId, workshopId, status: ACCEPTED|APPLIED|REJECTED, reason?, result?, acceptedAt, settledAt, ttl}`；`Notification{id, userId, kind, offerId?, body, status: PENDING|SENT|FAILED|SKIPPED, attempts, ttl}`；`BackfillRecord{workshopId, sessionId, releasedAt, cause: EXPIRED|DECLINED|CANCELLED_CONFIRMED|CANCELLED_OFFER|CAPACITY_UP, reallocatedAt?, newOfferId?, latencyMs?}`；`Attendance{workshopId, userId, attended, markedAt}`（API 同步写，不在 worker 锁内）。
- **命令**（均带客户端 `commandId`、`actorUserId`(来自 JWT，body 不带)、`workshopId`）：参与者 `REGISTER{acceptable[]}`、`ACCEPT_OFFER{offerId}`、`DECLINE_OFFER{offerId}`、`CANCEL_REGISTRATION`；组织者 `SET_CAPACITY{sessionId, capacity}`、`CANCEL_SESSION{sessionId}`、`CANCEL_WORKSHOP`、`CLOSE_REGISTRATION`/`OPEN_REGISTRATION`；内部 `TICK`（无 CMD 记录，天然幂等）、`REALLOCATE`（续作）。创建 workshop/session、编辑标题、到场登记为**同步 REST**。所有会改动 `WS#` 分区状态的操作都走命令（worker 是唯一写者，这是 META 单锁成立的前提）。
- **纯函数** `decide(snapshot, command, now): Decision` → `{status, reason?, writes: Change[], notifications[], timers: {offerId, expiresAt}[], backfills[]}`。步骤：(1) tick-first：过期所有到期 offer、处理已过 cut-off 的场次；(2) 应用命令；(3) `allocate()`：按 seq 扫描 QUEUED 报名，按偏好序找第一个 `free = capacity − confirmed − held > 0` 且 `now < cutoffAt` 的场次 → Offer（`expiresAt = min(now + holdSeconds, cutoffAt)`）、`held++`、Registration→OFFERED、Notification、BackfillRecord 补 `reallocatedAt`；(4) 重算 `nextDueAt`。每条命令最多生成 **12** 个 offer，超出则产生 `REALLOCATE` 续作（事务 100 项上限）。
- **规则落点**：R1 = 唯一标记项 `L#U#{userId}` 条件写入；R2 = `seq` 由 worker 单写者递增；R3 = allocate 顺序扫描；R4 = expiresAt/cutoffAt + sweep tick；R5 = DECLINE/EXPIRE 从 acceptable 移除该场，空则 ENDED，否则回到 QUEUED 并立即再 allocate；R6 = CANCEL 全退出，重报名 seq 新；R7 = SET_CAPACITY 拒绝 `capacity < confirmed + held`，增加容量则立即 allocate；CANCEL_SESSION 把该场 OFFERED→REVOKED、CONFIRMED→回到 QUEUED（可接受集移除该场）并通知。
- `checkInvariants(snapshot)`：C1 `confirmed + held ≤ capacity`、`held == 该场 OFFERED 数`；C2 每账号每 workshop ≤ 1 个 OFFERED/CONFIRMED；「无饥饿」：不存在 QUEUED 报名其某可接受场次仍有空位且未过 cut-off。用于测试、实验与 `verify` 端点。
- `mode: PER_SESSION` 策略：报名绑定单场次、各场独立队列、不施加跨场约束；报告写明「基线 = 同一引擎 + 按场分配器，在模拟时钟下重放」。
- 测试：vitest 覆盖每条规则与每个拒绝原因；fast-check 随机命令序列（≥ 2,000 条、长度 ≤ 200、含随机时钟推进）后 `checkInvariants` 必过；覆盖率目标 core ≥ 95% 分支。

### 2.3 DynamoDB 键设计与事务（services/aws/src/adapters/dynamo）
单表 `seatrelay-{stage}`，PK/SK 字符串，On-demand，PITR 开（dev 关 DeletionProtection），Streams `NEW_AND_OLD_IMAGES`，TTL 属性 `ttl`（epoch 秒）。**live / history 前缀分离**（评审修正：避免快照 Query 随实验增长而变慢）：
| 项 | PK | SK | 备注 |
|---|---|---|---|
| Organization | `ORG#{orgId}` | `META` | members；GSI1 `U#{userId}`→`ORG#` 查我的组织 |
| Workshop | `WS#{wsId}` | `L#META` | seq/version/holdSeconds/nextDueAt；GSI1PK `ORG#{orgId}` GSI1SK `WS#{createdAt}`；稀疏 `GSI1PK='DUE'` 仅 OPEN 且有到期事项时 |
| Session | `WS#{wsId}` | `L#S#{sessionId}` | capacity/confirmed/held/cutoffAt |
| 活跃 Registration | `WS#{wsId}` | `L#R#{seq:08d}` | QUEUED/OFFERED/CONFIRMED；GSI1PK `U#{userId}` GSI1SK `WS#{wsId}` 查我的报名 |
| 唯一标记 | `WS#{wsId}` | `L#U#{userId}` | {seq,status}；R1/C2；O(1) 一致读 |
| 活跃 Offer | `WS#{wsId}` | `L#O#{offerId}` | 仅 OFFERED |
| 历史 Registration/Offer | `WS#{wsId}` | `H#R#{seq}` / `H#O#{offerId}` | 结算时 Delete live + Put history（同一事务） |
| BackfillRecord | `WS#{wsId}` | `H#BF#{releasedAt}#{id}` | 看板 + 回补延迟 |
| Attendance | `WS#{wsId}` | `H#A#{userId}` | API 同步写 |
| CommandResult | `CMD#{commandId}` | `META` | ttl 30 天；含 acceptedAt/settledAt/result |
| Notification | `U#{userId}` | `N#{createdAt}#{id}` | entityType=NOTIFICATION；ttl 90 天 |
- worker 快照 = `Query PK=WS#{wsId} AND begins_with(SK,'L#')`（ConsistentRead）——只读 live 项，大小受容量 + 队列长度约束。
- **提交（评审修正）** = 一个 `TransactWriteItems`：条件只放在**被写的项**上：`L#META` 带 `version = :snapshot`（每次事务 +1，是整个 workshop 的乐观锁，成立前提 = worker 是 `WS#` 的唯一写者）；`CMD#` 更新带 `status = ACCEPTED`；新建项 `attribute_not_exists`。**不**对未改动项做 ConditionCheck（100 项上限、且同键 Put+ConditionCheck 会报 ValidationException）。`TransactionCanceledException` 按 `CancellationReasons[i].Code` 分支：CMD 失败 → 已结算，ack（重投幂等，C3）；META 失败 → 进程内重载快照重试 ≤ 3 次；其他 → 抛出。
- 定时器在提交前发送（`SendMessageBatch` 到 `expiry-delay`），多余 tick 无害。

### 2.4 AWS 资源（三个 stack，ap-southeast-1；评审修正：auth 永不拆、app 可按 stage 拆建、web 独立以免每次等 CloudFront）
- **`seatrelay-auth`**：Cognito UserPool（`UsernameAttributes:[email]`、`AutoVerifiedAttributes:[email]`、大小写不敏感、`DeletionProtection: ACTIVE`）；App client `web`（无 secret、`AllowedOAuthFlows:[code]`、scopes openid/email/profile、`ExplicitAuthFlows:[ALLOW_USER_SRP_AUTH, ALLOW_REFRESH_TOKEN_AUTH]`、Callback/Logout URLs = CloudFront 域 + `http://localhost:5173`、`PreventUserExistenceErrors: ENABLED`）；App client `tooling`（额外 `ALLOW_USER_PASSWORD_AUTH`，仅实验脚本用；k6 直接向 `cognito-idp` POST JSON，`X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth`，无需签名）；`UserPoolDomain{Domain: seatrelay-<accountId>, ManagedLoginVersion: 1}`（classic hosted UI；v2 需 branding 资源）；SES 发件身份。前端持 **ID token** 调 API（含 `email`；authorizer 对 `aud` 校验 = web client id；Keycloak 的 ID token 同样含 email）。登出：Cognito discovery 无 `end_session_endpoint`，`authAdapter` 做 `removeUser()` 后跳 `https://<domain>/logout?client_id&logout_uri`；Keycloak 走标准 RP-initiated logout。Cognito 默认邮件配额 **50 封/天/账号**（09:00 UTC 重置，不可提高；已核对配额表）；SES production 批准前保持 `COGNITO_DEFAULT`（sandbox 下切到 SES 会让未验证地址的注册验证码直接失败）。
- **`seatrelay-app-{stage}`**（dev / pilot；参数 `EmailEnabled`、`AllowFaultFlags`）：
  - **HTTP API**：`Auth.DefaultAuthorizer` JWT（`identitySource: $request.header.Authorization`，`issuer`/`audience` 小写键）；**路由按方法声明** `GET|POST|PUT|DELETE /{proxy+}`（不用 ANY/$default，否则 OPTIONS 预检被 authorizer 拦成 401 且无 CORS 头）；`CorsConfiguration{AllowOrigins:[CloudFront 域, http://localhost:5173], AllowHeaders:[authorization, content-type], AllowMethods:[GET,POST,PUT,DELETE], MaxAge:600}`；`DefaultRouteSettings` 节流 dev 300 rps/500 burst（50 VU × 200 ms 轮询 ≈ 250 rps，否则压测测到 429）、pilot 50/100；访问日志含 `$context.authorizer.error`、`$context.responseLatency`。
  - **Lambda**（nodejs20.x、arm64、`api` 512 MB / `worker` 1024 MB、Timeout api 10 s / worker 20 s；Powertools logger + EMF 指标（**不带 workshopId/userId 维度**，每个维度组合 $0.30/月）；每个函数显式 `AWS::Logs::LogGroup` + `RetentionInDays: 14` 经 `LoggingConfig.LogGroup` 绑定，否则日志组永不过期）。构建：**自有 esbuild 脚本**（`format: esm`、`platform: node`、`target: node20`、`external: ['@aws-sdk/*']`、createRequire banner、sourcemap）输出 `dist/<fn>/index.mjs`，SAM `CodeUri` 指向 dist、不用 `BuildMethod`（`sam build` 的 esbuild 会在临时目录 `npm install`，pnpm `workspace:*` 依赖会断、路径超 MAX_PATH）；`sam deploy` 直接部署。
  - **SQS**：`commands.fifo`（`ContentBasedDeduplication: false`、显式 DedupId、`VisibilityTimeout: 120`（≥ 6 × worker 20 s）、`RedrivePolicy maxReceiveCount: 3` → `commands-dlq.fifo`（DLQ 必须也是 FIFO，保留 14 天））；`expiry-delay`（标准、VisibilityTimeout 60、自带 DLQ）；`notify-dlq`。**worker 事件源**：`BatchSize: 1`（起步；若 hot-spot 实验 p95 > 5 s 再升到 10 并做「同组命令共享内存快照」优化）、`FunctionResponseTypes:[ReportBatchItemFailures]`、`ScalingConfig.MaximumConcurrency: 5`（下限 2）。**失败策略**：确定性拒绝（业务规则不通过）→ 结算为 REJECTED 并 ack，**绝不抛出**；DynamoDB 瞬时错误进程内重试；只有真正的基础设施故障才抛出。原因：Lambda 失败不会缩短可见性超时，抛出会让该 workshop 的消息组停摆 `VisibilityTimeout × maxReceiveCount`。FIFO 分批规则（AWS 文档）：批内第一个失败处停止，把该条及其后全部未处理消息放进 `batchItemFailures`。
  - **DynamoDB** 如 §2.3；Streams → `notifier`：`StartingPosition: LATEST`、`BatchSize 10`、`MaximumBatchingWindowInSeconds 1`、`BisectBatchOnFunctionError: true`、`MaximumRetryAttempts: 20`（默认 −1 = 重试 24 h，一条毒记录会卡住整个分片）、`MaximumRecordAgeInSeconds: 3600`、`FunctionResponseTypes:[ReportBatchItemFailures]`、`DestinationConfig.OnFailure → notify-dlq`、`FilterCriteria: {"eventName":["INSERT"],"dynamodb":{"NewImage":{"entityType":{"S":["NOTIFICATION"]}}}}`（必须只收 INSERT：notifier 自己的状态更新产生 MODIFY，TTL 删除产生 REMOVE，否则自循环）。`notifier`：SES 发信节奏 ≤ 1 封/s；`MessageRejected`（sandbox 未验证地址）→ 标 FAILED/SKIPPED 并 ack，**不抛出**；只有限流才抛出重试；测试用 `success@simulator.amazonses.com`；`EmailEnabled=false` 时只记录不发。
  - **EventBridge** `Type: ScheduleV2`，`rate(5 minutes)` → `sweep`。
  - **故障注入（评审修正）**：命令 body 可带 `_fault: BEFORE_COMMIT|AFTER_COMMIT|TIMER_SEND`，仅当 stack 参数 `AllowFaultFlags=true`（dev）时 API 保留并由 worker 执行；pilot 一律剥离。无需改配置即可逐条精确注入。
  - **CloudWatch**：Dashboard（API p50/p95、Lambda 错误/时长、SQS 深度与最老消息年龄、DLQ 深度、自定义指标 `CommandSettledLatency`、`BackfillLatency`、`OffersCreated/Expired`、`SweepLateExpiries`、`NotificationFailures`）；Alarms（DLQ `ApproximateNumberOfMessagesVisible > 0`、命令队列 `ApproximateAgeOfOldestMessage > 120`、worker/api `Errors ≥ 1`、notifier `IteratorAge > 60 s`；`TreatMissingData: notBreaching`）→ SNS 邮件。
  - **成本控制**：`AWS::Budgets::Budget` 月度 US$20（**`CostTypes.IncludeCredit: false`**，否则有 credits 时净额恒为 0、告警永不触发），ACTUAL 50/80/100% + FORECASTED 100%；另一个年度 US$60；所有资源标签 `Project=SeatRelay`（成本分配标签激活需 24 h，第 0 天就开）；`teardown.ps1` 先清空 S3 桶再 `sam delete`。
  - **IAM**：每个函数最小权限（api：DDB 读写 + FIFO Send；worker：DDB + 两条队列 Send；forwarder：FIFO Send + delay Send；sweep：DDB Query GSI1 + FIFO Send；notifier：DDB Update + `ses:SendEmail`）。
- **`seatrelay-web-{stage}`**：私有 S3（四项 PublicAccessBlock、`BucketOwnerEnforced`）+ CloudFront OAC（`SigningBehavior: always`、sigv4；桶策略 Principal `cloudfront.amazonaws.com` + `AWS:SourceArn` 条件）；`DefaultRootObject index.html`、`PriceClass_200`（100 不含新加坡边缘）、http2and3、redirect-to-https、CachingOptimized 策略、403/404 → `/index.html` 200 且 `ErrorCachingMinTTL: 0`。发布脚本：哈希资源 `immutable`、`index.html` `no-cache`、失效 `/index.html`。

### 2.5 API 契约（packages/contracts → OpenAPI 导出到 docs/）
- `GET /me`、`POST /orgs`（创建者成为 owner）、`POST /orgs/{orgId}/members`
- `GET /orgs/{orgId}/workshops`、`POST /orgs/{orgId}/workshops`（同步，含 sessions、holdSeconds）、`PATCH /workshops/{wsId}`（标题/描述）
- `GET /workshops/{wsId}`（公开视图：各场 capacity/free、队列长度、我的状态与队列位置）
- `POST /workshops/{wsId}/commands` → 202；`GET /commands/{commandId}`（仅发起者或该 workshop 组织者，否则 404）
- `GET /me/registrations`、`GET /me/notifications`、`POST /me/notifications/{id}/read`
- `GET /orgs/{orgId}/workshops/{wsId}/dashboard`（各场 capacity/confirmed/held/free、队列、回补记录含 latencyMs、distinct participants served、到场）、`PUT .../attendance/{userId}`（同步）、`GET .../export.csv`、`GET .../verify`（不变量检查）
- `GET /health`。错误体 `{code, message}`；所有输入 zod 校验；C7：每个组织者路由校验成员关系。

### 2.6 前端（apps/web）
- 页面：登录/首页；Workshop 公开页 + 报名表（勾选可接受场次 + 上下箭头排偏好）；「我的报名」（状态卡：Queued 位置 / Offered 倒计时 + Accept/Decline / Confirmed 场次 / Cancel；命令轮询与状态刷新如 §1.3）；通知中心；组织者：创建组织、workshop 列表、创建向导（2–5 场、hold 时长）、看板（各场表格、队列、回补日志、distinct served、改容量、取消场次/活动、到场勾选、导出 CSV、「验证不变量」按钮）。
- 认证：`react-oidc-context`，authority 由 env 指定；`authAdapter` 封装 Cognito/Keycloak 登出差异。
- 可用性：每个异步操作三态文案；错误原因人类可读；移动端可用。

### 2.7 On-premise 参照（services/local，用于成本对比与同等功能验证）
- `docker-compose.yml`：`postgres:16-alpine`、`keycloak:26`（`start-dev --import-realm`，realm 含公开 PKCE client `seatrelay-web`、启用 password grant 的 `tooling` client、测试用户）、`axllent/mailpit`、`server`（Node 20：Fastify API + 进程内 worker/timer/notifier 循环）、`web`（nginx 托管同一份 SPA 构建，`env.js` 注入 issuer/API）。
- Postgres schema：organizations、workshops、sessions、registrations、offers、command_results、notifications、backfill_records、attendance、**commands**（队列：id、workshop_id、payload、status、available_at、attempts）、**timers**（workshop_id、fire_at）。
- worker：每 200 ms `SELECT … FROM commands WHERE status='PENDING' AND available_at<=now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1` + `pg_advisory_xact_lock(hashtext(workshop_id))` 串行化每 workshop → 同一个 `decide()`（含 tick-first）→ 单事务应用写入 → 插入 timers。timer 循环每 1 s 把到期 timers 转成 TICK 命令；notifier 循环经 SMTP 发到 Mailpit。
- Keycloak 发行者坑：浏览器用 `http://localhost:8080/realms/seatrelay`，server 校验 `iss` 用同一字符串、取 JWKS 用容器内地址（`KC_HOSTNAME=http://localhost:8080`）。
- Docker 装不上的回退（Windows Home 需 WSL2）：Postgres 安装包 + Keycloak zip（JDK 21）+ 日志邮件；再不行在组员的 Mac/Linux 上跑一键脚本。
- 测量：同一套 k6 脚本；`docker stats` 采样 → CPU/RAM 曲线 → on-prem 硬件规格与成本模型。

### 2.8 可观测性、安全
- 结构化 JSON 日志含 commandId/workshopId；X-Ray 追踪 API→SQS→worker→DDB（可裁）；EMF 自定义指标（低基数维度）。
- 安全：JWT 校验、组织归属校验（C7）、zod 输入校验、限流、CORS、最小权限 IAM、SPA 不含密钥、PII 仅邮箱+显示名、TTL 保留期；`npm audit` 在 CI。凭证只由组员写入本机 `%USERPROFILE%\.aws\credentials`，不经过我。

---

## 3. 分阶段执行步骤（每步含验收标准）

### Phase 0 · 10/13(二)–10/15(四)：环境、仓库骨架、核心引擎
团队先做（阻塞项，见 §8）：IAM 用户 + 本机 `aws configure`；GitHub 公开仓库；SES production 申请；激活成本分配标签。
1. 安装工具（命令由我给出、团队点 Run 或授权我执行；winget ID 已核对）：`winget install --id Amazon.AWSCLI -e`、`winget install --id Amazon.SAM-CLI -e`、`winget install --id k6.k6 -e`、`winget install --id Docker.DockerDesktop -e`（需管理员 + WSL2 + 重启，团队执行）；`corepack enable` 启用 pnpm；验证 `aws sts get-caller-identity`、`sam --version`、`docker run hello-world`、`k6 version`。
2. 初始化 monorepo（§2.1），ESLint/Prettier/tsconfig，`git init` + 首次提交 + 推送；GitHub Actions CI（lint、typecheck、unit test、`sam validate --lint`、web build）。
3. `packages/contracts`：全部 zod schema + 类型导出。
4. `packages/core`：实体、命令、`decide()`（tick-first）、`allocate()`、`checkInvariants()`、PER_SESSION 策略；vitest 单测 + fast-check 属性测试。
   - 验收：`pnpm -r test` 全绿；属性测试 2,000 序列无不变量违反；覆盖率 ≥ 95% 分支。
5. `tools/replay` 机制对照仿真（纯 core，不需要 AWS）：生成器、两种模式、指标、1,000 seeds、输出 CSV + 图。
   - 验收：`pnpm replay` 产出 `results/replay/summary.md`，含 duplicate holds、distinct served、backfill time 的均值/中位数/95% CI。
6. 访谈材料：`docs/interviews/guide-participant.md`、`guide-organiser.md`（含市场规模与 WTP 问题）、记录模板；SES production 申请文案。

### Phase 1 · 10/16(五)–10/22(四)：云端纵切片 end-to-end（可演示 v0.1）
7. 部署 `seatrelay-auth`；`seatrelay-app-dev`（表、队列、函数、API、日志组、告警、预算）；esbuild 构建脚本；`samconfig.toml`。
   - 验收：三个 stack CREATE_COMPLETE；`GET /health` 200；Hosted UI 可注册登录；Dashboard/Alarms/Budget 存在。
8. `api`：路由、JWT claims 提取、zod 校验、组织归属校验、`POST /commands` 的 CMD 条件写 + FIFO 投递（失败回滚 CMD → 503）、`GET /commands/{id}` 一致读、org/workshop 同步 CRUD、`_fault` 门控。
9. `worker`：live 快照、`decide()`、提交前发 tick、`TransactWriteItems`（META 锁/CMD 条件/CancellationReasons 分支/进程内重试）、EMF 指标、故障注入点、`batchItemFailures` 返回、确定性拒绝不抛出。
10. `expiryForwarder`、`sweep`（DUE GSI）、`notifier`（SES 模板：offer、confirmed、expired、cancelled；节奏与错误策略如 §2.4）。
11. `apps/web` v0.1 + `seatrelay-web-dev`：登录、workshop 公开页 + 报名、我的报名（轮询 + 倒计时 + Accept/Decline/Cancel）、组织者创建 workshop；`deploy-web.ps1`。
12. 端到端手工脚本 `docs/RUNBOOK.md` §Smoke：注册 → 报名 → 获 offer → 接受 → Confirmed；第二账号排队 → 第一账号取消 → 第二账号在同一事务内得到 offer；holdSeconds=60 的 workshop 放一个 offer 到期 → 约 60 s 后自动释放并回补；过了 expiresAt 再 ACCEPT → 被拒。
   - 验收：Smoke 全过；CloudWatch 看到 `CommandSettledLatency`、`BackfillLatency`；DLQ 为 0；`verify` ok。

### Phase 2 · 10/23(五)–10/28(三)：功能补全、本地参照、实验与研究工具；**10/28 UI 功能冻结**（打 tag `v0.9-study`，之后只修 bug）
13. 组织者看板全部功能（各场名额、队列、回补记录含延迟、distinct served、改容量、取消场次/活动、到场登记、CSV 导出、验证按钮）；通知中心；队列位置；UX 打磨。
14. `tools/scripts/create-test-users.ts`（Cognito 批量建用户 `--message-action SUPPRESS` + 取 token 缓存）、`seed-demo.ts`、`cost-snapshot.ps1`、`teardown.ps1`。
15. `tools/loadtest`：k6 场景 `cross-workshop`（10 个 workshop 均摊）与 `hotspot`（1 个 workshop），10/25/50 VUs，每级预热 + 3 轮；客户端固定 200 ms 轮询探测完成；指标：读 p95、202 p95、客户端观测结算 p95、错误率；脚本拉取 CloudWatch 的 SQS 深度/最老消息年龄与 CMD 上的服务端结算延迟。
16. `tools/experiments`：Table 3 每项一个脚本（§4），统一输出 `results/<date>-<name>/{raw.csv, summary.md, *.png}`；`cost/` 子目录按用量 × 公开单价计价。
17. `services/local` 全套（§2.7）+ `docs/RUNBOOK.md` §Local；同一 SPA 指向 Keycloak 跑通 Smoke；k6 对本地跑 10/25/50 VUs + `docker stats` 采样。
18. 用户研究包 `docs/user-study/`：protocol、consent、recruitment、tasks-participant、tasks-organiser、control-condition-setup（3 个 Google Form + 带重复检测公式的 Sheet 模板）、sus、session-sheet.csv 模板、counterbalance 分配表、`analysis.py`。
19. 试点准备：`seatrelay-app-pilot` + `seatrelay-web-pilot`（`AllowFaultFlags=false`）；公开 workshop 页；报名说明；邮件方案（production 已批 → 任意邮箱；未批 → 站内通知 + 团队验证地址）。
   - 验收：dev 与 pilot 可用；本地参照 Smoke 过；所有实验脚本在 dev 上各跑通一次（小规模）。

### Phase 3 · 10/29(四)–11/05(四)：实验执行、用户研究、真实试点、成本采集
20. 10/29 用户研究**预试**（2 位非样本人员）→ 修正任务表与计时规则。
21. 系统实验正式运行（§4，每项 3 轮，记录 run id、时间、stack、commit hash）；每轮后 `verify` + DLQ 检查；结果写入 `results/`。
22. 用户研究 12 人（10/30–11/05，按 counterbalance 表，每人约 40 min）；数据录入 CSV；`analysis.py` 出表与图。
23. 真实试点两场（建议 11/3、11/4，或团队定的日期）：报名开放 ≥ 5 天；记录自然发生的取消/回补/通知/到场；团队观察 = 内部运营证据，独立参与者反馈 = 用户证据；试点后导出 CSV 与 CloudWatch 指标快照。
24. 成本采集：每日 `cost-snapshot.ps1`；实验期间按服务用量（请求数、Lambda GB-s、DDB RCU/WCU、SQS 请求、SES 封数）× 公开单价 → 计费口径（Cost Explorer 的「扣 credits 后」会显示 0，所以计费层必须从用量算）→ 单位成本（每 1,000 次报名）与随规模趋势；on-prem 模型填数（§6）。
   - 验收：Table 3 每项有 summary.md 与结论（达标/未达标 + 数值）；用户研究与试点数据齐；成本三层口径表完成。

### Phase 4 · 11/06(五)–11/12(四)：修复、Final 报告、幻灯片、演示
25. 按证据修复缺陷（回归跑受影响实验）；冻结代码，打 tag `v1.0-final`；README/Code Explanation 完稿；仓库公开可访问。
26. `report/Final.tex`（复用 Preliminary 版式，`build.ps1` 参数化 MAXPAGES=10、文件名 Final）；更新 Fig 1、Fig 2（delay 队列定时器、forwarder、DUE sweep 安全网、polling 第 9 步）、新增请求时序图、结果图表（§7）；R2/C5/hold 时长/sweep 间隔/轮询参数的措辞更新；AI 声明（真实描述 + 每人学习段落）；占位符零命中检查。
27. `Slides.pdf`（§7.2）+ 演示脚本 `docs/DEMO.md`（预置数据、两台浏览器/账号、故障注入演示一项、备用录屏）；每位成员的 `docs/walkthrough/<line>.md`；Q&A 预案。
28. 演练 2 次（计时 ≤ 15 min）；与 TA 约定展示时间（尽量 11/11–11/12）。

### Phase 5 · 11/13(五)：提交
29. Canvas 提交 `Final.pdf` + `Slides.pdf`（一人提交、另一人独立下载核对）；TA 展示；全员 peer assessment；确认仓库 URL 可访问；`teardown` dev stack（保留 auth 与 pilot）。

---

## 4. 系统实验方案（Table 3 逐项 → 方法 → 输出）
| Table 3 项 | 方法（脚本） | 通过判据 / 报告内容 |
|---|---|---|
| Core correctness | `correctness.ts`：脚本化场景（报名/确认/拒绝/取消/改容量/取消场次/取消活动）跑在 dev，每步后 `verify` | 0 超容量、0 双持有；列出每场景结果 |
| Preference, order | core 属性测试（2,000 随机序列）+ dev 上 20 个固定用例重放 | 从不分配不可接受场次；偏好序正确 |
| Concurrency | `concurrency.ts`：50 个账号并发争 3 场共 5 席；同一账号并发 accept/decline/cancel | 终态满足全部不变量；记录 META 冲突重试次数（预期 0，因 FIFO 单消费者） |
| Repeat execution | 同一 commandId 并发提交 5 次；`_fault: AFTER_COMMIT` 模拟提交后崩溃触发重投 | 无双扣/双放；CMD 唯一且 APPLIED 一次 |
| Expiry race | holdSeconds=60：ACCEPT 在 expiresAt − 200 ms 与 + 200 ms 各发；手工向 FIFO 投迟到的 TICK | 前者成功、后者 REJECTED(expired) 与定时器是否到达无关；迟到 tick 不影响新 offer |
| Failure recovery | `_fault: BEFORE_COMMIT`/`AFTER_COMMIT`/`TIMER_SEND`；notifier 置 reserved concurrency 0 → 记录积压 → 恢复 → Streams 重试送达 | 可恢复、可追溯（日志/X-Ray）；恢复 < 5 min（记录实际秒数） |
| Access control | 负向用例：确认他人 offer、跨组织看板/导出/改容量、无 token、读他人 CMD | 401/403/404 全部正确 |
| Performance | k6 10/25/50 VUs × 2 场景 × 3 轮 | 读与 202 p95 < 1 s；结算 p95 < 5 s（服务端与客户端口径分开）；错误率；队列深度；hot-spot 若未达标，如实报告并解释单 workshop 串行化 |
| Backfill latency | `backfill.ts`：holdSeconds=60，100 个 offer 放任到期、队列后有人等待；latency = reallocatedAt − expiresAt；取消驱动回补单独统计 | p95 ≤ 120 s（预期个位数秒）；离群值列出；`SweepLateExpiries`（期望 0） |
| Cost | 用量 × 单价 + Cost Explorer 日度；本地参照同负载 | 单位成本与规模趋势；三层口径 |
| Mechanism comparison | `tools/replay`（1,000 seeds，模拟时钟）+ dev 上两种 mode 各一次真实重放 | duplicate holds、distinct served、backfill time 对比图 |

---

## 5. 用户评估执行（团队主持，我提供全部材料与分析）
- 招募 12 位非组员（≥ 4 位有组织经验），从 10/20 起；预试 2 人（不计入）。
- 对照 = 「每场一个表单 + 电子表格」；一半先 SeatRelay 一半先对照；第二轮用等价但不同的数据。
- 任务：参与者 5 项（选可接受场次、加入候补、解读状态、确认名额、取消）；组织者 4 项（建多场 workshop、处理取消、查看回补结果、读 distinct 计数与导出）。
- 指标：关键任务完成率（目标 ≥ 90%）、配对任务时间中位数改善（≥ 25%，给 Wilcoxon 符号秩 p 值作为不确定性说明）、SUS（原版 10 题，目标 ≥ 75，报告均值 ± 95% CI）、错误操作数、求助次数、组织者人工步骤数、简短访谈。
- 报告如实写样本量与局限；招募不足就写实际人数。

## 6. 成本对比方法（docs/COST.md + 电子表格）
- 云端三层：用量 × 新加坡区单价 → 扣除免费额度 → 扣 credits 后实付（= 0，如实说明）；按实验与试点期间实测用量，推算 低/中/高 三档负载（如 1k / 10k / 100k 报名/月）的月成本与单位成本。
- On-prem：硬件摊销（一台小型服务器/迷你主机零售价，3–4 年直线摊销，引用来源）+ 电费（实测或规格功率 × SP 电价）+ 增量网络 + 备份与邮件（外部盘/对象存储 + 事务邮件服务按封计价）+ 运维人工（小时/月 × 时薪，注明假设）；分「仅硬件增量」与「全摊销」两口径；同负载同保留期同能力；明确单机与托管多 AZ 的可用性差异；给出交叉点图。

## 7. Final 报告与幻灯片
### 7.1 Final.pdf（≤ 10 页）页预算
1. 标题块 + §1 Motivation & business case（含**市场规模**表、访谈证据、竞品表精简）— 1.25 页
2. §2 Business model（定价/免费层/WTP 访谈结果）+ **Cloud vs on-prem 成本对比**（表 + 交叉点图）— 1.25 页
3. §3 Architecture & implementation：Fig 1 流程（复用）、Fig 2 架构（更新）、Fig 3 请求时序（202→poll→settled；offer→timer→tick→backfill）、数据模型与 META 单锁事务、R1–R7、C1–C7 落地（C5 改为 tick 语义）— 2.5 页
4. §4 Evaluation：系统结果表（目标 vs 实测，逐项）、性能图、回补延迟分布、机制对照图、用户研究结果（完成率/时间/SUS 图）、试点观察 — 2.5 页
5. §5 Conclusion & future work — 0.4 页；§6 Code explanation + 公开 URL（结构、构建/部署/实验运行方法、声明→代码路径映射）— 0.6 页；Assumptions + AI 声明 — 0.5 页；References（≥ 12 条）— 0.5 页
- 构建：`report/build.ps1 -Target Final -MaxPages 10`；提交前占位符零命中；每个数字可追溯到 `results/`。

### 7.2 Slides.pdf（15 min，每人 ~2.5 min）
问题与市场(1) → 商业模式与定价(1) → 机制与规则(1) → 架构(1) → 请求路径/定时器/事务(2) → **Live demo**(约 5 min：报名→offer→接受；第二人取消→即时回补；holdSeconds=60 的 offer 过期→自动回补；看板验证不变量；一项故障注入) → 系统评估结果(2) → 成本对比(1) → 用户研究与试点(1) → 局限/未来/AI 使用与分工(1)。备用录屏。

## 8. 团队必须完成的事项（带日期）
| 截止 | 事项 |
|---|---|
| 10/14 | 创建 IAM 用户 `seatrelay-deployer`（项目期内 AdministratorAccess 或等效），**自行在本机 `aws configure`**（region `ap-southeast-1`）；开启 Cost Explorer 并激活成本分配标签 `Project`；创建 GitHub 公开仓库 `seatrelay` 并在本机 `gh auth login` |
| 10/15 | 提交 **SES production access** 申请（我起草文案；免费，通常 1–2 天）；验证一个发件身份（团队邮箱） |
| 10/16–10/24 | 4–6 位学生访谈 + 2–3 位组织者访谈（用 `docs/interviews/` 指南；给出记录） |
| 10/22 | 定真实试点 workshop 的主题、两场日期（建议 11/3–11/4）、场地与容量 |
| 10/20 起 | 招募 12 位非组员参与者，排期 10/30–11/05；10/27 前约好预试 2 人 |
| 10/27 | 向目标学生群发试点报名链接 |
| 10/29–11/05 | 主持预试与用户测试、办试点、录入数据 |
| 11/06–11/10 | 每人写 AI 声明中的「我学到什么」段 + 审阅报告；准备各自讲解部分 |
| 11/11–11/12 | 两次演练；与 TA 约定展示时间 |
| 11/13 | 提交 Final.pdf + Slides.pdf；TA 展示；全员 peer assessment |

## 9. 风险与回退
- **SES sandbox**：production 未批 → 试点邮件仅发团队验证地址，参与者靠站内通知（报告如实说明）；Cognito 50 封/天 → 预建账号 + 分日注册。
- **Docker Desktop 装不上** → Podman/Rancher Desktop；再不行按 §2.7 的无 Docker 回退或在组员的 Mac/Linux 上跑。
- **成本失控**：Budget（不含 credits）告警 + 限流 + MaximumConcurrency + 每日快照 + 实验后 teardown；负载上限 50 VUs。
- **Hot-spot 性能未达标**：先做 1024 MB arm64 + live 快照 + BatchSize 10 共享快照优化；仍不达标则如实报告并说明串行化是设计性质。
- **Windows 下 SAM**：自有 esbuild 产物规避；如 `sam deploy` 仍有问题则用 `aws cloudformation package/deploy`。
- **招募不足**：提前两周；按实际样本报告，不造数据。
- **时间不足的裁剪顺序**：Keycloak（改本地开发 token 发行者并声明）→ Mailpit（日志邮件）→ X-Ray 与 EMF（用内置指标 + Logs Insights）→ 看板次要图表（保留告警）→ REALLOCATE 续作（cap 20 offer/事务，由 sweep 补完）→ 组织成员邀请 → 本地参照只跑 10/25 VUs → 机制对照只做仿真不做真机重放。**不裁**：核心测试、幂等、定时器+sweep、访问控制、k6、成本记录、CSV 导出、用户研究、报告与演示。

## 10. 验证（如何确认计划完成）
- 代码：CI 全绿；`pnpm -r test` 含属性测试；dev stack Smoke 通过；`verify` 在所有实验后无违例；DLQ 为 0；`SweepLateExpiries` 为 0。
- 实验：`results/` 下 Table 3 每项有 `summary.md`，写明目标/实测/结论；报告中每个数字可定位到文件。
- 用户研究/试点：CSV 原始记录 + `analysis.py` 输出；样本量如实。
- 报告：`build.ps1` 断言 ≤ 10 页、0 overfull、0 undefined ref、占位符零命中；含 Code Explanation 与可访问 URL；AI 声明真实。
- 演示：两次计时演练 ≤ 15 min；备用录屏存在；每位成员能讲自己的部分并回答 Q&A 预案。

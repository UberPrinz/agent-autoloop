# 插件错误路径归类

扫描入口：`rg -n 'throw new Error' plugins`。逐条核对抛出点及入口 catch；以下行号对应最终审查版本。分类仅用于审计，不扩大修改范围。

- 没事可做：GitLab 执行前准入不满足、手动扫描准入不满足已改为正常返回；飞书请求沿用此结论并生成原因通知。已合并、关闭、旧版本及已发布等原有正常结局保持不变。
- 临时：CLI 明确的网络、代理、DNS、超时、5xx、429，以及中台 fetch 的对应原因；3.3 仅为两个扫描入口改变调度行为，review 仍保留失败重试。
- 需要本人：登录、权限、身份失效；发布结果未知及发布期间权限变化仍保留既有安全边界，不自动冒充完成。发布期间准入变化的既有测试预期不修改。
- bug：参数、可信配置、协议/数据格式、完整性和输出契约错误，保留原始脱敏原因，不冒充临时网络故障。

GitHub source 的验签错误由 HTTP 层拒绝，Webhook / 飞书 channel 错误由通道层报告失败，并非 review 进程的退出码路径；仍列出，避免漏项。其他 delivery / ACP 的调度行为不在本任务修改范围。动态 HTTP / CLI 错误无法仅凭 throw 行确定运行时分类，表中明确按实际原因分支，不能将所有非零退出一律算临时。

最终扫描共 166 个 `throw new Error` 抛出点。两个准入抛出点已删除，分类为“没事可做”；新增 `cliFailure` / `classified` 依明确传输原因返回临时或访问错误，保持程序错误独立。

| 抛出位置 | 原因表达式 | 分类 |
| --- | --- | --- |
| `plugins/acp/bridge.ts:104` | `ACP 没有完成这一轮：${result.stopReason}`) | bug（未完整执行，保留失败） |
| `plugins/acp/bridge.ts:29` | "ACP 要在 command 写启动命令") | bug（程序 / 配置 / 数据契约） |
| `plugins/acp/bridge.ts:93` | `不支持 ACP 版本 ${init.protocolVersion}`) | bug（程序 / 配置 / 数据契约） |
| `plugins/acp/bridge.ts:95` | "这个 ACP Agent 不支持恢复会话") | bug（程序 / 配置 / 数据契约） |
| `plugins/acp/bridge.ts:99` | "ACP 没有返回会话编号") | bug（程序 / 配置 / 数据契约） |
| `plugins/delivery/action.ts:18` | "发布目标要是完整提交编号") | bug（程序 / 配置 / 数据契约） |
| `plugins/delivery/delivery.ts:110` | "只处理本仓库分支到 main 的合并请求") | bug（程序 / 配置 / 数据契约） |
| `plugins/delivery/delivery.ts:115` | "main 的 repo 设置与交付仓库不一致") | bug（程序 / 配置 / 数据契约） |
| `plugins/delivery/delivery.ts:121` | "已请求同步 main，稍后重新审查同步后的提交") | 临时（业务状态待核实，非扫描网络故障） |
| `plugins/delivery/delivery.ts:125` | "审查期间提交变了，等待重新交付") | 临时（业务状态待核实，非扫描网络故障） |
| `plugins/delivery/delivery.ts:136` | "完整检查没有通过") | 需要本人 |
| `plugins/delivery/delivery.ts:138` | "检查期间提交变了") | 临时（业务状态待核实，非扫描网络故障） |
| `plugins/delivery/delivery.ts:142` | "要合并的提交没有经过本轮审查") | bug（程序 / 配置 / 数据契约） |
| `plugins/delivery/delivery.ts:144` | "main 已前进，稍后重新同步和检查") | 临时（业务状态待核实，非扫描网络故障） |
| `plugins/delivery/delivery.ts:154` | "尚未确认合并，稍后继续核实") | 临时（业务状态待核实，非扫描网络故障） |
| `plugins/delivery/delivery.ts:38` | "无法确认自动合并已关闭") | 需要本人 |
| `plugins/delivery/delivery.ts:78` | "已经合并，发布没有通过；修复发布后重交，不要重复提交代码") | 需要本人 |
| `plugins/delivery/github.ts:25` | "仓库要写成 owner/name") | bug（程序 / 配置 / 数据契约） |
| `plugins/delivery/github.ts:41` | "仓库要写成 owner/name") | bug（程序 / 配置 / 数据契约） |
| `plugins/delivery/github.ts:73` | "GitHub 没有接受合并") | 需要本人（核实拒绝原因，不能冒充合并成功） |
| `plugins/delivery/github.ts:97` | "等待超过半小时，保留远端状态，稍后继续核实") | 临时（业务状态待核实，非扫描网络故障） |
| `plugins/delivery/input.ts:11` | "事项编号不正确") | bug（程序 / 配置 / 数据契约） |
| `plugins/delivery/input.ts:8` | "事件没有指向规则指定仓库的同一个事项") | bug（程序 / 配置 / 数据契约） |
| `plugins/delivery/poll.ts:13` | `找不到事项 ${issue.number} 的标签记录`) | bug（程序 / 配置 / 数据契约） |
| `plugins/delivery/project.ts:26` | "ops/delivery.json 的设置不正确") | bug（程序 / 配置 / 数据契约） |
| `plugins/delivery/review.ts:27` | "审查没有交回可读的 findings 列表") | bug（程序 / 配置 / 数据契约） |
| `plugins/delivery/review.ts:82` | "main 上没有审查要点") | bug（程序 / 配置 / 数据契约） |
| `plugins/feishu/agent.ts:9` | "飞书请求命令只接受 scan 或 review 和配置路径") | bug（程序 / 配置 / 数据契约） |
| `plugins/feishu/channel.ts:108` | `lark-cli ${args.slice(0, 3).join(" ")}: ${JSON.stringify(out.error ?? out).slice(0, 300)}`) | 临时 / 需要本人 / bug（依 CLI 原因） |
| `plugins/feishu/channel.ts:113` | "飞书通道要在 config.json 写 user，或者先 lark-cli auth login") | 需要本人 |
| `plugins/feishu/review-runtime.ts:114` | "GitLab 来源密钥为空") | bug（程序 / 配置 / 数据契约） |
| `plugins/feishu/review-runtime.ts:188` | "飞书请求未匹配唯一处理规则；修复后需重新投递未路由事件") | bug（程序 / 配置 / 数据契约） |
| `plugins/feishu/review-runtime.ts:196` | "缺少飞书请求上下文") | bug（程序 / 配置 / 数据契约） |
| `plugins/feishu/review-runtime.ts:198` | "飞书请求上下文无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/feishu/review-runtime.ts:244` | "请提供 scan/review 和配置路径") | bug（程序 / 配置 / 数据契约） |
| `plugins/feishu/review-runtime.ts:24` | "飞书审查配置无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/feishu/review-runtime.ts:29` | "飞书路由名称无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/feishu/review-runtime.ts:31` | "飞书模糊请求配置无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/feishu/review-runtime.ts:44` | "飞书请求编号无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/feishu/review-runtime.ts:49` | "飞书请求记录不一致") | bug（程序 / 配置 / 数据契约） |
| `plugins/feishu/review-runtime.ts:95` | "飞书扫描时间记录无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/feishu/review.ts:80` | "飞书消息读取失败或返回格式不完整") | bug（程序 / 配置 / 数据契约） |
| `plugins/feishu/review.ts:84` | "飞书消息分页未完成") | bug（程序 / 配置 / 数据契约） |
| `plugins/github/source.ts:12` | "signature") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/agent.ts:11` | "GitLab 命令只接受 scan 或 review 和配置路径") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/agent.ts:20` | "模型配置与执行参数不一致") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/api.ts:21` | "接口路径无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/api.ts:46` | "GitLab 限流等待时间无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/api.ts:61` | "GitLab 返回的数据无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/api.ts:69` | "接口路径无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/api.ts:75` | "GitLab 分页无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/api.ts:79` | "GitLab 列表无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/api.ts:86` | "接口路径无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/artifacts.ts:17` | "摘要无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/artifacts.ts:19` | "文件内容与摘要不符") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/artifacts.ts:22` | "文件版本无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/codex.ts:121` | "Codex 审查结果无法保存审计记录") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/codex.ts:123` | `Codex 审查结果无效或未完成${issue ? `：${issue}` : ""}，诊断保存在 ${directory}`) | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/codex.ts:2` | "模型配置无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/config.ts:103` | "GitLab 不再支持 skill/skillPath/rules；请在 rules.prompt 指定审查要求") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/config.ts:112` | "项目配置无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/config.ts:119` | "checks 模式需要非空且不重复的 ciJobs，ciBridges 也不得重复") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/config.ts:121` | "ciJobs/ciBridges 只用于 checks 模式") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/config.ts:128` | "项目路径无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/config.ts:133` | "可信分支无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/config.ts:33` | "配置不符合要求") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/config.ts:36` | "GitLab 不再支持 skill/skillPath/rules；请在 rules.prompt 指定审查要求") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/config.ts:38` | "配置目录必须是绝对路径") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/config.ts:45` | "程序名称无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/config.ts:80` | "配置不符合要求") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/config.ts:86` | "地址无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/config.ts:99` | "地址不符合要求") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/instructions.ts:13` | `项目 ${projectId} 必须恰好匹配一条审查规则`) | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/instructions.ts:15` | `项目 ${projectId} 禁用 rule.skill，请在 prompt 指定 Skill`) | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/instructions.ts:25` | `项目 ${projectId} 的审查规则与 GitLab 配置不一致`) | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/instructions.ts:27` | `项目 ${projectId} 的审查规则必须填写 prompt`) | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/instructions.ts:60` | "运行规则缺少可信审查 prompt") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/manual.ts:11` | "MR 地址不属于配置项目") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/manual.ts:13` | "MR 地址不属于配置项目") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/manual.ts:15` | "MR 编号无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/native.ts:124` | "Skill 目录信息无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/poll.ts:141` | "中台回执无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/poll.ts:144` | "项目规则未路由") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/poll.ts:153` | "MR 编号无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/poll.ts:179` | "MR 不属于配置实例或项目") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/poll.ts:181` | errors.join("；")) | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/poll.ts:21` | "请提供配置文件路径") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/poll.ts:32` | "覆盖项无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/poll.ts:35` | "参数无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/poll.ts:38` | "覆盖条件需要目标和原因") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/poll.ts:3` | "项目编号无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/poll.ts:42` | "GitLab 登录身份与配置不符") | 需要本人 |
| `plugins/gitlab/poll.ts:44` | "来源密钥为空") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/presentation.ts:31` | "完整报告超出飞书可展示的容量，未创建发布确认，也未发布评论。") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/publish.ts:41` | "发送记录无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/publish.ts:51` | "远端记录无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/publish.ts:61` | "远端记录无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/report.ts:42` | "报告超过大小限制") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/report.ts:59` | "报告格式不符合要求") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/request.ts:110` | "请求观察序号冲突") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/request.ts:24` | "观察无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/request.ts:36` | "观察序号无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/request.ts:50` | "请求记录无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/request.ts:64` | "请求记录不可改写") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/request.ts:71` | "请求编号无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/request.ts:91` | "请求记录无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/request.ts:96` | "请求记录文件无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/resume.ts:120` | "缺少可信配置路径") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/resume.ts:134` | "未获发布授权") | 需要本人 |
| `plugins/gitlab/resume.ts:143` | "自动发布清单不能由人工批准") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/resume.ts:145` | "GitLab 登录身份与配置不符") | 需要本人 |
| `plugins/gitlab/resume.ts:157` | "原审查请求记录缺失或不一致") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/resume.ts:227` | "待发布内容无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/resume.ts:233` | "评论内容已变化") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/resume.ts:67` | "报告与确认内容不一致") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/resume.ts:73` | "确认数量与发布清单不一致") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/resume.ts:75` | "报告项目无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/resume.ts:86` | "确认决定无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/resume.ts:87` | "确认决定冲突") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/run.ts:157` | "报告项目身份不一致") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/run.ts:214` | "完整报告超过大小限制") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/run.ts:224` | "审查项目身份已经变化") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/run.ts:246` | "MR 状态或发布权限已变化，保留报告等待重试") | 需要本人 |
| `plugins/gitlab/run.ts:249` | "原审查请求记录缺失") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/run.ts:275` | outcome === "unknown" ? "评论发送结果不明，请本人在 GitLab 核查" : "自动发布未完成") | 临时（业务状态待核实，非扫描网络故障） |
| `plugins/gitlab/run.ts:284` | "评论状态未确认，请本人在 GitLab 核查") | 需要本人 |
| `plugins/gitlab/run.ts:341` | "待发布内容校验失败") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/run.ts:353` | "评论发送结果不明，请本人在 GitLab 核查") | 需要本人 |
| `plugins/gitlab/run.ts:355` | "评论已发出，MR 状态或发布权限已变化，请本人处理") | 需要本人 |
| `plugins/gitlab/run.ts:370` | "评论发送结果不明，请本人在 GitLab 核查") | 需要本人 |
| `plugins/gitlab/run.ts:371` | "评论已发出，MR 状态或发布权限已变化，请本人处理") | 需要本人 |
| `plugins/gitlab/run.ts:376` | "自动发布未完成") | 临时（业务状态待核实，非扫描网络故障） |
| `plugins/gitlab/run.ts:52` | "请提供配置和模型") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/run.ts:54` | "模型配置与执行参数不一致") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/run.ts:57` | "缺少运行上下文") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/run.ts:59` | "运行上下文无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/run.ts:88` | "请求资料无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/run.ts:92` | "请求项目或事项不一致") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/run.ts:97` | "GitLab 登录身份与配置不符") | 需要本人 |
| `plugins/gitlab/scan.ts:26` | "项目路径无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/scan.ts:29` | "MR 编号无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/scan.ts:65` | "项目规则未路由，需修复后重新投递") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/scan.ts:90` | "中台回执无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/scan.ts:93` | "项目规则未路由") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/storage.ts:13` | "无法规范化数据") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/storage.ts:52` | "无效摘要") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/trusted-rules.ts:20` | "可信分支无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/trusted-rules.ts:24` | "可信分支名无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/trusted-rules.ts:37` | "无法读取裸缓存远端") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/trusted-rules.ts:45` | "请配置项目路径") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/trusted-rules.ts:53` | "项目身份与 GitLab 不一致") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/trusted-rules.ts:56` | "裸缓存远端与 GitLab 项目不一致") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/worktree.ts:38` | "审查缓存不是裸仓库") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/worktree.ts:42` | "可信分支无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/worktree.ts:45` | "审查缓存包含过滤器配置") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/worktree.ts:52` | "审查目录不属于本安装") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/worktree.ts:54` | "审查目录归属不匹配") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/worktree.ts:56` | "审查工作树来源不匹配") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/worktree.ts:57` | "专用审查目录缺失，需检查归属") | bug（程序 / 配置 / 数据契约） |
| `plugins/gitlab/worktree.ts:68` | "可信分支提交无效") | bug（程序 / 配置 / 数据契约） |
| `plugins/webhook/templates.ts:15` | `没有这个 Webhook 模板：${platform}`) | bug（程序 / 配置 / 数据契约） |
| `plugins/webhook/templates.ts:20` | `返回 ${response.status}`) | 临时 / 需要本人 / bug（依 HTTP 或服务端错误原因） |
| `plugins/webhook/templates.ts:23` | `发送失败：${result.errmsg ?? result.errcode}`) | 临时 / 需要本人 / bug（依 HTTP 或服务端错误原因） |
| `plugins/webhook/templates.ts:24` | "Slack 没有确认收到消息") | 临时 / 需要本人 / bug（依 HTTP 或服务端错误原因） |
| `plugins/webhook/templates.ts:3` | "Discord 消息超过 2000 个字，请缩短卡片") | bug（程序 / 配置 / 数据契约） |
| `plugins/webhook/templates.ts:4` | "企微消息超过 2048 字节，请缩短卡片") | bug（程序 / 配置 / 数据契约） |

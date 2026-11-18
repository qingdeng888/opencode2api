# opencode2api

[English](README.md) | [简体中文](README.zh-CN.md) | [Tiếng Việt](README.vi.md) | [Italiano](README.it.md)

使用 Go 编写的 OpenCode Zen / Zen Go 网关。客户端调用 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages，网关选择可用上游，并在原生协议不同时转换请求和响应。System One 决策使用独立透传接口。

管理 WebUI 内嵌于可执行文件，运行时无需 Node.js 或数据库。模型发现、推理、OAuth 和可选 WARP 仍需访问相应上游服务。

## 赞助商

<table>
  <tr>
    <td width="190" align="center">
      <a href="https://www.ipwo.net/?ref=githubopencode2api">
        <img src="assets/IPWO.png" width="163" alt="IPWO">
      </a>
    </td>
    <td>
      <a href="https://www.ipwo.net/?ref=githubopencode2api">IPWO</a> 住宅代理为 AI 开发与 API 工作流提供灵活的网络连接支持，覆盖 195+ 个国家和地区，支持 HTTP(S) 与 SOCKS5 协议。<br>
      适用于跨地区网络测试、合规数据采集及自动化开发场景。提供动态代理、静态代理及不限量代理，支持免费测试和地区选择。优惠折扣码：<b>0200</b>。
    </td>
  </tr>
</table>

## 快速开始

从 [GitHub Releases](https://github.com/qingdeng888/opencode2api/releases) 下载可执行文件，或使用 **Go 1.24 及以上版本**编译：

```bash
git clone https://github.com/qingdeng888/opencode2api.git
cd opencode2api
cp config.example.json config.json
go build -o opencode2api ./cmd/opencode2api
```

启动前编辑 `config.json`：

1. 将 `server_keys` 替换为自己的本地 API Key。
2. 在 `zen_keys` 填入 Zen API Key（推荐），或在 `go_keys` 填入 Go Key。示例关闭匿名通道，且两个上游 Key 数组为空，必须先配置上游凭证才能启动；已保存的 Go OAuth（`go_oauth`）或 Zen OAuth（`zen_oauth`）连接也满足此要求。不支持在凭证全空时先启动服务、再进入 WebUI 完成首次 OAuth 登录。
3. 替换 `webui.password`。示例配置启用了 WebUI，用户名为 `admin`。

**匿名通道可能已被上游重点封堵，优先使用 Zen API Key。** 配置与 WebUI 默认关闭匿名访问；已有配置中明确设置的 `anonymous: true` 不会被自动改为关闭。只有接受免费请求仍可能失败时，才主动开启。

```bash
./opencode2api -config config.json
```

Windows 下使用 `Copy-Item config.example.json config.json` 复制配置，执行 `go build -o opencode2api.exe ./cmd/opencode2api` 编译，再运行 `.\opencode2api.exe -config config.json`。

示例配置的 API 监听 `127.0.0.1:8080`，WebUI 监听 `0.0.0.0:8081`。本机可访问 `http://localhost:8081`。通过网络访问管理界面时，请限制访问范围，并使用 HTTPS 反向代理。

命令行参数：

| 参数          | 默认值        | 用途                  |
| ------------- | ------------- | --------------------- |
| `-config`     | `config.json` | 配置文件路径。        |
| `-listen`     | 未设置        | 覆盖 API 监听地址。   |
| `-web-listen` | 未设置        | 覆盖 WebUI 监听地址。 |

配置所在目录需要可写，以便迁移密码、保存配置和写入模型缓存。

## Docker 与 Compose

已发布镜像：`ghcr.io/qingdeng888/opencode2api`。先按前文准备 `config.json`。需要通过发布端口访问时，容器内部 API/WebUI 应监听 `0.0.0.0:8080`、`0.0.0.0:8081`；访问范围由宿主机端口绑定及必要的 HTTPS 入口限制。

```bash
docker compose up -d
docker compose logs -f
```

Compose **仅在首次启动**从宿主配置初始化 `opencode2api-state` 卷。此后实际配置位于卷中，建议通过 WebUI 修改。需重新导入宿主文件时：

```bash
docker compose cp config.json opencode2api:/var/lib/opencode2api/config.json
docker compose restart
```

覆盖前先备份实际配置与状态。入口脚本以普通用户运行服务，仅在初始化时把示例 API 的准确值 `127.0.0.1:8080` 改为 `0.0.0.0:8080`。Compose 使用只读根文件系统、可写状态卷与 `/tmp` tmpfs。发布端口默认绑定宿主全部接口；仅本机访问时，将 `ports` 改为 `127.0.0.1:8080:8080`、`127.0.0.1:8081:8081`。

| Compose 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `OPENCODE2API_VERSION` | `latest` | 镜像标签；固定版本时指定发行标签。 |
| `OPENCODE2API_PORT` | `8080` | 宿主 API 端口。 |
| `OPENCODE2API_WEBUI_PORT` | `8081` | 宿主管理端口。 |
| `OPENCODE2API_LISTEN` | 未设置 | 显式覆盖容器 API 监听。 |
| `OPENCODE2API_WEBUI_LISTEN` | 未设置 | 显式覆盖容器管理监听。 |

后两项在容器内为 `LISTEN_ADDRESS`、`WEBUI_LISTEN_ADDRESS`，为空时沿用实际配置。更改宿主端口不更改内部监听；更改内部 API 端口还须修改映射及默认检查 8080 的镜像健康检查。`proxyfile` 必须挂载到配置的容器内路径。

需要本地镜像时：

```bash
docker build -t opencode2api:local .
docker volume create opencode2api-state
docker run -d --name opencode2api \
  -p 127.0.0.1:8080:8080 -p 127.0.0.1:8081:8081 \
  -e CONFIG_SEED_PATH=/run/config/opencode2api.json \
  -v "$PWD/config.json:/run/config/opencode2api.json:ro" \
  -v opencode2api-state:/var/lib/opencode2api \
  opencode2api:local
```

WARP 需要向 Cloudflare `2408` 端口发送 UDP，不需要 host 网络或额外网络能力；网络阻断该流量时无法初始化 WARP。

## 调用 API

以下是现有兼容接口。OpenAI 兼容客户端的 Base URL 可填 `http://127.0.0.1:8080/v1`；管理接口位于另一监听端口。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `GET` | `/v1/models` | 当前配置可路由的模型，以及符合条件的轮转别名。 |
| `POST` | `/v1/chat/completions` | Chat Completions，支持 JSON 和 SSE。 |
| `POST` | `/v1/responses` | Responses，支持 JSON 和 SSE。 |
| `POST` | `/v1/messages` | Anthropic Messages，支持 JSON 和 SSE。 |
| `POST` | `/v1/systemone` | 原生 System One 决策透传，不转换协议。 |
| `GET` | `/healthz` | 无需认证的就绪检查与资源摘要。 |

全部 `/v1/*` 接口要求通过 `Authorization: Bearer ...` 或 `x-api-key` 提交已启用的 `server_keys` 值。请求体上限为 32 MiB。推理响应的 `x-request-id` 可用于关联日志。

先查询实际可用的模型 ID：

```bash
curl http://127.0.0.1:8080/v1/models \
  -H 'Authorization: Bearer YOUR_LOCAL_API_KEY'

curl http://127.0.0.1:8080/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_LOCAL_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"MODEL_ID","messages":[{"role":"user","content":"你好"}]}'
```

Responses 与 Anthropic Messages 分别使用以下标准 JSON 请求体，发送到对应接口：

```json
{"model":"MODEL_ID","input":"你好"}
```

协议值仅允许 `chat`、`responses`、`anthropic`。使用不支持的原生协议的模型会从模型列表中隐藏，除非配置了覆盖值。

成本、弃用信息及模型限制来自官方 [OpenCode 元数据地址](https://models.opencode.ai/api.json)，每 24 小时刷新一次。能力目录中的限制优先；元数据中的 `limit.context`、`limit.input` 和 `limit.output` 仅补充缺失字段，通过 `/v1/models` 的 `context_window` / `context_length`、`max_input`、`max_output` 暴露。每个 HTTP 客户端的拉取超时为 30 秒，刷新失败时保留已有数据。升级后继续兼容原有 `.models.dev.json` 缓存文件名，无需删除缓存。

元数据给出价格时，`/v1/models` 的每个条目还会带上 `cost`（每百万 token 的美元价格：`input`、`output`、`cache_read`、`cache_write`，以及 OpenClaw 使用的 `cacheRead` / `cacheWrite`）。推理模型会在 `reasoning_efforts` 和 OpenClaw 读取的 `compat.supportedReasoningEfforts` 中列出可用档位：`minimal` 到 `max`；思考强度为 `auto` 时截止到探测得到的上限。强制或探测得到的档位通过 `default_reasoning_effort` 给出。缓存价格字段会在下一次元数据刷新后出现。

### 匿名通道与回退

启用 `anonymous: true` 后，满足以下任一条件的模型可以进入 Zen 匿名通道：

- 模型 ID 包含 `free`，不区分大小写。
- OpenCode 元数据中的输入、输出成本均为零，且模型未弃用。

这只是网关的路由判断，上游仍可能拒绝或限制请求。匿名请求在上游认证头中使用 `public` 凭证。

路由顺序：

1. 符合条件的模型最多尝试 `performance.max_anonymous_exits` 个可用匿名代理，每个代理一次；每个代理先走 v2 `/inference`，再走 v1 `/zen`。
2. 按 `prefer` 顺序尝试认证通道，仅包含已配置 Key 且可以提供该模型的 Tier。
3. 每个认证 Tier 分别使用 `retry.max_attempts` 预算。

匿名阶段不受 `retry.max_attempts` 截断，但所有阶段共享请求总超时。网络错误、认证失败、限流和服务端错误可以触发出口轮换。请求级 `400`/`413`/`422`（例如 `context_length_exceeded`）会立即结束请求：换出口或换 Tier 都无法改变请求本身。IP 级 abuse `403` 只淘汰当前出口；所有出口都被封时停止扫描，已配置的 Go Key 仍可继续服务。

配置 `models.anonymous_backoff` 后，连续 `threshold` 次匿名失败或所有出口都被 IP 封禁会暂停整条匿名通道 `base_hours`，之后每次再触发翻倍，直到 `max_hours`。单个非滥用 `403` 或 `429` 不会立即熔断，只计入连续失败。暂停期间不取代理、不发任何上游请求（包括模型目录刷新和可用性探测），路由直接落到认证通道。窗口到期后只允许一个请求做半开探测：成功关闭熔断并恢复匿名通道，失败则开启下一个更长的窗口。省略该配置块时熔断关闭。

每个 Tier 使用自己的原生协议编码请求。启用 `performance.first_event_timeout_seconds` 后，会先等待完整的 SSE data 事件再向客户端交付响应；注释心跳不算首事件。首事件前超时或断开会沿用现有 Key / 代理重试预算，交付后不再重放。默认 `0` 关闭，可对接受请求后无事件的上游尝试设置为 `15` 秒。它限制首事件而非首个文本 token，不适用于 System One；轮转别名使用独立的 `rotation.first_output_seconds`。识别到过期的 Responses reasoning 引用时，可执行一次修复重试；指定 Key 的诊断不会执行该重试。

只有匿名通道可用时，`/v1/models` 仅展示符合匿名条件的模型。

免费模型不需要 Zen Key：启用 `anonymous: true` 后由匿名通道提供，已配置的 Key 只作为回退。如果想保留 Key 但只暴露免费模型，设置 `models.free_only: true`：付费模型不再出现在 `/v1/models`，直接请求会被拒绝，轮转别名只保留免费成员；免费模型仍可回退到已配置的 Key。

### 模型上下文窗口（防止上游封禁 IP）

上游封禁的依据是**整段对话的上下文**（模型窗口）超过 200k tokens，而不是单次请求的某个字段。所以网关不从"拦请求"入手，而是把所有模型对外声明的**上下文窗口**统一压到 `models.context_limit`，默认 **160000**：

- **声明（关键）**：`/v1/models` 里每个模型的 `context_window`、`context_length`、`max_input` 以及 `metadata` 里的同名/`max_input` 字段全部按该上限输出，轮转别名同样。客户端（OpenCode、Claude Code、Cline 等）据此规划自己的历史预算并在接近窗口时自动压缩对话——这才是真正控制"模型上下文"的地方。模型自身窗口更小的（例如 128k）保留更小的值：只会往下压，不会往上抬。
- **兜底拒绝**：如果客户端不理会上限、仍把超长历史发上来，网关估算"prompt（含免费通道注入的工具定义，实测预留约 2.7k）+ 回复预算"，超过窗口即本机返回 `413` + `context_length_exceeded`，请求不会发往上游。三个协议（`/v1/chat/completions`、`/v1/responses`、`/v1/messages`）、轮转别名与诊断页共用 `prepareRouteBodies` 这一处校验。
- **压缩回复预算**：prompt 未超但「prompt + max_tokens」超了时，只把回复预算降到剩余空间，请求继续，不整单拒绝。
- **估算偏保守**：ASCII 约 4 字符/token，CJK 等宽字符按 1 字符/token；图片按固定 1600 token 计，不按 base64 长度计（否则普通截图会被误判）。

把窗口调大等于把上限还给客户端，上游会重新暴露在封禁风险里，请只在上游确实接受时调整。设为 `0` 表示使用默认 160000；合法范围 4000–8000000。修改后热生效，无需重启。

### 上游 Key 的启停

WebUI「上游 Key 管理」页可以单独停用某个 Zen / Go Key（行内按钮），也可以勾选后批量启用 / 停用：

- 停用的 Key **保留在 `zen_keys` / `go_keys` 数组中**，备注、代理绑定和顺序都不丢，随时可再启用；只有删除才会真正移除。
- 停用后该 Key 立即从上游池剔除：不再参与轮询、不会计入 `/api/debug/models` 的可选 Key、额度查询也跳过（Go 额度页只查已启用的 Go Key）。仅剩的启用 Key 决定某个 Tier 是否“可用”，因此把某 Tier 的 Key 全部停用后，该 Tier 在模型可用性判断中即视为不可用，请求会转向其他 Tier 或匿名通道。
- 启用状态存放在 `upstream_key_metadata` 的 `disabled` 字段中，按 Key 指纹关联，与 `server_key_metadata` 的做法一致。
- 保护规则：关闭匿名通道时必须至少保留一个启用的上游 Key，否则保存被拒绝并返回提示；开启匿名通道时允许全部停用，此时请求由匿名通道服务。

**注意**：停用与删除都不会让在途请求失败，它们只影响新请求的选路。

### 免费模型 WARP 出口

启用 `warp.enabled` 后，免费通道上的所有免费模型请求——匿名通道、通过 Zen Key 的免费模型回退、免费模型可用性探测，以及匿名模型目录刷新——都改走用户态 Cloudflare WARP 隧道，不再使用任何代理，因此上游看到的是 WARP 出口地址，而不是配置的节点。Go 套餐 Key 与付费模型仍使用原有代理绑定。

隧道运行在网关进程内：注册 WARP 设备，通过 UDP 与 Cloudflare 建立 WireGuard 连接，并在用户态网络栈中终结。它不需要 TUN 设备、root、`NET_ADMIN` 或修改路由表，但宿主机（或容器）必须能向 Cloudflare 端点发送 UDP（端口 `2408`）。注册与 `warp=on` 的 trace 探测在启动时完成；WARP 无法初始化时启动直接失败，不会静默回退到代理。通过 WebUI 启用同样采用失败即拒绝：参数错误会返回错误，旧运行时继续服务。

`warp.pool_size`（1–32，默认 `2`）是**上限**而不是固定数量。第一个出口同步注册、决定服务是否 ready；之后池子在后台预注册上限的一半（至少 1 个），突发流量可以直接拿到预热出口而不用等注册。活跃出口再按并发调整：每个在途请求一个出口，另加一个备用，最多不超过上限；空闲 60 秒的多余出口会被回收。出口第一次收到上游 429 或 403 即被淘汰，由预注册的出口立刻顶上——免费模型请求会持续切换到其他出口，直到用完 `retry.max_attempts` 次才把最后一个 429 返回客户端；被淘汰的出口马上在后台重新注册。注册仍然串行，节流改由 Cloudflare 的 429 / Retry-After 决定，而不是固定间隔。若机房能给出的不同出口网段少于预注册目标，池子会退避而不是无限注册；自动免费模型探测在没有备用出口时跳过，并在一轮探测淘汰出口后停止本轮。`warp.stack` 默认 `ipv6`，可选 `ipv4` 或 `dual`。

上游的免费额度按**出口网段**计算，所以只有替换出口能拿到不同网段时轮换才有意义：IPv6 出口按 `/64` 去重并冷却 30 分钟，IPv4 出口按 `/32`。Cloudflare WARP 的 IPv4 出口通常是同一个共享 NAT 地址，常被其他用户用尽；IPv6 网络栈的出口则由外层 WireGuard 源地址决定。把 `warp.source_ipv6` 设为路由到本机的 IPv6 前缀（通常是 `/64`，`warp.stack` 默认已是 `ipv6`），每个出口就会从该前缀绑定自己的源地址。Linux 下该地址通过 `IPV6_FREEBIND` 绑定（网关已自动设置），或要求地址已分配到网卡。不会预先探测地址族：握手先尝试 IPv6 端点，全部失败时自动回退到 IPv4 端点（此时出口为共享地址）。留空则共用本机默认源地址。某些网络的 WARP 出口池本身已被用尽，此时每个新出口也会返回 429，网关会持续轮换出口，但仍会在尝试次数用尽后返回 429。`/healthz` 会返回 `warp` 状态块；启用 WARP 但没有任何活跃出口时返回 503。只有 WARP 关闭或存在 Go Key 需要代理时，`no_healthy_proxies` 才会阻塞就绪。诊断请求会占用出口，但不会轮换或淘汰它。关闭 WARP 后，免费通道恢复使用代理。

### 官方系统提示词

每个经过整形的免费模型请求都会携带 OpenCode CLI 自身的系统提示词——基础指令、`<env>` 环境块和内置 skill 列表——因为免费层级会校验请求是否具有 agent 形态。v1 `/zen` 使用 1.x 工具名，`/inference` 与 `/zen/go` 使用 2.x 工具名。环境块包含请求的模型、网关工作目录、平台和 UTC 日期。

注入按协议处理：Chat 的系统与 developer 消息会合并为一条位于最前的 `system` 消息；Anthropic 写入 `system`（字符串，或调用方提供块列表时在最前插入文本块）；Responses 写入 `instructions`。如果系统内容中已包含标记 `You are opencode, an interactive CLI tool`，请求会原样通过，因此已经发送官方提示词的客户端不会被重复注入。通过 Zen 或 Go Key 提供的免费模型也会接受同样的整形，只是仍然从对应 Tier 的代理出网。

### 工具整形

每个经过整形的免费模型请求中，网关会把客户端声明的每个具名工具改名为 `clint_<name>`——`A-Za-z0-9_-` 之外的字符替换为 `_`，名称最长 64 字节，冲突时追加 `_2`、`_3` 等后缀——并追加该通道的完整官方工具集：`/zen` 使用 1.x 定义（`bash`、`edit`、`glob`、`grep`、`read`、`skill`、`task`、`todowrite`、`webfetch`、`websearch`、`write`），`/inference` 与 `/zen/go` 使用 13 个工具的 2.x 定义。没有 `tools`、`tools` 为空数组或使用旧版 `functions` 数组的请求同样会补全官方工具集；`tool_choice`、旧版 `function_call` 和工具调用历史会同步改写。Responses 内置工具和 Anthropic 服务端工具保持不变。

响应会恢复为客户端声明的名称，流式与非流式均适用，包括被拆分到多个 Chat 分块中的工具名。如果上游调用了客户端从未声明的官方工具，该名称会原样透传：网关不会重放或隐藏官方工具调用。

### 免费模型可用性

只探测 ID 含 `free`（不区分大小写），或元数据输入、输出价格均为零且未弃用的模型，按模型原生协议发送简短探测请求。先尝试已启用的匿名通道，再尝试一个配置的 Zen Key；启用 `warp.enabled` 时，每条探测通道都改走 WARP 而不是代理，无法取得出口时结果为 `warp_unavailable`，视为不确定。任一通道返回完整有效响应即视为可用，只有所有实际尝试的通道都明确返回模型不存在或已下架时才自动禁用，从模型列表与路由中移除。认证失败、429、超时、网络错误、5xx 和响应格式异常均视为结果不确定，不新增禁用，1 小时后复测。探测不修改生产 Key / 代理的冷却状态，也不计入请求统计，但仍会访问上游并可能消耗免费额度。

System One 使用原生 `noul` 类型询问“1+1 是否等于 2”，不注入聊天或工具字段。模型列表标明 `native_protocol` 和 `supported_endpoints`；仅在配置 Go Key 且有可用模型时展示轮转别名。升级时解除 v1.3.6 旧探测生成的禁用并立即安排复测，避免非法会话 ID 造成的误判继续保留。

周期硬编码：正常模型每 **1 小时**探测，明确失效模型每 **24 小时**复测。已禁用模型到期复测遇到临时错误时，保留原禁用原因并在 24 小时后重试；复测成功自动恢复。也可在 WebUI「免费模型可用性」页立即恢复启用，进入手动控制：保持启用且不再自动探测，也不会被在途或后续探测结果覆盖；如需回到自动探测，在同一页面按「切回自动」，下一轮调度即安排探测。旧版本留下的 `manually_enabled` 记录在启动时自动迁移为手动控制。没有可用 Zen / 匿名通道，或推理协议不支持探测时跳过，不自动禁用。

手动控制也会暂停 `reasoning.effort=auto` 的档位探测；已验证档位超过 2 小时后不再强制下发。切回自动后可重新探测档位。

状态保存在 `config.json.<上游地址指纹>.availability.json`，重启后保留，按 Zen 上游 URL 隔离。后台每分钟检查到期项，跳过手动控制的模型，串行探测其余模型，每条通道最多等待 60 秒。

管理接口：`GET /api/models/availability` 查看状态；`POST /api/models/probe` 将所有自动探测的免费模型标记为到期并立即开始一轮探测，WebUI「刷新状态」按钮即调用它（真正的重新探测，而不是只重载缓存视图）；`POST /api/models/restore` 携带 `{"model":"MODEL_ID"}` 恢复并进入手动控制；`POST /api/models/manual` 携带 `{"model":"MODEL_ID","manual":true|false}` 在手动与自动之间切换。均需管理登录，写入接口还需 CSRF 校验。

### 会话与代理

Key 初始化时均衡分配到代理。真实流量可以触发代理检查、Key 重新绑定和失败冷却。已经标记异常的代理，每 15 分钟通过 Cloudflare trace 复查一次。

服务使用稳定会话哈希选择首选 Key 或匿名代理。建议通过 `x-session-id` 区分独立会话，同时支持 `x-opencode-session`、`x-session-affinity`、`session_id`、`conversation-id`、`conversation_id` 请求头，请求体中的 `conversation_id`、`metadata.session_id`，以及 Claude Code `metadata.user_id` 中的会话 ID。

网关自行生成的会话与项目标识按调用方的服务端 Key 隔离，不同 Key 不会共享上游会话、首选 Key 或匿名代理；客户端自带的官方 OpenCode 会话（`ses_…`）原样保留；网关自行派生的会话标识按进程加盐，重启网关后会用新的标识，而不会沿用上一轮进程的上游会话。没有显式会话 ID 时，使用系统提示词和第一条用户消息生成会话标识，因此同一 Key 下系统提示词和开场内容都相同的会话仍可能共享亲和性。需要互相隔离的用户应各自使用独立的服务端 Key。调整 Key 或代理池成员后，原有会话选择的节点可能变化。

失败冷却按指数增长，最高为 `performance.failure_cooldown_seconds` 的八倍；如果上游的 `Retry-After` 更长，则使用更长时间。所有认证 Key 都处于冷却时，路由仍可能尝试最早结束冷却的 Key；仍在冷却的匿名节点会被跳过。

### 会话隔离

上游免费通道按 `ses_*` 会话 ID 保存服务端对话状态（提示缓存、reasoning 引用链）。如果两个并发对话共用同一个上游会话，它们的状态会在上游交错，出现串台。

网关因此为每个下游对话分配独立的上游会话：

- **显式会话 ID 优先**：客户端传入 `x-session-id`（或 `conversation-id` 等，见上）时，网关以「调用方 Key 指纹 + 该 ID」为键映射到一个随机铸造的上游会话。不同调用方即使 ID 相同也不会共用。
- **无会话 ID 时**：以「调用方 Key 指纹 + 首条用户消息指纹」为键。两个用户在同一 Key 下发送完全相同的首条消息时仍会共用上游会话，因此多用户服务务必传会话 ID。
- **官方会话透传**：已经符合 OpenCode 官方格式（`ses_` + descending 时间戳）的 ID 原样转发，保持客户端自己拥有的上游对话与缓存。
- **TTL 与滑动**：映射空闲超过 `session.ttl_seconds`（默认 900 秒）后，下一轮会铸造新的上游会话。对话历史在请求体里，正确性不受影响，只损失一次缓存命中；活跃对话每轮都会刷新窗口。
- **容量上限**：映射表最多保留 10 万个条目，超出时优先淘汰已过期项，再淘汰最久未使用的项。

映射在配置热重载时保留（只有 TTL 会更新），因此保存配置不会打断进行中的对话。管理端「配置中心 → 会话隔离」显示活跃映射数、TTL、铸造/命中/过期计数，`request_routed` 日志同时输出 `session`（上游）与 `client_session`（下游）便于核对一一对应关系。

## 配置参考

完整起始配置见 [config.example.json](config.example.json)。配置支持 `//` 和 `/* ... */` 注释，未知字段和无效取值会被拒绝。

### Key、监听地址与路由

| 字段                        | 默认值或要求                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `listen`                    | `127.0.0.1:8080`。                                                                    |
| `server_keys`               | 至少一个本地 Key。                                                                    |
| `zen_keys`、`go_keys`       | 未启用匿名模式时，至少需要启用一个上游 Key。                                          |
| `upstream_key_metadata`     | 按 Key 指纹记录备注、启停与代理绑定；停用的 Key 保留在数组中但不参与路由。             |
| `anonymous`                 | `false`。                                                                             |
| `warp.enabled`              | `false`；免费通道流量通过 Cloudflare WARP 出口，不使用代理。                          |
| `warp.pool_size`            | `2`；WARP 出口上限（后台预注册一半，活跃出口按并发调整），1–32。                    |
| `warp.stack`                | `ipv6`；可选 `ipv6`、`ipv4`、`dual`。                                                 |
| `warp.source_ipv6`          | 空；每个出口绑定的外层 IPv6 源前缀（`/64`），要求 `stack = "ipv6"`。                  |
| `prefer`                    | `go`；可选 `go`、`zen`。                                                              |
| `upstream.zen`              | `https://opencode.ai/zen`。                                                           |
| `upstream.go`               | `https://opencode.ai/zen/go`。                                                        |
| `upstream.anonymous`        | `https://opencode.ai/inference`；匿名通道优先使用，失败后回退到 `/zen`。             |
| `proxies`                   | 两个代理来源都为空时，使用 `["direct"]`。                                             |
| `proxyfile`                 | 可选；相对路径基于配置文件所在目录解析。                                              |
| `models.refresh_seconds`    | `300`；最小为 1。                                                                     |
| `models.protocols`          | `{}`；按模型 ID 覆盖原生协议。                                                        |
| `models.free_only`          | `false`；即使配置了 Zen / Go Key，也只暴露和路由免费模型。                            |
| `models.context_limit`      | `160000`；所有模型声明的上下文窗口。声明值按它截断，超限请求本地返回 413，避免上游按 200k 阈值封禁 IP。 |
| `models.anonymous_backoff`  | 缺省关闭；`{threshold, base_hours, max_hours}`，默认 6、1、24。                       |
| `session.ttl_seconds`       | `900`（15 分钟）；范围为 60–86400。下游会话到上游会话的映射空闲窗口，见「会话隔离」。 |
| `performance.max_anonymous_exits` | `8`；单个匿名请求最多尝试多少个静态代理出口。 |
| `performance.free_tier_block_seconds` | `900`；被免费层判定滥用的出口在此时间内不再参与匿名轮询。 |
| `reasoning.effort`          | 空（关闭）；可选 `auto`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`none`。 |
| `reasoning.effort_by_model` | `{}`；按模型 ID 覆盖 `reasoning.effort`。                                             |

### 强制思考强度

`reasoning.effort` 在请求自身没有指定思考强度时，指定发往上游的强度；
`reasoning.effort_by_model` 按模型 ID 覆盖它。它对三种协议、两个转换方向都生效，
对跨协议请求尤其重要：Anthropic 的 `thinking.budget_tokens` 只能被 Chat 与
Responses 近似表达，而强制指定的强度可以到达单独靠预算表达不出的档位。

```json
{"model":"MODEL_ID","max_tokens":512,"messages":[{"role":"user","content":"你好"}]}
```

Anthropic 客户端还可发送 `anthropic-version: 2023-06-01`。流式请求添加 `"stream": true`，用 `curl -N` 或能即时消费 SSE 的客户端。HTTP 200 后仍可能发生流错误，需检查错误事件与最终结果。

System One 要求选择 `native_protocol` 为 `systemone` 的模型，例如：

```json
{"model":"SYSTEM_ONE_MODEL_ID","state":"1 + 1 = 2","questions":{"arithmetic":{"type":"noul","instructions":"Is 1 + 1 equal to 2?"}}}
```

网关直接转发决策请求与答案。消息接口也能识别 System One 模型的这种决策结构，但普通聊天内容无法转换成决策问题。上游 System One 流式响应直接透传，不提供流重置恢复。

### 兼容边界

三种消息协议支持文本、可表达的图片/文件内容、reasoning、函数定义、工具调用、工具结果和流式响应。原生请求保留未被网关主动整形的供应商字段；跨协议只转换已有对应表示的内容，例如 Chat `seed` 和 JSON 输出约束不转换为 Anthropic 参数。不支持的内容或工具可能返回校验错误。

Responses 历史中的 assistant reasoning、文本和函数调用会合并为 assistant 轮次；用户消息和工具结果分隔轮次。转换到 Chat Completions 时，缺失或不匹配的工具结果仍会报错。

网关不实现 embeddings、文件上传、图片生成、Responses 检索或取消，也不替客户端保存会话历史。请求需携带所需历史；上游可能提供的有状态功能不代表网关具有本地会话存储。

## 配置与路由

从 [config.example.json](config.example.json) 开始配置。文件支持 `//` 和 `/* ... */` 注释，管理 API 请求体须使用标准 JSON。未知字段、无效值、重复顶层字段及同一 OAuth 方案的新旧字段冲突会被拒绝。保存会规范化配置并去掉注释。

| 配置项 | 默认值 / 含义 |
| --- | --- |
| `server_keys` | 必须保留至少一个启用的本地 Key。 |
| `zen_keys`、`go_keys` | 独立上游 Key 池；示例均为空。 |
| `prefer` | `go`；也可设为 `zen`，决定可用认证通道的首选顺序。 |
| `anonymous` | `false`；为符合条件的免费模型启用上游 `public` 凭证。 |
| `upstream.zen` | 手动 Zen Key 默认使用 `https://opencode.ai/zen`。 |
| `upstream.go` | 手动 Go Key 及其额度接口默认使用 `https://opencode.ai/zen/go`。 |
| `upstream.anonymous` | 匿名通道默认使用 `https://opencode.ai/inference`。 |
| `models.refresh_seconds` | `300`；模型发现间隔。 |
| `models.protocols` | 按模型覆盖原生协议：`chat`、`responses`、`anthropic`、`systemone`。 |
| `models.free_only` | `false`；发现与路由均仅允许免费模型。 |
| `models.active_probes` | `false`；可选的免费模型合成推理探测。 |
| `reasoning.effort` | 内置默认未设置；示例设为 `high`。 |
| `reasoning.effort_by_model` | 按模型覆盖默认思考强度。 |

### 模型与通道选择

模型发现结合上游目录与 `https://models.opencode.ai/api.json` 的 OpenCode 能力和价格目录，按 Tier 保存原生协议，并通过 `/v1/models` 提供已知的上下文/Token 上限、价格、`native_protocol`、`supported_endpoints` 与 reasoning 信息。价格及弃用元数据每 24 小时刷新，失败保留已有数据；价格元数据不是账单估算或账户余额。

使用手动 Key 时，明确开启匿名后，符合条件的免费模型可先尝试匿名通道，再按 `prefer` 尝试可用 Key 池；匿名关闭时使用已配置 Key。模型 ID 不区分大小写包含 `free`，或元数据表明未弃用且输入/输出价格均为零，即可判为免费，但不保证上游接受。付费模型需要适当的认证通道。`models.free_only` 同时限制轮转组成员。

OAuth 另有规则：请求选择 OAuth 路由后，只使用该 Tier 已确认的路由，不因失败改走匿名、手动 Key 或其他 Tier。Go OAuth 授权失败、额度耗尽或返回 429，均不会触发 PAYG 请求。两类通道都能服务同一模型时，明确选择 `prefer: "zen"` 允许使用已连接的 Zen PAYG 通道。

### 超时、代理与会话亲和

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `retry.max_attempts` | `3` | Key 重试循环预算；匿名与轮转有各自选择规则。 |
| `retry.timeout_seconds` | `300` | 整个推理请求预算，含流式消费。 |
| `performance.attempt_timeout_seconds` | `0` | 可选的较短单次尝试上限；零沿用请求超时。 |
| `performance.first_event_timeout_seconds` | `0` | 可选的首事件等待上限；零关闭。 |
| `performance.connect_timeout_seconds` | `5` | 建立连接超时。 |
| `performance.failure_cooldown_seconds` | `15` | 失败后的基础冷却时间。 |
| `performance.max_anonymous_exits` | 有效值 `8` | 单次匿名请求的不同静态出口上限；零使用内置值。 |
| `performance.free_tier_block_seconds` | 有效值 `900` | 免费通道出口封锁冷却时间；零使用内置值。 |
| `performance.max_idle_conns` | `2048` | 每个 transport 的空闲连接上限。 |
| `performance.max_idle_conns_per_host` | `256` | 每个 host/transport 的空闲连接上限。 |
| `performance.max_conns_per_host` | `0` | 连接数上限；零表示不限。 |
| `performance.idle_conn_timeout_seconds` | `120` | 空闲连接寿命。 |

`proxies` 支持 `direct`、HTTP、HTTPS、SOCKS5、SOCKS5H URL。`proxyfile` 从配置目录相对路径读取，每个非空行一个代理，合并后去重；最终为空时使用直连。行首或空白后的 `#`、`;`、`//` 表示注释。代理 URL 中的账号密码属于敏感信息。

供应商负责轮换出口时，可写成 `pool+https://proxy.example:8443` 或 `https://proxy.example:8443#pool`。每次尝试新建连接，不复用 keep-alive/HTTP/2，也不采用静态节点的冷却和健康淘汰。实际出口轮换由供应商提供。静态代理保留连接复用、健康跟踪与 Key 绑定；`proxy_bindings` 可按 Key 指纹绑定已配置代理。

建议为独立会话发送 `x-session-id`。同时支持 OpenCode 会话头和既有 conversation 字段；未指定时使用初始 system/user 内容生成种子。网关生成的身份按本地 API Key 与进程生命周期隔离，有效的官方 OpenCode 会话 ID 原样保留。同一 Key 下相同开头可能共享亲和性，需要用户隔离时使用独立 Key。

可选 `models.anonymous_backoff` 在连续失败后暂停整个匿名通道，默认阈值 `6` 次、基础 `1` 小时、最大 `24` 小时；不配置此对象则关闭该通道级熔断。

### 免费模型整形与 reasoning

免费模型兼容逻辑会按需注入官方 OpenCode 系统提示词和工具定义，改写线上工具名，并在响应中还原客户端名称。使用 Key 的免费模型也可能经过整形。网关只转发工具调用，不会在本机执行工具；System One 不经过消息/工具整形。

注入提示词包含目录、工作区、平台、模型与 UTC 日期，默认描述网关主机。远程客户端可配置兼容文本：

```json
{"working_directory":"C:\\work\\project","workspace_root":"C:\\work\\project","platform":"windows","is_git_repo":true}
```

将此对象合并到 `upstream.prompt_environment`。目录仅作为文本使用，不会由此访问；`windows` 规范为 `win32`，还支持 `linux`、`darwin`。客户端已提供的官方提示词不被覆盖。界面没有这些高级字段，需编辑配置并重载；任意环境覆盖值尚未经过真实上游校验。

思考强度接受 `minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`none`、`auto` 或空值，客户端明确指定的强度优先。`none` 移除 reasoning 设置。`auto` 仅使用近期为免费 Zen/匿名模型验证的强度上限，不扩大探测范围；自动发现需开启主动探测，可能发送多次消耗额度的请求，结果两小时后过期。Go/付费模型及未验证强度不会被推算。

默认从真实流量学习可用性。只有 `models.active_probes: true` 才执行合成检查；管理端探测按钮仅安排检查，不绕过此开关。只有明确的模型下架/不存在证据才禁用模型，限流、认证失败、普通错误和超时不能证明下架。手动恢复会保持启用并退出自动探测，直到恢复自动控制。

### WARP

`warp.enabled` 默认 `false`。开启后，免费匿名/手动 Zen 流量及其目录/探测路径使用进程内 Cloudflare WARP 隧道；Go、付费及 OAuth 路由继续使用配置的代理。需要向 Cloudflare `2408` 端口发送 UDP，无需 TUN 设备或修改路由表。初始化失败会拒绝启动或候选配置。

`warp.pool_size` 是随并发调整的出口上限，范围 1–32，默认 2。`warp.stack` 为 `ipv6`（默认）、`ipv4` 或 `dual`。替换出口不保证获得新的上游额度。可选 `warp.source_ipv6` 要求 IPv6 堆栈及 `/64` 或更短前缀；Windows 下实际选择的源地址必须已分配到网卡，程序不会配置主机网络。

## 管理与 OAuth

WebUI 包含概览、诊断/Playground/日志、接入、API Key、模型与额度、轮转、配置、账号页面，提供简中、英语、越南语及意大利语。语言与主题选择保存在浏览器。完整操作与端点见[管理指南](docs/management.zh-CN.md)。

管理端使用管理员 Session Cookie、写操作 CSRF 和登录限流；修改管理员凭证会使 Session 失效。本地 API Key 不授予管理权限。`GET /api/config` 隐藏敏感值；再次验证密码后可显示手动 Key/代理值，但不会显示 OAuth Token。

在「模型与额度」启动 Device OAuth。自行打开页面显示的官方验证地址，输入 `user_code`，批准自己发起的请求，并按需选择组织/工作区。后端负责轮询和刷新；不使用粘贴 Token、导入本机凭证文件或提交回调 URL 的流程。

| 连接 | 范围与限制 |
| --- | --- |
| Go OAuth | 仅官方 Go 订阅路由；额度显示未知。 |
| Zen OAuth | 使用 Console 工作区 credits 的 PAYG；开始前必须明确确认，余额显示未知。 |

两类连接的待完成登录、凭证、刷新和断开分别管理。离开/隐藏页面停止自动轮询，返回可继续未过期登录。退出管理 Session 取消该 Session 的待完成登录，保留已完成连接；取消待完成登录不会断开已有账号。

连接以 `go_oauth`、`zen_oauth` 保存于配置，包含访问/刷新凭证，配置与备份均需保护。对应 OAuth 存在期间，手动 Key 保留但不作备用，即使需要重新登录也一样。断开仅删除本地连接，在重新发现后恢复手动路由，不撤销官方 Session。匿名关闭时，断开最后连接前先保留其他凭证。

只接受已认证官方远程配置中通过方案 URL 与 SDK 校验的路由，不从 Go 地址推导 PAYG，也不引入任意远程请求头。普通配置保存保留后端管理的 OAuth 凭证。旧 `go_subscription`/`zen_subscription` 加载时迁移；同一方案同时提供新旧字段会被拒绝。

实现依据管理指南列出的上游源码快照；此处说明代码行为，不代表所有账号的真实授权与推理已通过验证，上游权限和路由格式可能变化。

### 本地 Key、额度与轮转

API Key 页面支持创建、命名、启用、停用、删除。自动 Key 使用 192 位随机数；自定义 Key 为 16–256 位字母、数字、`.`、`_`、`-`，名称 1–80 字符，最多 200 个，至少一个启用。新请求立即使用变更；未实现按 Key 模型权限、消费上限或过期时间。

手动 Go Key 额度来自已配置 Go 上游的 `/v1/usage`，是共享滚动/每周/每月百分比窗口，不是逐模型余额。多个 Key 可能共享同一套餐，不能相加。成功缓存 60 秒、失败 15 秒，旧数据标记历史。OAuth 额度/credits 未知，不根据手动 Key 或成功请求推算。

轮转别名 `sota`、`sweet` 使用 Go 模型，支持三种消息接口和流式输出。每组共享当前模型，成功保持，失败推进。SOTA 固定包含 `deepseek-v4.1-flash`、`glm-5.3`、`grok-4.6`、`kimi-k3`、`qwen3.8-max`；Sweet 收集其他合适的 Go 模型。能否调用以实际发现为准。可在 `/#rotation` 调整别名、顺序和首输出超时。

普通错误预算为三个模型、每模型最多三次；额度/限流直接跳过，轮换不产生额外共享额度。流式内容提交后，错误结束当前答案并让下一请求使用后续模型。响应 `model` 保留请求别名，`X-Resolved-Model` 标记实际模型。状态保存于配置旁。

## 运行与安全

配置保存先校验并构建替代运行时，校验或持久化失败保留当前运行时。Key、代理、路由、模型与日志设置对新请求生效；监听地址和 WebUI 开关需要重启。手动编辑文件后执行 UI 重载或 `POST /api/config/reload`，没有自动文件监视器。

| 数据 | 存储位置 |
| --- | --- |
| 配置及上一版本 | `config.json`、`config.json.bak`。 |
| 模型及元数据缓存 | `config.json.models.catalog.json`、`config.json.models.dev.json`。 |
| 可用性及轮转 | `config.json.<upstream-fingerprint>.availability.json`、`config.json.rotation.json`。 |
| Session、用量、近期请求/尝试、日志环形缓冲、最近 Playground 结果 | 内存，进程重启清空。 |
| 结构化日志 | stdout JSON，需外部收集才能长期保存。 |

文件名以实际配置路径为前缀。监控保留跨热重载数据，不跨进程共享；Token 只统计上游报告值，不估算缺失用量。完整请求结果与收到响应头为止的尝试指标是不同口径。Playground 用量单独归类。最近一小时最多保留 10,000 请求/20,000 尝试，接口各返回最多 500 条。

`GET /healthz` 不发送上游请求、无需 Key。目录未就绪/为空、WARP 不可用或必要代理全部不健康时返回 503。可用但过期目录可返回 200 及 `status: "degraded"`；过期阈值为两倍刷新间隔，最低 60 秒。就绪不保证 Key 有效、额度充足或推理成功；公开响应只含计数与状态，不含凭证或代理地址。

本地使用将 API 与管理监听在 loopback。网络访问须使用 HTTPS 并限制管理入口；可信反向代理应正确设置 `X-Forwarded-Proto`。限流使用直连对端地址，同一反向代理后的客户端共享限制。可执行文件本身提供 HTTP。

配置和备份包含上游 Key、代理密码、OAuth Token，密码哈希不加密这些内容。限制文件权限，Windows 使用 ACL，分享源码时排除运行文件。`logging.dump_request_bodies` 默认关闭且需 debug 才输出，即使截断与脱敏仍可能暴露对话内容。Playground 和主动可用性探测会发送真实上游请求，可能消耗额度或 credits。

## 本地开发与核对

`cmd/opencode2api` 启动服务；`internal/admin` 负责管理，`gateway` 负责路由/运行时，`protocol` 负责 JSON/SSE 转换，`models` 负责发现，`oauth` 负责官方授权，`config` 负责校验/持久化，`telemetry` 负责监控/日志。静态资源位于 `webui`，无需安装前端依赖。

常规开发环境可运行以下原生 Go 命令；需要工作区内缓存时，将 `GOCACHE`、`GOMODCACHE` 设为项目内持久目录：

```bash
go vet ./...
go build -trimpath -o opencode2api ./cmd/opencode2api
```

Node.js 仅用于可选的 JavaScript 语法核对，无需安装包。在 Bash 执行，Windows 可用 Git Bash：

```bash
for file in webui/js/*.js webui/js/pages/*.js; do
  node --input-type=module --check < "$file" || exit 1
done
```

在 Bash 中执行以上命令（Windows 可用 Git Bash）。部署前检查见[验证与维护](docs/management.zh-CN.md#验证与维护)。发行版本可通过 `-ldflags "-X main.version=vX.Y.Z"` 注入。

| 现象 | 核对内容 |
| --- | --- |
| API 401 | 本地 Key、启用状态与请求头。 |
| 启动提示缺少凭证 | 配置上游 Key/已有 OAuth，或明确启用匿名。 |
| 无模型 / health 503 | 目录状态、原生协议支持、凭证配置和资源可用性。 |
| OAuth 请求失败 | 安全账号状态与重登提示，不会自动转 PAYG。 |
| HTTP 200 但生成失败 | SSE 错误事件、请求结果及 `x-request-id` 日志。 |
| 修改无效 | 保存/重载实际配置；监听变化需重启。 |
| Compose 中宿主配置修改无效 | 实际配置位于状态卷，重新导入或使用 WebUI。 |
| 重启后用量清零 | 计数器仅在内存，日志需另外保存。 |

升级前安全备份程序、配置及状态，停止进程后再替换可执行文件。回退时恢复相互匹配的程序、配置与状态。

## 致谢

感谢 [LINUX DO](https://linux.do) 社区的支持。

## 许可证

SPDX-License-Identifier: GPL-3.0-or-later。完整条款见 [LICENSE](LICENSE)，本软件不提供担保。

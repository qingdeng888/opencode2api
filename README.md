# opencode2api

[English](README.md) | [简体中文](README.zh-CN.md) | [Tiếng Việt](README.vi.md) | [Italiano](README.it.md)

A Go gateway for OpenCode Zen and Zen Go. Clients use OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages; the gateway selects an available upstream and converts the request and response when the native protocol differs. System One decisions have a separate pass-through endpoint.

The executable embeds the management WebUI. Running it requires neither Node.js nor a database. Model discovery, inference, OAuth, and optional WARP still require access to their upstream services.

## Sponsors

<table>
  <tr>
    <td width="190" align="center">
      <a href="https://www.ipwo.net/?ref=githubopencode2api">
        <img src="assets/IPWO.png" width="163" alt="IPWO">
      </a>
    </td>
    <td>
      <a href="https://www.ipwo.net/?ref=githubopencode2api">IPWO</a> residential proxies provide flexible network connectivity for AI development and API workflows, covering 195+ countries and regions with HTTP(S) and SOCKS5 support.<br>
      Suitable for cross-region network testing, compliant data collection, and automated development. Dynamic, static, and unlimited proxy plans are available, with free testing and region selection. Discount code: <b>0200</b>.
    </td>
  </tr>
</table>

## Quick start

Download a binary from [GitHub Releases](https://github.com/qingdeng888/opencode2api/releases), or build with **Go 1.24 or newer**:

```bash
git clone https://github.com/qingdeng888/opencode2api.git
cd opencode2api
cp config.example.json config.json
go build -o opencode2api ./cmd/opencode2api
```

Before starting, edit `config.json`:

1. Replace `server_keys` with your own local API key.
2. Supply a Zen API Key in `zen_keys` (recommended), or a Go key in `go_keys`. The example leaves both arrays empty and disables anonymous access, so configure an upstream credential before starting. An already saved Go OAuth (`go_oauth`) or Zen OAuth (`zen_oauth`) connection also satisfies this requirement; starting from empty credentials solely to open the OAuth WebUI is not supported.
3. Replace `webui.password`. The example enables the WebUI with username `admin`.

**Anonymous traffic may be heavily blocked upstream. Prefer a Zen API Key.** Anonymous access is off by default in the configuration and WebUI; existing configurations that explicitly set `anonymous: true` keep that choice. Enable it deliberately only if you accept that free requests may still fail.

```bash
./opencode2api -config config.json
```

On Windows, use `Copy-Item config.example.json config.json`, build with `go build -o opencode2api.exe ./cmd/opencode2api`, then run `.\opencode2api.exe -config config.json`.

The example listens on `127.0.0.1:8080` for the API and `0.0.0.0:8081` for the WebUI. Open `http://localhost:8081` locally. Restrict management access and use an HTTPS reverse proxy when accessing it over a network.

Command-line options:

| Option        | Default       | Purpose                            |
| ------------- | ------------- | ---------------------------------- |
| `-config`     | `config.json` | Configuration file path.           |
| `-listen`     | Unset         | Override the API listen address.   |
| `-web-listen` | Unset         | Override the WebUI listen address. |

The configuration directory must be writable for password migration, configuration saves, and model caches.

## Docker and Compose

The published image is `ghcr.io/qingdeng888/opencode2api`. Prepare `config.json` as above before starting. For published container ports, keep the internal API/WebUI listeners on `0.0.0.0:8080` and `0.0.0.0:8081`; restrict access using host-side port bindings and HTTPS where needed.

```bash
docker compose up -d
docker compose logs -f
```

Compose seeds `opencode2api-state` from the host configuration **only on first startup**. Later, the active configuration lives in that volume; use the WebUI for changes. To import an edited host file again:

```bash
docker compose cp config.json opencode2api:/var/lib/opencode2api/config.json
docker compose restart
```

Back up the active configuration and state before replacing them. The entrypoint runs the service as an unprivileged user and changes the exact example API listener `127.0.0.1:8080` to `0.0.0.0:8080` only while seeding. Compose uses a read-only root filesystem, a writable state volume, and a `/tmp` tmpfs. Default published ports bind on all host interfaces; edit `ports` to use `127.0.0.1:8080:8080` and `127.0.0.1:8081:8081` for local access only.

| Compose variable | Default | Effect |
| --- | --- | --- |
| `OPENCODE2API_VERSION` | `latest` | Image tag; pin a release tag for a fixed version. |
| `OPENCODE2API_PORT` | `8080` | Published host API port. |
| `OPENCODE2API_WEBUI_PORT` | `8081` | Published host management port. |
| `OPENCODE2API_LISTEN` | Unset | Explicit container API listener override. |
| `OPENCODE2API_WEBUI_LISTEN` | Unset | Explicit container management listener override. |

The last two become `LISTEN_ADDRESS` and `WEBUI_LISTEN_ADDRESS` in the container. Empty values defer to the active config. Changing host ports does not change internal listeners. If the internal API port changes, update both the port mapping and image health check, which uses 8080. A `proxyfile` must be mounted at its configured container path.

Build and run a local image if needed:

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

WARP needs outbound UDP to Cloudflare port `2408`; the image does not need host networking or additional network capabilities. A network that blocks this traffic prevents WARP initialization.

## Call the API

The following are the existing compatibility routes. Set an OpenAI-compatible client's base URL to `http://127.0.0.1:8080/v1`; management uses its separate listener.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/v1/models` | Models routable with the current configuration, including eligible rotation aliases. |
| `POST` | `/v1/chat/completions` | Chat Completions, JSON or SSE. |
| `POST` | `/v1/responses` | Responses, JSON or SSE. |
| `POST` | `/v1/messages` | Anthropic Messages, JSON or SSE. |
| `POST` | `/v1/systemone` | Native System One decisions, without protocol translation. |
| `GET` | `/healthz` | Unauthenticated readiness and resource summary. |

All `/v1/*` routes require an enabled `server_keys` value in `Authorization: Bearer ...` or `x-api-key`. Requests are limited to 32 MiB. Inference responses carry `x-request-id` for log correlation.

Discover the actual model IDs before making a request:

```bash
curl http://127.0.0.1:8080/v1/models \
  -H 'Authorization: Bearer YOUR_LOCAL_API_KEY'

curl http://127.0.0.1:8080/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_LOCAL_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"MODEL_ID","messages":[{"role":"user","content":"Hello"}]}'
```

Use these standard JSON bodies with the corresponding endpoint:

```json
{"model":"MODEL_ID","input":"Hello"}
```

Allowed protocol values are `chat`, `responses`, and `anthropic`. Models using unsupported native protocols are filtered from discovery unless overridden.

Cost, deprecation, and model limits come from the official [OpenCode metadata endpoint](https://models.opencode.ai/api.json), refreshed every 24 hours. OpenCode's capability catalog remains authoritative for context and token limits; metadata `limit.context`, `limit.input`, and `limit.output` fill fields missing from that catalog. These limits are exposed by `/v1/models` as `context_window`/`context_length`, `max_input`, and `max_output` for discovery clients such as CLIProxyAPI and Pi. Metadata requests use a 30-second timeout per HTTP client. Refresh failures retain existing data.

Each `/v1/models` entry also carries `cost` (USD per million tokens: `input`, `output`, `cache_read`, `cache_write`, plus OpenClaw's `cacheRead`/`cacheWrite`) when the metadata states a price. Reasoning models list their levels in `reasoning_efforts` and in OpenClaw's `compat.supportedReasoningEfforts`: `minimal` through `max`, capped at the probed ceiling when the model's effort is `auto`. A forced or probed level is reported as `default_reasoning_effort`. Cache prices appear after the next metadata refresh.

### Anonymous access and fallback

With `anonymous: true`, either condition makes a model eligible for the anonymous Zen lane:

- Its ID contains `free`, case-insensitively.
- OpenCode metadata reports zero input and output cost and the model is not deprecated.

Eligibility is a routing decision; the upstream can still reject or rate-limit the request. Anonymous requests use `public` in the upstream authentication header.

The routing sequence is:

1. For an eligible model, try up to `performance.max_anonymous_exits` available anonymous proxies once each. Every proxy uses the v2 `/inference` lane; the v1 `/zen` fallback is retired for free models and its call site is commented out.
2. Try authenticated tiers in `prefer` order, using only tiers with a configured key and a route for that model.
3. Apply `retry.max_attempts` separately to each authenticated tier.

Anonymous attempts are not cut short by `retry.max_attempts`, but all attempts share the request timeout. Network errors, authentication failures, rate limits, and server errors can rotate exits. A request-level `400`/`413`/`422` (for example `context_length_exceeded`) ends the request immediately: another exit or tier cannot change the request. An IP-level abuse `403` blocks only that exit; if every exit is blocked, the gateway stops walking them, and an authenticated Go key can still serve the request.

When the free tier is blocked for the whole deployment (an IP-level `403` abuse response), retrying only extends the penalty, so an optional lane-level circuit breaker can stop the probing. With `models.anonymous_backoff` configured, `threshold` consecutive failed anonymous attempts or an all-exits IP block pause the whole anonymous lane for `base_hours`, doubling on every further trip up to `max_hours`. A single non-abuse `403` or `429` does not open the breaker; it counts toward the threshold. While paused, requests skip the lane entirely: no proxy is drawn, no upstream request is made, and routing goes straight to the authenticated tiers. Catalog refreshes and availability probes honour the pause as well. When the window expires one request wins the half-open probe; success closes the breaker and restores the free lane, failure opens the next, longer window. The block is absent, and so the breaker stays off, by default.

Requests are encoded for each tier's own protocol. With `performance.first_event_timeout_seconds` enabled, a successful SSE response is held until the first complete data event. A timeout or disconnect before that event uses the existing key/proxy retry budget; comments do not satisfy the timeout. Once released downstream, the stream is never replayed. The default is `0` (disabled); try `15` seconds for upstreams that accept requests but send no events. This bounds the first event, not the first text token, and does not apply to System One. Rotation aliases use their separate `rotation.first_output_seconds` timeout. A recognized stale Responses reasoning reference can trigger one repair pass; selected-key diagnostics never use that replay.

When only anonymous access is configured, `/v1/models` exposes only models eligible for that lane.

Free models never need a Zen key: with `anonymous: true` they are served by the public lane, and a configured key is only their fallback. To keep keys but expose free models only, set `models.free_only: true`. Paid models then disappear from `/v1/models`, direct requests for them are rejected, and rotation aliases keep only free members; free models may still fall back to the configured keys.

### Model context window (protecting the egress IP from a ban)

The upstream bans on the **conversation's context** — the model's context
window — growing past 200k tokens, not on any single request field. So the
gateway does not just police requests: it lowers the **context window every
model advertises** to `models.context_limit`, **160000** by default.

- **Advertised (the part that matters)**: each `/v1/models` entry reports that
  figure in `context_window`, `context_length`, `max_input`, and the same
  fields inside `metadata`; rotation aliases report it too. Clients (OpenCode,
  Claude Code, Cline, …) budget their history against that number and compact
  the conversation before it grows past it — that is what actually bounds the
  model's context. A model whose own window is smaller (128k, say) keeps its
  smaller value: the cap only lowers figures, never raises them.
- **Backstop**: if a client ignores the advertised window and sends a longer
  history anyway, the gateway estimates prompt (including the ~2.7k tokens of
  tool schemas it injects for the free-tier gates) plus the reply budget and,
  when that exceeds the window, answers `413` with `context_length_exceeded`
  without contacting the upstream. All three protocols
  (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`), rotation aliases,
  and the diagnostics page share that one check in `prepareRouteBodies`.
- **Reply budget trimmed**: if the prompt fits but prompt + `max_tokens` does
  not, the completion budget is lowered to the remaining space and the request
  still runs.
- **Conservative estimate**: ASCII is about four characters per token and CJK
  costs roughly one token per character. An image costs a flat 1600 tokens
  rather than its base64 length, which would otherwise reject ordinary
  screenshots.

Raising the window hands the budget back to clients and re-exposes the IP to
the upstream ban; only do it if the upstream accepts it. `0` means the 160000
default, and the accepted range is 4000–8000000. Changes apply on save, without
a restart.

### Enabling and disabling upstream keys

The "upstream keys" page can disable a single Zen/Go key (row button) or a selection in bulk:

- A disabled key **stays in the `zen_keys` / `go_keys` array**, so its note, proxy binding, and position survive; only deletion removes it.
- Disabling takes the key out of the runtime pools immediately: it no longer participates in rotation, disappears from the Playground key list, and is skipped by quota lookups (the Go quota page only queries enabled keys). The enabled keys alone decide whether a tier counts as available, so disabling every key of a tier makes that tier unavailable in model diagnostics and requests fall through to another tier or the anonymous lane.
- The flag lives in `upstream_key_metadata.disabled`, keyed by key fingerprint, mirroring `server_key_metadata`.
- Guard rail: with the anonymous lane off, at least one upstream key must stay enabled; the save is rejected otherwise. With it on, disabling every key is allowed and requests are served anonymously.

Disabling or deleting never fails an in-flight request; both only affect how new requests are routed.

### WARP egress for free models

`warp.enabled` moves every free-model request on a free lane — the anonymous lane, the free-model fallback through a Zen key, free-model availability probes, and the anonymous catalog refresh — onto a userspace Cloudflare WARP tunnel. Those requests use no proxy, so the free tier sees the WARP exit address instead of a configured node. Go-plan keys and paid models keep their proxy bindings.

The tunnel lives inside the gateway process: it registers a WARP device, speaks WireGuard over UDP to Cloudflare, and terminates in a userspace network stack. It needs no TUN device, root, `NET_ADMIN`, or routing-table change, but the host or container must be able to send UDP to Cloudflare's endpoint (port `2408`). Registration and the `warp=on` trace probe run at startup; if WARP cannot initialize, startup fails instead of silently falling back to proxies. Enabling it through the WebUI is also fail-closed: a bad value returns an error and the previous runtime keeps serving.

`warp.pool_size` (1–32, default `2`) is an upper bound, not a fixed count. The first exit registers synchronously and gates readiness; the pool then registers half of the ceiling (at least one) in the background, so a burst finds warm exits instead of waiting for registrations. The active ring follows concurrency: one exit per in-flight lease plus a spare, never more than the maximum. Surplus exits that stay idle for 60 seconds are retired, so a quiet period scales back down. An exit answered with 429 or 403 is retired immediately and a pre-registered exit takes its place — a free-model request keeps switching to another exit and only returns the last 429 to the client once `retry.max_attempts` is spent — and the retired exit is re-registered in the background right away. Registrations are serialized; Cloudflare's 429/Retry-After answer sets the pacing instead of a fixed delay. If the colo hands out fewer distinct egress blocks than the preload, the pool backs off instead of registering forever, and automatic free-model probes skip a pool without a spare exit and stop the sweep after one probe retires an exit. `warp.stack` selects `ipv6` (default), `ipv4`, or `dual`.

The upstream free quota is scoped to the egress block, so rotation only helps when a replacement leaves from a different one: an IPv6 exit is keyed and cooled by its `/64` for 30 minutes, an IPv4 exit by its `/32`. Cloudflare's WARP IPv4 egress is usually one shared NAT address, which other users routinely exhaust; the IPv6 stack gets an egress derived from the outer WireGuard source. Set `warp.source_ipv6` to an IPv6 prefix routed to the host (usually a `/64`), with the default `ipv6` stack to make every exit bind its own source address from that prefix. The prefix needs `IPV6_FREEBIND` on Linux (the gateway sets it) or addresses already assigned to an interface. Endpoint family is not probed in advance: the handshake tries IPv6 endpoints first and falls back to IPv4 ones when none answer (the exit then egresses from the shared address). Leave `source_ipv6` empty to keep the host's default source address. On networks whose WARP egress pool is saturated every fresh exit can still answer 429; the gateway then churns exits without ever surfacing a 429 before the attempt budget is spent. `/healthz` reports a `warp` block and answers 503 while WARP is enabled but no exit is active; `no_healthy_proxies` only blocks readiness when WARP is off or Go keys need proxies. Diagnostics acquire an exit but never rotate or penalize it. Turning WARP off restores proxy routing for the free lanes.

### Official system prompt

Every shaped free-model request carries the OpenCode CLI's own system prompt — its base instructions, the `<env>` block, and the built-in skill listing — because the free tier validates agent-shaped traffic. The v1 `/zen` lane uses the 1.x tool names; `/inference` and `/zen/go` use the 2.x names. The environment block names the requested model, the gateway's working directory, the platform, and a UTC date.

Injection is protocol-aware: Chat system and developer messages are folded into one leading `system` message, Anthropic receives a `system` value (a string, or a leading text block when the caller sent blocks), and Responses receives `instructions`. A body whose system content already contains the marker `You are opencode, an interactive CLI tool` is passed through, so a client that sends the official prompt never gets a second copy. Free models served by a Zen or Go key receive the same shaping even though they still leave through that tier's proxy.

### Tool shaping

On every shaped free-model request the gateway replaces each named client tool with an opaque wire name, `clint_` plus the first 12 hex characters of the client name's SHA-256 (collisions get a `_2`, `_3`, … suffix), and appends the complete official tool set for the lane: the 1.x definitions (`bash`, `edit`, `glob`, `grep`, `read`, `skill`, `task`, `todowrite`, `webfetch`, `websearch`, `write`) on `/zen`, and the 13-tool 2.x set on `/inference` and `/zen/go`. The digest is not cosmetic: the free tier refuses a shaped body that still carries another client's vocabulary — a Claude Code request that declares both `ReportFindings` and `ScheduleWakeup` is answered with `FreeUsageLimitError`, and removing either name lifts the refusal — so no client tool name reaches the wire. Requests without a `tools` array, with an empty one, or with a legacy `functions` array get the same official set; `tool_choice`, legacy `function_call`, and the tool-call history are rewritten to match. Responses built-in tools and Anthropic server tools are left untouched.

Responses are restored to the names the client declared, for streaming and non-streaming replies, including a Chat tool name split across chunks. If the upstream calls an official tool the client never declared, that name passes through unchanged: the gateway does not replay or hide official tool calls.

### Free model availability

The gateway probes models whose IDs contain `free` (case-insensitive), or whose metadata reports zero input/output cost without deprecation, with a short request using its native protocol. It tries the enabled anonymous lane first and then one configured Zen Key. With `warp.enabled`, every probe lane leaves through WARP instead of a proxy; when no exit can be acquired the probe reports `warp_unavailable` and stays inconclusive. A valid completed response on either lane keeps the model enabled; the model is disabled in discovery and routing only when every attempted lane explicitly reports that the model does not exist or has been retired. Authentication errors, rate limits, timeouts, transport errors, 5xx responses, and malformed replies are inconclusive: they do not create a new disable, and are checked again in one hour. Probe traffic does not alter production key/proxy cooldowns or request statistics. It still reaches the upstream and may consume its free allowance.

System One models use a native `noul` question asking whether 1 + 1 equals 2; they are never sent chat/tool payloads. Model discovery includes `native_protocol` and `supported_endpoints`; rotation aliases are listed only when Go keys and eligible models exist. Legacy v1.3.6 disables are cleared on load and scheduled for immediate recheck because those probes used invalid session IDs.

The intervals are fixed: enabled models are checked every **1 hour**, models confirmed unavailable every **24 hours**. An inconclusive due recheck of a disabled model preserves its original disable reason and schedules another retry in 24 hours. A successful recheck restores the model automatically. The WebUI **Free model availability** page can restore it immediately, which puts the model under manual control: it stays enabled and is excluded from automatic probing, so later probe results cannot overwrite it. Use the per-model **manual/automatic toggle** on the same page to return it to automatic probing; the next scheduler pass then schedules a probe. Records left as `manually_enabled` by older versions migrate to manual control on load. An in-flight probe cannot undo a manual restore. Models without a usable Zen/anonymous lane, or without a supported inference protocol, are skipped.

Manual control also pauses effort discovery for `reasoning.effort=auto`; learned levels stop being forced after two hours without verification. Returning to automatic control allows effort discovery to resume.

State survives restarts in `config.json.<upstream-fingerprint>.availability.json`, separated by the Zen upstream URL. The background scheduler checks for due models once per minute, skips manually controlled models, and probes the rest sequentially, with a 60-second timeout per lane. No channels available means no automatic disable.

Administration endpoints (login required; writes also require CSRF): `GET /api/models/availability`, `POST /api/models/probe` (marks every automatic free model due and starts a probe sweep right away, so the WebUI's refresh status button re-probes instead of only reloading the cached view), `POST /api/models/restore` with `{"model":"MODEL_ID"}` (restores and takes manual control), and `POST /api/models/manual` with `{"model":"MODEL_ID","manual":true|false}` to switch between manual and automatic control.

### Sessions and proxies

Keys are initially spread across proxies. Real traffic can trigger proxy checks, key rebinding, and cooldowns. Unhealthy proxies are rechecked every 15 minutes against Cloudflare trace.

A stable session hash selects the preferred key or anonymous proxy. Send an explicit `x-session-id` to separate independent conversations. The gateway also accepts the `x-opencode-session`, `x-session-affinity`, `session_id`, `conversation-id`, and `conversation_id` headers, the `conversation_id` and `metadata.session_id` body fields, and the session ID inside Claude Code's `metadata.user_id`.

Sessions and projects the gateway derives itself are scoped to the caller's server key, so different keys never share an upstream session, preferred key, or anonymous proxy. Official OpenCode sessions (`ses_…`) sent by the client are kept as-is. Derived session ids are salted per process, so restarting the gateway re-mints them instead of resuming the upstream session of the previous run. Without an explicit ID, the system prompt and the first user message are used as a seed. Conversations under the same key that begin with the same system prompt and content can therefore still share affinity; give users who must stay isolated their own server keys. Changing pool membership can change the selected node.

Cooldowns grow exponentially up to eight times `performance.failure_cooldown_seconds`, and a longer `Retry-After` is honored. A configured `models.anonymous_backoff` breaker is a separate lane-level guard: it pauses the whole anonymous lane for hours, while these cooldowns stay per exit and short. If every authenticated key is cooling down, routing may try the key whose cooldown ends first. Anonymous nodes still in cooldown are skipped.

### Session isolation

The upstream free tier keeps server-side conversation state (prompt cache, reasoning reference chains) keyed by the `ses_*` session id. Two concurrent conversations sharing one upstream session interleave that state and cross-contaminate each other's replies.

The gateway therefore gives every downstream conversation its own upstream session:

- **Explicit ids win**: when the client sends `x-session-id` (or any of the accepted alternatives above), the gateway maps "caller key fingerprint + that id" to a freshly minted upstream session. Two callers using the same id never share one.
- **No id**: the key is "caller key fingerprint + fingerprint of the first user message". Two users on the same key who send an identical first message still share an upstream session, so multi-user deployments should always send a session id.
- **Native passthrough**: an id already in OpenCode's own format (`ses_` plus the descending timestamp) is forwarded verbatim, preserving the upstream conversation and cache the client owns.
- **TTL and sliding**: a mapping idle for longer than `session.ttl_seconds` (default 900) is replaced on the next turn. Conversation history travels in the request body, so correctness is unaffected; only one cache hit is lost. Active conversations re-slide the window every turn.
- **Capacity**: the map holds at most 100,000 entries, evicting expired entries first and then the least recently used one.

Mappings survive configuration hot reloads (only the TTL is updated), so saving the configuration never interrupts a live conversation. The config center's "session isolation" panel shows active mappings, TTL, and mint/hit/expiry counters, and `request_routed` logs both `session` (upstream) and `client_session` (downstream) so the one-to-one mapping can be audited.

## Configuration reference

See [config.example.json](config.example.json) for a complete starting configuration. JSON supports `//` and `/* ... */` comments; unknown fields and invalid values are rejected.

### Keys, listeners, and routing

| Field                       | Default / requirement                                                       |
| --------------------------- | --------------------------------------------------------------------------- |
| `listen`                    | `127.0.0.1:8080`.                                                           |
| `server_keys`               | At least one local key is required.                                         |
| `zen_keys`, `go_keys`       | At least one upstream key must be *enabled* unless anonymous access is on.  |
| `upstream_key_metadata`     | Per-key note, enabled flag, and proxy binding, keyed by fingerprint; a disabled key stays in the array but is excluded from routing. |
| `anonymous`                 | `false`.                                                                    |
| `warp.enabled`              | `false`; free-lane traffic leaves through Cloudflare WARP and no proxy.    |
| `warp.pool_size`            | `2`; upper bound on WARP exits (half pre-registered in the background; the active ring follows concurrency), 1–32. |
| `warp.stack`                | `ipv6`; `ipv6`, `ipv4`, or `dual`.                                          |
| `warp.source_ipv6`          | empty; IPv6 prefix (`/64`) each exit binds its outer source from; requires `stack = "ipv6"`. |
| `prefer`                    | `go`; accepts `go` or `zen`.                                                |
| `upstream.zen`              | `https://opencode.ai/zen`.                                                  |
| `upstream.go`               | `https://opencode.ai/zen/go`.                                               |
| `upstream.anonymous`        | `https://opencode.ai/inference`; the only anonymous lane (the retired `/zen` fallback is commented out in `anonymousUpstreams`). |
| `proxies`                   | Falls back to `["direct"]` when both proxy sources are empty.               |
| `proxyfile`                 | Optional; relative paths resolve beside the configuration file.             |
| `models.refresh_seconds`    | `300`; minimum 1.                                                           |
| `models.protocols`          | `{}`; per-model native protocol overrides.                                  |
| `models.free_only`          | `false`; expose and route only free models, even with Zen or Go keys.       |
| `models.context_limit`      | `160000`; the context window declared for every model. Advertised `context_window`/`context_length`/`max_input` are clamped to it so clients compact against it, and a longer request is still rejected locally with 413 before the upstream sees the 200k that bans the IP. |
| `models.anonymous_backoff`  | Absent (off); `{threshold, base_hours, max_hours}`, defaulting to `6`, `1`, `24`. |
| `session.ttl_seconds`       | `900` (15 min); range 60–86400. Idle window of the downstream→upstream session map, see "Session isolation". |
| `performance.max_anonymous_exits` | `8`; how many static proxy exits one anonymous request may walk. |
| `performance.free_tier_block_seconds` | `900`; how long an exit the free tier flagged as abusive stays out of the anonymous cursor. |
| `reasoning.effort`          | Empty (off); `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `none`. |
| `reasoning.effort_by_model` | `{}`; per-model overrides of `reasoning.effort`.                            |

### Forced thinking level

`reasoning.effort` sets the thinking level used upstream when a request does not
state one of its own, and `reasoning.effort_by_model` overrides it for the model
IDs it names. It applies to all three protocols, in either direction of
conversion, and matters most for cross-protocol traffic: an Anthropic
`thinking.budget_tokens` can only be approximated by the Chat and Responses
surfaces, so a forced level reaches a rung that the budget alone cannot express.

```json
{"model":"MODEL_ID","max_tokens":512,"messages":[{"role":"user","content":"Hello"}]}
```

The first body is for Responses, the second for Anthropic Messages. Anthropic clients may also send `anthropic-version: 2023-06-01`. For SSE, add `"stream": true` and use `curl -N` or another client that consumes events as they arrive. A stream can fail after HTTP 200; inspect its error events and final outcome.

System One requires a model whose `native_protocol` is `systemone`, with a decision body such as:

```json
{"model":"SYSTEM_ONE_MODEL_ID","state":"1 + 1 = 2","questions":{"arithmetic":{"type":"noul","instructions":"Is 1 + 1 equal to 2?"}}}
```

It forwards the decision body and answer without conversion. The message endpoints also recognize this decision shape for a System One model; ordinary chat messages cannot be converted into decisions. An upstream System One stream is relayed without stream-reset recovery.

### Compatibility limits

The three message protocols support text, representable image/file content, reasoning, function definitions, tool calls, tool results, and streaming. Native requests preserve provider-specific fields where the gateway does not deliberately shape them. Cross-protocol conversion only carries fields with a supported equivalent; for example, Chat `seed` and JSON output constraints are not translated into Anthropic options. Unsupported content or tools can produce a validation error.

Responses assistant reasoning, text, and function-call items are grouped into assistant turns when converted. User messages and tool results separate turns; incomplete or unmatched tool results remain errors when converting to Chat Completions.

The gateway does not implement embeddings, file uploads, image generation, or Responses retrieval/cancellation. It does not store conversation history for clients. Supply the history in requests; upstream stateful features are not a promise of local session storage.

## Configuration and routing

[config.example.json](config.example.json) is the configuration reference to start from. File input permits `//` and `/* ... */` comments; API request bodies require standard JSON. Unknown fields, invalid values, repeated top-level fields, and conflicting old/new OAuth fields are rejected. Saving normalizes the configuration and removes comments.

| Setting | Default / meaning |
| --- | --- |
| `server_keys` | At least one enabled local key is required. |
| `zen_keys`, `go_keys` | Independent upstream key pools; empty in the example. |
| `prefer` | `go`; selects the preferred available authenticated tier, or `zen`. |
| `anonymous` | `false`; enables the upstream `public` credential for eligible free models. |
| `upstream.zen` | `https://opencode.ai/zen` for manual Zen keys. |
| `upstream.go` | `https://opencode.ai/zen/go` for manual Go keys and their usage endpoint. |
| `upstream.anonymous` | `https://opencode.ai/inference` for anonymous traffic. |
| `models.refresh_seconds` | `300`; model discovery interval. |
| `models.protocols` | Per-model native-protocol overrides: `chat`, `responses`, `anthropic`, or `systemone`. |
| `models.free_only` | `false`; filters both model discovery and routing to free models. |
| `models.active_probes` | `false`; optional synthetic free-model inference probes. |
| `reasoning.effort` | Unset in built-in defaults; the example sets `high`. |
| `reasoning.effort_by_model` | Per-model override of the default effort. |

### Models and upstream selection

Discovery combines upstream model lists with the OpenCode capability and price catalog at `https://models.opencode.ai/api.json`. It tracks native protocols per tier and exposes available context/token limits, prices, `native_protocol`, `supported_endpoints`, and reasoning metadata through `/v1/models`. Price/deprecation metadata refreshes every 24 hours; failed refreshes retain existing data. Prices are metadata, not a billing estimate or account balance.

With manual keys, eligible free models can first use the anonymous lane when explicitly enabled, then the available keyed tiers in `prefer` order. Without anonymous access they use configured keys. Free eligibility comes from a case-insensitive `free` in the model ID or non-deprecated metadata with zero input and output cost; eligibility does not guarantee acceptance upstream. Paid models require an appropriate authenticated route. `models.free_only` also filters members of rotation groups.

OAuth routes follow separate rules: the selected OAuth tier owns the request, uses only its confirmed routes, and does not fall back to anonymous traffic, manual keys, or another tier after failure. Selecting Go OAuth never triggers a PAYG request on authorization failure, quota exhaustion, or 429. When both tiers serve a model, explicitly choosing `prefer: "zen"` permits the connected Zen PAYG route.

### Timeouts, proxies, and affinity

| Setting | Default | Meaning |
| --- | --- | --- |
| `retry.max_attempts` | `3` | Retry budget for keyed loops; anonymous and rotation paths have their own selection rules. |
| `retry.timeout_seconds` | `300` | Whole inference budget, including stream consumption. |
| `performance.attempt_timeout_seconds` | `0` | Optional shorter attempt bound; zero leaves the request timeout. |
| `performance.first_event_timeout_seconds` | `0` | Optional first-event wait; zero disables it. |
| `performance.connect_timeout_seconds` | `5` | Connection establishment timeout. |
| `performance.failure_cooldown_seconds` | `15` | Base cooldown after failures. |
| `performance.max_anonymous_exits` | `8` effective | Maximum distinct static anonymous exits; zero selects this built-in limit. |
| `performance.free_tier_block_seconds` | `900` effective | Free-tier exit block cooldown; zero selects the built-in value. |
| `performance.max_idle_conns` | `2048` | Idle connections per transport. |
| `performance.max_idle_conns_per_host` | `256` | Idle connections per host/transport. |
| `performance.max_conns_per_host` | `0` | Connection cap; zero means unlimited. |
| `performance.idle_conn_timeout_seconds` | `120` | Idle connection lifetime. |

`proxies` accepts `direct`, HTTP, HTTPS, SOCKS5, and SOCKS5H URLs. `proxyfile` adds one proxy per nonempty line, relative to the configuration directory; entries are deduplicated and an empty resolved list means direct access. Line comments start with `#`, `;`, or `//` at the beginning or after whitespace. Credentials embedded in proxy URLs are secrets.

Mark a provider-managed rotating endpoint with `pool+https://proxy.example:8443` or `https://proxy.example:8443#pool`. Each attempt then opens a fresh connection without keep-alive/HTTP/2 reuse; these entries do not use static-node cooldown or health eviction. The provider must actually rotate its exits. Static proxies retain connection reuse, health tracking, and key bindings. `proxy_bindings` can pin a key fingerprint to a configured proxy.

An explicit `x-session-id` provides conversation affinity. OpenCode session headers and supported conversation fields also work; otherwise the initial system/user content supplies a seed. Generated identities are scoped to the local API key and process lifetime. Valid official OpenCode session IDs are preserved. Separate independent conversations with explicit IDs and use separate keys where user isolation is required; identical starts under one key can share affinity.

An optional `models.anonymous_backoff` object pauses the anonymous lane after repeated failures. Its defaults are threshold `6`, base `1` hour, maximum `24` hours. Omitting the object disables this lane-level breaker.

### Free-model request shaping and reasoning

Free-model compatibility can inject the official OpenCode system prompt and tool definitions, rename client tools on the wire, and restore their names in responses. This also affects free models served by keys. The gateway relays tool calls; it does not execute tools on the host. System One is excluded from message/tool shaping.

The injected prompt includes a working directory, workspace, platform, model, and UTC date. By default these describe the gateway host. Set `upstream.prompt_environment` to supply compatibility text for remote clients:

```json
{"working_directory":"C:\\work\\project","workspace_root":"C:\\work\\project","platform":"windows","is_git_repo":true}
```

Merge that object into `upstream.prompt_environment`. Paths are text, not accessed by this setting. `windows` normalizes to `win32`; `linux` and `darwin` are also accepted. A client-supplied official prompt is not replaced. There are no dedicated UI fields for these advanced values; edit the file and reload it. Arbitrary environment overrides have not been verified against upstream validation.

Reasoning accepts `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `none`, `auto`, or an empty value. Explicit client effort takes precedence. `none` removes reasoning settings. `auto` uses a recently validated effort ceiling only for eligible free Zen/anonymous models; it does not expand probe scope. Automatic discovery needs active probes, may make several billable/quota-consuming requests, and expires after two hours. Go/paid models and unverified levels get no inferred override.

Availability is learned from real traffic by default. Synthetic checks run only with `models.active_probes: true`; the management probe action schedules checks but does not override this switch. Explicit model-retired/not-found evidence can disable a model. Rate limits, authentication failures, generic errors, and timeouts do not prove retirement. Manual restore keeps a model enabled and excludes it from automatic probing until automatic control is restored.

### WARP

`warp.enabled` defaults to `false`. When enabled, free anonymous/manual-Zen traffic and their discovery/probe paths use an in-process Cloudflare WARP tunnel. Go traffic, paid traffic, and OAuth routes retain their configured proxy routing. WARP needs outbound UDP to Cloudflare port `2408`; no TUN device or routing-table change is required. Initialization failure rejects startup or the candidate configuration.

`warp.pool_size` is a concurrency-driven exit ceiling from 1 to 32, default 2. `warp.stack` accepts `ipv6` (default), `ipv4`, or `dual`. Replacing an exit does not guarantee a fresh upstream allowance. `warp.source_ipv6` is optional, requires the IPv6 stack and a prefix of `/64` or shorter, and on Windows the selected source addresses must already be assigned to an interface. It does not configure host networking.

## Management and OAuth

The WebUI has overview, diagnostics/Playground/logs, client access, API keys, models/quota, rotation, configuration, and account pages. It supports Simplified Chinese, English, Vietnamese, and Italian; language/theme choices are stored in the browser. See the [management guide](docs/management.md) for endpoint details.

Management authentication uses an administrator session cookie, CSRF tokens for writes, and login throttling. Changing the administrator credentials invalidates sessions. Local API keys do not grant management access. `GET /api/config` masks secrets; password-confirmed reveal can expose manual keys/proxy values, but never OAuth tokens.

Use **Models & Quota** to start a Device OAuth login. Open the displayed official verification URL yourself, enter `user_code`, authorize the request you initiated, and select an organization/workspace if asked. The backend polls and refreshes credentials; there is no token-paste, local credential-file import, or callback-URL workflow.

| Connection | Scope and constraints |
| --- | --- |
| Go OAuth | Official Go subscription routes only; allowance is shown as unknown. |
| Zen OAuth | Console PAYG using workspace credits; explicit acknowledgement is required before starting. Credit balance is shown as unknown. |

Go and Zen pending logins, saved credentials, refresh state, and disconnect actions are separate. Hiding/leaving the page stops automatic polling; returning can resume an unexpired login. Logout cancels that session's pending logins and preserves completed connections. Canceling a pending login does not disconnect an existing account.

Saved connections are `go_oauth` and `zen_oauth` in the configuration and contain access/refresh credentials. Protect the configuration and its backups. Manual keys remain saved but are not fallback routes while the corresponding OAuth connection exists, including when it needs a new login. Disconnect removes only the local connection, restores manual routing after discovery, and does not revoke the official session. Keep another credential before disconnecting the last usable connection with anonymous access disabled.

Only routes from authenticated official remote configuration that pass plan-specific URL and SDK validation are accepted. The gateway does not derive PAYG URLs from Go routes or import arbitrary remote headers. Ordinary config saves preserve backend-managed OAuth credentials. Legacy `go_subscription`/`zen_subscription` fields migrate on load; combining old and new fields for one plan is rejected.

OAuth integration follows the upstream source snapshots listed in the management guide. This documents implementation behavior, not successful live authorization or inference against every account; upstream permissions and route formats can change.

### Local keys, quota, and rotation

The API-key page creates, names, enables, disables, and deletes local keys. Generated keys contain 192 random bits. Custom keys accept 16–256 characters from letters, digits, `.`, `_`, and `-`; names accept 1–80 characters, with at most 200 keys. At least one must remain enabled. New requests observe changes immediately. There are no per-key model permissions, spending limits, or expiry settings.

Manual Go-key quota comes from the configured Go upstream's `/v1/usage`: shared rolling/weekly/monthly percentage windows, not per-model balances. Keys can share the same allowance, so their percentages are not added. Successes cache for 60 seconds, failures for 15; old data is marked stale. OAuth quota/credits are unknown and are never inferred from manual keys or successful requests.

Rotation aliases `sota` and `sweet` use Go models and work with the three message endpoints, including streaming. Each group has a service-wide current model that stays after success and advances on failure. SOTA contains `deepseek-v4.1-flash`, `glm-5.3`, `grok-4.6`, `kimi-k3`, and `qwen3.8-max`; Sweet collects other eligible Go models. Availability follows actual discovery, not the fixed names. Aliases/order and the first-output timeout are editable in `/#rotation`.

The ordinary-error budget is three models with up to three attempts each. Quota/rate-limit failures skip directly to the next model; rotating cannot create extra shared quota. Once stream output is committed, an error ends that answer and advances the group for the next request. Responses keep the requested alias in `model`; `X-Resolved-Model` identifies the actual model. State persists beside the configuration.

## Operations and security

Configuration saves validate and construct a replacement runtime before applying it. Failed validation or persistence keeps the active runtime. Keys, proxies, routing, model settings, and logging apply to new requests; listeners and WebUI enablement require restart. File edits require `POST /api/config/reload` or the UI reload action; there is no automatic file watcher.

| Data | Storage |
| --- | --- |
| Configuration and previous version | `config.json`, `config.json.bak`. |
| Model and metadata caches | `config.json.models.catalog.json`, `config.json.models.dev.json`. |
| Availability and rotation | `config.json.<upstream-fingerprint>.availability.json`, `config.json.rotation.json`. |
| Sessions, usage, recent requests/attempts, log ring, last Playground result | Memory; reset on process restart. |
| Structured logs | JSON on stdout; retention requires an external collector. |

Names use the actual configuration path. Monitoring survives hot reloads but is not shared across processes. Token counts use upstream-reported usage; missing usage is not estimated. Request completion and upstream header-attempt metrics measure different things. Playground has a separate usage bucket. The recent-hour buffers retain at most 10,000 requests/20,000 attempts and return at most 500 of each.

`GET /healthz` makes no upstream request and requires no key. Pending/empty discovery, unavailable WARP, or missing required healthy proxies return 503. A usable stale catalog can return 200 with `status: "degraded"`; stale means older than twice the refresh interval, at least 60 seconds. Readiness is not proof of a valid key, remaining allowance, or successful inference. The public response contains counts/status, not secret values or proxy addresses.

Keep API and management listeners on loopback for local use. For network access, use HTTPS and restrict access to management. A trusted reverse proxy must set `X-Forwarded-Proto` consistently; rate limiting uses the direct peer, so clients behind one proxy share its limits. The executable itself serves HTTP.

Configuration files and backups hold upstream keys, proxy passwords, and OAuth tokens; password hashing does not encrypt them. Restrict filesystem permissions (Windows ACLs when applicable) and exclude runtime files from source sharing. `logging.dump_request_bodies` is off by default and requires debug logging; even redacted, capped body dumps can reveal conversation content. Playground and availability probes send real upstream requests and can consume quota or credits.

## Local development and verification

`cmd/opencode2api` starts the service. `internal/admin` owns management, `gateway` owns routing/runtime, `protocol` handles JSON/SSE conversion, `models` owns discovery, `oauth` owns official authorization, `config` owns validation/persistence, and `telemetry` owns metrics/logging. Static assets live in `webui`; no frontend package installation is required.

The native Go commands for a normal development environment are:

```bash
go vet ./...
go build -trimpath -o opencode2api ./cmd/opencode2api
```

For workspace-local caches, set `GOCACHE` and `GOMODCACHE` to persistent project directories before invoking Go. Node.js is optional for checking JavaScript syntax, without installing packages:

```bash
for file in webui/js/*.js webui/js/pages/*.js; do
  node --input-type=module --check < "$file" || exit 1
done
```

Run these commands in Bash (Git Bash on Windows). See [verification and maintenance](docs/management.md#verification-and-maintenance) for deployment checks. A release version can be injected with `-ldflags "-X main.version=vX.Y.Z"`.

| Symptom | What to inspect |
| --- | --- |
| API 401 | The local key, its enabled state, and the client header. |
| Startup rejects credentials | Configure an upstream key/saved OAuth connection, or deliberately enable anonymous access. |
| No models / health 503 | Discovery status, supported native protocols, configured credentials, and resource availability. |
| OAuth requests fail | Safe connection state and whether reauthorization is required; no automatic PAYG fallback occurs. |
| HTTP 200 but generation fails | SSE error events, request outcome, and `x-request-id` logs. |
| Changes do not apply | Save/reload the active config; restart for listener changes. |
| Host config edits do not affect Compose | The active config is in the state volume; import the file again or use the WebUI. |
| Usage disappears after restart | Counters are in memory; retain structured logs separately. |

Before upgrading, back up the executable, configuration, and state securely. Stop the process before replacing the executable; rollback should restore a matching program/config/state set.

## Acknowledgements

Thanks to the [LINUX DO](https://linux.do) community for its support.

## License

SPDX-License-Identifier: GPL-3.0-or-later. See [LICENSE](LICENSE). The software is provided without warranty.

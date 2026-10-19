package gateway

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"

	"opencode2api/internal/config"
)

// The upstream bans the calling IP once a conversation's context — the model's
// context window — grows past 200k tokens, before the model ever runs. The
// gateway therefore advertises models.context_limit (160k by default) as every
// model's window, so a well-behaved client compacts its history against that
// figure, and additionally refuses a request that still exceeds it. This file
// implements the second half; the advertised window lives in the model catalog
// and /v1/models. The estimate is deliberately conservative: it rounds up, and
// the tool schemas the gateway injects for the upstream gates are budgeted too.
//
// An image is charged a flat estimate rather than the size of its base64
// payload: base64 says nothing about the picture's token cost, and counting it
// as text would reject ordinary screenshot traffic.
const (
	// imageTokenEstimate is the flat charge for one inline or linked image.
	imageTokenEstimate = 1600
	// messageTokenOverhead is the per-message structural cost of the chat
	// envelope (role marker, separators).
	messageTokenOverhead = 4
	// toolTokenOverhead is the per-tool structural cost on top of its schema.
	toolTokenOverhead = 8
	// minOutputTokens is the smallest completion budget still worth sending;
	// a request that leaves less room than this is rejected instead.
	minOutputTokens = 256
)

// contextUsage is the token estimate of one outbound request.
type contextUsage struct {
	// Prompt is the estimated prompt size, including the gateway's injected
	// tool schemas.
	Prompt int
	// Output is the completion budget the request asks for, or 0 when the
	// upstream default applies.
	Output int
	// Limit is the model context window that produced this estimate.
	Limit int
}

// Total is the estimated context the upstream would see: the prompt plus the
// requested completion budget.
func (u contextUsage) Total() int { return u.Prompt + u.Output }

// overLimit reports whether the request would exceed the context window.
func (u contextUsage) overLimit() bool { return u.Limit > 0 && u.Total() > u.Limit }

// estimateJSONTokens approximates the token count of a decoded JSON value.
// Strings are measured with estimateTextTokens, with an inline image charged
// the flat image estimate; numbers, booleans and nulls cost almost nothing.
func estimateJSONTokens(value any) int {
	switch typed := value.(type) {
	case string:
		if isInlineImage(typed) {
			return imageTokenEstimate
		}
		return estimateTextTokens(typed)
	case []any:
		total := 0
		for _, item := range typed {
			total += estimateJSONTokens(item)
		}
		return total
	case map[string]any:
		total := 0
		for _, item := range typed {
			total += estimateJSONTokens(item)
		}
		return total
	default:
		return 0
	}
}

// isInlineImage reports whether value is a data URL carrying media bytes.
func isInlineImage(value string) bool {
	return strings.HasPrefix(value, "data:") && strings.Contains(value, ";base64,")
}

// estimateTextTokens approximates how many tokens text costs. ASCII averages
// about four characters per token, while CJK and other non-ASCII scripts cost
// roughly one token per character. The ASCII divisor is slightly aggressive so
// the estimate errs high, which is the safe direction for a ban threshold.
func estimateTextTokens(text string) int {
	if text == "" {
		return 0
	}
	ascii := 0
	wide := 0
	for _, r := range text {
		if r < utf8.RuneSelf {
			ascii++
			continue
		}
		wide++
	}
	return wide + (ascii+3)/4
}

// injectionReserveTokens is the token cost of the tool definitions the gateway
// adds for the upstream free-tier gates. A request whose own prompt already
// fills the window would otherwise still reach the upstream over the limit
// after injection, so the reserve is subtracted from every budget.
var (
	injectionReserveOnce   sync.Once
	injectionReserveTokens int
)

// injectedToolReserve returns the tokens the gateway may add to an outbound
// body. It measures the embedded v2 tool set, the largest injection, and adds
// a small allowance for the v1 single-tool stub and the stream/usage fields.
func injectedToolReserve() int {
	injectionReserveOnce.Do(func() {
		definitions := map[string]opencodeToolDefinition{}
		if err := json.Unmarshal(opencodeToolsJSON, &definitions); err != nil {
			// An unreadable embedded file means no injection happens; keep a
			// modest reserve so the accounting still holds if it does.
			injectionReserveTokens = 512
			return
		}
		names := make([]string, 0, len(definitions))
		for name := range definitions {
			names = append(names, name)
		}
		// Sort for a deterministic figure across runs.
		sort.Strings(names)
		content := make(map[string]any, len(definitions))
		for _, name := range names {
			definition := definitions[name]
			content[name] = map[string]any{
				"description": definition.Description,
				"parameters":  definition.Parameters,
			}
		}
		injectionReserveTokens = estimateJSONTokens(content) + 256
	})
	return injectionReserveTokens
}

// contextLimit returns the effective context window for this gateway. Config
// validation has already replaced zero with the default.
func (g *Gateway) contextLimit() int {
	limit := g.cfg.Models.ContextLimit
	if limit <= 0 {
		limit = config.DefaultContextLimit
	}
	return limit
}

// estimateContext measures one prepared upstream body against the context
// window. The reserve for injected tool schemas is included in Prompt, so the
// comparison covers what the upstream will actually receive.
func (g *Gateway) estimateContext(payload map[string]any) contextUsage {
	usage := contextUsage{Limit: g.contextLimit()}
	prompt := estimateJSONTokens(payload)
	// Structural overhead the string walk cannot see: one charge per chat
	// message, per Responses input item, and per declared tool.
	for _, field := range []string{"messages", "input"} {
		if items, ok := payload[field].([]any); ok {
			prompt += len(items) * messageTokenOverhead
		}
	}
	if tools, ok := payload["tools"].([]any); ok {
		prompt += len(tools) * toolTokenOverhead
	}
	// Tool schemas the gateway injects for the free-tier gates are not in the
	// body yet; budget them so a request that fills the window on its own
	// cannot overshoot once they are added.
	prompt += injectedToolReserve()
	usage.Prompt = prompt
	usage.Output = completionBudget(payload)
	return usage
}

// completionBudget reads the requested completion size from a prepared body.
// Chat and Anthropic use max_tokens, Responses uses max_output_tokens; the
// priority spellings are the ones the upstream honors.
func completionBudget(payload map[string]any) int {
	for _, field := range []string{"max_completion_tokens", "max_tokens", "max_output_tokens"} {
		if value, ok := numberAt(payload[field]); ok && value > 0 {
			return value
		}
	}
	return 0
}

// numberAt converts a decoded JSON number to an int.
func numberAt(value any) (int, bool) {
	switch typed := value.(type) {
	case float64:
		return int(typed), true
	case int:
		return typed, true
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil {
			return 0, false
		}
		return int(parsed), true
	default:
		return 0, false
	}
}

// clampCompletionBudget lowers the completion budget so the prompt plus the
// reply still fits the window, and returns whether it changed anything. A
// request whose prompt alone leaves no usable room is left untouched so the
// caller can reject it with a clear message instead of silently shrinking the
// answer to nothing.
func clampCompletionBudget(payload map[string]any, usage contextUsage) bool {
	if usage.Limit <= 0 || usage.Output <= 0 {
		return false
	}
	available := usage.Limit - usage.Prompt
	if available < minOutputTokens || usage.Output <= available {
		return false
	}
	for _, field := range []string{"max_completion_tokens", "max_tokens", "max_output_tokens"} {
		if value, ok := numberAt(payload[field]); ok && value > 0 {
			payload[field] = float64(available)
			return true
		}
	}
	return false
}

// contextLimitError reports a request that cannot be served without exceeding
// the model context window even after shrinking the completion budget. It is a
// client error, not an upstream one: the gateway refuses the request instead of
// letting the upstream ban the IP.
type contextLimitError struct {
	usage contextUsage
	model string
}

func (e *contextLimitError) Error() string {
	return fmt.Sprintf(
		"%s has a %d token context window and this conversation is about %d tokens, leaving no room for a reply (at least %d tokens are needed); compact or trim the conversation, or raise models.context_limit if the upstream accepts it",
		e.model, e.usage.Limit, e.usage.Prompt, minOutputTokens)
}

// enforceContext applies the model context window to one prepared upstream body. It
// lowers an oversized completion budget so prompt and reply fit together, and
// rejects a request whose prompt alone already fills the window. The body is
// modified in place when trimming succeeds.
func (g *Gateway) enforceContext(model string, payload map[string]any) error {
	usage := g.estimateContext(payload)
	if usage.Limit <= 0 {
		return nil
	}
	if usage.overLimit() {
		clampCompletionBudget(payload, usage)
		usage = g.estimateContext(payload)
	}
	if usage.Prompt+minOutputTokens > usage.Limit {
		return &contextLimitError{usage: usage, model: model}
	}
	return nil
}

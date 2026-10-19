package gateway

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"opencode2api/internal/config"
	"opencode2api/internal/models"
	wire "opencode2api/internal/protocol"
)

// newContextGateway builds a Gateway with only the fields the context limiter
// reads, so the tests stay free of pools, proxies and network setup.
func newContextGateway(limit int) *Gateway {
	return &Gateway{cfg: config.Config{Models: config.ModelsConfig{ContextLimit: limit}}}
}

func TestEstimateTextTokensCountsWideRunesPerCharacter(t *testing.T) {
	// ASCII is about four characters per token; CJK is roughly one token per
	// character. The estimate must not understate the wide-script case, which
	// is where a byte- or character-based divisor silently overflows.
	if got := estimateTextTokens(strings.Repeat("a", 400)); got != 100 {
		t.Errorf("400 ASCII chars = %d tokens, want 100", got)
	}
	if got := estimateTextTokens(strings.Repeat("汉", 100)); got != 100 {
		t.Errorf("100 CJK chars = %d tokens, want 100", got)
	}
	if got := estimateTextTokens(""); got != 0 {
		t.Errorf("empty text = %d tokens, want 0", got)
	}
}

func TestEstimateJSONTokensChargesImagesOnce(t *testing.T) {
	// A 1 MB base64 image must not be charged a megabyte of tokens: it is one
	// picture. Counting the payload as text rejected ordinary screenshots.
	image := "data:image/png;base64," + strings.Repeat("A", 1_000_000)
	if got := estimateJSONTokens(image); got != imageTokenEstimate {
		t.Errorf("inline image = %d tokens, want the flat %d", got, imageTokenEstimate)
	}
	// The same URL nested in a message still costs only one image charge.
	body := map[string]any{"messages": []any{map[string]any{
		"role": "user",
		"content": []any{
			map[string]any{"type": "text", "text": "what is this?"},
			map[string]any{"type": "image_url", "image_url": map[string]any{"url": image}},
		},
	}}}
	got := estimateJSONTokens(body)
	if got > imageTokenEstimate+64 {
		t.Errorf("body with one image = %d tokens, want about %d", got, imageTokenEstimate)
	}
}

func TestEnforceContextRejectsOversizedPrompt(t *testing.T) {
	g := newContextGateway(198_000)
	// 1,000,000 ASCII characters is roughly 250k tokens before the reserve.
	payload := map[string]any{
		"model":  "test-model",
		"stream": true,
		"messages": []any{map[string]any{
			"role":    "user",
			"content": strings.Repeat("a", 1_000_000),
		}},
	}
	err := g.enforceContext("test-model", payload)
	if err == nil {
		t.Fatal("a 250k-token prompt was accepted under a 198k ceiling")
	}
	var overLimit *contextLimitError
	if !errors.As(err, &overLimit) {
		t.Fatalf("error is %T, want *contextLimitError", err)
	}
	if !strings.Contains(err.Error(), "198000") {
		t.Errorf("error %q does not name the limit", err)
	}
}

func TestEnforceContextAcceptsPromptUnderLimit(t *testing.T) {
	g := newContextGateway(198_000)
	payload := map[string]any{
		"model":      "test-model",
		"max_tokens": float64(4096),
		"messages": []any{map[string]any{
			"role":    "user",
			"content": strings.Repeat("a", 40_000), // ~10k tokens
		}},
	}
	if err := g.enforceContext("test-model", payload); err != nil {
		t.Fatalf("a 10k-token prompt was rejected: %v", err)
	}
	if got := payload["max_tokens"]; got != float64(4096) {
		t.Errorf("max_tokens = %v, want the client's 4096", got)
	}
}

func TestEnforceContextShrinksOversizedCompletionBudget(t *testing.T) {
	g := newContextGateway(10_000)
	// A small prompt with an enormous completion budget would still exceed the
	// ceiling: prompt + reply is what the upstream measures.
	payload := map[string]any{
		"model":      "test-model",
		"max_tokens": float64(1_000_000),
		"messages":   []any{map[string]any{"role": "user", "content": strings.Repeat("a", 4_000)}},
	}
	if err := g.enforceContext("test-model", payload); err != nil {
		t.Fatalf("enforceContext: %v", err)
	}
	budget, ok := numberAt(payload["max_tokens"])
	if !ok || budget <= 0 {
		t.Fatalf("max_tokens = %v, want a positive number", payload["max_tokens"])
	}
	usage := g.estimateContext(payload)
	if usage.Total() > usage.Limit {
		t.Errorf("after clamping, prompt %d + budget %d still exceeds %d", usage.Prompt, usage.Output, usage.Limit)
	}
}

func TestEnforceContextLeavesSmallBudgetAlone(t *testing.T) {
	g := newContextGateway(198_000)
	payload := map[string]any{
		"model":                 "test-model",
		"max_output_tokens":     float64(64),
		"messages":              []any{map[string]any{"role": "user", "content": "hi"}},
		"context_length_exceed": nil,
	}
	if err := g.enforceContext("test-model", payload); err != nil {
		t.Fatalf("enforceContext: %v", err)
	}
	if got := payload["max_output_tokens"]; got != float64(64) {
		t.Errorf("max_output_tokens = %v, want the client's 64", got)
	}
}

func TestEnforceContextDisabledByZeroLimit(t *testing.T) {
	// Config validation replaces zero with the default, but a hand-built
	// Gateway must not reject everything when the field is unset.
	g := &Gateway{cfg: config.Config{}}
	if limit := g.contextLimit(); limit != config.DefaultContextLimit {
		t.Errorf("contextLimit() = %d, want the default %d", limit, config.DefaultContextLimit)
	}
	payload := map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": strings.Repeat("a", 4_000_000)}},
	}
	if err := g.enforceContext("m", payload); err == nil {
		t.Error("a 1M-token prompt was accepted by the default ceiling")
	}
}

func TestCompletionBudgetReadsEveryProtocolSpelling(t *testing.T) {
	cases := []struct {
		body map[string]any
		want int
	}{
		{map[string]any{"max_tokens": float64(10)}, 10},
		{map[string]any{"max_completion_tokens": float64(20), "max_tokens": float64(10)}, 20},
		{map[string]any{"max_output_tokens": float64(30)}, 30},
		{map[string]any{"max_tokens": json.Number("40")}, 40},
		{map[string]any{}, 0},
		{map[string]any{"max_tokens": "not a number"}, 0},
	}
	for i, tc := range cases {
		if got := completionBudget(tc.body); got != tc.want {
			t.Errorf("case %d: completionBudget = %d, want %d", i, got, tc.want)
		}
	}
}

// The gateway injects tool definitions this large on the free-tier lanes; the
// reserve has to account for them or a request at exactly the limit still
// overshoots upstream.
func TestInjectedToolReserveIsNonTrivial(t *testing.T) {
	reserve := injectedToolReserve()
	if reserve < 1_000 {
		t.Errorf("injected tool reserve = %d tokens, suspiciously small for the embedded schema", reserve)
	}
	if reserve > 20_000 {
		t.Errorf("injected tool reserve = %d tokens, unreasonably large", reserve)
	}
}

func TestEstimateContextIncludesInjectedReserve(t *testing.T) {
	g := newContextGateway(198_000)
	payload := map[string]any{"messages": []any{map[string]any{"role": "user", "content": "hi"}}}
	usage := g.estimateContext(payload)
	if usage.Prompt < injectedToolReserve() {
		t.Errorf("prompt estimate %d does not include the %d-token injection reserve", usage.Prompt, injectedToolReserve())
	}
}

// prepareRouteBodies is the single funnel every inference path (direct,
// fallback tier, rotation alias, diagnostic) goes through, so the ceiling must
// be enforced there rather than at one endpoint.
func TestPrepareRouteBodiesRejectsOverLimitPayload(t *testing.T) {
	g := &Gateway{cfg: config.Config{
		Models: config.ModelsConfig{ContextLimit: 20_000},
		Upstream: config.UpstreamConfig{
			Zen: "https://opencode.ai/zen", Go: "https://opencode.ai/zen/go",
			Anonymous: "https://opencode.ai/inference",
		},
	}}
	route := models.Route{ID: "test-model", Tier: config.TierGo, Protocol: wire.Chat}
	payload := map[string]any{
		"model":      "test-model",
		"max_tokens": float64(4096),
		"messages":   []any{map[string]any{"role": "user", "content": strings.Repeat("a", 400_000)}},
	}
	_, err := g.prepareRouteBodies(wire.Chat, route, payload)
	if err == nil {
		t.Fatal("prepareRouteBodies accepted a 100k-token payload under a 20k ceiling")
	}
	var overLimit *contextLimitError
	if !errors.As(err, &overLimit) {
		t.Fatalf("error is %T, want *contextLimitError", err)
	}
}

func TestPrepareRouteBodiesKeepsNormalPayload(t *testing.T) {
	g := &Gateway{cfg: config.Config{
		Models: config.ModelsConfig{ContextLimit: 198_000},
		Upstream: config.UpstreamConfig{
			Zen: "https://opencode.ai/zen", Go: "https://opencode.ai/zen/go",
			Anonymous: "https://opencode.ai/inference",
		},
	}}
	route := models.Route{ID: "test-model", Tier: config.TierGo, Protocol: wire.Chat}
	payload := map[string]any{
		"model":      "test-model",
		"max_tokens": float64(1024),
		"messages":   []any{map[string]any{"role": "user", "content": "hello"}},
	}
	bodies, err := g.prepareRouteBodies(wire.Chat, route, payload)
	if err != nil {
		t.Fatalf("prepareRouteBodies: %v", err)
	}
	if len(bodies[config.TierGo]) == 0 {
		t.Fatal("no body encoded for the go tier")
	}
}

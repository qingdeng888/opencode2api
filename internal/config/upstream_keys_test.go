package config

import (
	"testing"
)

// baseConfig returns a minimal valid configuration with one zen and one go key.
func baseConfig() Config {
	cfg := Config{
		Listen:      "127.0.0.1:8080",
		ServerKeys:  []string{"local-key"},
		ZenKeys:     []string{"zen-a", "zen-b"},
		GoKeys:      []string{"go-a"},
		Anonymous:   true,
		ProxyFile:   "",
		Upstream:    UpstreamConfig{Zen: "https://opencode.ai/zen", Go: "https://opencode.ai/zen/go", Anonymous: "https://opencode.ai/inference"},
		Retry:       RetryConfig{MaxAttempts: 3, TimeoutSeconds: 300},
		Models:      ModelsConfig{RefreshSeconds: 300, Protocols: map[string]string{}},
		Session:     SessionConfig{TTLSeconds: 900},
		Performance: PerformanceConfig{MaxIdleConns: 10, MaxIdleConnsPerHost: 10, MaxConnsPerHost: 0, IdleConnTimeoutSeconds: 10, ConnectTimeoutSeconds: 5, FailureCooldownSeconds: 15},
		Logging:     LoggingConfig{Level: "info", RingSize: 2000},
		WebUI:       WebUIConfig{Enabled: false, SessionTTLMinutes: 720},
		Prefer:      TierGo,
	}
	cfg.Rotation.Defaults()
	return cfg
}

func TestUpstreamKeyEnabledDefaultsToTrue(t *testing.T) {
	cfg := baseConfig()
	if !cfg.UpstreamKeyEnabled("zen-a") {
		t.Error("a key without metadata must be enabled")
	}
	if got := cfg.EnabledZenKeys(); len(got) != 2 {
		t.Errorf("EnabledZenKeys = %v, want both keys", got)
	}
}

func TestEnabledKeysExcludeDisabled(t *testing.T) {
	cfg := baseConfig()
	cfg.UpstreamKeyMetadata = map[string]UpstreamKeyMetadata{
		Fingerprint("zen-a"): {Disabled: true},
		Fingerprint("go-a"):  {Disabled: true},
	}
	if got := cfg.EnabledZenKeys(); len(got) != 1 || got[0] != "zen-b" {
		t.Errorf("EnabledZenKeys = %v, want [zen-b]", got)
	}
	if got := cfg.EnabledGoKeys(); len(got) != 0 {
		t.Errorf("EnabledGoKeys = %v, want empty", got)
	}
	// The raw lists must keep the disabled entries so the operator can
	// re-enable them and their notes/bindings survive.
	if len(cfg.ZenKeys) != 2 || len(cfg.GoKeys) != 1 {
		t.Errorf("raw key lists lost disabled entries: zen=%v go=%v", cfg.ZenKeys, cfg.GoKeys)
	}
}

func TestNormalizeRejectsDisablingLastKeyWithoutAnonymous(t *testing.T) {
	cfg := baseConfig()
	cfg.Anonymous = false
	cfg.ZenKeys = []string{"zen-a"}
	cfg.GoKeys = []string{"go-a"}
	cfg.UpstreamKeyMetadata = map[string]UpstreamKeyMetadata{
		Fingerprint("zen-a"): {Disabled: true},
		Fingerprint("go-a"):  {Disabled: true},
	}
	_, err := Normalize("/tmp/config.json", cfg)
	if err == nil {
		t.Fatal("Normalize accepted disabling every key with anonymous off")
	}
}

func TestNormalizeAllowsDisablingLastKeyWhenAnonymousOn(t *testing.T) {
	cfg := baseConfig()
	cfg.Anonymous = true
	cfg.ZenKeys = []string{"zen-a"}
	cfg.GoKeys = nil
	cfg.UpstreamKeyMetadata = map[string]UpstreamKeyMetadata{
		Fingerprint("zen-a"): {Disabled: true},
	}
	if _, err := Normalize("/tmp/config.json", cfg); err != nil {
		t.Fatalf("Normalize rejected an anonymous-backed configuration: %v", err)
	}
}

func TestDisabledFlagSurvivesClone(t *testing.T) {
	cfg := baseConfig()
	cfg.UpstreamKeyMetadata = map[string]UpstreamKeyMetadata{
		Fingerprint("zen-a"): {Disabled: true, Note: "停用中的主号"},
	}
	clone := Clone(cfg)
	// The clone carries the same enabled state and note.
	if clone.UpstreamKeyEnabled("zen-a") {
		t.Error("clone lost the disabled flag")
	}
	if clone.UpstreamKeyNote("zen-a") != "停用中的主号" {
		t.Error("clone lost the note")
	}
	// The metadata map must be deep-copied: mutating the clone cannot change
	// the original configuration that live requests are served from.
	clone.UpstreamKeyMetadata[Fingerprint("zen-b")] = UpstreamKeyMetadata{Disabled: true}
	if !cfg.UpstreamKeyEnabled("zen-b") {
		t.Error("Clone aliased the metadata map: mutating the clone changed the original")
	}
}

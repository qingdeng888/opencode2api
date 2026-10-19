package config

import "testing"

// A key saved by a build that used the 10-character fingerprint must keep its
// note, disabled flag, and proxy binding after the fingerprint grew to 16.
func TestRemapUpstreamKeyMetadataFromLegacyFingerprint(t *testing.T) {
	const key = "sk-legacy-upstream-key"
	cfg := Config{
		Listen:      "127.0.0.1:8080",
		ServerKeys:  []string{"local"},
		ZenKeys:     []string{key},
		Anonymous:   true,
		Upstream:    UpstreamConfig{Zen: "https://opencode.ai/zen", Go: "https://opencode.ai/zen/go", Anonymous: "https://opencode.ai/inference"},
		Retry:       RetryConfig{MaxAttempts: 3, TimeoutSeconds: 300},
		Models:      ModelsConfig{RefreshSeconds: 300, Protocols: map[string]string{}},
		Session:     SessionConfig{TTLSeconds: 900},
		Performance: PerformanceConfig{MaxIdleConns: 10, MaxIdleConnsPerHost: 10, IdleConnTimeoutSeconds: 10, ConnectTimeoutSeconds: 5, FailureCooldownSeconds: 15},
		Logging:     LoggingConfig{Level: "info", RingSize: 2000},
		WebUI:       WebUIConfig{Enabled: false, SessionTTLMinutes: 720},
		Prefer:      TierGo,
		UpstreamKeyMetadata: map[string]UpstreamKeyMetadata{
			Fingerprint(key)[:10]: {Note: "主号", Disabled: true, ProxyMode: ProxyModeRotate},
		},
	}
	normalized, err := Normalize("config.json", cfg)
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	full := Fingerprint(key)
	if _, legacy := normalized.UpstreamKeyMetadata[full[:10]]; legacy {
		t.Error("legacy 10-char fingerprint survived normalization")
	}
	meta, ok := normalized.UpstreamKeyMetadata[full]
	if !ok {
		t.Fatal("metadata was not remapped to the 16-char fingerprint")
	}
	if meta.Note != "主号" || !meta.Disabled || meta.ProxyMode != ProxyModeRotate {
		t.Errorf("remapped metadata lost fields: %+v", meta)
	}
	// The remapped state must drive routing, not just storage.
	if len(normalized.EnabledZenKeys()) != 0 {
		t.Error("disabled flag lost during remap: the key is enabled again")
	}
}

// The disabled-proxy set is fingerprinted the same way and must migrate too.
func TestRemapDisabledProxiesFromLegacyFingerprint(t *testing.T) {
	const proxy = "http://user:pass@127.0.0.1:7890"
	cfg := Config{
		Listen:      "127.0.0.1:8080",
		ServerKeys:  []string{"local"},
		ZenKeys:     []string{"sk-zen"},
		Anonymous:   true,
		Proxies:     []string{proxy},
		Upstream:    UpstreamConfig{Zen: "https://opencode.ai/zen", Go: "https://opencode.ai/zen/go", Anonymous: "https://opencode.ai/inference"},
		Retry:       RetryConfig{MaxAttempts: 3, TimeoutSeconds: 300},
		Models:      ModelsConfig{RefreshSeconds: 300, Protocols: map[string]string{}},
		Session:     SessionConfig{TTLSeconds: 900},
		Performance: PerformanceConfig{MaxIdleConns: 10, MaxIdleConnsPerHost: 10, IdleConnTimeoutSeconds: 10, ConnectTimeoutSeconds: 5, FailureCooldownSeconds: 15},
		Logging:     LoggingConfig{Level: "info", RingSize: 2000},
		WebUI:       WebUIConfig{Enabled: false, SessionTTLMinutes: 720},
		Prefer:      TierGo,
		DisabledProxies: map[string]bool{
			Fingerprint(proxy)[:10]: true,
		},
	}
	normalized, err := Normalize("config.json", cfg)
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if normalized.ProxyEnabled(proxy) {
		t.Error("disabled proxy became enabled again after the fingerprint length changed")
	}
	if len(normalized.RuntimeProxies()) != 0 && normalized.RuntimeProxies()[0] != "direct" {
		t.Errorf("RuntimeProxies = %v, want the disabled proxy excluded", normalized.RuntimeProxies())
	}
}

// A config that ended up with both spellings (for example after a partially
// migrated save) must merge them instead of dropping the legacy note.
func TestRemapUpstreamKeyMetadataMergesPartialEntries(t *testing.T) {
	const key = "sk-merge-me"
	cfg := Config{
		Listen:      "127.0.0.1:8080",
		ServerKeys:  []string{"local"},
		ZenKeys:     []string{key},
		Anonymous:   true,
		Upstream:    UpstreamConfig{Zen: "https://opencode.ai/zen", Go: "https://opencode.ai/zen/go", Anonymous: "https://opencode.ai/inference"},
		Retry:       RetryConfig{MaxAttempts: 3, TimeoutSeconds: 300},
		Models:      ModelsConfig{RefreshSeconds: 300, Protocols: map[string]string{}},
		Session:     SessionConfig{TTLSeconds: 900},
		Performance: PerformanceConfig{MaxIdleConns: 10, MaxIdleConnsPerHost: 10, IdleConnTimeoutSeconds: 10, ConnectTimeoutSeconds: 5, FailureCooldownSeconds: 15},
		Logging:     LoggingConfig{Level: "info", RingSize: 2000},
		WebUI:       WebUIConfig{Enabled: false, SessionTTLMinutes: 720},
		Prefer:      TierGo,
		UpstreamKeyMetadata: map[string]UpstreamKeyMetadata{
			Fingerprint(key)[:10]: {Note: "旧备注", Disabled: true},
			Fingerprint(key):      {Note: "新备注"},
		},
	}
	normalized, err := Normalize("config.json", cfg)
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	meta := normalized.UpstreamKeyMetadata[Fingerprint(key)]
	if meta.Note != "新备注" {
		t.Errorf("note = %q, want the newer entry to win", meta.Note)
	}
	if !meta.Disabled {
		t.Error("disabled flag from the legacy entry was dropped during merge")
	}
	if _, legacy := normalized.UpstreamKeyMetadata[Fingerprint(key)[:10]]; legacy {
		t.Error("legacy entry survived the merge")
	}
}

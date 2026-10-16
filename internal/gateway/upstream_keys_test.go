package gateway

import (
	"testing"
	"time"

	"opencode2api/internal/config"
)

// Disabled upstream keys must be absent from the runtime pools: the pool is
// the single source of truth for "can this tier serve a request", and every
// routing decision now reads it instead of the raw key lists.
func TestDisabledUpstreamKeysAreExcludedFromPools(t *testing.T) {
	transports := newTestTransportPool(t, "direct", "http://a:1")
	cfg := config.Config{
		ZenKeys: []string{"zen-a", "zen-b", "zen-c"},
		GoKeys:  []string{"go-a"},
		UpstreamKeyMetadata: map[string]config.UpstreamKeyMetadata{
			config.Fingerprint("zen-b"): {Disabled: true},
			config.Fingerprint("go-a"):  {Disabled: true},
		},
	}
	zen, err := newNodePool(cfg.EnabledZenKeys(), transports, time.Second, cfg.UpstreamKeyBinding)
	if err != nil {
		t.Fatalf("zen pool: %v", err)
	}
	if zen.Len() != 2 {
		t.Fatalf("zen pool has %d nodes, want 2 (zen-b is disabled)", zen.Len())
	}
	for _, node := range zen.nodes {
		if node.key == "zen-b" {
			t.Error("disabled key zen-b still built a runtime node")
		}
	}
	// Node indexes are the position inside the enabled pool, so they compact:
	// the admin view must align by fingerprint, which this also asserts is
	// distinct per key.
	statuses := keyStatuses("zen", zen)
	if len(statuses) != 2 {
		t.Fatalf("keyStatuses returned %d entries, want 2", len(statuses))
	}
	seen := map[string]bool{}
	for i, status := range statuses {
		if status.Fingerprint == "" {
			t.Fatalf("status %d has an empty fingerprint; admin views cannot align rows", i)
		}
		if status.Fingerprint == config.Fingerprint("zen-b") {
			t.Error("disabled key still reported in live status")
		}
		if seen[status.Fingerprint] {
			t.Errorf("duplicate fingerprint %q in live status", status.Fingerprint)
		}
		seen[status.Fingerprint] = true
	}

	goPool, err := newNodePool(cfg.EnabledGoKeys(), transports, time.Second, cfg.UpstreamKeyBinding)
	if err != nil {
		t.Fatalf("go pool: %v", err)
	}
	if goPool.Len() != 0 {
		t.Errorf("go pool has %d nodes, want 0 (the only go key is disabled)", goPool.Len())
	}
}

// Re-enabling a key must restore it to the pool without losing its note or
// proxy binding, since those live in the metadata that the disabled flag is
// stored in.
func TestReenablingKeyRestoresNoteAndBinding(t *testing.T) {
	cfg := config.Config{
		ZenKeys: []string{"zen-a"},
		UpstreamKeyMetadata: map[string]config.UpstreamKeyMetadata{
			config.Fingerprint("zen-a"): {
				Disabled: true, Note: "主号", ProxyMode: config.ProxyModeRotate,
			},
		},
	}
	if len(cfg.EnabledZenKeys()) != 0 {
		t.Fatal("disabled key was still enabled")
	}
	meta := cfg.UpstreamKeyMetadata[config.Fingerprint("zen-a")]
	meta.Disabled = false
	cfg.UpstreamKeyMetadata[config.Fingerprint("zen-a")] = meta

	if got := cfg.EnabledZenKeys(); len(got) != 1 || got[0] != "zen-a" {
		t.Fatalf("EnabledZenKeys = %v, want [zen-a]", got)
	}
	if cfg.UpstreamKeyNote("zen-a") != "主号" {
		t.Error("re-enabling lost the note")
	}
	if mode, _ := cfg.UpstreamKeyBinding("zen-a"); mode != config.ProxyModeRotate {
		t.Errorf("re-enabling lost the proxy binding: mode=%q", mode)
	}
}

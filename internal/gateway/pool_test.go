package gateway

import (
	"testing"
	"time"

	"opencode2api/internal/config"
)

// newTestTransportPool builds a pool of N fake proxies without any network
// dialing; only the identity/health of each entry matters for binding tests.
func newTestTransportPool(t *testing.T, names ...string) *transportPool {
	t.Helper()
	perf := config.PerformanceConfig{
		MaxIdleConns: 4, MaxIdleConnsPerHost: 4, MaxConnsPerHost: 0,
		IdleConnTimeoutSeconds: 1, ConnectTimeoutSeconds: 1, FailureCooldownSeconds: 1,
	}
	pool, err := newTransportPool(names, perf, time.Second)
	if err != nil {
		t.Fatalf("newTransportPool: %v", err)
	}
	return pool
}

func TestNodePoolAutoBindingIsRoundRobin(t *testing.T) {
	transports := newTestTransportPool(t, "direct", "http://a:1", "http://b:2")
	pool, err := newNodePool([]string{"k1", "k2", "k3", "k4"}, transports, time.Second, nil)
	if err != nil {
		t.Fatalf("newNodePool: %v", err)
	}
	// auto mode must keep the historical i%N distribution
	want := []int{0, 1, 2, 0}
	for i, node := range pool.nodes {
		if node.proxyMode != "" {
			t.Fatalf("node %d: auto node must have empty proxyMode, got %q", i, node.proxyMode)
		}
		if got := int(node.proxyIndex.Load()); got != want[i] {
			t.Errorf("node %d: proxyIndex = %d, want %d", i, got, want[i])
		}
	}
	if pool.bindingCount[0] != 2 || pool.bindingCount[1] != 1 || pool.bindingCount[2] != 1 {
		t.Errorf("bindingCount = %v, want [2 1 1]", pool.bindingCount)
	}
}

func TestNodePoolBindPinsConfiguredProxy(t *testing.T) {
	transports := newTestTransportPool(t, "direct", "http://a:1", "http://b:2")
	pinnedID := config.Fingerprint("http://b:2")
	binding := func(string) (string, string) { return config.ProxyModeBind, pinnedID }
	pool, err := newNodePool([]string{"k1"}, transports, time.Second, binding)
	if err != nil {
		t.Fatalf("newNodePool: %v", err)
	}
	node := pool.nodes[0]
	if node.proxyMode != config.ProxyModeBind {
		t.Fatalf("proxyMode = %q, want %q", node.proxyMode, config.ProxyModeBind)
	}
	if got := pool.Proxy(node).name; got != "http://b:2" {
		t.Errorf("bound proxy = %q, want http://b:2", got)
	}
	// A pinned key must never be moved by failover or recovery.
	proxy := pool.Proxy(node)
	pool.RebindProxy(proxy.index)
	if got := pool.Proxy(node).name; got != "http://b:2" {
		t.Errorf("after RebindProxy bound proxy = %q, want http://b:2 (pin must not move)", got)
	}
	pool.RestoreProxy(proxy.index)
	if got := pool.Proxy(node).name; got != "http://b:2" {
		t.Errorf("after RestoreProxy bound proxy = %q, want http://b:2", got)
	}
}

func TestNodePoolBindFallsBackToAutoWhenProxyMissing(t *testing.T) {
	transports := newTestTransportPool(t, "direct", "http://a:1")
	binding := func(string) (string, string) { return config.ProxyModeBind, "deadbeef00" }
	pool, err := newNodePool([]string{"k1"}, transports, time.Second, binding)
	if err != nil {
		t.Fatalf("newNodePool: %v", err)
	}
	node := pool.nodes[0]
	if node.proxyMode != "" {
		t.Errorf("proxyMode = %q, want empty auto fallback", node.proxyMode)
	}
	if pool.Proxy(node) == nil {
		t.Fatal("auto fallback must still resolve a proxy")
	}
}

func TestNodePoolRotatePicksDifferentProxiesPerCall(t *testing.T) {
	transports := newTestTransportPool(t, "http://a:1", "http://b:2", "http://c:3")
	binding := func(string) (string, string) { return config.ProxyModeRotate, "" }
	pool, err := newNodePool([]string{"k1"}, transports, time.Second, binding)
	if err != nil {
		t.Fatalf("newNodePool: %v", err)
	}
	node := pool.nodes[0]
	if node.proxyMode != config.ProxyModeRotate {
		t.Fatalf("proxyMode = %q, want %q", node.proxyMode, config.ProxyModeRotate)
	}
	if got := int(node.proxyIndex.Load()); got != -1 {
		t.Errorf("rotate node proxyIndex = %d, want -1 (not statically bound)", got)
	}
	// Consecutive resolutions must walk the pool, proving per-request rotation.
	seen := map[string]int{}
	for i := 0; i < 6; i++ {
		proxy := pool.Proxy(node)
		if proxy == nil {
			t.Fatal("rotate Proxy() returned nil")
		}
		seen[proxy.name]++
	}
	if len(seen) != 3 {
		t.Errorf("rotate visited %d proxies over 6 calls, want 3 (%v)", len(seen), seen)
	}
	// Rotate keys must not be cooled down by a proxy failure.
	if pool.stillBound(node, pool.Proxy(node)) {
		t.Error("rotate node reported as stillBound; proxy failures would cool the key down")
	}
}

func TestNodePoolRotateSkipsUnhealthyProxies(t *testing.T) {
	transports := newTestTransportPool(t, "http://a:1", "http://b:2", "http://c:3")
	transports.items[0].healthy.Store(false)
	transports.items[2].healthy.Store(false)
	binding := func(string) (string, string) { return config.ProxyModeRotate, "" }
	pool, err := newNodePool([]string{"k1"}, transports, time.Second, binding)
	if err != nil {
		t.Fatalf("newNodePool: %v", err)
	}
	node := pool.nodes[0]
	for i := 0; i < 5; i++ {
		if got := pool.Proxy(node).name; got != "http://b:2" {
			t.Fatalf("call %d: rotate chose %q, want the only healthy proxy http://b:2", i, got)
		}
	}
}

func TestNodePoolAutoStillRebindsOnProxyFailure(t *testing.T) {
	transports := newTestTransportPool(t, "http://a:1", "http://b:2")
	pool, err := newNodePool([]string{"k1", "k2"}, transports, time.Second, nil)
	if err != nil {
		t.Fatalf("newNodePool: %v", err)
	}
	// k1 rides proxy 0, k2 rides proxy 1.
	if moved := pool.RebindProxy(0); moved != 1 {
		t.Fatalf("RebindProxy moved %d keys, want 1", moved)
	}
	if got := pool.Proxy(pool.nodes[0]).name; got != "http://b:2" {
		t.Errorf("rebound key rides %q, want http://b:2", got)
	}
	if !pool.stillBound(pool.nodes[0], pool.Proxy(pool.nodes[0])) {
		t.Error("auto node should still be bound to its (new) proxy after rebind")
	}
}

func TestUpstreamKeyBindingDefaultsToAuto(t *testing.T) {
	cfg := config.Config{}
	if mode, id := cfg.UpstreamKeyBinding("sk-x"); mode != config.ProxyModeAuto || id != "" {
		t.Errorf("empty metadata => (%q,%q), want (auto,\"\")", mode, id)
	}
	cfg.UpstreamKeyMetadata = map[string]config.UpstreamKeyMetadata{
		config.Fingerprint("sk-x"): {ProxyMode: config.ProxyModeRotate},
		config.Fingerprint("sk-y"): {ProxyMode: config.ProxyModeBind, ProxyID: "abc123"},
	}
	if mode, _ := cfg.UpstreamKeyBinding("sk-x"); mode != config.ProxyModeRotate {
		t.Errorf("sk-x mode = %q, want rotate", mode)
	}
	if mode, id := cfg.UpstreamKeyBinding("sk-y"); mode != config.ProxyModeBind || id != "abc123" {
		t.Errorf("sk-y => (%q,%q), want (bind,abc123)", mode, id)
	}
}

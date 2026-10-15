package session

import (
	"sync"
	"testing"
	"time"
)

// fakeClock lets TTL behavior be tested without sleeping.
type fakeClock struct {
	mu sync.Mutex
	at time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.at
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.at = c.at.Add(d)
	c.mu.Unlock()
}

func newTestMapper(ttl time.Duration) (*Mapper, *fakeClock) {
	clock := &fakeClock{at: time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)}
	m := NewMapper(ttl)
	m.now = clock.Now
	return m, clock
}

func TestResolveMintsUniqueUpstreamSessions(t *testing.T) {
	m, _ := newTestMapper(DefaultTTL)
	seen := make(map[string]struct{}, 10000)
	for i := 0; i < 10000; i++ {
		upstream := m.Resolve("scope", identitySignal(i))
		if !isCanonicalSession(upstream) {
			t.Fatalf("minted session %q is not canonical ses_ shape", upstream)
		}
		if _, dup := seen[upstream]; dup {
			t.Fatalf("upstream session %q minted twice", upstream)
		}
		seen[upstream] = struct{}{}
	}
}

func identitySignal(i int) string {
	return string(rune('a'+i%26)) + string(rune('a'+(i/26)%26)) + string(rune('a'+(i/676)%26)) + time.Duration(i).String()
}

func isCanonicalSession(s string) bool {
	if len(s) != 30 || s[:4] != "ses_" {
		return false
	}
	for i := 4; i < 16; i++ {
		if !isHex(s[i]) {
			return false
		}
	}
	return true
}

func isHex(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'f')
}

func TestSameConversationGetsStableUpstreamSession(t *testing.T) {
	m, clock := newTestMapper(15 * time.Minute)
	first := m.Resolve("scopeA", "conv-1")
	clock.Advance(14 * time.Minute) // still inside the sliding window
	if got := m.Resolve("scopeA", "conv-1"); got != first {
		t.Fatalf("stable conversation changed upstream session: %q -> %q", first, got)
	}
	clock.Advance(14 * time.Minute) // slid again, still inside
	if got := m.Resolve("scopeA", "conv-1"); got != first {
		t.Fatalf("sliding window failed to keep session: %q -> %q", first, got)
	}
}

func TestTTLExpiryMintsNewUpstreamSession(t *testing.T) {
	m, clock := newTestMapper(15 * time.Minute)
	first := m.Resolve("scopeA", "conv-1")
	clock.Advance(16 * time.Minute) // idle past the TTL
	second := m.Resolve("scopeA", "conv-1")
	if second == first {
		t.Fatalf("expired mapping returned the stale upstream session %q", second)
	}
	if got := m.Stats().Expired; got == 0 {
		t.Error("expiry was not counted in stats")
	}
}

func TestScopeIsolatesIdenticalSignals(t *testing.T) {
	m, _ := newTestMapper(DefaultTTL)
	// The core regression: identical first-message seeds from two different
	// server keys (scopes) must NOT share an upstream session.
	a := m.Resolve("key-AAA", "帮我写一个冒泡排序")
	b := m.Resolve("key-BBB", "帮我写一个冒泡排序")
	if a == b {
		t.Fatalf("two scopes with the same signal collided on %q", a)
	}
}

func TestConcurrentSameKeyResolvesToOneSession(t *testing.T) {
	m, _ := newTestMapper(DefaultTTL)
	const goroutines = 64
	results := make([]string, goroutines)
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func(n int) {
			defer wg.Done()
			results[n] = m.Resolve("scope", "racy-conversation")
		}(i)
	}
	wg.Wait()
	for i, got := range results {
		if got != results[0] {
			t.Fatalf("goroutine %d resolved %q, want %q (single-flight broken)", i, got, results[0])
		}
	}
	if minted := m.Stats().Minted; minted != 1 {
		t.Fatalf("minted %d sessions for one conversation, want 1", minted)
	}
}

func TestCapacityEvictsOldest(t *testing.T) {
	m, clock := newTestMapper(DefaultTTL)
	m.max = 8
	first := m.Resolve("scope", "conv-0")
	for i := 1; i <= 20; i++ {
		clock.Advance(time.Second)
		m.Resolve("scope", "conv-"+time.Duration(i).String())
	}
	if len(m.entries) > 8 {
		t.Fatalf("map grew to %d entries, want <= 8", len(m.entries))
	}
	// conv-0 was the least recently seen and must have been evicted; resolving
	// it again mints a new session rather than returning the old mapping.
	if got := m.Resolve("scope", "conv-0"); got == first {
		t.Error("evicted entry still returned its old upstream session")
	}
}

func TestSetTTLAppliesToLiveEntries(t *testing.T) {
	m, clock := newTestMapper(15 * time.Minute)
	first := m.Resolve("scope", "conv")
	m.SetTTL(time.Minute)
	clock.Advance(2 * time.Minute)
	if got := m.Resolve("scope", "conv"); got == first {
		t.Error("shortened TTL did not expire the live entry")
	}
	m.SetTTL(0) // ignored
	if m.ttl != time.Minute {
		t.Error("SetTTL(0) must be ignored")
	}
}

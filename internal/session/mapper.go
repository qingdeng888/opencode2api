// Package session maps downstream conversation identifiers to unique upstream
// OpenCode session ids.
//
// The upstream free tier keys its server-side conversation state (prompt
// cache, reasoning reference chains) by the ses_* session id. Two concurrent
// downstream conversations that share one upstream session interleave their
// state there and cross-contaminate each other's replies. The mapper gives
// every distinct downstream conversation its own upstream session for a
// sliding TTL window, and never derives that identity from message content,
// so identical first messages from different users can no longer collide.
package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"sync/atomic"
	"time"

	"opencode2api/internal/identity"
)

// DefaultTTL is how long an unused downstream→upstream mapping survives.
// Every hit slides the window, so an active conversation keeps its upstream
// session (and its prompt cache) for its whole life.
const DefaultTTL = 15 * time.Minute

// defaultMaxEntries bounds the map so a flood of distinct conversation ids
// cannot grow it without limit. Oldest entries are evicted first.
const defaultMaxEntries = 100_000

type entry struct {
	upstream string
	lastSeen time.Time
}

// Stats is the operator-facing snapshot rendered by the WebUI.
type Stats struct {
	Active     int    `json:"active"`
	TTLSeconds int    `json:"ttl_seconds"`
	Minted     uint64 `json:"minted"`
	Hits       uint64 `json:"hits"`
	Misses     uint64 `json:"misses"`
	Expired    uint64 `json:"expired"`
	Evictions  uint64 `json:"evictions"`
}

// Mapper is safe for concurrent use. It implements identity.Resolver.
type Mapper struct {
	mu      sync.Mutex
	entries map[string]*entry
	ttl     time.Duration
	max     int
	now     func() time.Time

	minted    atomic.Uint64
	hits      atomic.Uint64
	misses    atomic.Uint64
	expired   atomic.Uint64
	evictions atomic.Uint64
}

func NewMapper(ttl time.Duration) *Mapper {
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	return &Mapper{entries: make(map[string]*entry), ttl: ttl, max: defaultMaxEntries, now: time.Now}
}

// SetTTL applies a hot-reloaded configuration change to live mappings.
func (m *Mapper) SetTTL(ttl time.Duration) {
	if ttl <= 0 {
		return
	}
	m.mu.Lock()
	m.ttl = ttl
	m.mu.Unlock()
}

// Resolve returns the upstream session for one downstream conversation.
// scope separates tenants (the local server key fingerprint), signal is the
// client-supplied conversation identifier. The mapping slides on every hit and
// is minted fresh once it expires, so a conversation idle for longer than the
// TTL starts a new upstream session on its next turn.
func (m *Mapper) Resolve(scope, signal string) string {
	sum := sha256.Sum256([]byte(scope + "\x00" + signal))
	key := hex.EncodeToString(sum[:])
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	if existing, ok := m.entries[key]; ok {
		if now.Sub(existing.lastSeen) < m.ttl {
			existing.lastSeen = now
			m.hits.Add(1)
			return existing.upstream
		}
		delete(m.entries, key)
		m.expired.Add(1)
	}
	m.misses.Add(1)
	if len(m.entries) >= m.max {
		m.evictLocked(now)
	}
	upstream := identity.CanonicalSessionID(identity.RandomID("fallback", 16))
	m.entries[key] = &entry{upstream: upstream, lastSeen: now}
	m.minted.Add(1)
	return upstream
}

// evictLocked drops expired mappings first and, if the map is still full, the
// least recently seen entry. The caller holds m.mu.
func (m *Mapper) evictLocked(now time.Time) {
	for key, candidate := range m.entries {
		if now.Sub(candidate.lastSeen) >= m.ttl {
			delete(m.entries, key)
			m.expired.Add(1)
		}
	}
	if len(m.entries) < m.max {
		return
	}
	var oldestKey string
	var oldestSeen time.Time
	for key, candidate := range m.entries {
		if oldestKey == "" || candidate.lastSeen.Before(oldestSeen) {
			oldestKey, oldestSeen = key, candidate.lastSeen
		}
	}
	if oldestKey != "" {
		delete(m.entries, oldestKey)
		m.evictions.Add(1)
	}
}

// Sweep removes expired mappings in the background until ctx is done.
func (m *Mapper) Sweep(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.mu.Lock()
			now := m.now()
			for key, candidate := range m.entries {
				if now.Sub(candidate.lastSeen) >= m.ttl {
					delete(m.entries, key)
					m.expired.Add(1)
				}
			}
			m.mu.Unlock()
		}
	}
}

func (m *Mapper) Stats() Stats {
	m.mu.Lock()
	active, ttl := len(m.entries), m.ttl
	m.mu.Unlock()
	return Stats{
		Active: active, TTLSeconds: int(ttl / time.Second),
		Minted: m.minted.Load(), Hits: m.hits.Load(), Misses: m.misses.Load(),
		Expired: m.expired.Load(), Evictions: m.evictions.Load(),
	}
}

// OneShot mints a fresh upstream session for every call and stores nothing.
// Diagnostic traffic (the Playground) uses it so one probe cannot reuse a
// warmed conversation and cannot occupy a slot in the live mapping table.
type OneShot struct{}

func (OneShot) Resolve(_, _ string) string {
	return identity.CanonicalSessionID(identity.RandomID("fallback", 16))
}

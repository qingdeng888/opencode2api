package config

import "time"

// Metadata is keyed by the existing key fingerprint; secret values remain in
// server_keys for compatibility with existing configuration and clients.
type ServerKeyMetadata struct {
	Name      string    `json:"name"`
	Disabled  bool      `json:"disabled,omitempty"`
	CreatedAt time.Time `json:"created_at,omitempty"`
}

func (c Config) ServerKeyEnabled(key string) bool {
	return !c.ServerKeyMetadata[Fingerprint(key)].Disabled
}

func (c Config) FirstEnabledServerKey() string {
	for _, key := range c.ServerKeys {
		if c.ServerKeyEnabled(key) {
			return key
		}
	}
	return ""
}

// UpstreamKeyMetadata stores the operator-facing note for a zen/go upstream
// key, keyed by its fingerprint, plus its proxy binding mode and enabled flag.
// Notes exist purely to tell keys apart in the WebUI; the binding mode controls
// which proxy carries the key's upstream requests, and Disabled keeps the key
// in config.json while excluding it from the runtime pools.
type UpstreamKeyMetadata struct {
	Note      string    `json:"note,omitempty"`
	Disabled  bool      `json:"disabled,omitempty"`
	CreatedAt time.Time `json:"created_at,omitempty"`
	// ProxyMode is "" or "auto" (static i%N binding with failover, the
	// historical behavior), "bind" (pinned to ProxyID, never auto-moved), or
	// "rotate" (a fresh healthy proxy is picked per request attempt).
	ProxyMode string `json:"proxy_mode,omitempty"`
	// ProxyID is the fingerprint of the pinned proxy; only used with "bind".
	ProxyID string `json:"proxy_id,omitempty"`
}

// Proxy binding modes for upstream keys.
const (
	ProxyModeAuto   = "auto"
	ProxyModeBind   = "bind"
	ProxyModeRotate = "rotate"
)

// UpstreamKeyNote returns the operator note for an upstream key, if any.
func (c Config) UpstreamKeyNote(key string) string {
	return c.UpstreamKeyMetadata[Fingerprint(key)].Note
}

// UpstreamKeyEnabled reports whether an upstream key participates in routing.
// Disabled keys stay in ZenKeys/GoKeys so the operator can re-enable them.
func (c Config) UpstreamKeyEnabled(key string) bool {
	return !c.UpstreamKeyMetadata[Fingerprint(key)].Disabled
}

// EnabledZenKeys / EnabledGoKeys return the keys that actually build the
// runtime pools. Every routing decision (availability, tier selection,
// diagnostics) must use these instead of the raw lists, or a disabled key
// would keep a tier looking available while the pool serving it is empty.
func (c Config) EnabledZenKeys() []string { return c.enabledUpstreamKeys(c.ZenKeys) }

func (c Config) EnabledGoKeys() []string { return c.enabledUpstreamKeys(c.GoKeys) }

func (c Config) enabledUpstreamKeys(keys []string) []string {
	enabled := make([]string, 0, len(keys))
	for _, key := range keys {
		if c.UpstreamKeyEnabled(key) {
			enabled = append(enabled, key)
		}
	}
	return enabled
}

// UpstreamKeyBinding returns the configured proxy binding for an upstream key.
func (c Config) UpstreamKeyBinding(key string) (mode string, proxyID string) {
	meta := c.UpstreamKeyMetadata[Fingerprint(key)]
	if meta.ProxyMode == "" {
		return ProxyModeAuto, ""
	}
	return meta.ProxyMode, meta.ProxyID
}

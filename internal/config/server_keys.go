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
// key, keyed by its fingerprint. Notes exist purely to tell keys apart in the
// WebUI; they never influence routing.
type UpstreamKeyMetadata struct {
	Note      string    `json:"note,omitempty"`
	CreatedAt time.Time `json:"created_at,omitempty"`
}

// UpstreamKeyNote returns the operator note for an upstream key, if any.
func (c Config) UpstreamKeyNote(key string) string {
	return c.UpstreamKeyMetadata[Fingerprint(key)].Note
}

package admin

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"opencode2api/internal/config"
	"opencode2api/internal/gateway"
	"opencode2api/internal/httpx"
)

// upstreamKeyNoteLimit bounds the operator note so a typo cannot bloat
// config.json; matches the WebUI input maxlength.
const upstreamKeyNoteLimit = 80

// UpstreamKeyView is the operator-facing row of one zen/go upstream key:
// masked value, note, and live runtime state (proxy binding, failures,
// cooldown). The key value itself never leaves the server.
type UpstreamKeyView struct {
	ID            string     `json:"id"`
	Tier          string     `json:"tier"`
	Display       string     `json:"display"`
	Note          string     `json:"note"`
	Index         int        `json:"index"`
	Proxy         string     `json:"proxy,omitempty"`
	Failures      uint32     `json:"failures"`
	CooldownUntil *time.Time `json:"cooldown_until,omitempty"`
	CreatedAt     *time.Time `json:"created_at,omitempty"`
}

func (a *Server) upstreamKeyViews() ([]UpstreamKeyView, bool) {
	cfg := a.manager.Config()
	resources := a.manager.Resources()
	// Live runtime state keyed by tier+index: bindings move when proxies fail,
	// so the displayed proxy must come from the pool, not from i % len.
	live := make(map[string]gateway.KeyStatus, len(resources.Keys))
	for _, key := range resources.Keys {
		live[key.Tier+":"+strconv.Itoa(key.Index)] = key
	}
	proxyAddr := make(map[int]string, len(resources.Proxies))
	for _, proxy := range resources.Proxies {
		proxyAddr[proxy.Index] = proxy.Address
	}
	views := make([]UpstreamKeyView, 0, len(cfg.ZenKeys)+len(cfg.GoKeys))
	appendTier := func(tier string, keys []string) {
		for i, key := range keys {
			id := config.Fingerprint(key)
			meta := cfg.UpstreamKeyMetadata[id]
			view := UpstreamKeyView{
				ID: id, Tier: tier, Display: config.MaskValue(key), Index: i, Note: meta.Note,
			}
			if !meta.CreatedAt.IsZero() {
				created := meta.CreatedAt
				view.CreatedAt = &created
			}
			if status, ok := live[tier+":"+strconv.Itoa(i)]; ok {
				view.Failures = status.Failures
				view.CooldownUntil = status.CooldownUntil
				view.Proxy = proxyAddr[status.ProxyIndex]
			}
			views = append(views, view)
		}
	}
	appendTier(string(config.TierZen), cfg.ZenKeys)
	appendTier(string(config.TierGo), cfg.GoKeys)
	return views, cfg.Anonymous
}

func (a *Server) writeUpstreamKeyViews(w http.ResponseWriter) {
	views, anonymous := a.upstreamKeyViews()
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"keys": views, "anonymous": anonymous})
}

func (a *Server) handleListUpstreamKeys(w http.ResponseWriter, _ *http.Request) {
	a.writeUpstreamKeyViews(w)
}

func (a *Server) handleCreateUpstreamKey(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Tier  string `json:"tier"`
		Value string `json:"value"`
		Note  string `json:"note"`
	}
	if err := decodeAdminJSON(w, r, &input); err != nil {
		writeAdminError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	tier := strings.ToLower(strings.TrimSpace(input.Tier))
	if tier != string(config.TierZen) && tier != string(config.TierGo) {
		writeAdminError(w, http.StatusBadRequest, "invalid_tier", "tier must be zen or go")
		return
	}
	value := strings.TrimSpace(input.Value)
	if value == "" {
		writeAdminError(w, http.StatusBadRequest, "invalid_key", "key must not be empty")
		return
	}
	note := strings.TrimSpace(input.Note)
	if utf8.RuneCountInString(note) > upstreamKeyNoteLimit {
		writeAdminError(w, http.StatusBadRequest, "invalid_note", fmt.Sprintf("note must be at most %d characters", upstreamKeyNoteLimit))
		return
	}
	_, err := a.manager.Update(func(cfg *config.Config) error {
		keys := &cfg.ZenKeys
		if tier == string(config.TierGo) {
			keys = &cfg.GoKeys
		}
		for _, existing := range *keys {
			if existing == value {
				return fmt.Errorf("该 %s Key 已存在（尾码 %s）", strings.ToUpper(tier), config.MaskValue(value))
			}
		}
		*keys = append(*keys, value)
		id := config.Fingerprint(value)
		if cfg.UpstreamKeyMetadata == nil {
			cfg.UpstreamKeyMetadata = map[string]config.UpstreamKeyMetadata{}
		}
		meta := cfg.UpstreamKeyMetadata[id]
		if meta.CreatedAt.IsZero() {
			meta.CreatedAt = time.Now().UTC()
		}
		meta.Note = note
		cfg.UpstreamKeyMetadata[id] = meta
		return nil
	})
	if err != nil {
		writeAdminError(w, http.StatusBadRequest, "upstream_key_add_failed", a.manager.Redact(err.Error()))
		return
	}
	a.logger.Info("upstream key added", "component", "upstream_keys", "event", "upstream_key_added", "tier", tier, "key", config.MaskValue(value), "client_ip", clientIP(r))
	a.writeUpstreamKeyViews(w)
}

func (a *Server) handleUpdateUpstreamKey(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeAdminError(w, http.StatusBadRequest, "invalid_request", "key id is required")
		return
	}
	var input struct {
		Note *string `json:"note"`
	}
	if err := decodeAdminJSON(w, r, &input); err != nil {
		writeAdminError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if input.Note == nil {
		writeAdminError(w, http.StatusBadRequest, "invalid_request", "note is required (empty string clears it)")
		return
	}
	note := strings.TrimSpace(*input.Note)
	if utf8.RuneCountInString(note) > upstreamKeyNoteLimit {
		writeAdminError(w, http.StatusBadRequest, "invalid_note", fmt.Sprintf("note must be at most %d characters", upstreamKeyNoteLimit))
		return
	}
	_, err := a.manager.Update(func(cfg *config.Config) error {
		if !hasUpstreamKeyID(cfg, id) {
			return fmt.Errorf("key %q 不存在或已被删除", id)
		}
		if cfg.UpstreamKeyMetadata == nil {
			cfg.UpstreamKeyMetadata = map[string]config.UpstreamKeyMetadata{}
		}
		meta := cfg.UpstreamKeyMetadata[id]
		if meta.CreatedAt.IsZero() {
			meta.CreatedAt = time.Now().UTC()
		}
		meta.Note = note
		cfg.UpstreamKeyMetadata[id] = meta
		return nil
	})
	if err != nil {
		writeAdminError(w, http.StatusBadRequest, "upstream_key_update_failed", a.manager.Redact(err.Error()))
		return
	}
	a.logger.Info("upstream key note updated", "component", "upstream_keys", "event", "upstream_key_note_updated", "key_id", id, "client_ip", clientIP(r))
	a.writeUpstreamKeyViews(w)
}

func (a *Server) handleDeleteUpstreamKey(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeAdminError(w, http.StatusBadRequest, "invalid_request", "key id is required")
		return
	}
	removedTier, removedDisplay := "", ""
	_, err := a.manager.Update(func(cfg *config.Config) error {
		for tier, keys := range map[string]*[]string{string(config.TierZen): &cfg.ZenKeys, string(config.TierGo): &cfg.GoKeys} {
			kept := make([]string, 0, len(*keys))
			found := false
			for _, existing := range *keys {
				if config.Fingerprint(existing) == id {
					found = true
					removedTier = tier
					removedDisplay = config.MaskValue(existing)
					continue
				}
				kept = append(kept, existing)
			}
			if found {
				*keys = kept
				delete(cfg.UpstreamKeyMetadata, id)
				return nil
			}
		}
		return fmt.Errorf("key %q 不存在或已被删除", id)
	})
	if err != nil {
		// Normalize also rejects removing the last key while anonymous is off;
		// that guard message reaches the operator verbatim.
		writeAdminError(w, http.StatusBadRequest, "upstream_key_delete_failed", a.manager.Redact(err.Error()))
		return
	}
	a.logger.Info("upstream key deleted", "component", "upstream_keys", "event", "upstream_key_deleted", "tier", removedTier, "key", removedDisplay, "client_ip", clientIP(r))
	a.writeUpstreamKeyViews(w)
}

func (a *Server) handleSetAnonymous(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Enabled *bool `json:"enabled"`
	}
	if err := decodeAdminJSON(w, r, &input); err != nil {
		writeAdminError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if input.Enabled == nil {
		writeAdminError(w, http.StatusBadRequest, "invalid_request", "enabled must be true or false")
		return
	}
	_, err := a.manager.Update(func(cfg *config.Config) error {
		cfg.Anonymous = *input.Enabled
		return nil
	})
	if err != nil {
		writeAdminError(w, http.StatusBadRequest, "anonymous_update_failed", a.manager.Redact(err.Error()))
		return
	}
	a.logger.Info("anonymous lane toggled", "component", "upstream_keys", "event", "anonymous_toggled", "enabled", *input.Enabled, "client_ip", clientIP(r))
	a.writeUpstreamKeyViews(w)
}

func hasUpstreamKeyID(cfg *config.Config, id string) bool {
	for _, key := range cfg.ZenKeys {
		if config.Fingerprint(key) == id {
			return true
		}
	}
	for _, key := range cfg.GoKeys {
		if config.Fingerprint(key) == id {
			return true
		}
	}
	return false
}

package admin

import (
	"fmt"
	"net/http"
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
	ID        string `json:"id"`
	Tier      string `json:"tier"`
	Display   string `json:"display"`
	Note      string `json:"note"`
	Index     int    `json:"index"`
	Enabled   bool   `json:"enabled"`
	Proxy     string `json:"proxy,omitempty"`
	ProxyMode string `json:"proxy_mode"`
	ProxyID   string `json:"proxy_id,omitempty"`
	// InPool reports whether the key currently builds a runtime node. A
	// disabled key is absent from the pool, so its failures/cooldown are
	// meaningless and the UI shows it as inactive rather than "正常".
	InPool        bool       `json:"in_pool"`
	Failures      uint32     `json:"failures"`
	CooldownUntil *time.Time `json:"cooldown_until,omitempty"`
	CreatedAt     *time.Time `json:"created_at,omitempty"`
}

func (a *Server) upstreamKeyViews() ([]UpstreamKeyView, bool) {
	cfg := a.manager.Config()
	resources := a.manager.Resources()
	// Live runtime state keyed by fingerprint, never by index: the pool index
	// shifts as soon as a key is disabled, so index-based lookups would attach
	// one key's cooldown to a different row.
	live := make(map[string]gateway.KeyStatus, len(resources.Keys))
	for _, key := range resources.Keys {
		live[key.Tier+":"+key.Fingerprint] = key
	}
	proxyAddr := make(map[int]string, len(resources.Proxies))
	proxyIDByIndex := make(map[int]string, len(resources.Proxies))
	for _, proxy := range resources.Proxies {
		proxyAddr[proxy.Index] = proxy.Address
		proxyIDByIndex[proxy.Index] = proxy.ID
	}
	views := make([]UpstreamKeyView, 0, len(cfg.ZenKeys)+len(cfg.GoKeys))
	appendTier := func(tier string, keys []string) {
		for i, key := range keys {
			id := config.Fingerprint(key)
			meta := cfg.UpstreamKeyMetadata[id]
			mode, pinnedID := cfg.UpstreamKeyBinding(key)
			view := UpstreamKeyView{
				ID: id, Tier: tier, Display: config.MaskValue(key), Index: i, Note: meta.Note,
				Enabled: cfg.UpstreamKeyEnabled(key), ProxyMode: mode, ProxyID: pinnedID,
			}
			if !meta.CreatedAt.IsZero() {
				created := meta.CreatedAt
				view.CreatedAt = &created
			}
			if status, ok := live[tier+":"+id]; ok {
				view.InPool = true
				view.Index = status.Index
				view.Failures = status.Failures
				view.CooldownUntil = status.CooldownUntil
				switch mode {
				case config.ProxyModeRotate:
					view.Proxy = "轮询（每次请求取一个可用代理）"
				case config.ProxyModeBind:
					// Show the pinned proxy; if it vanished from the pool the
					// runtime fell back to auto, so reflect the live binding.
					if addr := proxyAddr[status.ProxyIndex]; addr != "" && proxyIDByIndex[status.ProxyIndex] == pinnedID {
						view.Proxy = addr
					} else {
						view.Proxy = proxyAddr[status.ProxyIndex]
						view.ProxyMode = config.ProxyModeAuto
						view.ProxyID = ""
					}
				default:
					view.Proxy = proxyAddr[status.ProxyIndex]
				}
			}
			views = append(views, view)
		}
	}
	appendTier(string(config.TierZen), cfg.ZenKeys)
	appendTier(string(config.TierGo), cfg.GoKeys)
	return views, cfg.Anonymous
}

// upstreamKeyProxyOptions lists the enabled pool as dropdown options, so the
// binding selector can only offer proxies that will actually be built.
func (a *Server) upstreamKeyProxyOptions() []map[string]string {
	resources := a.manager.Resources()
	options := make([]map[string]string, 0, len(resources.Proxies))
	for _, proxy := range resources.Proxies {
		options = append(options, map[string]string{"id": proxy.ID, "address": proxy.Address})
	}
	return options
}

func (a *Server) writeUpstreamKeyViews(w http.ResponseWriter) {
	views, anonymous := a.upstreamKeyViews()
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"keys": views, "anonymous": anonymous, "proxies": a.upstreamKeyProxyOptions()})
}

func (a *Server) handleListUpstreamKeys(w http.ResponseWriter, _ *http.Request) {
	a.writeUpstreamKeyViews(w)
}

func (a *Server) handleCreateUpstreamKey(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Tier    string `json:"tier"`
		Value   string `json:"value"`
		Note    string `json:"note"`
		Mode    string `json:"mode"`
		ProxyID string `json:"proxy_id"`
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
	mode := strings.TrimSpace(input.Mode)
	if mode == "" {
		mode = config.ProxyModeAuto
	}
	switch mode {
	case config.ProxyModeAuto, config.ProxyModeBind, config.ProxyModeRotate:
	default:
		writeAdminError(w, http.StatusBadRequest, "invalid_proxy_mode", "mode must be auto, bind, or rotate")
		return
	}
	proxyID := strings.TrimSpace(input.ProxyID)
	if mode == config.ProxyModeBind && proxyID == "" {
		writeAdminError(w, http.StatusBadRequest, "invalid_proxy_mode", "bind mode requires proxy_id")
		return
	}
	if mode != config.ProxyModeBind {
		proxyID = ""
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
		if proxyID != "" && !proxyIDInPool(cfg, proxyID) {
			return fmt.Errorf("proxy %q 不在当前代理池中（可能已删除或停用）", proxyID)
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
		if mode == config.ProxyModeAuto {
			meta.ProxyMode, meta.ProxyID = "", ""
		} else {
			meta.ProxyMode, meta.ProxyID = mode, proxyID
		}
		cfg.UpstreamKeyMetadata[id] = meta
		return nil
	})
	if err != nil {
		writeAdminError(w, http.StatusBadRequest, "upstream_key_add_failed", a.manager.Redact(err.Error()))
		return
	}
	a.logger.Info("upstream key added", "component", "upstream_keys", "event", "upstream_key_added", "tier", tier, "key", config.MaskValue(value), "mode", mode, "client_ip", clientIP(r))
	a.writeUpstreamKeyViews(w)
}

// proxyIDInPool reports whether a proxy fingerprint is in the effective pool
// (config + proxyfile, minus disabled entries), so a key can only be pinned to
// a proxy that will actually be built into the transport pool.
func proxyIDInPool(cfg *config.Config, proxyID string) bool {
	for _, value := range cfg.RuntimeProxies() {
		if config.Fingerprint(value) == proxyID {
			return true
		}
	}
	return false
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

// handleSetUpstreamKeysEnabled enables or disables a batch of upstream keys.
// Disabled keys stay in zen_keys/go_keys (so notes, bindings, and ordering
// survive) but are excluded from the runtime pools on the next Apply. The
// config guard rejects disabling the last enabled key while the anonymous lane
// is off, so a misclick can never leave the gateway without an upstream
// credential.
func (a *Server) handleSetUpstreamKeysEnabled(w http.ResponseWriter, r *http.Request) {
	var input struct {
		IDs     []string `json:"ids"`
		Enabled *bool    `json:"enabled"`
	}
	if err := decodeAdminJSON(w, r, &input); err != nil {
		writeAdminError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if input.Enabled == nil {
		writeAdminError(w, http.StatusBadRequest, "invalid_request", "enabled must be true or false")
		return
	}
	wanted := map[string]struct{}{}
	for _, id := range input.IDs {
		if id = strings.TrimSpace(id); id != "" {
			wanted[id] = struct{}{}
		}
	}
	if len(wanted) == 0 {
		writeAdminError(w, http.StatusBadRequest, "invalid_request", "no key ids provided")
		return
	}
	var changed []string
	_, err := a.manager.Update(func(cfg *config.Config) error {
		for id := range wanted {
			if !hasUpstreamKeyID(cfg, id) {
				continue
			}
			if cfg.UpstreamKeyMetadata == nil {
				cfg.UpstreamKeyMetadata = map[string]config.UpstreamKeyMetadata{}
			}
			meta := cfg.UpstreamKeyMetadata[id]
			if meta.CreatedAt.IsZero() {
				meta.CreatedAt = time.Now().UTC()
			}
			meta.Disabled = !*input.Enabled
			cfg.UpstreamKeyMetadata[id] = meta
			changed = append(changed, id)
		}
		return nil
	})
	if err != nil {
		writeAdminError(w, http.StatusBadRequest, "upstream_key_update_failed", a.manager.Redact(err.Error()))
		return
	}
	changedSet := map[string]struct{}{}
	for _, id := range changed {
		changedSet[id] = struct{}{}
	}
	var skipped []string
	for id := range wanted {
		if _, ok := changedSet[id]; !ok {
			skipped = append(skipped, id)
		}
	}
	action := "upstream_keys_enabled"
	if !*input.Enabled {
		action = "upstream_keys_disabled"
	}
	a.logger.Info("upstream keys enabled flag updated", "component", "upstream_keys", "event", action, "enabled", *input.Enabled, "changed", len(changed), "skipped", len(skipped), "client_ip", clientIP(r))
	views, anonymous := a.upstreamKeyViews()
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"keys": views, "anonymous": anonymous, "proxies": a.upstreamKeyProxyOptions(),
		"changed": changed, "skipped": skipped,
	})
}

// handleSetUpstreamKeyProxy changes one key's proxy binding mode: "auto"
// (static i%N binding with failover), "rotate" (pick a healthy proxy per
// request), or "bind" pinned to proxy_id. The change goes through the normal
// Update path, so the pool is rebuilt and takes effect immediately.
func (a *Server) handleSetUpstreamKeyProxy(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeAdminError(w, http.StatusBadRequest, "invalid_request", "key id is required")
		return
	}
	var input struct {
		Mode    string `json:"mode"`
		ProxyID string `json:"proxy_id"`
	}
	if err := decodeAdminJSON(w, r, &input); err != nil {
		writeAdminError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	mode := strings.TrimSpace(input.Mode)
	if mode == "" {
		mode = config.ProxyModeAuto
	}
	switch mode {
	case config.ProxyModeAuto, config.ProxyModeBind, config.ProxyModeRotate:
	default:
		writeAdminError(w, http.StatusBadRequest, "invalid_proxy_mode", "mode must be auto, bind, or rotate")
		return
	}
	proxyID := strings.TrimSpace(input.ProxyID)
	if mode == config.ProxyModeBind && proxyID == "" {
		writeAdminError(w, http.StatusBadRequest, "invalid_proxy_mode", "bind mode requires proxy_id")
		return
	}
	if mode != config.ProxyModeBind {
		proxyID = ""
	}
	_, err := a.manager.Update(func(cfg *config.Config) error {
		if !hasUpstreamKeyID(cfg, id) {
			return fmt.Errorf("key %q 不存在或已被删除", id)
		}
		if proxyID != "" && !proxyIDInPool(cfg, proxyID) {
			return fmt.Errorf("proxy %q 不在当前代理池中（可能已删除或停用）", proxyID)
		}
		if cfg.UpstreamKeyMetadata == nil {
			cfg.UpstreamKeyMetadata = map[string]config.UpstreamKeyMetadata{}
		}
		meta := cfg.UpstreamKeyMetadata[id]
		if meta.CreatedAt.IsZero() {
			meta.CreatedAt = time.Now().UTC()
		}
		if mode == config.ProxyModeAuto {
			meta.ProxyMode, meta.ProxyID = "", ""
		} else {
			meta.ProxyMode, meta.ProxyID = mode, proxyID
		}
		cfg.UpstreamKeyMetadata[id] = meta
		return nil
	})
	if err != nil {
		writeAdminError(w, http.StatusBadRequest, "upstream_key_proxy_failed", a.manager.Redact(err.Error()))
		return
	}
	a.logger.Info("upstream key proxy binding updated", "component", "upstream_keys", "event", "upstream_key_proxy_updated", "key_id", id, "mode", mode, "proxy_id", proxyID, "client_ip", clientIP(r))
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

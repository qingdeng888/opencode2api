package admin

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"opencode2api/internal/config"
	"opencode2api/internal/gateway"
	"opencode2api/internal/httpx"
)

// proxyProbeTimeout bounds one proxy connectivity test. It mirrors the
// scheduled health-check timeout so the button reports what the pool would see.
const proxyProbeTimeout = 10 * time.Second

type proxyView struct {
	ID        string `json:"id"`
	Index     int    `json:"index"`
	Address   string `json:"address"`
	Healthy   bool   `json:"healthy"`
	Checking  bool   `json:"checking"`
	Source    string `json:"source"`
	ZenKeys   int    `json:"zen_keys"`
	GoKeys    int    `json:"go_keys"`
	Anonymous bool   `json:"anonymous"`
	// Managed is false for implicit default entries and proxyfile entries, which
	// the API cannot delete. The UI hides their delete buttons accordingly.
	Managed bool `json:"managed"`
	// Enabled is false for config proxies the operator disabled. Disabled
	// entries stay in the list but are excluded from the runtime pool.
	Enabled bool `json:"enabled"`
}

func proxyViews(cfg config.Config, resources gateway.ResourceSnapshot) []proxyView {
	views := make([]proxyView, 0, len(resources.Proxies)+len(cfg.Proxies))
	seen := map[string]struct{}{}
	for _, proxy := range resources.Proxies {
		seen[proxy.ID] = struct{}{}
		views = append(views, proxyView{
			ID: proxy.ID, Index: proxy.Index, Address: proxy.Address,
			Healthy: proxy.Healthy, Checking: proxy.Checking, Source: proxy.Source,
			ZenKeys: proxy.ZenKeys, GoKeys: proxy.GoKeys, Anonymous: proxy.Anonymous,
			Managed: proxy.Source == "config", Enabled: true,
		})
	}
	// Disabled config entries are excluded from the runtime pool, so they need
	// synthetic rows or the operator could never re-enable them.
	for _, value := range cfg.Proxies {
		id := config.Fingerprint(value)
		if _, ok := seen[id]; ok {
			continue
		}
		views = append(views, proxyView{
			ID: id, Index: -1, Address: value,
			Source: "config", Managed: true, Enabled: false,
		})
	}
	return views
}

func proxyResources(a *Server) (gateway.ResourceSnapshot, []proxyView) {
	resources := a.manager.Resources()
	return resources, proxyViews(a.manager.Config(), resources)
}

func (a *Server) handleListProxies(w http.ResponseWriter, _ *http.Request) {
	resources, views := proxyResources(a)
	cfg := a.manager.Config()
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"proxies": views, "proxyfile": cfg.ProxyFile,
		// anonymous drains every healthy proxy, so its state explains why the
		// pool matters even with upstream keys configured.
		"anonymous":  cfg.Anonymous,
		"zen_target": strings.TrimRight(cfg.Upstream.Zen, "/") + "/v1/models",
		// resources keeps the raw pool rows for the 运行桌面 table.
		"resources": resources.Proxies,
	})
}

func (a *Server) handleCreateProxy(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Value string `json:"value"`
	}
	if err := decodeAdminJSON(w, r, &input); err != nil {
		writeAdminError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	value := strings.TrimSpace(input.Value)
	if value == "" {
		writeAdminError(w, http.StatusBadRequest, "invalid_proxy", "proxy must not be empty")
		return
	}
	result, err := a.manager.Update(func(cfg *config.Config) error {
		for _, existing := range cfg.Proxies {
			if existing == value {
				return fmt.Errorf("proxy %q is already configured", config.RedactURL(value))
			}
		}
		cfg.Proxies = append(cfg.Proxies, value)
		return nil
	})
	if err != nil {
		writeAdminError(w, http.StatusBadRequest, "proxy_add_failed", a.manager.Redact(err.Error()))
		return
	}
	a.logger.Info("proxy added", "component", "proxy", "event", "proxy_added", "proxy", config.RedactURL(value), "client_ip", clientIP(r))
	resources, views := proxyResources(a)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"result": result, "proxies": views, "resources": resources.Proxies})
}

func (a *Server) handleCreateProxiesBulk(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Values []string `json:"values"`
		Text   string   `json:"text"`
	}
	if err := decodeAdminJSON(w, r, &input); err != nil {
		writeAdminError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	values := append([]string(nil), input.Values...)
	for _, line := range strings.Split(input.Text, "\n") {
		if value := strings.TrimSpace(line); value != "" {
			values = append(values, value)
		}
	}
	seen := map[string]struct{}{}
	unique := make([]string, 0, len(values))
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" {
			continue
		}
		if _, dup := seen[value]; dup {
			continue
		}
		seen[value] = struct{}{}
		unique = append(unique, value)
	}
	if len(unique) == 0 {
		writeAdminError(w, http.StatusBadRequest, "invalid_proxy", "no proxy values provided")
		return
	}
	added := 0
	var skipped []string
	result, err := a.manager.Update(func(cfg *config.Config) error {
		known := map[string]struct{}{}
		for _, existing := range cfg.Proxies {
			known[existing] = struct{}{}
		}
		for _, value := range unique {
			if _, dup := known[value]; dup {
				skipped = append(skipped, value)
				continue
			}
			cfg.Proxies = append(cfg.Proxies, value)
			known[value] = struct{}{}
			added++
		}
		return nil
	})
	if err != nil {
		writeAdminError(w, http.StatusBadRequest, "proxy_add_failed", a.manager.Redact(err.Error()))
		return
	}
	a.logger.Info("proxies bulk added", "component", "proxy", "event", "proxies_bulk_added", "added", added, "skipped", len(skipped), "client_ip", clientIP(r))
	resources, views := proxyResources(a)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"result": result, "proxies": views, "added": added,
		"skipped": redactProxyList(skipped), "resources": resources.Proxies,
	})
}

func (a *Server) handleDeleteProxiesBulk(w http.ResponseWriter, r *http.Request) {
	var input struct {
		IDs []string `json:"ids"`
	}
	if err := decodeAdminJSON(w, r, &input); err != nil {
		writeAdminError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	wanted := map[string]struct{}{}
	for _, id := range input.IDs {
		if id = strings.TrimSpace(id); id != "" {
			wanted[id] = struct{}{}
		}
	}
	if len(wanted) == 0 {
		writeAdminError(w, http.StatusBadRequest, "invalid_request", "no proxy ids provided")
		return
	}
	var removed []string
	result, err := a.manager.Update(func(cfg *config.Config) error {
		kept := cfg.Proxies[:0]
		for _, existing := range cfg.Proxies {
			if _, ok := wanted[config.Fingerprint(existing)]; ok {
				removed = append(removed, existing)
				continue
			}
			kept = append(kept, existing)
		}
		cfg.Proxies = append([]string(nil), kept...)
		if cfg.DisabledProxies != nil {
			for _, value := range removed {
				delete(cfg.DisabledProxies, config.Fingerprint(value))
			}
			if len(cfg.DisabledProxies) == 0 {
				cfg.DisabledProxies = nil
			}
		}
		return nil
	})
	if err != nil {
		writeAdminError(w, http.StatusBadRequest, "proxy_delete_failed", a.manager.Redact(err.Error()))
		return
	}
	// wanted minus removed = ids that are not managed here (proxyfile/default
	// entries or stale ids); report them so the UI can explain the skip.
	removedSet := map[string]struct{}{}
	for _, value := range removed {
		removedSet[config.Fingerprint(value)] = struct{}{}
	}
	var skipped []string
	for id := range wanted {
		if _, ok := removedSet[id]; !ok {
			skipped = append(skipped, id)
		}
	}
	a.logger.Info("proxies bulk deleted", "component", "proxy", "event", "proxies_bulk_deleted", "removed", len(removed), "skipped", len(skipped), "client_ip", clientIP(r))
	resources, views := proxyResources(a)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"result": result, "proxies": views,
		"removed": redactProxyList(removed), "skipped": skipped,
		"resources": resources.Proxies,
	})
}

func (a *Server) handleDeleteProxy(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeAdminError(w, http.StatusBadRequest, "invalid_request", "proxy id is required")
		return
	}
	removed := ""
	result, err := a.manager.Update(func(cfg *config.Config) error {
		kept := cfg.Proxies[:0]
		for _, existing := range cfg.Proxies {
			if config.Fingerprint(existing) == id {
				removed = existing
				continue
			}
			kept = append(kept, existing)
		}
		if removed == "" {
			return fmt.Errorf("proxy %q is not managed here (proxyfile or default entries cannot be deleted)", id)
		}
		cfg.Proxies = append([]string(nil), kept...)
		if cfg.DisabledProxies != nil {
			delete(cfg.DisabledProxies, config.Fingerprint(removed))
			if len(cfg.DisabledProxies) == 0 {
				cfg.DisabledProxies = nil
			}
		}
		return nil
	})
	if err != nil {
		writeAdminError(w, http.StatusBadRequest, "proxy_delete_failed", a.manager.Redact(err.Error()))
		return
	}
	a.logger.Info("proxy deleted", "component", "proxy", "event", "proxy_deleted", "proxy", config.RedactURL(removed), "client_ip", clientIP(r))
	resources, views := proxyResources(a)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"result": result, "proxies": views, "resources": resources.Proxies})
}

func redactProxyList(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		out = append(out, value)
	}
	return out
}

// handleSetProxiesEnabled flips the disabled flag for a batch of config
// proxies. Disabled entries stay in config.json (so they remain editable and
// re-enableable) but are excluded from the runtime pool on the next Apply,
// which rebuilds transports, key bindings, and the anonymous lane from
// scratch. Proxyfile/default entries cannot be disabled and are reported in
// skipped.
func (a *Server) handleSetProxiesEnabled(w http.ResponseWriter, r *http.Request) {
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
		writeAdminError(w, http.StatusBadRequest, "invalid_request", "no proxy ids provided")
		return
	}
	var changed []string
	result, err := a.manager.Update(func(cfg *config.Config) error {
		known := map[string]struct{}{}
		for _, existing := range cfg.Proxies {
			known[config.Fingerprint(existing)] = struct{}{}
		}
		for id := range wanted {
			if _, ok := known[id]; !ok {
				continue
			}
			if *input.Enabled {
				if cfg.DisabledProxies != nil {
					delete(cfg.DisabledProxies, id)
					if len(cfg.DisabledProxies) == 0 {
						cfg.DisabledProxies = nil
					}
				}
			} else {
				if cfg.DisabledProxies == nil {
					cfg.DisabledProxies = map[string]bool{}
				}
				cfg.DisabledProxies[id] = true
			}
			changed = append(changed, id)
		}
		return nil
	})
	if err != nil {
		writeAdminError(w, http.StatusBadRequest, "proxy_update_failed", a.manager.Redact(err.Error()))
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
	action := "proxies_enabled"
	if !*input.Enabled {
		action = "proxies_disabled"
	}
	a.logger.Info("proxies enabled flag updated", "component", "proxy", "event", action, "enabled", *input.Enabled, "changed", len(changed), "skipped", len(skipped), "client_ip", clientIP(r))
	resources, views := proxyResources(a)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"result": result, "proxies": views,
		"changed": changed, "skipped": skipped,
		"resources": resources.Proxies,
	})
}

// handleTestProxy probes one proxy against the Zen /v1/models endpoint, the
// same target FetchModels uses. Any HTTP response proves the route is
// reachable (auth failures count as reachable); only a timeout or connection
// refusal fails the test. Pool health, cooldowns, and key bindings are
// untouched: the probe runs on the proxy's own client with an independent
// timeout, exactly like a scheduled health check.
func (a *Server) handleTestProxy(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeAdminError(w, http.StatusBadRequest, "invalid_request", "proxy id is required")
		return
	}
	if !a.allowDebug(clientIP(r)) {
		writeAdminError(w, http.StatusTooManyRequests, "debug_rate_limited", "too many proxy tests; retry in one minute")
		return
	}
	client := a.manager.ProxyClient(id)
	if client == nil {
		writeAdminError(w, http.StatusNotFound, "unknown_proxy", "proxy is no longer configured")
		return
	}
	cfg := a.manager.Config()
	target := strings.TrimRight(cfg.Upstream.Zen, "/") + "/v1/models"
	started := time.Now()
	ctx, cancel := context.WithTimeout(r.Context(), proxyProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		writeAdminError(w, http.StatusInternalServerError, "proxy_test_failed", "could not construct probe request")
		return
	}
	req.Header.Set("User-Agent", httpx.V2UserAgent())
	resp, err := client.Do(req)
	latency := time.Since(started)
	if resp != nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		_ = resp.Body.Close()
	}
	w.Header().Set("Cache-Control", "no-store")
	if err != nil {
		a.logger.Info("proxy test failed", "component", "proxy", "event", "proxy_test_failed", "proxy_id", id, "target", target, "latency_ms", latency.Milliseconds(), "error", err)
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
			"ok": false, "latency_ms": latency.Milliseconds(),
			"error": a.manager.Redact(err.Error()), "target": target,
		})
		return
	}
	a.logger.Info("proxy test succeeded", "component", "proxy", "event", "proxy_test_succeeded", "proxy_id", id, "target", target, "status", resp.StatusCode, "latency_ms", latency.Milliseconds())
	httpx.WriteJSON(w, http.StatusOK, map[string]any{
		"ok": true, "status": resp.StatusCode, "latency_ms": latency.Milliseconds(), "target": target,
	})
}

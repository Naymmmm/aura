package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"strings"
)

type auraConfig struct {
	Version int            `json:"version"`
	TUN     tunConfig      `json:"tun"`
	Servers []serverConfig `json:"servers"`
}

type tunConfig struct {
	Address string `json:"address"`
	MTU     int    `json:"mtu"`
}

type serverConfig struct {
	Tag            string `json:"tag"`
	Host           string `json:"host"`
	ConnectAddress string `json:"connect_address"`
	Port           int    `json:"port"`
	Username       string `json:"username"`
	Password       string `json:"password"`
}

var (
	tagPattern  = regexp.MustCompile(`^[A-Za-z0-9._-]{1,32}$`)
	hostPattern = regexp.MustCompile(`^[A-Za-z0-9.-]{1,253}$`)
)

func parseConfig(raw json.RawMessage) (auraConfig, error) {
	var cfg auraConfig
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cfg); err != nil {
		return cfg, errors.New("config must match the Aura Core schema")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return cfg, errors.New("config must contain exactly one JSON object")
	}
	if cfg.Version != 1 {
		return cfg, errors.New("unsupported config version")
	}
	if cfg.TUN.Address != "172.19.0.1/30" {
		return cfg, errors.New("unsupported TUN address")
	}
	if cfg.TUN.MTU < 1280 || cfg.TUN.MTU > 1500 {
		return cfg, errors.New("TUN MTU must be between 1280 and 1500")
	}
	if len(cfg.Servers) == 0 || len(cfg.Servers) > 8 {
		return cfg, errors.New("config must contain 1 to 8 servers")
	}
	seen := make(map[string]bool, len(cfg.Servers))
	for i, server := range cfg.Servers {
		if !tagPattern.MatchString(server.Tag) || seen[server.Tag] {
			return cfg, fmt.Errorf("server %d has an invalid or duplicate tag", i)
		}
		seen[server.Tag] = true
		if !validHost(server.Host) || !validHost(server.ConnectAddress) {
			return cfg, fmt.Errorf("server %q has an invalid address", server.Tag)
		}
		if server.Port < 1 || server.Port > 65535 {
			return cfg, fmt.Errorf("server %q has an invalid port", server.Tag)
		}
		if server.Username == "" || len(server.Username) > 255 || server.Password == "" || len(server.Password) > 255 {
			return cfg, fmt.Errorf("server %q has invalid credentials", server.Tag)
		}
	}
	return cfg, nil
}

func validHost(value string) bool {
	if value == "" || strings.ContainsAny(value, " /\\\t\r\n") {
		return false
	}
	if net.ParseIP(value) != nil {
		return true
	}
	return hostPattern.MatchString(value) && !strings.HasPrefix(value, ".") && !strings.HasSuffix(value, ".")
}

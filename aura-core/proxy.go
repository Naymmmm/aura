package main

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"sort"
	"sync"
	"time"

	M "github.com/xjasonlyu/tun2socks/v2/metadata"
	P "github.com/xjasonlyu/tun2socks/v2/proxy"
	"github.com/xjasonlyu/tun2socks/v2/transport/socks5"
)

const uotMagicAddress = "sp.v2.udp-over-tcp.arpa"

var _ P.Proxy = (*multiProxy)(nil)

type proxyEndpoint struct {
	tag  string
	addr string
}

type multiProxy struct {
	mu        sync.RWMutex
	endpoints []proxyEndpoint
	active    int
	latencies map[string]int
}

func newMultiProxy(endpoints []proxyEndpoint) *multiProxy {
	return &multiProxy{
		endpoints: endpoints,
		active:    -1,
		latencies: make(map[string]int, len(endpoints)),
	}
}

func (p *multiProxy) DialContext(ctx context.Context, metadata *M.Metadata) (net.Conn, error) {
	target := socks5.ParseAddrString(metadata.DestinationAddress())
	if target == nil {
		return nil, errors.New("invalid TCP destination")
	}
	var lastErr error
	for _, index := range p.order() {
		conn, err := dialSOCKS(ctx, p.endpoints[index].addr, target)
		if err == nil {
			p.setActive(index)
			return conn, nil
		}
		lastErr = err
	}
	return nil, fmt.Errorf("all NaiveProxy transports failed: %w", lastErr)
}

func (p *multiProxy) DialUDP(metadata *M.Metadata) (net.PacketConn, error) {
	// QUIC over UoT creates a reliable stream inside another reliable stream,
	// and current sing-box Naive inbounds corrupt or stall larger QUIC flows.
	// Failing UDP/443 makes browsers immediately fall back to HTTP/2 while all
	// other UDP (DNS, STUN, games, calls) still uses native UoT v2.
	if metadata.DstPort == 443 {
		return nil, errors.New("QUIC disabled; use HTTP/2 over TCP")
	}
	target := socks5.ParseAddrString(metadata.DestinationAddress())
	if target == nil {
		return nil, errors.New("invalid UDP destination")
	}
	magic := socks5.ParseAddrString(net.JoinHostPort(uotMagicAddress, "0"))
	if magic == nil {
		return nil, errors.New("invalid UoT magic destination")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var lastErr error
	for _, index := range p.order() {
		conn, err := dialSOCKS(ctx, p.endpoints[index].addr, magic)
		if err != nil {
			lastErr = err
			continue
		}
		// UoT v2 request: connected mode byte followed by a SOCKS address.
		header := append([]byte{1}, target...)
		if _, err = conn.Write(header); err != nil {
			_ = conn.Close()
			lastErr = err
			continue
		}
		p.setActive(index)
		return &uotPacketConn{Conn: conn, destination: metadata.UDPAddr()}, nil
	}
	return nil, fmt.Errorf("all NaiveProxy UoT transports failed: %w", lastErr)
}

func dialSOCKS(ctx context.Context, endpoint string, target socks5.Addr) (net.Conn, error) {
	conn, err := (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, "tcp", endpoint)
	if err != nil {
		return nil, err
	}
	if _, err = socks5.ClientHandshake(conn, target, socks5.CmdConnect, nil); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return conn, nil
}

func (p *multiProxy) Probe(ctx context.Context) error {
	type result struct {
		index int
		ms    int
	}
	results := make(chan result, len(p.endpoints))
	var wg sync.WaitGroup
	for i, endpoint := range p.endpoints {
		wg.Add(1)
		go func(index int, ep proxyEndpoint) {
			defer wg.Done()
			started := time.Now()
			target := socks5.ParseAddrString("1.1.1.1:443")
			conn, err := dialSOCKS(ctx, ep.addr, target)
			if err != nil {
				return
			}
			tlsConn := tls.Client(conn, &tls.Config{
				MinVersion: tls.VersionTLS12,
				ServerName: "cloudflare-dns.com",
			})
			if err = tlsConn.HandshakeContext(ctx); err != nil {
				_ = conn.Close()
				return
			}
			_ = tlsConn.Close()
			results <- result{index: index, ms: max(1, int(time.Since(started).Milliseconds()))}
		}(i, endpoint)
	}
	go func() {
		wg.Wait()
		close(results)
	}()

	latencies := make(map[string]int, len(p.endpoints))
	bestIndex, bestMS := -1, int(^uint(0)>>1)
	for value := range results {
		latencies[p.endpoints[value.index].tag] = value.ms
		if value.ms < bestMS {
			bestIndex, bestMS = value.index, value.ms
		}
	}
	if bestIndex < 0 {
		return errors.New("no NaiveProxy server passed its health probe")
	}
	p.mu.Lock()
	p.active = bestIndex
	p.latencies = latencies
	p.mu.Unlock()
	return nil
}

func (p *multiProxy) Snapshot() (string, map[string]int) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	active := ""
	if p.active >= 0 && p.active < len(p.endpoints) {
		active = p.endpoints[p.active].tag
	}
	latencies := make(map[string]int, len(p.latencies))
	for tag, latency := range p.latencies {
		latencies[tag] = latency
	}
	return active, latencies
}

func (p *multiProxy) order() []int {
	p.mu.RLock()
	active := p.active
	latencies := make(map[int]int, len(p.endpoints))
	for i, endpoint := range p.endpoints {
		if value, ok := p.latencies[endpoint.tag]; ok {
			latencies[i] = value
		}
	}
	p.mu.RUnlock()
	indices := make([]int, 0, len(p.endpoints))
	if active >= 0 && active < len(p.endpoints) {
		indices = append(indices, active)
	}
	for i := range p.endpoints {
		if i != active {
			indices = append(indices, i)
		}
	}
	sortFrom := 0
	if active >= 0 && active < len(p.endpoints) {
		sortFrom = 1
	}
	if len(indices)-sortFrom > 1 {
		sort.SliceStable(indices[sortFrom:], func(i, j int) bool {
			return latencies[indices[i+sortFrom]] < latencies[indices[j+sortFrom]]
		})
	}
	return indices
}

func (p *multiProxy) setActive(index int) {
	p.mu.Lock()
	p.active = index
	p.mu.Unlock()
}

type uotPacketConn struct {
	net.Conn
	destination net.Addr
	writeMu     sync.Mutex
}

func (c *uotPacketConn) ReadFrom(p []byte) (int, net.Addr, error) {
	var length uint16
	if err := binary.Read(c.Conn, binary.BigEndian, &length); err != nil {
		return 0, nil, err
	}
	if int(length) > len(p) {
		_, _ = io.CopyN(io.Discard, c.Conn, int64(length))
		return 0, nil, io.ErrShortBuffer
	}
	n, err := io.ReadFull(c.Conn, p[:length])
	return n, c.destination, err
}

func (c *uotPacketConn) WriteTo(p []byte, _ net.Addr) (int, error) {
	if len(p) > 65535 {
		return 0, errors.New("UoT datagram exceeds 65535 bytes")
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	var header [2]byte
	binary.BigEndian.PutUint16(header[:], uint16(len(p)))
	if err := writeAll(c.Conn, header[:]); err != nil {
		return 0, err
	}
	if err := writeAll(c.Conn, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func writeAll(writer io.Writer, value []byte) error {
	for len(value) > 0 {
		n, err := writer.Write(value)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrUnexpectedEOF
		}
		value = value[n:]
	}
	return nil
}

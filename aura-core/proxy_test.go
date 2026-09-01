package main

import (
	"encoding/binary"
	"io"
	"net"
	"net/netip"
	"testing"
	"time"

	M "github.com/xjasonlyu/tun2socks/v2/metadata"
	"github.com/xjasonlyu/tun2socks/v2/transport/socks5"
)

func TestUOTv2ThroughSOCKSConnect(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	serverErr := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			serverErr <- err
			return
		}
		defer conn.Close()
		var greeting [3]byte
		if _, err = io.ReadFull(conn, greeting[:]); err != nil {
			serverErr <- err
			return
		}
		if _, err = conn.Write([]byte{5, 0}); err != nil {
			serverErr <- err
			return
		}
		var request [3]byte
		if _, err = io.ReadFull(conn, request[:]); err != nil {
			serverErr <- err
			return
		}
		address, err := socks5.ReadAddr(conn, make([]byte, socks5.MaxAddrLen))
		if err != nil {
			serverErr <- err
			return
		}
		if request != [3]byte{5, byte(socks5.CmdConnect), 0} || address.String() != uotMagicAddress+":0" {
			serverErr <- io.ErrUnexpectedEOF
			return
		}
		if _, err = conn.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0}); err != nil {
			serverErr <- err
			return
		}
		var connected [1]byte
		if _, err = io.ReadFull(conn, connected[:]); err != nil || connected[0] != 1 {
			serverErr <- io.ErrUnexpectedEOF
			return
		}
		destination, err := socks5.ReadAddr(conn, make([]byte, socks5.MaxAddrLen))
		if err != nil || destination.String() != "8.8.8.8:53" {
			serverErr <- io.ErrUnexpectedEOF
			return
		}
		var length uint16
		if err = binary.Read(conn, binary.BigEndian, &length); err != nil {
			serverErr <- err
			return
		}
		payload := make([]byte, length)
		if _, err = io.ReadFull(conn, payload); err != nil || string(payload) != "ping" {
			serverErr <- io.ErrUnexpectedEOF
			return
		}
		if err = binary.Write(conn, binary.BigEndian, uint16(4)); err == nil {
			_, err = conn.Write([]byte("pong"))
		}
		serverErr <- err
	}()

	proxy := newMultiProxy([]proxyEndpoint{{tag: "test", addr: listener.Addr().String()}})
	packetConn, err := proxy.DialUDP(&M.Metadata{
		Network: M.UDP,
		DstIP:   netip.MustParseAddr("8.8.8.8"),
		DstPort: 53,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer packetConn.Close()
	_ = packetConn.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err = packetConn.WriteTo([]byte("ping"), nil); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 32)
	n, from, err := packetConn.ReadFrom(buffer)
	if err != nil {
		t.Fatal(err)
	}
	if string(buffer[:n]) != "pong" || from.String() != "8.8.8.8:53" {
		t.Fatalf("unexpected response %q from %v", buffer[:n], from)
	}
	if err := <-serverErr; err != nil {
		t.Fatal(err)
	}
}

func TestQUICFallsBackToTCP(t *testing.T) {
	proxy := newMultiProxy(nil)
	_, err := proxy.DialUDP(&M.Metadata{
		Network: M.UDP,
		DstIP:   netip.MustParseAddr("1.1.1.1"),
		DstPort: 443,
	})
	if err == nil {
		t.Fatal("expected UDP/443 to be rejected so the browser falls back to HTTP/2")
	}
}

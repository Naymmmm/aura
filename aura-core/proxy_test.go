package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"net/netip"
	"testing"
	"time"

	M "github.com/xjasonlyu/tun2socks/v2/metadata"
	"github.com/xjasonlyu/tun2socks/v2/transport/socks5"
)

func TestQUICDatagramThroughUOTv2(t *testing.T) {
	// Chromium QUIC initial packets are typically close to the path MTU. Keep
	// this regression payload large enough to catch the Naive padding/framing
	// corruption that previously caused Chromium to close the connection.
	expectedPayload := bytes.Repeat([]byte{0x42}, 1350)
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
		if err != nil || destination.String() != "8.8.8.8:443" {
			serverErr <- io.ErrUnexpectedEOF
			return
		}
		var length uint16
		if err = binary.Read(conn, binary.BigEndian, &length); err != nil {
			serverErr <- err
			return
		}
		packetPayload := make([]byte, length)
		if _, err = io.ReadFull(conn, packetPayload); err != nil || !bytes.Equal(packetPayload, expectedPayload) {
			serverErr <- io.ErrUnexpectedEOF
			return
		}
		if err = binary.Write(conn, binary.BigEndian, length); err == nil {
			_, err = conn.Write(packetPayload)
		}
		serverErr <- err
	}()

	proxy := newMultiProxy([]proxyEndpoint{{tag: "test", addr: listener.Addr().String()}})
	packetConn, err := proxy.DialUDP(&M.Metadata{
		Network: M.UDP,
		DstIP:   netip.MustParseAddr("8.8.8.8"),
		DstPort: 443,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer packetConn.Close()
	_ = packetConn.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err = packetConn.WriteTo(expectedPayload, nil); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, len(expectedPayload))
	n, from, err := packetConn.ReadFrom(buffer)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(buffer[:n], expectedPayload) || from.String() != "8.8.8.8:443" {
		t.Fatalf("unexpected %d-byte response from %v", n, from)
	}
	if err := <-serverErr; err != nil {
		t.Fatal(err)
	}
}

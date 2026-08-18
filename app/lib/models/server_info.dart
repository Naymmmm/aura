/// A single NaiveProxy server entry from the Worker config API.
class ServerInfo {
  final String tag;
  final String host;
  final String ip;
  final String username;
  final String password;

  const ServerInfo({
    required this.tag,
    required this.host,
    required this.ip,
    required this.username,
    required this.password,
  });

  factory ServerInfo.fromJson(Map<String, dynamic> json) {
    return ServerInfo(
      tag: json['tag'] as String,
      host: json['host'] as String,
      ip: json['ip'] as String,
      username: json['username'] as String,
      password: json['password'] as String,
    );
  }

  /// Connect address: the domain by default, the raw IP when `preferIp`
  /// is on (escape hatch for DNS poisoning — tls.server_name stays the host).
  String connectAddress(bool preferIp) => preferIp ? ip : host;

  /// The name shown in the UI (tag, prettified).
  String get label => tag[0].toUpperCase() + tag.substring(1);
}

/// The whole payload served by the Worker.
class ServerConfig {
  final int version;
  final bool preferIp;
  final List<ServerInfo> servers;

  const ServerConfig({
    required this.version,
    required this.preferIp,
    required this.servers,
  });

  factory ServerConfig.fromJson(Map<String, dynamic> json) {
    return ServerConfig(
      version: json['version'] as int,
      preferIp: json['prefer_ip'] as bool? ?? false,
      servers: (json['servers'] as List)
          .map((e) => ServerInfo.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  ServerInfo? byTag(String tag) {
    for (final s in servers) {
      if (s.tag == tag) return s;
    }
    return null;
  }
}

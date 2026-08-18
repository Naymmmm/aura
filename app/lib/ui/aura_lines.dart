// ALL the meme copy in one place. Edit here, vibe everywhere.
// Each list maps to a real VPN state — the UI stays functional, just
// with aura. o7

class AuraLines {
  AuraLines._();

  static const disconnected = [
    'no aura right now. network is cringe',
    'L + ratio + no VPN',
    'your packets are rawdogging the ISP rn',
    'aura: 0. mogging potential: untapped',
    'connect and ascend. or don\'t. idc (connect)',
  ];

  static const connecting = [
    'summoning the aura...',
    'lock in. tunneling...',
    'mogging the ISP as we speak',
    'packets, assemble. o7',
    'dialing romeo, juliet & mercutio...',
  ];

  static const connected = [
    'AURA ON. you are him.',
    '+10000 aura. the ISP sees nothing',
    'certified mogger. traffic untouchable',
    'every packet is mogging now',
    'locked in. sigma mode engaged',
  ];

  static const error = [
    'aura.exe has stopped working... skill issue',
    'we got ratio\'d by the network',
    'the tunnel collapsed. not very skibidi of it',
    'connect failed. blame the cloud, not me fr',
    'the aura could not be summoned. try again king',
  ];

  static const latencyBanter = [
    'ping so low it\'s basically telepathy',
    'latency? never heard of her',
    'speed limit? in THIS economy?',
    'that latency is mogging the competition',
  ];

  static const switching = [
    'fell off. switched servers fr',
    'that server fumbled the bag, moving on',
  ];

  static const budget = [
    'the aura is a shared allowance. spend it wisely',
    '100GB of pure aura, shared by everyone o7',
    'monthly aura tax: 100GB max',
    'aura credits are communal. don\'t be greedy',
  ];

  static const budgetLow = [
    'aura running low. ration the packets',
    'we\'re at 80%+. lock in or log off',
    'the allowance is coughing. slow down king',
  ];

  static const budgetOver = [
    'aura allowance: 0. tapped out fr',
    'budget blown. we\'ll be so back next month',
    'the aura is exhausted. skill issue on us (it\'s the budget)',
  ];

  static const toastConnected = 'sheesh. connected to {server}';
  static const toastSwitched = '{from} fell off, switched to {new}';
  static const toastDisconnected = 'aura paused. go touch grass (or don\'t)';

  /// Pick a line from a list, stable-ish per day so it doesn't flicker.
  static String pick(List<String> lines, [int? seed]) {
    final i = (seed ?? DateTime.now().millisecondsSinceEpoch) % lines.length;
    return lines[i];
  }
}

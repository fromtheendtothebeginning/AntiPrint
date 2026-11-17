// ws.dart — 管理端实时连接：新任务待审核时立刻收到事件（后台靠前台服务保活）
import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/status.dart' as ws_status;
import 'package:web_socket_channel/web_socket_channel.dart';

import 'api.dart';

class WsService {
  WsService._();

  static final WsService instance = WsService._();

  /// 最近一次「新任务待审核」事件（页面监听它刷新列表）
  final ValueNotifier<Map<String, dynamic>?> lastJobEvent = ValueNotifier(null);
  final ValueNotifier<bool> connected = ValueNotifier(false);

  /// 令牌失效（服务器 1008 关闭）时回调，让界面跳回登录页
  VoidCallback? onAuthFailed;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  Timer? _retry;
  bool _enabled = false;

  void start() {
    _enabled = true;
    // 重复调用（登录页 + 首页各一次）时先清掉旧连接，避免同一令牌开两条
    _subscription?.cancel();
    _subscription = null;
    _retry?.cancel();
    _channel?.sink.close(ws_status.normalClosure);
    _channel = null;
    _connect();
  }

  void stop() {
    _enabled = false;
    _retry?.cancel();
    _subscription?.cancel();
    _subscription = null;
    _channel?.sink.close(ws_status.normalClosure);
    _channel = null;
    connected.value = false;
  }

  void _connect() {
    if (!_enabled) return;
    final token = Api.token;
    if (token == null || token.isEmpty) return;

    _retry?.cancel();
    final base = Api.base.replaceFirst('https://', 'wss://').replaceFirst('http://', 'ws://');
    final uri = Uri.parse('$base/api/ws/admin?token=${Uri.encodeComponent(token)}');

    try {
      final channel = WebSocketChannel.connect(uri);
      _channel = channel;
      _subscription = channel.stream.listen(
        (message) {
          connected.value = true;
          try {
            final data = jsonDecode(message as String);
            if (data is Map && data['type'] == 'job_pending' && data['job'] is Map) {
              lastJobEvent.value = Map<String, dynamic>.from(data['job'] as Map);
            }
          } catch (_) {
            // 非 JSON 消息忽略
          }
        },
        onDone: () {
          connected.value = false;
          if (channel.closeCode == 1008) {
            _enabled = false;
            onAuthFailed?.call();
            return;
          }
          _scheduleRetry();
        },
        onError: (_) {
          connected.value = false;
          _scheduleRetry();
        },
        cancelOnError: true,
      );
      connected.value = true;
    } catch (_) {
      _scheduleRetry();
    }
  }

  void _scheduleRetry() {
    if (!_enabled) return;
    _retry?.cancel();
    _retry = Timer(const Duration(seconds: 3), _connect);
  }
}

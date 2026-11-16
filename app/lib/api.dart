// api.dart — AntiPrint 管理接口封装（Bearer 令牌，401 抛 ApiException.unauthorized）
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

class ApiException implements Exception {
  ApiException(this.status, this.message);

  final int status;
  final String message;

  bool get unauthorized => status == 401;

  @override
  String toString() => message;
}

class Api {
  Api._();

  static const String defaultBase = 'https://print.anticraft.top';
  static String base = defaultBase;
  static String? token;
  static const Duration _timeout = Duration(seconds: 25);

  static Map<String, String> get _headers => {
        'Accept': 'application/json',
        if (token != null && token!.isNotEmpty) 'Authorization': 'Bearer $token',
      };

  static dynamic _decode(http.Response response) {
    final text = utf8.decode(response.bodyBytes);
    dynamic data;
    try {
      data = text.isEmpty ? null : jsonDecode(text);
    } catch (_) {
      data = text;
    }
    if (response.statusCode >= 400) {
      var detail = '请求失败（${response.statusCode}）';
      if (data is Map && data['detail'] != null) {
        final value = data['detail'];
        detail = value is String ? value : jsonEncode(value);
      }
      throw ApiException(response.statusCode, detail);
    }
    return data;
  }

  static Future<dynamic> _send(String method, String path, {Object? body}) async {
    final uri = Uri.parse('$base$path');
    final headers = {
      ..._headers,
      if (body != null) 'Content-Type': 'application/json; charset=utf-8',
    };
    http.Response response;
    try {
      Future<http.Response> call;
      switch (method) {
        case 'GET':
          call = http.get(uri, headers: headers);
          break;
        case 'POST':
          call = http.post(uri, headers: headers, body: body == null ? null : jsonEncode(body));
          break;
        case 'DELETE':
          call = http.delete(uri, headers: headers);
          break;
        default:
          throw ApiException(0, '不支持的请求方法：$method');
      }
      response = await call.timeout(_timeout);
    } on SocketException {
      throw ApiException(0, '网络不可用，请检查手机网络');
    } on TimeoutException {
      throw ApiException(0, '请求超时，请重试');
    } on HandshakeException {
      throw ApiException(0, 'HTTPS 握手失败，请检查服务器地址');
    }
    return _decode(response);
  }

  static Map<String, dynamic> _asMap(dynamic data) => Map<String, dynamic>.from(data as Map);

  // ── 账号 ──

  static Future<Map<String, dynamic>> login(String username, String password) async {
    final data = await _send('POST', '/api/login', body: {'username': username, 'password': password});
    return _asMap(data);
  }

  static Future<Map<String, dynamic>> me() async => _asMap(await _send('GET', '/api/me'));

  // ── 任务 ──

  static Future<List<Map<String, dynamic>>> jobs({String? status}) async {
    final data = _asMap(await _send('GET', '/api/jobs'));
    final list = (data['jobs'] as List? ?? const [])
        .map((item) => Map<String, dynamic>.from(item as Map))
        .where((job) => status == null || status.isEmpty || job['status'] == status)
        .toList();
    return list;
  }

  static Future<Map<String, dynamic>> job(int id) async {
    final data = _asMap(await _send('GET', '/api/jobs/$id'));
    return Map<String, dynamic>.from(data['job'] as Map);
  }

  static Future<Map<String, dynamic>> approve(int id) async => _asMap(await _send('POST', '/api/jobs/$id/approve'));

  static Future<Map<String, dynamic>> reject(int id, String reason) async =>
      _asMap(await _send('POST', '/api/jobs/$id/reject', body: {'reason': reason}));

  static Future<Map<String, dynamic>> retry(int id) async => _asMap(await _send('POST', '/api/jobs/$id/retry'));

  static Future<Map<String, dynamic>> reprint(int id) async => _asMap(await _send('POST', '/api/jobs/$id/reprint'));

  static Future<Map<String, dynamic>> advance(int id, String to) async =>
      _asMap(await _send('POST', '/api/jobs/$id/advance', body: {'to': to}));

  static Future<Map<String, dynamic>> withdraw(int id) async => _asMap(await _send('POST', '/api/jobs/$id/withdraw'));

  static Future<Map<String, dynamic>> deleteJob(int id) async => _asMap(await _send('DELETE', '/api/jobs/$id'));

  /// 下载任务文件（Office 已在服务端转成 PDF），返回字节
  static Future<List<int>> downloadJobFile(int jobId, int fileId) async {
    final uri = Uri.parse('$base/api/jobs/$jobId/files/$fileId');
    try {
      final response = await http.get(uri, headers: _headers).timeout(const Duration(seconds: 60));
      if (response.statusCode >= 400) {
        _decode(response);
      }
      return response.bodyBytes;
    } on SocketException {
      throw ApiException(0, '网络不可用，请检查手机网络');
    } on TimeoutException {
      throw ApiException(0, '下载超时，请重试');
    }
  }

  // ── 用户 ──

  static Future<List<Map<String, dynamic>>> users() async {
    final data = _asMap(await _send('GET', '/api/users'));
    return (data['users'] as List? ?? const []).map((item) => Map<String, dynamic>.from(item as Map)).toList();
  }

  static Future<Map<String, dynamic>> adjustBalance(int id, String delta, String note) async =>
      _asMap(await _send('POST', '/api/users/$id/balance', body: {'delta': delta, 'note': note}));

  static Future<Map<String, dynamic>> setRole(int id, String role) async =>
      _asMap(await _send('POST', '/api/users/$id/role', body: {'role': role}));

  static Future<Map<String, dynamic>> deleteUser(int id) async => _asMap(await _send('DELETE', '/api/users/$id'));

  // ── 设置 ──

  static Future<Map<String, dynamic>> settings() async => _asMap(await _send('GET', '/api/settings'));

  static Future<Map<String, dynamic>> updateSettings(Map<String, dynamic> body) async =>
      _asMap(await _send('POST', '/api/settings', body: body));

  static Future<Map<String, dynamic>> agentLink(bool connected) async =>
      _asMap(await _send('POST', '/api/settings/agent-link', body: {'connected': connected}));
}

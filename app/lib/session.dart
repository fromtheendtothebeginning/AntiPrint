// session.dart — 登录令牌与服务器地址的本地持久化
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';

class Session {
  Session._();

  static const String _tokenKey = 'token';
  static const String _baseKey = 'base';

  /// 启动时恢复：返回已保存的令牌（可能已过期，调用方需再验证）
  static Future<String?> restore() async {
    final prefs = await SharedPreferences.getInstance();
    final base = prefs.getString(_baseKey);
    if (base != null && base.isNotEmpty) Api.base = base;
    final token = prefs.getString(_tokenKey);
    Api.token = token;
    return token;
  }

  static Future<void> save(String token) async {
    Api.token = token;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_tokenKey, token);
    await prefs.setString(_baseKey, Api.base);
  }

  static Future<void> clear() async {
    Api.token = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenKey);
  }
}

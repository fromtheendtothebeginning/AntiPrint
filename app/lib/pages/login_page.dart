// login_page.dart — 账号密码登录（管理员/root），保存令牌并启动实时连接
import 'package:flutter/material.dart';

import '../api.dart';
import '../main.dart';
import '../session.dart';
import '../ws.dart';
import 'home_page.dart';

class LoginPage extends StatefulWidget {
  const LoginPage({super.key});

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final TextEditingController _username = TextEditingController();
  final TextEditingController _password = TextEditingController();
  final TextEditingController _server = TextEditingController(text: Api.base);
  bool _busy = false;
  String _error = '';

  @override
  void dispose() {
    _username.dispose();
    _password.dispose();
    _server.dispose();
    super.dispose();
  }

  Future<void> _login() async {
    final username = _username.text.trim();
    final password = _password.text;
    if (username.isEmpty || password.isEmpty) {
      setState(() => _error = '请填写用户名和密码');
      return;
    }
    setState(() {
      _busy = true;
      _error = '';
    });
    final server = _server.text.trim();
    if (server.isNotEmpty) {
      Api.base = server.endsWith('/') ? server.substring(0, server.length - 1) : server;
    }
    try {
      final data = await Api.login(username, password);
      await Session.save(data['token'] as String);
      final role = (data['user'] as Map?)?['role'];
      if (role != 'admin' && role != 'root') {
        await Session.clear();
        setState(() => _error = '该账号不是管理员，无法使用管理 App');
        return;
      }
      WsService.instance.start();
      try {
        await ensureForegroundService();
      } catch (_) {
        // 前台服务启动失败不阻塞登录（部分 ROM 需要用户手动授权）
      }
      if (!mounted) return;
      Navigator.of(context).pushAndRemoveUntil(
        MaterialPageRoute(builder: (_) => const HomePage()),
        (route) => false,
      );
    } on ApiException catch (err) {
      setState(() => _error = err.message);
    } catch (err) {
      setState(() => _error = '登录失败：$err');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 32),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Icon(Icons.print_rounded, size: 56, color: theme.colorScheme.primary),
                const SizedBox(height: 12),
                Text('AntiPrint 管理', textAlign: TextAlign.center, style: theme.textTheme.headlineSmall),
                const SizedBox(height: 6),
                Text(
                  '审核、交接、用户与设置',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.outline),
                ),
                const SizedBox(height: 28),
                TextField(
                  controller: _username,
                  textInputAction: TextInputAction.next,
                  decoration: const InputDecoration(labelText: '管理员账号', border: OutlineInputBorder()),
                ),
                const SizedBox(height: 14),
                TextField(
                  controller: _password,
                  obscureText: true,
                  onSubmitted: (_) => _login(),
                  decoration: const InputDecoration(labelText: '密码', border: OutlineInputBorder()),
                ),
                const SizedBox(height: 14),
                ExpansionTile(
                  tilePadding: EdgeInsets.zero,
                  title: const Text('服务器地址（默认线上）', style: TextStyle(fontSize: 13)),
                  children: [
                    TextField(
                      controller: _server,
                      decoration: const InputDecoration(
                        labelText: 'Base URL',
                        border: OutlineInputBorder(),
                        isDense: true,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                if (_error.isNotEmpty)
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: theme.colorScheme.errorContainer,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(_error, style: TextStyle(color: theme.colorScheme.onErrorContainer)),
                  ),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: _busy ? null : _login,
                  style: FilledButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 14)),
                  child: _busy
                      ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Text('登录'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

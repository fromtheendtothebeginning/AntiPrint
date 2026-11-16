// settings_page.dart — 计费/打印/代理设置，后台保活授权，退出登录
import 'package:flutter/material.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';

import '../api.dart';
import '../session.dart';
import '../state.dart';
import '../util.dart';
import '../ws.dart';
import 'login_page.dart';

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key});

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  Map<String, dynamic> _settings = const {};
  List<dynamic> _agents = const [];
  bool _agentOnline = false;
  bool _loading = true;
  bool _busy = false;
  String _error = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final data = await Api.settings();
      if (!mounted) return;
      setState(() {
        _settings = Map<String, dynamic>.from(data['settings'] as Map? ?? {});
        _agents = data['agents'] as List? ?? const [];
        _agentOnline = data['agent_online'] == true;
        _loading = false;
        _error = '';
      });
    } on ApiException catch (err) {
      if (err.unauthorized) {
        await handleUnauthorized();
        return;
      }
      if (mounted) {
        setState(() {
          _error = err.message;
          _loading = false;
        });
      }
    } catch (err) {
      if (mounted) {
        setState(() {
          _error = errorText(err);
          _loading = false;
        });
      }
    }
  }

  String _value(String key, [String fallback = '']) => (_settings[key] ?? fallback).toString();

  Future<void> _update(Map<String, dynamic> body, String successText) async {
    setState(() => _busy = true);
    try {
      final data = await Api.updateSettings(body);
      if (!mounted) return;
      setState(() => _settings = Map<String, dynamic>.from(data['settings'] as Map? ?? _settings));
      showInfo(context, successText);
      await _load();
    } on ApiException catch (err) {
      if (err.unauthorized) {
        await handleUnauthorized();
        return;
      }
      if (mounted) showError(context, err.message);
    } catch (err) {
      if (mounted) showError(context, errorText(err));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _edit(String title, String key, {String hint = '', bool numeric = false}) async {
    final controller = TextEditingController(text: _value(key));
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(title),
        content: TextField(
          controller: controller,
          autofocus: true,
          maxLines: hint.contains('逗号') ? 4 : 1,
          keyboardType: numeric ? const TextInputType.numberWithOptions(decimal: true) : TextInputType.text,
          decoration: InputDecoration(hintText: hint, border: const OutlineInputBorder()),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('保存')),
        ],
      ),
    );
    if (ok != true) return;
    await _update({key: controller.text.trim()}, '$title已保存');
  }

  Future<void> _toggleAgent(bool connected) async {
    setState(() => _busy = true);
    try {
      final data = await Api.agentLink(connected);
      if (!mounted) return;
      setState(() {
        _settings = Map<String, dynamic>.from(data['settings'] as Map? ?? _settings);
        _agents = data['agents'] as List? ?? _agents;
        _agentOnline = data['agent_online'] == true;
      });
      showInfo(context, connected ? '已恢复代理连接' : '已断开代理连接（任务会排队等待）');
    } catch (err) {
      if (mounted) showError(context, errorText(err));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _allowBackground() async {
    final ignoring = await FlutterForegroundTask.isIgnoringBatteryOptimizations;
    if (ignoring) {
      if (mounted) showInfo(context, '已在电池优化白名单，无需重复设置');
      return;
    }
    await FlutterForegroundTask.requestIgnoreBatteryOptimization();
  }

  Future<void> _logout() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('退出登录'),
        content: const Text('退出后将停止实时提醒，确定吗？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('退出')),
        ],
      ),
    );
    if (ok != true) return;
    WsService.instance.stop();
    await Session.clear();
    navigatorKey.currentState?.pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const LoginPage()),
      (route) => false,
    );
  }

  Widget _section(String title, List<Widget> children) {
    return Card(
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
            child: Text(title, style: TextStyle(fontWeight: FontWeight.w700, color: Theme.of(context).colorScheme.primary)),
          ),
          ...children,
          const SizedBox(height: 6),
        ],
      ),
    );
  }

  Widget _row(String label, String value, {VoidCallback? onTap, Widget? trailing}) {
    return ListTile(
      dense: true,
      title: Text(label, style: const TextStyle(fontSize: 14)),
      subtitle: value.isEmpty ? null : Text(value, style: const TextStyle(fontSize: 13)),
      trailing: trailing ?? (onTap == null ? null : const Icon(Icons.edit_outlined, size: 18)),
      onTap: onTap,
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    final bonus = int.tryParse(_value('recharge_bonus_percent', '0')) ?? 0;
    final price = double.tryParse(_value('print_price', '0')) ?? 0;
    final examples = [10, 20, 50]
        .map((rmb) => '充 $rmb 到账 ${(rmb * (1 + bonus / 100)).toStringAsFixed(0)} 元')
        .join('，');
    return Stack(
      children: [
        RefreshIndicator(
          onRefresh: _load,
          child: ListView(
            padding: const EdgeInsets.only(bottom: 24),
            children: [
              if (_error.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.all(12),
                  child: Text(_error, style: const TextStyle(color: Colors.red)),
                ),
              _section('计费', [
                _row('单价', '${price.toStringAsFixed(2)} 元 / 张', onTap: () => _edit('修改单价', 'print_price', numeric: true, hint: '例如 0.15')),
                _row('充值赠送', '$bonus%（$examples）', onTap: () => _edit('修改赠送比例', 'recharge_bonus_percent', numeric: true, hint: '百分比，例如 50')),
              ]),
              _section('打印', [
                _row('默认份数', _value('copies'), onTap: () => _edit('修改默认份数', 'copies', numeric: true, hint: '1~99')),
                _row('打印机', _value('printer_name'), onTap: () => _edit('修改打印机名称', 'printer_name')),
                _row('免费白名单', _value('free_users').isEmpty ? '（空）' : _value('free_users'),
                    onTap: () => _edit('修改免费白名单', 'free_users', hint: '用户名，用逗号分隔')),
                SwitchListTile(
                  dense: true,
                  title: const Text('打印封面页', style: TextStyle(fontSize: 14)),
                  subtitle: const Text('出纸前先打一张任务信息页', style: TextStyle(fontSize: 12)),
                  value: _value('cover_page') == '1',
                  onChanged: _busy ? null : (value) => _update({'cover_page': value}, '封面页设置已保存'),
                ),
                SwitchListTile(
                  dense: true,
                  title: const Text('试运行（只生成不打印）', style: TextStyle(fontSize: 14)),
                  value: _value('dry_run') == '1',
                  onChanged: _busy ? null : (value) => _update({'dry_run': value}, '试运行设置已保存'),
                ),
              ]),
              _section('打印代理', [
                SwitchListTile(
                  dense: true,
                  title: const Text('代理连接', style: TextStyle(fontSize: 14)),
                  subtitle: Text(_agentOnline ? '在线' : '离线（代理未上报心跳）', style: const TextStyle(fontSize: 12)),
                  value: _value('agent_enabled', '1') == '1',
                  onChanged: _busy ? null : _toggleAgent,
                ),
                for (final agent in _agents)
                  ListTile(
                    dense: true,
                    leading: const Icon(Icons.computer_outlined, size: 20),
                    title: Text((agent['name'] ?? '未知代理').toString(), style: const TextStyle(fontSize: 14)),
                    subtitle: Text(
                      '最后心跳 ${formatTime(agent['last_seen'])} · v${agent['version'] ?? '?'}',
                      style: const TextStyle(fontSize: 12),
                    ),
                  ),
              ]),
              _section('App', [
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.battery_saver_outlined, size: 20),
                  title: const Text('允许后台运行', style: TextStyle(fontSize: 14)),
                  subtitle: const Text('加入电池优化白名单，避免实时通知被系统杀掉', style: TextStyle(fontSize: 12)),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: _allowBackground,
                ),
                ListTile(
                  dense: true,
                  leading: const Icon(Icons.logout, size: 20, color: Colors.red),
                  title: const Text('退出登录', style: TextStyle(fontSize: 14, color: Colors.red)),
                  onTap: _logout,
                ),
              ]),
            ],
          ),
        ),
        if (_busy) const Positioned(left: 0, right: 0, top: 0, child: LinearProgressIndicator()),
      ],
    );
  }
}

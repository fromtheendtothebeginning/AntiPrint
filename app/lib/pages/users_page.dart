// users_page.dart — 用户列表：调余额、改角色（root）、删除
import 'package:flutter/material.dart';

import '../api.dart';
import '../util.dart';

class UsersPage extends StatefulWidget {
  const UsersPage({super.key});

  @override
  State<UsersPage> createState() => _UsersPageState();
}

class _UsersPageState extends State<UsersPage> {
  List<Map<String, dynamic>> _users = const [];
  bool _loading = true;
  String _error = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final users = await Api.users();
      if (!mounted) return;
      setState(() {
        _users = users;
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

  Future<void> _adjust(Map<String, dynamic> user) async {
    final delta = TextEditingController();
    final note = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('调整余额 · ${user['username']}'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('当前余额 ${formatMoney(user['balance'])}', style: const TextStyle(fontSize: 13)),
            const SizedBox(height: 12),
            TextField(
              controller: delta,
              autofocus: true,
              keyboardType: const TextInputType.numberWithOptions(decimal: true, signed: true),
              decoration: const InputDecoration(
                labelText: '变动金额（正=加钱，负=扣钱）',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: note,
              decoration: const InputDecoration(labelText: '备注（可选）', border: OutlineInputBorder()),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('确定')),
        ],
      ),
    );
    if (ok != true) return;
    final text = delta.text.trim();
    if (double.tryParse(text) == null || double.parse(text) == 0) {
      if (mounted) showError(context, '请输入非 0 的金额');
      return;
    }
    try {
      final result = await Api.adjustBalance(user['id'] as int, text, note.text.trim());
      if (mounted) showInfo(context, '已调账，当前余额 ${formatMoney(result['balance'])}');
      await _load();
    } catch (err) {
      if (mounted) showError(context, errorText(err));
    }
  }

  Future<void> _toggleRole(Map<String, dynamic> user) async {
    final current = (user['role'] ?? 'user').toString();
    final next = current == 'admin' ? 'user' : 'admin';
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('修改角色'),
        content: Text('把「${user['username']}」设为 ${next == 'admin' ? '管理员' : '普通用户'}？'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('取消')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('确定')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await Api.setRole(user['id'] as int, next);
      if (mounted) showInfo(context, '已设为${next == 'admin' ? '管理员' : '普通用户'}');
      await _load();
    } catch (err) {
      if (mounted) showError(context, errorText(err));
    }
  }

  Future<void> _delete(Map<String, dynamic> user) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('删除账号'),
        content: Text('删除「${user['username']}」？余额必须为 0，任务记录会保留但提交人显示为空。'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('取消')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red.shade700),
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await Api.deleteUser(user['id'] as int);
      if (mounted) showInfo(context, '已删除 ${user['username']}');
      await _load();
    } catch (err) {
      if (mounted) showError(context, errorText(err));
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    return RefreshIndicator(
      onRefresh: _load,
      child: Column(
        children: [
          if (_error.isNotEmpty)
            Padding(
              padding: const EdgeInsets.all(12),
              child: Text(_error, style: const TextStyle(color: Colors.red)),
            ),
          Expanded(
            child: ListView.builder(
              padding: const EdgeInsets.only(bottom: 16),
              itemCount: _users.length,
              itemBuilder: (context, index) {
                final user = _users[index];
                final role = (user['role'] ?? 'user').toString();
                final roleText = role == 'root' ? '超管' : (role == 'admin' ? '管理员' : '普通用户');
                return Card(
                  margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                  child: ListTile(
                    title: Row(
                      children: [
                        Expanded(child: Text(user['username'].toString(), overflow: TextOverflow.ellipsis)),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                          decoration: BoxDecoration(
                            color: role == 'user' ? Colors.grey.shade200 : Colors.teal.shade50,
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Text(roleText, style: const TextStyle(fontSize: 11)),
                        ),
                      ],
                    ),
                    subtitle: Text(
                      '余额 ${formatMoney(user['balance'])} · ${user['job_count'] ?? 0} 单 · ${user['source'] ?? 'local'}',
                      style: const TextStyle(fontSize: 12),
                    ),
                    trailing: PopupMenuButton<String>(
                      onSelected: (value) {
                        if (value == 'balance') _adjust(user);
                        if (value == 'role') _toggleRole(user);
                        if (value == 'delete') _delete(user);
                      },
                      itemBuilder: (menuContext) => [
                        const PopupMenuItem(value: 'balance', child: Text('调整余额')),
                        if (role != 'root') const PopupMenuItem(value: 'role', child: Text('设为管理员/普通用户')),
                        if (role != 'root') const PopupMenuItem(value: 'delete', child: Text('删除账号')),
                      ],
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

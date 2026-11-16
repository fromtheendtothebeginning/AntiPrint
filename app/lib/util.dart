// util.dart — 通用小工具：401 处理、时间与金额格式化、状态配色、提示条
import 'package:flutter/material.dart';

import 'api.dart';
import 'pages/login_page.dart';
import 'session.dart';
import 'state.dart';
import 'ws.dart';

/// 令牌失效：停止实时连接、清令牌、回登录页
Future<void> handleUnauthorized() async {
  WsService.instance.stop();
  await Session.clear();
  navigatorKey.currentState?.pushAndRemoveUntil(
    MaterialPageRoute(builder: (_) => const LoginPage()),
    (route) => false,
  );
}

String formatTime(dynamic value) {
  if (value == null) return '';
  final text = value.toString().replaceFirst('T', ' ');
  return text.length >= 16 ? text.substring(0, 16) : text;
}

String formatMoney(dynamic value) {
  final amount = double.tryParse(value?.toString() ?? '') ?? 0;
  return '¥${amount.toStringAsFixed(2)}';
}

String describePrintOptions(dynamic options, dynamic copies) {
  final parts = <String>[];
  final effectiveCopies = copies is int ? copies : int.tryParse(copies?.toString() ?? '') ?? 1;
  parts.add('$effectiveCopies 份');
  if (options is Map) {
    final paper = options['paper'];
    if (paper != null && paper.toString().isNotEmpty) parts.add(paper.toString());
    final pages = options['pages'];
    if (pages != null && pages.toString().isNotEmpty) parts.add('页 $pages');
    final nup = options['nup'];
    if (nup != null && nup.toString().isNotEmpty) parts.add('每面 $nup 页');
    final scale = options['scale'];
    if (scale != null && scale.toString().isNotEmpty) parts.add(scale.toString());
  }
  return parts.join(' · ');
}

Color statusColor(String status) {
  switch (status) {
    case '待支付':
      return Colors.orange;
    case '待审核':
      return Colors.amber.shade800;
    case '已通过':
      return Colors.blue;
    case '打印中':
      return Colors.indigo;
    case '已打印':
      return Colors.teal;
    case '待配送':
    case '待取件':
      return Colors.deepPurple;
    case '已完成':
      return Colors.green;
    case '已驳回':
      return Colors.red;
    case '打印失败':
      return Colors.red.shade900;
    case '已撤回':
      return Colors.grey;
    default:
      return Colors.grey;
  }
}

class StatusChip extends StatelessWidget {
  const StatusChip(this.status, {super.key});

  final String status;

  @override
  Widget build(BuildContext context) {
    final color = statusColor(status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: color.withValues(alpha: 0.4)),
      ),
      child: Text(status, style: TextStyle(fontSize: 12, color: color, fontWeight: FontWeight.w600)),
    );
  }
}

/// 统一错误提示
void showError(BuildContext context, String message) {
  if (!context.mounted) return;
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(content: Text(message), backgroundColor: Colors.red.shade700),
  );
}

void showInfo(BuildContext context, String message) {
  if (!context.mounted) return;
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
}

/// 把 ApiException / 其它异常统一成中文提示
String errorText(Object error) {
  if (error is ApiException) return error.message;
  return '操作失败：$error';
}

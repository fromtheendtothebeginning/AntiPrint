// job_detail_page.dart — 任务详情与全部管理操作（通过/驳回/交接/重打/撤回/删除/看文件）
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';

import '../api.dart';
import '../util.dart';

class JobDetailPage extends StatefulWidget {
  const JobDetailPage({super.key, required this.jobId});

  final int jobId;

  @override
  State<JobDetailPage> createState() => _JobDetailPageState();
}

class _JobDetailPageState extends State<JobDetailPage> {
  Map<String, dynamic>? _job;
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
      final job = await Api.job(widget.jobId);
      if (!mounted) return;
      setState(() {
        _job = job;
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

  Future<void> _run(Future<dynamic> Function() action, String successText) async {
    setState(() => _busy = true);
    try {
      await action();
      if (mounted) showInfo(context, successText);
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

  Future<bool> _confirm(String title, String content, {bool danger = false}) async {
    final result = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(title),
        content: Text(content),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('取消')),
          FilledButton(
            style: danger ? FilledButton.styleFrom(backgroundColor: Colors.red.shade700) : null,
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('确定'),
          ),
        ],
      ),
    );
    return result == true;
  }

  Future<void> _reject() async {
    final controller = TextEditingController();
    final reason = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('驳回任务'),
        content: TextField(
          controller: controller,
          autofocus: true,
          maxLines: 3,
          decoration: const InputDecoration(
            hintText: '填写驳回理由（用户可见，费用自动退回）',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('取消')),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, controller.text.trim()),
            child: const Text('驳回'),
          ),
        ],
      ),
    );
    if (reason == null) return;
    if (reason.isEmpty) {
      if (mounted) showError(context, '驳回理由不能为空');
      return;
    }
    await _run(() => Api.reject(widget.jobId, reason), '已驳回');
  }

  /// Office 文件服务端已转成 PDF，本地按 .pdf 保存才能直接打开
  String _localName(String filename) {
    final lower = filename.toLowerCase();
    const office = ['.doc', '.docx', '.ppt', '.pptx'];
    for (final suffix in office) {
      if (lower.endsWith(suffix)) {
        return '${filename.substring(0, filename.length - suffix.length)}.pdf';
      }
    }
    return filename;
  }

  Future<void> _openFile(Map<String, dynamic> file) async {
    setState(() => _busy = true);
    try {
      final bytes = await Api.downloadJobFile(widget.jobId, file['id'] as int);
      final dir = await getTemporaryDirectory();
      final path = '${dir.path}/${_localName(file['filename'].toString())}';
      await File(path).writeAsBytes(bytes, flush: true);
      final result = await OpenFilex.open(path);
      if (result.type != ResultType.done && mounted) {
        showError(context, '没有能打开该文件的应用：${result.message}');
      }
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

  Widget _infoRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 76,
            child: Text(label, style: TextStyle(color: Theme.of(context).colorScheme.outline, fontSize: 13)),
          ),
          Expanded(child: Text(value, style: const TextStyle(fontSize: 13))),
        ],
      ),
    );
  }

  List<Widget> _actionButtons(Map<String, dynamic> job) {
    final status = (job['status'] ?? '').toString();
    final delivery = (job['delivery_mode'] ?? '').toString();
    final buttons = <Widget>[];

    if (status == '待审核') {
      buttons.add(FilledButton.icon(
        onPressed: _busy ? null : () => _run(() => Api.approve(widget.jobId), '已通过审核'),
        icon: const Icon(Icons.check),
        label: const Text('通过'),
      ));
      buttons.add(OutlinedButton.icon(
        onPressed: _busy ? null : _reject,
        icon: const Icon(Icons.close),
        label: const Text('驳回'),
        style: OutlinedButton.styleFrom(foregroundColor: Colors.red.shade700),
      ));
    }
    if (status == '打印失败') {
      buttons.add(FilledButton.icon(
        onPressed: _busy ? null : () => _run(() => Api.retry(widget.jobId), '已重新入队'),
        icon: const Icon(Icons.refresh),
        label: const Text('重试'),
      ));
    }
    if (status == '已打印') {
      buttons.add(FilledButton.icon(
        onPressed: _busy
            ? null
            : () => _run(
                  () => Api.advance(widget.jobId, delivery == '取件' ? '待取件' : '待配送'),
                  '已标记为${delivery == '取件' ? '待取件' : '待配送'}',
                ),
        icon: const Icon(Icons.local_shipping),
        label: Text(delivery == '取件' ? '待取件' : '待配送'),
      ));
    }
    if (status == '待配送' || status == '待取件') {
      buttons.add(FilledButton.icon(
        onPressed: _busy ? null : () => _run(() => Api.advance(widget.jobId, '已完成'), '已标记为已完成'),
        icon: const Icon(Icons.task_alt),
        label: const Text('已完成'),
      ));
    }
    if (['已打印', '打印失败', '待配送', '待取件', '已完成'].contains(status)) {
      buttons.add(OutlinedButton.icon(
        onPressed: _busy
            ? null
            : () async {
                if (await _confirm('重新打印', '任务 #${job['id']} 会重新进入打印队列，确定吗？')) {
                  await _run(() => Api.reprint(widget.jobId), '已重新入队');
                }
              },
        icon: const Icon(Icons.print),
        label: const Text('重新打印'),
      ));
    }
    if (['待支付', '待审核', '已通过'].contains(status)) {
      buttons.add(OutlinedButton.icon(
        onPressed: _busy
            ? null
            : () async {
                if (await _confirm('撤回任务', '撤回后任务结束，已扣费用会自动退回（支付宝订单原路退款）。确定吗？')) {
                  await _run(() => Api.withdraw(widget.jobId), '已撤回并退费');
                }
              },
        icon: const Icon(Icons.undo),
        label: const Text('撤回'),
      ));
    }
    buttons.add(OutlinedButton.icon(
      onPressed: _busy
          ? null
          : () async {
              if (await _confirm('删除任务', '任务与上传文件会被永久删除，未出纸的费用会退回。确定吗？', danger: true)) {
                await _run(() async {
                  await Api.deleteJob(widget.jobId);
                  if (mounted) Navigator.of(context).pop();
                }, '已删除');
              }
            },
      icon: const Icon(Icons.delete_outline),
      label: const Text('删除'),
      style: OutlinedButton.styleFrom(foregroundColor: Colors.red.shade700),
    ));
    return buttons;
  }

  @override
  Widget build(BuildContext context) {
    final job = _job;
    return Scaffold(
      appBar: AppBar(
        title: Text('任务 #${widget.jobId}'),
        actions: [
          IconButton(onPressed: _loading ? null : _load, icon: const Icon(Icons.refresh)),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : job == null
              ? Center(child: Text(_error.isEmpty ? '任务不存在' : _error))
              : Stack(
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
                          Card(
                            margin: const EdgeInsets.fromLTRB(12, 12, 12, 6),
                            child: Padding(
                              padding: const EdgeInsets.all(14),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    children: [
                                      StatusChip(job['status'].toString()),
                                      const Spacer(),
                                      Text(
                                        '${formatMoney(job['charge'])} · ${job['pay_method'] == 'alipay' ? '即时付款' : '余额支付'}',
                                        style: const TextStyle(fontSize: 13),
                                      ),
                                    ],
                                  ),
                                  const Divider(height: 18),
                                  _infoRow('提交人', (job['username'] ?? '未知').toString()),
                                  _infoRow('配送方式', (job['delivery_mode'] ?? '').toString()),
                                  if ((job['address'] ?? '').toString().isNotEmpty)
                                    _infoRow('地址', job['address'].toString()),
                                  _infoRow('打印设置', describePrintOptions(job['print_options'], job['copies'])),
                                  _infoRow('提交时间', formatTime(job['created_at'])),
                                  if ((job['note'] ?? '').toString().isNotEmpty) _infoRow('备注', job['note'].toString()),
                                  if ((job['reject_reason'] ?? '').toString().isNotEmpty)
                                    _infoRow('驳回理由', job['reject_reason'].toString()),
                                  if ((job['print_error'] ?? '').toString().isNotEmpty)
                                    _infoRow('打印错误', job['print_error'].toString()),
                                ],
                              ),
                            ),
                          ),
                          Card(
                            margin: const EdgeInsets.fromLTRB(12, 6, 12, 6),
                            child: Column(
                              children: [
                                for (final file in (job['files'] as List? ?? const []))
                                  ListTile(
                                    dense: true,
                                    leading: const Icon(Icons.description_outlined),
                                    title: Text(file['filename'].toString()),
                                    subtitle: Text('${((file['size'] as int? ?? 0) / 1024).toStringAsFixed(0)} KB'),
                                    trailing: const Icon(Icons.open_in_new, size: 18),
                                    onTap: () => _openFile(Map<String, dynamic>.from(file as Map)),
                                  ),
                              ],
                            ),
                          ),
                          Padding(
                            padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
                            child: Wrap(spacing: 10, runSpacing: 10, children: _actionButtons(job)),
                          ),
                        ],
                      ),
                    ),
                    if (_busy)
                      const Positioned(
                        left: 0,
                        right: 0,
                        top: 0,
                        child: LinearProgressIndicator(),
                      ),
                  ],
                ),
    );
  }
}

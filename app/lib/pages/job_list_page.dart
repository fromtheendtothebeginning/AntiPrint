// job_list_page.dart — 任务列表（待审模式带快捷通过/驳回；全部模式支持状态筛选）
import 'package:flutter/material.dart';

import '../api.dart';
import '../state.dart';
import '../util.dart';
import 'job_detail_page.dart';

const List<String> _statusFilters = [
  '全部',
  '待审核',
  '已通过',
  '打印中',
  '已打印',
  '待配送',
  '待取件',
  '已完成',
  '已驳回',
  '打印失败',
  '已撤回',
];

class JobListPage extends StatefulWidget {
  const JobListPage({super.key, required this.pendingOnly});

  final bool pendingOnly;

  @override
  State<JobListPage> createState() => _JobListPageState();
}

class _JobListPageState extends State<JobListPage> {
  List<Map<String, dynamic>> _jobs = const [];
  bool _loading = true;
  String _error = '';
  String _filter = '全部';

  @override
  void initState() {
    super.initState();
    pendingVersion.addListener(_onRealtime);
    _load();
  }

  @override
  void dispose() {
    pendingVersion.removeListener(_onRealtime);
    super.dispose();
  }

  void _onRealtime() {
    if (mounted) _load(silent: true);
  }

  Future<void> _load({bool silent = false}) async {
    if (!silent) {
      setState(() {
        _loading = true;
        _error = '';
      });
    }
    try {
      final status = widget.pendingOnly ? '待审核' : (_filter == '全部' ? null : _filter);
      final jobs = await Api.jobs(status: status);
      if (!mounted) return;
      setState(() {
        _jobs = jobs;
        _loading = false;
        _error = '';
      });
      if (widget.pendingOnly) pendingUnread.value = false;
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

  Future<void> _approve(Map<String, dynamic> job) async {
    try {
      await Api.approve(job['id'] as int);
      showInfo(context, '任务 #${job['id']} 已通过审核');
      await _load(silent: true);
    } catch (err) {
      showError(context, errorText(err));
    }
  }

  Future<void> _reject(Map<String, dynamic> job) async {
    final controller = TextEditingController();
    final reason = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text('驳回任务 #${job['id']}'),
        content: TextField(
          controller: controller,
          autofocus: true,
          maxLines: 3,
          decoration: const InputDecoration(
            hintText: '填写驳回理由（用户能看到，费用会自动退回）',
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
    try {
      await Api.reject(job['id'] as int, reason);
      if (!mounted) return;
      showInfo(context, '任务 #${job['id']} 已驳回');
      await _load(silent: true);
    } catch (err) {
      if (!mounted) return;
      showError(context, errorText(err));
    }
  }

  Future<void> _openDetail(Map<String, dynamic> job) async {
    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => JobDetailPage(jobId: job['id'] as int)),
    );
    await _load(silent: true);
  }

  Widget _jobTile(Map<String, dynamic> job) {
    final files = (job['files'] as List? ?? const []);
    final id = job['id'];
    final username = job['username'] ?? '未知用户';
    final delivery = job['delivery_mode'] ?? '';
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => _openDetail(job),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 12, 8, 12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text('#$id', style: const TextStyle(fontWeight: FontWeight.w700)),
                        const SizedBox(width: 8),
                        StatusChip((job['status'] ?? '').toString()),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      '$username · ${files.length} 个文件 · $delivery',
                      style: const TextStyle(fontSize: 13),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      describePrintOptions(job['print_options'], job['copies']),
                      style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.outline),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '${formatTime(job['created_at'])} · ${formatMoney(job['charge'])}',
                      style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.outline),
                    ),
                  ],
                ),
              ),
              if (widget.pendingOnly) ...[
                IconButton(
                  tooltip: '通过',
                  icon: const Icon(Icons.check_circle, color: Colors.green),
                  onPressed: () => _approve(job),
                ),
                IconButton(
                  tooltip: '驳回',
                  icon: const Icon(Icons.cancel, color: Colors.redAccent),
                  onPressed: () => _reject(job),
                ),
              ] else
                const Padding(
                  padding: EdgeInsets.only(top: 6),
                  child: Icon(Icons.chevron_right, color: Colors.grey),
                ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        if (!widget.pendingOnly)
          SizedBox(
            height: 48,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              itemCount: _statusFilters.length,
              separatorBuilder: (_, _) => const SizedBox(width: 6),
              itemBuilder: (context, index) {
                final label = _statusFilters[index];
                final selected = label == _filter;
                return ChoiceChip(
                  label: Text(label),
                  selected: selected,
                  onSelected: (_) {
                    setState(() => _filter = label);
                    _load();
                  },
                );
              },
            ),
          ),
        if (_error.isNotEmpty)
          Padding(
            padding: const EdgeInsets.all(12),
            child: Text(_error, style: const TextStyle(color: Colors.red)),
          ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _load,
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _jobs.isEmpty
                    ? ListView(
                        children: [
                          const SizedBox(height: 120),
                          Icon(Icons.inbox_outlined, size: 48, color: Colors.grey.shade400),
                          const SizedBox(height: 8),
                          Center(
                            child: Text(
                              widget.pendingOnly ? '没有待审核的任务' : '没有符合条件的任务',
                              style: TextStyle(color: Colors.grey.shade600),
                            ),
                          ),
                        ],
                      )
                    : ListView.builder(
                        padding: const EdgeInsets.only(bottom: 16),
                        itemCount: _jobs.length,
                        itemBuilder: (context, index) => _jobTile(_jobs[index]),
                      ),
          ),
        ),
      ],
    );
  }
}

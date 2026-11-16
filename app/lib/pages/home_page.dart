// home_page.dart — 底部导航：待审 / 全部任务 / 用户 / 设置
import 'package:flutter/material.dart';

import '../main.dart';
import '../state.dart';
import '../util.dart';
import '../ws.dart';
import 'job_list_page.dart';
import 'settings_page.dart';
import 'users_page.dart';

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  int _index = 0;

  static const List<String> _titles = ['待审核任务', '全部任务', '用户', '设置'];

  @override
  void initState() {
    super.initState();
    WsService.instance.onAuthFailed = handleUnauthorized;
    WsService.instance.start();
    ensureForegroundService().catchError((Object _) {});
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_titles[_index])),
      body: Column(
        children: [
          ValueListenableBuilder<bool>(
            valueListenable: WsService.instance.connected,
            builder: (context, connected, _) {
              if (connected) return const SizedBox.shrink();
              return Container(
                width: double.infinity,
                color: Colors.orange.shade100,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                child: const Text('实时连接已断开，正在重连…（新任务通知可能延迟）', style: TextStyle(fontSize: 12)),
              );
            },
          ),
          Expanded(
            child: IndexedStack(
              index: _index,
              children: const [
                JobListPage(pendingOnly: true),
                JobListPage(pendingOnly: false),
                UsersPage(),
                SettingsPage(),
              ],
            ),
          ),
        ],
      ),
      bottomNavigationBar: ValueListenableBuilder<bool>(
        valueListenable: pendingUnread,
        builder: (context, unread, _) => NavigationBar(
          selectedIndex: _index,
          onDestinationSelected: (index) {
            setState(() => _index = index);
            if (index == 0) pendingUnread.value = false;
          },
          destinations: [
            NavigationDestination(
              icon: Badge(isLabelVisible: unread, child: const Icon(Icons.fact_check_outlined)),
              selectedIcon: const Icon(Icons.fact_check),
              label: '待审',
            ),
            const NavigationDestination(
              icon: Icon(Icons.list_alt_outlined),
              selectedIcon: Icon(Icons.list_alt),
              label: '任务',
            ),
            const NavigationDestination(
              icon: Icon(Icons.people_outline),
              selectedIcon: Icon(Icons.people),
              label: '用户',
            ),
            const NavigationDestination(
              icon: Icon(Icons.settings_outlined),
              selectedIcon: Icon(Icons.settings),
              label: '设置',
            ),
          ],
        ),
      ),
    );
  }
}

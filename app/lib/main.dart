// main.dart — AntiPrint 管理 App：登录态恢复、系统通知、前台服务保活、WS 事件分发
import 'package:flutter/material.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';

import 'notify.dart';
import 'pages/home_page.dart';
import 'pages/login_page.dart';
import 'session.dart';
import 'state.dart';
import 'ws.dart';

/// 前台服务回调（顶层函数，插件要求）：只负责保活，WebSocket 跑在主 isolate
@pragma('vm:entry-point')
void startCallback() {
  FlutterForegroundTask.setTaskHandler(KeepAliveHandler());
}

class KeepAliveHandler extends TaskHandler {
  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) async {}

  @override
  void onRepeatEvent(DateTime timestamp) {}

  @override
  Future<void> onDestroy(DateTime timestamp, bool isTimeout) async {}
}

/// 启动常驻前台服务（登录成功后调用）；已启动则重启一次
Future<void> ensureForegroundService() async {
  FlutterForegroundTask.init(
    androidNotificationOptions: AndroidNotificationOptions(
      channelId: 'antiprint_service',
      channelName: '实时任务监控',
      channelDescription: '保持与 AntiPrint 的连接，有新任务时立刻提醒',
      onlyAlertOnce: true,
    ),
    iosNotificationOptions: const IOSNotificationOptions(showNotification: false, playSound: false),
    foregroundTaskOptions: ForegroundTaskOptions(
      eventAction: ForegroundTaskEventAction.repeat(60000),
      autoRunOnBoot: true,
      autoRunOnMyPackageReplaced: true,
      allowWakeLock: true,
      allowWifiLock: true,
    ),
  );
  if (await FlutterForegroundTask.isRunningService) {
    await FlutterForegroundTask.restartService();
  } else {
    await FlutterForegroundTask.startService(
      serviceId: 256,
      notificationTitle: 'AntiPrint 监控中',
      notificationText: '新任务会实时提醒',
      callback: startCallback,
    );
  }
}

void _bindRealtime() {
  WsService.instance.lastJobEvent.addListener(() {
    final job = WsService.instance.lastJobEvent.value;
    if (job == null) return;
    Notify.showPending(job);
    pendingUnread.value = true;
    pendingVersion.value += 1;
  });
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  FlutterForegroundTask.initCommunicationPort();
  final token = await Session.restore();
  await Notify.init();
  _bindRealtime();
  runApp(AdminApp(loggedIn: token != null && token.isNotEmpty));
}

class AdminApp extends StatelessWidget {
  const AdminApp({super.key, required this.loggedIn});

  final bool loggedIn;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      navigatorKey: navigatorKey,
      title: 'AntiPrint 管理',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF0F9B8E)),
      ),
      home: loggedIn ? const HomePage() : const LoginPage(),
    );
  }
}

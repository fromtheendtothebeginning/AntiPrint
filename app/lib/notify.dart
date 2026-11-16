// notify.dart — 系统通知（新任务待审核时弹通知栏）
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

class Notify {
  Notify._();

  static final FlutterLocalNotificationsPlugin _plugin = FlutterLocalNotificationsPlugin();
  static const String _channelId = 'antiprint_pending';
  static const String _channelName = '待审任务提醒';
  static int _nextId = 1000;

  static Future<void> init() async {
    const settings = InitializationSettings(
      android: AndroidInitializationSettings('@mipmap/ic_launcher'),
    );
    await _plugin.initialize(settings);
    final android = _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    await android?.createNotificationChannel(
      const AndroidNotificationChannel(
        _channelId,
        _channelName,
        description: '有新的打印任务待审核时提醒你',
        importance: Importance.max,
      ),
    );
    await android?.requestNotificationsPermission();
  }

  /// 新任务待审核：标题带任务号，正文带提交人 / 文件名 / 配送方式
  static Future<void> showPending(Map<String, dynamic> job) async {
    final files = (job['files'] as List? ?? const []);
    final parts = <String>[
      (job['username'] ?? '').toString(),
      if (files.isNotEmpty) files.first.toString(),
      (job['delivery_mode'] ?? '').toString(),
    ].where((item) => item.isNotEmpty);
    await _plugin.show(
      _nextId++,
      '新任务待审核 #${job['id']}',
      parts.join(' · '),
      const NotificationDetails(
        android: AndroidNotificationDetails(
          _channelId,
          _channelName,
          channelDescription: '有新的打印任务待审核时提醒你',
          importance: Importance.max,
          priority: Priority.high,
        ),
      ),
    );
  }
}

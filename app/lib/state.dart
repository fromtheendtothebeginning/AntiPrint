// state.dart — 跨页面的轻量状态（未读角标、刷新信号、全局导航）
import 'package:flutter/material.dart';

/// 每来一条"新任务待审核"事件就 +1，列表页监听它自动刷新
final ValueNotifier<int> pendingVersion = ValueNotifier<int>(0);

/// 待审 tab 的红点（进入待审页刷新后清除）
final ValueNotifier<bool> pendingUnread = ValueNotifier<bool>(false);

/// 全局导航（令牌失效时从任意页面跳回登录页）
final GlobalKey<NavigatorState> navigatorKey = GlobalKey<NavigatorState>();

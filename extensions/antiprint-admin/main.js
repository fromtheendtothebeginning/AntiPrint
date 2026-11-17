// AntiPrint 管理拓展（Cordis）
//
// 在 AntiSIT 的「拓展」页里管理远程打印服务：待审任务通过/驳回、交接流转、
// 撤回/重打/删除、用户余额调账、充值赠送与打印设置，新任务会弹本地通知。
//
// 依赖宿主服务：ui / storage / notify（对应 ext.json 的 storage、network、notification 权限）

const DEFAULT_BASE = 'https://print.anticraft.top';
const POLL_MS = 30000;
const STATUS_FILTERS = [
  '全部', '待审核', '已通过', '打印中', '已打印',
  '待配送', '待取件', '已完成', '已驳回', '打印失败', '已撤回',
];

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
));

const money = (value) => {
  const amount = Number(value ?? 0);
  return '¥' + (Number.isFinite(amount) ? amount.toFixed(2) : '0.00');
};

const timeText = (value) => String(value ?? '').replace('T', ' ').slice(0, 16);

const filesOf = (job) => (Array.isArray(job && job.files) ? job.files : []);

function printOptionsText(job) {
  const options = job && job.print_options ? job.print_options : {};
  const parts = [];
  const copies = Number(job && job.copies) || 1;
  parts.push(copies + ' 份');
  if (options.paper) parts.push(options.paper);
  if (options.pages) parts.push('页 ' + options.pages);
  if (options.nup) parts.push('每面 ' + options.nup + ' 页');
  if (options.scale) parts.push(options.scale);
  return parts.join(' · ');
}

export default {
  name: 'antiprint-admin',
  inject: ['ui', 'storage', 'notify'],
  async apply(ctx) {
    const root = ctx.ui.root;
    const state = {
      base: DEFAULT_BASE,
      token: '',
      me: null,
      tab: 'pending',
      filter: '全部',
      jobs: [],
      users: [],
      agents: [],
      agentOnline: false,
      notifyOn: true,
      pendingSig: '',
      loading: false,
      booted: false,
      // 正在处理的任务 id：同一单的按钮在请求期间禁用，防止连点造成重复审核
      busyId: 0,
      refreshing: false,
      // 详情子页打开时不能整块重画根节点（会把子页栈一起冲掉）
      detailOpen: false,
    };
    let pollTimer = null;

    // ── 持久化 ──
    state.base = (await ctx.storage.get('base')) || DEFAULT_BASE;
    state.token = (await ctx.storage.get('token')) || '';
    state.notifyOn = (await ctx.storage.get('notify')) !== false;

    // ── 接口 ──
    async function api(path, options = {}) {
      const method = options.method || 'GET';
      const headers = { Accept: 'application/json' };
      if (state.token) headers.Authorization = 'Bearer ' + state.token;
      let body;
      if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(options.body);
      }
      let response;
      try {
        response = await fetch(state.base + path, { method, headers, body });
      } catch (err) {
        throw new Error('连不上服务器，请检查网络或服务器地址');
      }
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (response.status === 401) {
        await logout(true);
        throw new Error('登录已过期，请重新登录');
      }
      if (!response.ok) {
        let detail = '请求失败（' + response.status + '）';
        if (data && data.detail) {
          detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
        }
        throw new Error(detail);
      }
      return data;
    }

    // ── 登录态 ──
    async function login(username, password) {
      const data = await api('/api/login', { method: 'POST', body: { username, password } });
      const role = data && data.user ? data.user.role : '';
      if (role !== 'admin' && role !== 'root') {
        throw new Error('该账号不是管理员，无法使用管理拓展');
      }
      state.token = data.token;
      state.me = data.user;
      await ctx.storage.set('token', data.token);
      await ctx.storage.set('base', state.base);
      state.pendingSig = '';
      await refreshAll(true);
      startPolling();
      render();
    }

    async function logout(silent) {
      stopPolling();
      state.token = '';
      state.me = null;
      state.jobs = [];
      state.users = [];
      state.pendingSig = '';
      await ctx.storage.remove('token');
      render();
      if (!silent) ctx.ui.toast('已退出登录');
    }

    // ── 数据 ──
    async function loadJobs(silent) {
      const data = await api('/api/jobs');
      const before = state.jobs.map((job) => job.id + ':' + job.status).join(',');
      state.jobs = Array.isArray(data.jobs) ? data.jobs : [];
      state.agents = Array.isArray(data.agents) ? data.agents : [];
      state.agentOnline = data.agent_online === true;
      // 新待审通知：首次加载只记基线，不打扰
      const pendingIds = state.jobs.filter((job) => job.status === '待审核').map((job) => job.id);
      const signature = pendingIds.slice().sort((a, b) => a - b).join(',');
      if (state.pendingSig && signature !== state.pendingSig) {
        const previous = new Set(state.pendingSig.split(',').filter(Boolean).map(Number));
        const added = state.jobs.filter((job) => job.status === '待审核' && !previous.has(job.id));
        if (added.length && state.notifyOn) {
          const first = added[0];
          const fileCount = filesOf(first).length;
          ctx.notify.show({
            key: 'pending-' + first.id,
            title: '新任务待审核 #' + first.id,
            body: (first.username || '未知用户') + ' · ' + fileCount + ' 个文件 · ' + (first.delivery_mode || ''),
          });
        }
      }
      state.pendingSig = signature;
      // 轮询时只在数据真的变了才重画：避免每 30 秒整页闪一次，也保证新任务 / 状态变化能自动出现
      const after = state.jobs.map((job) => job.id + ':' + job.status).join(',');
      if (!silent || before !== after) render();
    }

    async function loadUsers() {
      const data = await api('/api/users');
      state.users = Array.isArray(data.users) ? data.users : [];
      if (!state.loading) render();
    }

    async function refreshAll(silent) {
      state.loading = true;
      state.refreshing = true;
      if (!silent) render();
      try {
        if (!state.me) {
          const me = await api('/api/me');
          state.me = me;
        }
        await loadJobs(true);
        await loadUsers();
      } catch (err) {
        if (!String(err.message).includes('重新登录')) ctx.ui.toast(err.message);
      } finally {
        state.loading = false;
        state.refreshing = false;
        render();
      }
    }

    // ── 轮询通知 ──
    function startPolling() {
      stopPolling();
      pollTimer = setInterval(() => {
        if (!state.token) return;
        loadJobs(true).catch(() => {});
      }, POLL_MS);
    }

    function stopPolling() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    ctx.effect(() => () => stopPolling());

    // ── 弹层 ──
    function askText(title, hint, initial) {
      return new Promise((resolve) => {
        const mask = document.createElement('div');
        mask.className = 'ap-mask';
        mask.innerHTML =
          '<div class="ap-dialog">' +
          '<h3>' + esc(title) + '</h3>' +
          '<textarea class="ap-input" rows="3" placeholder="' + esc(hint) + '">' + esc(initial || '') + '</textarea>' +
          '<div class="ap-dialog-actions">' +
          '<button class="ap-btn" data-role="cancel">取消</button>' +
          '<button class="ap-btn primary" data-role="ok">确定</button>' +
          '</div></div>';
        const input = mask.querySelector('textarea');
        const close = (value) => {
          mask.remove();
          resolve(value);
        };
        mask.addEventListener('click', (event) => {
          if (event.target === mask) return close(null);
          const role = event.target.closest('[data-role]');
          if (!role) return;
          if (role.dataset.role === 'cancel') close(null);
          if (role.dataset.role === 'ok') close(input.value.trim());
        });
        root.appendChild(mask);
        setTimeout(() => input.focus(), 30);
      });
    }

    function confirmBox(title, text) {
      return new Promise((resolve) => {
        const mask = document.createElement('div');
        mask.className = 'ap-mask';
        mask.innerHTML =
          '<div class="ap-dialog">' +
          '<h3>' + esc(title) + '</h3>' +
          '<p class="ap-dialog-text">' + esc(text) + '</p>' +
          '<div class="ap-dialog-actions">' +
          '<button class="ap-btn" data-role="cancel">取消</button>' +
          '<button class="ap-btn primary" data-role="ok">确定</button>' +
          '</div></div>';
        const close = (value) => {
          mask.remove();
          resolve(value);
        };
        mask.addEventListener('click', (event) => {
          if (event.target === mask) return close(false);
          const role = event.target.closest('[data-role]');
          if (!role) return;
          close(role.dataset.role === 'ok');
        });
        root.appendChild(mask);
      });
    }

    // ── 操作 ──
    /** 卡片退场：先淡出，再重排列表，别让点完「通过」后整页「啪」地跳一下 */
    function animateOut(jobId) {
      const card = root.querySelector('.ap-card[data-id="' + jobId + '"]');
      if (!card) return Promise.resolve();
      card.classList.add('leaving');
      return new Promise((resolve) => setTimeout(resolve, 160));
    }

    /** 用接口返回的最新任务替换列表里的同 id 项（先就地更新，再后台同步全量） */
    function applyJob(job) {
      if (!job || !job.id) return;
      state.jobs = state.jobs.map((item) => (item.id === job.id ? { ...item, ...job } : item));
    }

    async function runAction(action, job) {
      if (state.busyId) return false;
      state.busyId = job.id;
      try {
        let data = null;
        if (action === 'approve') {
          data = await api('/api/jobs/' + job.id + '/approve', { method: 'POST' });
          ctx.ui.toast('#' + job.id + ' 已通过审核');
        } else if (action === 'reject') {
          const reason = await askText('驳回任务 #' + job.id, '填写驳回理由（用户可见，费用会自动退回）');
          if (!reason) return false;
          data = await api('/api/jobs/' + job.id + '/reject', { method: 'POST', body: { reason } });
          ctx.ui.toast('#' + job.id + ' 已驳回');
        } else if (action === 'retry') {
          data = await api('/api/jobs/' + job.id + '/retry', { method: 'POST' });
          ctx.ui.toast('已重新入队');
        } else if (action === 'reprint') {
          if (!(await confirmBox('重新打印', '#' + job.id + ' 会重新进入打印队列，确定吗？'))) return false;
          data = await api('/api/jobs/' + job.id + '/reprint', { method: 'POST' });
          ctx.ui.toast('已重新入队');
        } else if (action === 'advance') {
          const to = job.delivery_mode === '取件' ? '待取件' : '待配送';
          data = await api('/api/jobs/' + job.id + '/advance', { method: 'POST', body: { to } });
          ctx.ui.toast('已标记为' + to);
        } else if (action === 'done') {
          data = await api('/api/jobs/' + job.id + '/advance', { method: 'POST', body: { to: '已完成' } });
          ctx.ui.toast('已标记为已完成');
        } else if (action === 'withdraw') {
          if (!(await confirmBox('撤回任务', '撤回后任务结束，已扣费用会自动退回。确定吗？'))) return false;
          data = await api('/api/jobs/' + job.id + '/withdraw', { method: 'POST' });
          ctx.ui.toast('已撤回并退费');
        } else if (action === 'delete') {
          if (!(await confirmBox('删除任务', '任务与上传文件会永久删除，未出纸的费用会退回。确定吗？'))) return false;
          data = await api('/api/jobs/' + job.id, { method: 'DELETE' });
          state.jobs = state.jobs.filter((item) => item.id !== job.id);
          ctx.ui.toast('已删除 #' + job.id);
          if (!state.detailOpen) render();
          return { deleted: true };
        } else {
          return true;
        }
        // 成功后：卡片淡出 → 就地更新状态 → 重画列表（详情页打开时只更新数据，不重画根节点）
        await animateOut(job.id);
        applyJob(data && data.job);
        if (!state.detailOpen) render();
        // 后台再同步一次全量（代理在线状态、别人的操作），失败不影响刚才的结果
        loadJobs(true).catch(() => {});
        return (data && data.job) || true;
      } catch (err) {
        ctx.ui.toast(String(err.message || err));
        // 409（状态已变化）或网络抖动：顺手刷新一次，别让界面停在旧状态
        loadJobs(true).catch(() => {});
        return false;
      } finally {
        state.busyId = 0;
      }
    }

    async function adjustBalance(user) {
      const value = await askText(
        '调整余额 · ' + user.username,
        '正数加钱、负数扣钱（最多两位小数），当前 ' + money(user.balance),
      );
      if (!value) return;
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount === 0) {
        ctx.ui.toast('请输入非 0 的金额');
        return;
      }
      try {
        const data = await api('/api/users/' + user.id + '/balance', {
          method: 'POST',
          body: { delta: String(amount), note: '手机端调账' },
        });
        ctx.ui.toast('已调账，当前余额 ' + money(data.balance));
        await loadUsers();
      } catch (err) {
        ctx.ui.toast(String(err.message || err));
      }
    }

    // ── 渲染：登录 ──
    function loginHtml() {
      return (
        '<section class="ap-login">' +
        '<div class="ap-logo">🖨</div>' +
        '<h1>AntiPrint 管理</h1>' +
        '<p class="ap-muted">用管理员账号登录远程打印服务</p>' +
        '<label class="ap-field"><span>服务器</span>' +
        '<input id="ap-base" class="ap-input" value="' + esc(state.base) + '" placeholder="' + DEFAULT_BASE + '"></label>' +
        '<label class="ap-field"><span>账号</span>' +
        '<input id="ap-user" class="ap-input" autocomplete="username" placeholder="管理员用户名"></label>' +
        '<label class="ap-field"><span>密码</span>' +
        '<input id="ap-pass" class="ap-input" type="password" autocomplete="current-password" placeholder="密码"></label>' +
        '<button class="ap-btn primary block" data-action="login">登录</button>' +
        '<p class="ap-hint">登录态保存在本机，只用于调用你自己的 AntiPrint 服务。</p>' +
        '</section>'
      );
    }

    async function submitLogin() {
      const baseInput = root.querySelector('#ap-base');
      const userInput = root.querySelector('#ap-user');
      const passInput = root.querySelector('#ap-pass');
      const base = (baseInput.value || '').trim() || DEFAULT_BASE;
      const username = (userInput.value || '').trim();
      const password = passInput.value || '';
      if (!username || !password) {
        ctx.ui.toast('请填写账号和密码');
        return;
      }
      state.base = base.replace(/\/+$/, '');
      const button = root.querySelector('[data-action="login"]');
      if (button) {
        button.disabled = true;
        button.textContent = '登录中…';
      }
      try {
        await login(username, password);
        ctx.ui.toast('已登录：' + (state.me ? state.me.username : username));
      } catch (err) {
        ctx.ui.toast(String(err.message || err));
        if (button) {
          button.disabled = false;
          button.textContent = '登录';
        }
      }
    }

    // ── 渲染：主界面 ──
    function jobCard(job, withActions) {
      const status = String(job.status || '');
      const files = filesOf(job);
      const busy = state.busyId === job.id;
      const actions = withActions
        ? '<div class="ap-actions">' +
          '<button class="ap-btn ok" data-action="approve" data-id="' + job.id + '"' + (busy ? ' disabled' : '') + '>' +
          (busy ? '处理中…' : '通过') + '</button>' +
          '<button class="ap-btn danger" data-action="reject" data-id="' + job.id + '"' + (busy ? ' disabled' : '') + '>驳回</button>' +
          '</div>'
        : '';
      return (
        '<article class="ap-card' + (busy ? ' busy' : '') + '" data-action="detail" data-id="' + job.id + '">' +
        '<div class="ap-row">' +
        '<span class="ap-id">#' + job.id + '</span>' +
        '<span class="ap-badge" data-status="' + esc(status) + '">' + esc(status) + '</span>' +
        '<span class="ap-amount">' + money(job.charge) + '</span>' +
        '</div>' +
        '<div class="ap-meta">' + esc(job.username || '未知用户') + ' · ' + files.length + ' 个文件 · ' + esc(job.delivery_mode || '') + '</div>' +
        '<div class="ap-sub">' + esc(printOptionsText(job)) + '</div>' +
        '<div class="ap-sub">' + esc(timeText(job.created_at)) + '</div>' +
        actions +
        '</article>'
      );
    }

    function jobListHtml() {
      const pendingOnly = state.tab === 'pending';
      const list = state.jobs.filter((job) => {
        if (pendingOnly) return job.status === '待审核';
        if (state.filter === '全部') return true;
        return job.status === state.filter;
      });
      if (!list.length) {
        return '<div class="ap-empty">' + (pendingOnly ? '没有待审核的任务' : '没有符合条件的任务') + '</div>';
      }
      return list.slice(0, 100).map((job) => jobCard(job, pendingOnly)).join('');
    }

    function usersHtml() {
      if (!state.users.length) return '<div class="ap-empty">没有用户</div>';
      return state.users.map((user) => (
        '<article class="ap-card">' +
        '<div class="ap-row">' +
        '<span class="ap-id">' + esc(user.username) + '</span>' +
        '<span class="ap-badge" data-status="' + (user.role === 'user' ? '已撤回' : '已通过') + '">' +
        (user.role === 'root' ? '超管' : (user.role === 'admin' ? '管理员' : '普通用户')) + '</span>' +
        '<span class="ap-amount">' + money(user.balance) + '</span>' +
        '</div>' +
        '<div class="ap-meta">' + (user.job_count || 0) + ' 单 · ' + esc(user.source || 'local') + '</div>' +
        '<div class="ap-actions">' +
        '<button class="ap-btn" data-action="balance" data-id="' + user.id + '">调整余额</button>' +
        '</div>' +
        '</article>'
      )).join('');
    }

    function mainHtml() {
      const filters = state.tab === 'jobs'
        ? '<div class="ap-chips">' + STATUS_FILTERS.map((label) => (
          '<button class="ap-chip' + (label === state.filter ? ' on' : '') + '" data-action="filter" data-filter="' + esc(label) + '">' + esc(label) + '</button>'
        )).join('') + '</div>'
        : '';
      const body = state.tab === 'users' ? usersHtml() : jobListHtml();
      return (
        '<div class="ap-app">' +
        '<header class="ap-head">' +
        '<div class="ap-title">' +
        '<b>' + (state.tab === 'pending' ? '待审核' : state.tab === 'jobs' ? '全部任务' : '用户') + '</b>' +
        '<span class="ap-dot ' + (state.agentOnline ? 'on' : '') + '">' +
        (state.agentOnline ? '代理在线' : '代理离线') + '</span>' +
        '</div>' +
        '<div class="ap-head-actions">' +
        '<button class="ap-icon' + (state.refreshing ? ' spinning' : '') + '" data-action="refresh" title="刷新">⟳</button>' +
        '<button class="ap-icon" data-action="settings" title="设置">⚙</button>' +
        '</div>' +
        '</header>' +
        filters +
        (state.loading ? '<div class="ap-loading">加载中…</div>' : '') +
        '<main class="ap-list">' + body + '</main>' +
        '<nav class="ap-tabs">' +
        '<button class="' + (state.tab === 'pending' ? 'on' : '') + '" data-action="tab" data-tab="pending">待审</button>' +
        '<button class="' + (state.tab === 'jobs' ? 'on' : '') + '" data-action="tab" data-tab="jobs">任务</button>' +
        '<button class="' + (state.tab === 'users' ? 'on' : '') + '" data-action="tab" data-tab="users">用户</button>' +
        '</nav>' +
        '</div>'
      );
    }

    function render() {
      // 详情页打开时根节点被压在下面：整块重画会把子页一起冲掉，等 onPop 再重画
      if (state.detailOpen) return;
      const list = root.querySelector('.ap-list');
      const scrollTop = list ? list.scrollTop : 0;
      root.innerHTML = state.token ? mainHtml() : loginHtml();
      const next = root.querySelector('.ap-list');
      if (next && scrollTop) next.scrollTop = scrollTop;
    }

    // ── 详情子页 ──
    function detailHtml(job) {
      const status = String(job.status || '');
      const buttons = [];
      if (status === '待审核') {
        buttons.push('<button class="ap-btn ok" data-detail-action="approve">通过</button>');
        buttons.push('<button class="ap-btn danger" data-detail-action="reject">驳回</button>');
      }
      if (status === '打印失败') {
        buttons.push('<button class="ap-btn primary" data-detail-action="retry">重试</button>');
      }
      if (status === '已打印') {
        buttons.push('<button class="ap-btn primary" data-detail-action="advance">' +
          (job.delivery_mode === '取件' ? '待取件' : '待配送') + '</button>');
        // 当场交付：直接跳到底，不用先点待取件/待配送再点完成
        buttons.push('<button class="ap-btn" data-detail-action="done">直接完成</button>');
      }
      if (status === '待配送' || status === '待取件') {
        buttons.push('<button class="ap-btn primary" data-detail-action="done">已完成</button>');
      }
      if (['已打印', '打印失败', '待配送', '待取件', '已完成'].includes(status)) {
        buttons.push('<button class="ap-btn" data-detail-action="reprint">重新打印</button>');
      }
      if (['待支付', '待审核', '已通过'].includes(status)) {
        buttons.push('<button class="ap-btn" data-detail-action="withdraw">撤回</button>');
      }
      buttons.push('<button class="ap-btn danger" data-detail-action="delete">删除</button>');

      const files = filesOf(job).map((file) => (
        '<li><span>' + esc(file.filename) + '</span>' +
        '<em>' + Math.round((Number(file.size) || 0) / 1024) + ' KB</em></li>'
      )).join('');

      return (
        '<div class="ap-detail">' +
        '<header class="ap-head"><button class="ap-icon" data-detail-action="back">←</button>' +
        '<div class="ap-title"><b>任务 #' + job.id + '</b></div></header>' +
        '<main class="ap-detail-body">' +
        '<section class="ap-card">' +
        '<div class="ap-row"><span class="ap-badge" data-status="' + esc(status) + '">' + esc(status) + '</span>' +
        '<span class="ap-amount">' + money(job.charge) + '</span></div>' +
        '<dl class="ap-dl">' +
        '<dt>提交人</dt><dd>' + esc(job.username || '未知') + '</dd>' +
        '<dt>配送方式</dt><dd>' + esc(job.delivery_mode || '') + '</dd>' +
        (job.address ? '<dt>地址</dt><dd>' + esc(job.address) + '</dd>' : '') +
        '<dt>打印设置</dt><dd>' + esc(printOptionsText(job)) + '</dd>' +
        '<dt>提交时间</dt><dd>' + esc(timeText(job.created_at)) + '</dd>' +
        (job.note ? '<dt>备注</dt><dd>' + esc(job.note) + '</dd>' : '') +
        (job.reject_reason ? '<dt>驳回理由</dt><dd>' + esc(job.reject_reason) + '</dd>' : '') +
        (job.print_error ? '<dt>打印错误</dt><dd>' + esc(job.print_error) + '</dd>' : '') +
        '</dl></section>' +
        '<section class="ap-card"><ul class="ap-files">' + (files || '<li>没有文件</li>') + '</ul>' +
        '<p class="ap-hint">文件预览需要在 AntiPrint 网站上打开（拓展运行在沙箱中，不能直接下载）。</p>' +
        '</section>' +
        '<div class="ap-actions wrap">' + buttons.join('') + '</div>' +
        '</main></div>'
      );
    }

    async function openDetail(jobId) {
      state.detailOpen = true;
      const sub = ctx.ui.push({
        onPop: () => {
          // 退层后列表按最新数据整页重画（动作里只改了数据，根节点被压着没重画）
          state.detailOpen = false;
          loadJobs(false).catch(() => {});
        },
      });
      const page = sub.root;
      page.innerHTML = '<div class="ap-loading">加载中…</div>';
      let job = null;
      try {
        const data = await api('/api/jobs/' + jobId);
        job = data.job;
        page.innerHTML = detailHtml(job);
      } catch (err) {
        page.innerHTML = '<div class="ap-empty">' + esc(String(err.message || err)) + '</div>';
        return;
      }
      page.addEventListener('click', async (event) => {
        const target = event.target.closest('[data-detail-action]');
        if (!target || !job || target.disabled) return;
        const action = target.dataset.detailAction;
        if (action === 'back') {
          sub.close();
          return;
        }
        target.disabled = true;
        const result = await runAction(action, job);
        if (!result) {
          target.disabled = false;
          return;
        }
        if (result.deleted) {
          sub.close();
          return;
        }
        // 接口返回的就是最新任务：直接拿它重画详情，不再多一次 GET
        if (result && result.id) job = result;
        page.innerHTML = detailHtml(job);
      });
    }

    // ── 设置 ──
    async function openSettings() {
      const mask = document.createElement('div');
      mask.className = 'ap-mask';
      mask.innerHTML =
        '<div class="ap-dialog">' +
        '<h3>设置</h3>' +
        '<dl class="ap-dl">' +
        '<dt>服务器</dt><dd>' + esc(state.base) + '</dd>' +
        '<dt>账号</dt><dd>' + esc(state.me ? state.me.username : '-') + '（' + esc(state.me ? state.me.role : '-') + '）</dd>' +
        '<dt>轮询</dt><dd>每 ' + Math.round(POLL_MS / 1000) + ' 秒检查新待审（页面打开时生效）</dd>' +
        '</dl>' +
        '<button class="ap-btn block" data-role="notify">待审通知：' + (state.notifyOn ? '开' : '关') + '</button>' +
        '<button class="ap-btn block danger" data-role="logout">退出登录</button>' +
        '<div class="ap-dialog-actions"><button class="ap-btn primary" data-role="close">关闭</button></div>' +
        '</div>';
      mask.addEventListener('click', async (event) => {
        if (event.target === mask) return mask.remove();
        const role = event.target.closest('[data-role]');
        if (!role) return;
        const value = role.dataset.role;
        if (value === 'close') {
          mask.remove();
        } else if (value === 'notify') {
          state.notifyOn = !state.notifyOn;
          await ctx.storage.set('notify', state.notifyOn);
          role.textContent = '待审通知：' + (state.notifyOn ? '开' : '关');
        } else if (value === 'logout') {
          mask.remove();
          await logout(false);
        }
      });
      root.appendChild(mask);
    }

    // ── 事件委托 ──
    root.addEventListener('click', async (event) => {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      if (action === 'login') {
        await submitLogin();
        return;
      }
      if (action === 'tab') {
        state.tab = target.dataset.tab;
        render();
        return;
      }
      if (action === 'filter') {
        state.filter = target.dataset.filter;
        render();
        return;
      }
      if (action === 'refresh') {
        await refreshAll(false);
        return;
      }
      if (action === 'settings') {
        await openSettings();
        return;
      }
      if (action === 'detail') {
        const id = Number(target.dataset.id);
        if (id) await openDetail(id);
        return;
      }
      if (action === 'balance') {
        const user = state.users.find((item) => item.id === Number(target.dataset.id));
        if (user) await adjustBalance(user);
        return;
      }
      if (action === 'approve' || action === 'reject') {
        const job = state.jobs.find((item) => item.id === Number(target.dataset.id));
        if (job) {
          target.disabled = true;   // 立刻反馈，不用等接口回来
          const result = await runAction(action, job);
          if (!result) target.disabled = false;
        }
      }
    });

    ctx.effect(() => () => {
      root.innerHTML = '';
    });

    // ── 启动 ──
    if (state.token) {
      try {
        state.me = await api('/api/me');
        await refreshAll(true);
        startPolling();
      } catch (err) {
        state.token = '';
        await ctx.storage.remove('token');
      }
    }
    render();
    state.booted = true;
  },
};

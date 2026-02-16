const API_ROOT = '';
let POLL_INTERVAL = 3000;
let currentAccountId = null; // null means 'all' or 'default', but for detailed views we need a specific ID
let accounts = [];
let logFilterAccountId = localStorage.getItem('logFilterAccountId') || 'all';
let lastServerUptime = 0;
let lastSyncTimestamp = 0;
let expHistory = [];
let expChart = null;
let adminToken = localStorage.getItem('adminToken') || '';
let isLoggedIn = false;
let pollTimer = null;
let lastAccountsPolledAt = 0;
let accountsLoading = false;
let seedLoadPromise = null;
const pendingAutomationKeys = new Set();
let latestConfigRevision = 0;
let expectedConfigRevision = 0;
let lastLogsRenderKey = '';
let lastStatusPolledAt = 0;
let lastOperationsData = {};
const logFilters = {
    module: localStorage.getItem('logFilterModule') || '',
    event: localStorage.getItem('logFilterEvent') || '',
    keyword: localStorage.getItem('logFilterKeyword') || '',
    isWarn: localStorage.getItem('logFilterIsWarn') || '',
};

const LOG_MODULE_LABELS = {
    farm: '农场',
    friend: '好友',
    scheduler: '调度',
    warehouse: '仓库',
    task: '任务',
    account: '账号',
    system: '系统',
};

const LOG_EVENT_LABELS = {
    farm_cycle: '农场巡查',
    lands_notify: '土地推送',
    remove_plant: '铲除枯死作物',
    seed_pick: '选种',
    seed_buy: '购买种子',
    seed_buy_skip: '种子购买跳过',
    plant_seed: '种植种子',
    fertilize: '施加化肥',
    friend_cycle: '好友巡查',
    friend_scan: '好友扫描',
    visit_friend: '访问好友',
    enter_farm: '进入农场',
    quiet_hours: '静默时段',
    sell_success: '出售成功',
    sell_done: '出售完成',
    sell_gain_pending: '出售收益待同步',
    sell_after_harvest: '收获后出售',
    sell_skip_invalid: '出售跳过',
    upgrade_land: '土地升级',
    unlock_land: '土地解锁',
    tick: '调度执行',
};

function shouldHideLogEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;
    const tag = String(entry.tag || '');
    const msg = String(entry.msg || '');
    if (tag === '物品') return true; // 屏蔽金币+/-等物品变更噪声
    if (msg.includes('获得物品')) return true;
    if (/金币\s*[+-]/.test(msg)) return true;
    return false;
}

function showExpChart(e) {
    e.preventDefault();
    const modal = document.getElementById('modal-chart');
    modal.classList.add('show');
    
    const ctx = document.getElementById('expChart').getContext('2d');
    if (expChart) expChart.destroy();
    
    expChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: expHistory.map(h => h.time),
            datasets: [{
                label: '累计获得经验',
                data: expHistory.map(h => h.exp),
                borderColor: '#2196F3',
                tension: 0.1
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: { beginAtZero: true }
            }
        }
    });
}

const $ = id => document.getElementById(id);

function pickAccountAvatar(acc) {
    if (!acc || typeof acc !== 'object') return '';
    const direct = acc.avatar || acc.avatarUrl || acc.headUrl || acc.faceUrl || acc.qlogo || '';
    if (direct) return direct;
    const qq = String(acc.qq || acc.uin || '').trim();
    if (/^\d{5,}$/.test(qq)) {
        return `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`;
    }
    const name = String(acc.name || '').trim();
    if (/^\d{5,}$/.test(name)) {
        return `https://q1.qlogo.cn/g?b=qq&nk=${name}&s=640`;
    }
    return '';
}

function updateTopbarAccount(acc) {
    const nameEl = $('topbar-account-name');
    const statusEl = $('topbar-account-status');
    const avatarEl = $('topbar-account-avatar');
    const fallbackEl = $('topbar-account-fallback');
    if (!nameEl || !statusEl || !avatarEl || !fallbackEl) return;

    const name = (acc && acc.name) ? String(acc.name) : '未选择账号';
    nameEl.textContent = name;
    if (acc && typeof acc.running === 'boolean') {
        statusEl.textContent = acc.running ? '运行中' : '已停止';
    } else if (name === '未登录') {
        statusEl.textContent = '未登录';
    } else if (name === '无账号') {
        statusEl.textContent = '未添加账号';
    } else {
        statusEl.textContent = '未选择';
    }

    const initial = (name && name.trim()) ? name.trim().charAt(0).toUpperCase() : '未';
    fallbackEl.textContent = initial;

    const avatar = pickAccountAvatar(acc);
    if (avatar) {
        avatarEl.src = avatar;
        avatarEl.style.display = '';
        fallbackEl.style.display = 'none';
    } else {
        avatarEl.removeAttribute('src');
        avatarEl.style.display = 'none';
        fallbackEl.style.display = '';
    }
}

function lockHorizontalSwipeOnMobile() {
    const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
    const isNarrow = window.matchMedia('(max-width: 980px)').matches;
    if (!isTouch || !isNarrow) return;

    let startX = 0;
    let startY = 0;
    document.addEventListener('touchstart', (e) => {
        if (!e.touches || e.touches.length !== 1) return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        if (!e.touches || e.touches.length !== 1) return;
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 6) {
            e.preventDefault();
        }
    }, { passive: false });
}

function updateValueWithAnim(id, newValue, className = 'value-changed') {
    const el = $(id);
    if (!el) return;
    // 只有在值变化且不为初始状态时才播放动画
    if (el.textContent !== '-' && el.textContent !== newValue) {
        el.textContent = newValue;
        el.classList.remove(className);
        void el.offsetWidth; // 触发重绘
        el.classList.add(className);
    } else {
        el.textContent = newValue;
    }
}

function renderOpsList(opsRaw) {
    const wrap = $('ops-list');
    if (!wrap) return;
    const ops = (opsRaw && typeof opsRaw === 'object') ? { ...opsRaw } : {};
    lastOperationsData = { ...ops };
    const labels = { harvest:'收获', water:'浇水', weed:'除草', bug:'除虫', fertilize:'施肥', plant:'种植', upgrade:'升级', steal:'偷菜', helpWater:'帮浇水', helpWeed:'帮除草', helpBug:'帮除虫', taskClaim:'任务', sell:'出售' };
    const fixedShow = ['harvest', 'steal', 'water', 'weed', 'bug', 'plant', 'sell'];
    const list = fixedShow.map((k) => [k, Number(ops[k] || 0)]);
    wrap.innerHTML = list.map(([k,v]) => `<div class="op-stat"><span class="label">${labels[k]||k}</span><span class="count">${v}</span></div>`).join('');
}

function resetDashboardStats() {
    const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    setText('gold', '0');
    setText('stat-gold', '+0');
    setText('level', 'Lv0');
    setText('exp-rate', '0/时');
    setText('stat-exp', '+0');
    setText('exp-num', '0/0');
    setText('time-to-level', '');
    setText('stat-uptime', '0:00');
    const fill = $('exp-fill');
    if (fill) fill.style.width = '0%';
    expHistory = [];
    renderOpsList({});
}

function clearFarmView(message = '暂无账号') {
    const grid = $('farm-grid');
    const sum = $('farm-summary');
    if (grid) grid.innerHTML = `<div style="padding:20px;text-align:center;color:#666">${message}</div>`;
    if (sum) sum.textContent = '';
}

function clearFriendsView(message = '暂无账号') {
    const wrap = $('friends-list');
    if (wrap) wrap.innerHTML = `<div style="padding:20px;text-align:center;color:#666">${message}</div>`;
}

function updateFriendSubControlsState() {
    const master = $('auto-friend');
    const wrap = $('friend-sub-controls');
    if (!master || !wrap) return;
    const enabled = !!master.checked;
    ['auto-friend-steal', 'auto-friend-help', 'auto-friend-bad'].forEach(id => {
        const input = $(id);
        if (input) input.disabled = !enabled;
    });
    wrap.classList.toggle('disabled', !enabled);
}

function renderLogFilterOptions() {
    const sel = $('logs-account-filter');
    if (!sel) return;

    const hasSelected = logFilterAccountId === 'all' || accounts.some(a => a.id === logFilterAccountId);
    if (!hasSelected) logFilterAccountId = 'all';

    const options = ['<option value="all">全部账号</option>'];
    accounts.forEach(acc => {
        options.push(`<option value="${acc.id}">${escapeHtml(acc.name)}</option>`);
    });
    sel.innerHTML = options.join('');
    sel.value = logFilterAccountId;
}

function initLogFiltersUI() {
    const moduleEl = $('logs-module-filter');
    const eventEl = $('logs-event-filter');
    const keywordEl = $('logs-keyword-filter');
    const warnEl = $('logs-warn-filter');

    if (moduleEl) moduleEl.value = logFilters.module;
    if (eventEl) eventEl.value = logFilters.event;
    if (keywordEl) keywordEl.value = logFilters.keyword;
    if (warnEl) warnEl.value = logFilters.isWarn;
}

function buildLogQuery() {
    const p = new URLSearchParams();
    p.set('limit', '50');
    p.set('accountId', logFilterAccountId || 'all');
    if (logFilters.module) p.set('module', logFilters.module);
    if (logFilters.event) p.set('event', logFilters.event);
    if (logFilters.keyword) p.set('keyword', logFilters.keyword);
    if (logFilters.isWarn !== '') p.set('isWarn', logFilters.isWarn);
    return p.toString();
}

function updateRevisionState(obj) {
    if (!obj || typeof obj !== 'object') return;
    const rev = Number(obj.configRevision || 0);
    if (rev > 0) {
        if (rev > latestConfigRevision) latestConfigRevision = rev;
        if (rev > expectedConfigRevision) expectedConfigRevision = rev;
    }
}

// ============ 工具函数 ============
function fmtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function fmtRemainSec(sec) {
    const n = Math.max(0, Math.floor(Number(sec) || 0));
    if (n <= 0) return '';
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    if (h > 0) return `${h}小时${m}分`;
    if (m > 0) return `${m}分`;
    return `${n}秒`;
}

function toSafeNumber(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

async function api(path, method = 'GET', body = null) {
    const headers = { 'Content-Type': 'application/json' };
    if (adminToken) headers['x-admin-token'] = adminToken;
    if (currentAccountId) {
        headers['x-account-id'] = currentAccountId;
    }
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    
    try {
        const r = await fetch(API_ROOT + path, opts);
        if (r.status === 401) {
            setLoginState(false);
            return null;
        }
        const j = await r.json();
        if (!j.ok) return null;
        return j.data === undefined ? true : j.data;
    } catch (e) {
        console.error('API Error:', e);
        return null;
    }
}

function showLogin(message = '') {
    const overlay = $('login-overlay');
    if (overlay) overlay.classList.add('show');
    const msg = $('login-error');
    if (msg) msg.textContent = message || '';
}

function hideLogin() {
    const overlay = $('login-overlay');
    if (overlay) overlay.classList.remove('show');
    const msg = $('login-error');
    if (msg) msg.textContent = '';
}

function stopPolling() {
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
}

function getPollIntervalMs() {
    if (document.visibilityState !== 'visible' || !isLoggedIn) return 10000;
    const activePage = document.querySelector('.page.active');
    const pageId = activePage ? activePage.id : '';
    if (!currentAccountId) return 8000;
    if (pageId === 'page-dashboard') return 3000;
    if (pageId === 'page-farm' || pageId === 'page-friends') return 4000;
    return 6000;
}

function startPolling() {
    stopPolling();
    const tick = async () => {
        if (document.visibilityState === 'visible' && isLoggedIn) {
            const activePage = document.querySelector('.page.active');
            const activePageId = activePage ? activePage.id : '';
            const now = Date.now();

            // 仅在首页高频拉状态，其他页面低频兜底刷新顶部连接状态
            const statusDue = activePageId === 'page-dashboard' || (now - lastStatusPolledAt > 12000);
            if (statusDue) {
                await pollStatus();
                lastStatusPolledAt = now;
            }

            // 周期刷新账号列表，确保被动删除（踢下线/离线自动删除）能及时反映到前端
            if (!accountsLoading && (now - lastAccountsPolledAt > 3500)) {
                accountsLoading = true;
                try {
                    await loadAccounts();
                } finally {
                    lastAccountsPolledAt = Date.now();
                    accountsLoading = false;
                }
            }

            // 运行日志只在首页拉取
            if (activePageId === 'page-dashboard') {
                await pollLogs();
            }

            if ($('page-accounts') && $('page-accounts').classList.contains('active')) {
                await pollAccountLogs();
            }
        }
        pollTimer = setTimeout(tick, getPollIntervalMs());
    };
    pollTimer = setTimeout(tick, 200);
}

function setLoginState(loggedIn) {
    isLoggedIn = loggedIn;
    if (loggedIn) {
        hideLogin();
        startPolling();
        loadAccounts();
    } else {
        stopPolling();
        currentAccountId = null;
        accounts = [];
        resetDashboardStats();
        logFilterAccountId = 'all';
        $('current-account-name').textContent = '未登录';
        updateTopbarAccount({ name: '未登录' });
        $('conn-text').textContent = '请登录';
        $('conn-dot').className = 'dot offline';
        clearFarmView('请先登录并选择账号');
        clearFriendsView('请先登录并选择账号');
        showLogin('');
    }
}

async function checkLogin() {
    if (!adminToken) {
        setLoginState(false);
        return;
    }
    const ping = await api('/api/ping');
    if (ping) {
        setLoginState(true);
    } else {
        setLoginState(false);
    }
}

async function doLogin() {
    const password = $('login-password').value;
    try {
        const r = await fetch(API_ROOT + '/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        if (r.status === 401) {
            showLogin('密码错误');
            return;
        }
        const j = await r.json();
        if (j && j.ok && j.data && j.data.token) {
            adminToken = j.data.token;
            localStorage.setItem('adminToken', adminToken);
            setLoginState(true);
        } else {
            showLogin('登录失败');
        }
    } catch (e) {
        console.error('Login Error:', e);
        showLogin('登录失败');
    }
}

// ============ 账号管理 ============
async function loadAccounts() {
    const list = await api('/api/accounts');
    if (list && list.accounts) {
        const prevCurrentId = String(currentAccountId || '');
        accounts = list.accounts;
        renderAccountSelector();
        renderAccountManager();
        renderLogFilterOptions();

        // 当前账号被删除或不存在时，自动回退
        const hasCurrent = currentAccountId && accounts.some(a => a.id === currentAccountId);
        if (!hasCurrent) currentAccountId = null;

        // 如果当前没有选中账号，且有账号，默认选第一个
        if (!currentAccountId && accounts.length > 0) {
            switchAccount(accounts[0].id);
        } else if (accounts.length === 0) {
            $('current-account-name').textContent = '无账号';
            updateTopbarAccount({ name: '无账号' });
            resetDashboardStats();
            clearFarmView('暂无账号，请先添加账号');
            clearFriendsView('暂无账号，请先添加账号');
        } else {
            updateTopbarAccount(accounts.find(a => a.id === currentAccountId) || null);
            if (!hasCurrent && prevCurrentId) {
                // 当前账号被删除后，农场/好友页数据立即切换到新账号
                if ($('page-farm').classList.contains('active')) loadFarm();
                if ($('page-friends').classList.contains('active')) loadFriends();
            }
        }
    }
}

function renderAccountSelector() {
    const dropdown = $('account-dropdown');
    dropdown.innerHTML = accounts.map(acc => `
        <div class="account-option ${acc.id === currentAccountId ? 'active' : ''}" data-id="${acc.id}">
            <i class="fas fa-user-circle"></i>
            <span>${acc.name}</span>
            ${acc.running ? '<span class="dot online"></span>' : '<span class="dot offline"></span>'}
        </div>
    `).join('');
    
    dropdown.querySelectorAll('.account-option').forEach(el => {
        el.addEventListener('click', () => {
            switchAccount(el.dataset.id);
            dropdown.classList.remove('show');
        });
    });
}

function switchAccount(id) {
    currentAccountId = id;
    expHistory = [];
    lastOperationsData = {};
    const acc = accounts.find(a => a.id === id);
    if (acc) {
        $('current-account-name').textContent = acc.name;
        updateTopbarAccount(acc);
    }
    const seedSel = $('seed-select');
    if (seedSel) {
        seedSel.dataset.loaded = '0';
        seedSel.innerHTML = '<option value="0">自动选择 (等级最高)</option>';
    }
    renderOpsList({});
    // 刷新所有数据
    pollStatus();
    pollLogs();
    if ($('page-farm').classList.contains('active')) loadFarm();
    if ($('page-friends').classList.contains('active')) loadFriends();
}

$('current-account-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('account-dropdown').classList.toggle('show');
});

document.addEventListener('click', () => $('account-dropdown').classList.remove('show'));

// ============ 核心轮询 ============
// 限制经验效率更新频率 (每10秒)
let lastRateUpdate = 0;

async function pollStatus() {
    if (!currentAccountId) {
        $('conn-text').textContent = '请添加账号';
        $('conn-dot').className = 'dot offline';
        resetDashboardStats();
        return;
    }

    const data = await api('/api/status');
    
    if (!data) {
        $('conn-text').textContent = '未连接';
        $('conn-dot').className = 'dot offline';
        lastServerUptime = 0;
        lastSyncTimestamp = 0;
        renderOpsList({});
        if (currentAccountId) {
            loadAccounts();
        }
        return;
    }

    const isConnected = data.connection?.connected;
    const statusRevision = Number(data.configRevision || 0);
    if (statusRevision > latestConfigRevision) latestConfigRevision = statusRevision;
    if (expectedConfigRevision > 0 && statusRevision >= expectedConfigRevision) {
        pendingAutomationKeys.clear();
    }
    $('conn-text').textContent = isConnected ? '运行中' : '未连接';
    $('conn-dot').className = 'dot ' + (isConnected ? 'online' : 'offline');

    // Stats
    $('level').textContent = data.status?.level ? 'Lv' + data.status.level : '-';
    
    updateValueWithAnim('gold', String(data.status?.gold ?? '-'), 'value-changed-gold');
    
    if (data.uptime !== undefined) {
        lastServerUptime = data.uptime;
        lastSyncTimestamp = Date.now();
        updateUptimeDisplay();
    }
    
    // Exp
    const ep = data.expProgress;
    if (ep && ep.needed > 0) {
        const pct = Math.min(100, (ep.current / ep.needed) * 100);
        $('exp-fill').style.width = pct + '%';
        $('exp-num').textContent = ep.current + '/' + ep.needed;
    }

    // Session Gains & History
    const expGain = toSafeNumber(data.sessionExpGained, 0);
    const goldGain = toSafeNumber(data.sessionGoldGained, 0);
    
    // stat-exp 显示会话总增量
    updateValueWithAnim('stat-exp', (expGain >= 0 ? '+' : '') + Math.floor(expGain));
    updateValueWithAnim('stat-gold', (goldGain >= 0 ? '+' : '') + Math.floor(goldGain), 'value-changed-gold');
    
    // 记录历史数据用于图表 (每分钟记录一次)
    const now = new Date();
    const timeLabel = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (expHistory.length === 0 || expHistory[expHistory.length - 1].time !== timeLabel) {
        expHistory.push({ time: timeLabel, exp: expGain, ts: now.getTime() });
        if (expHistory.length > 60) expHistory.shift();
    }

    // 效率计算 (每10秒更新一次)
    if (Date.now() - lastRateUpdate > 10000) {
        lastRateUpdate = Date.now();
        if (data.uptime > 0) { // 只要运行时间大于0就显示
            const hours = data.uptime / 3600;
            const finalRatePerHour = hours > 0 ? (expGain / hours) : 0;
            const rateDisplay = Math.floor(finalRatePerHour) + '/时';
            $('exp-rate').textContent = rateDisplay;
            
            // 预计升级
            if (data.expProgress && data.expProgress.needed > 0 && finalRatePerHour > 0) {
                // 计算还需要多少经验
                const expNeeded = data.expProgress.needed - data.expProgress.current;
                if (expNeeded > 0) {
                    const minsToLevel = expNeeded / (finalRatePerHour / 60);
                    if (minsToLevel < 60) {
                        $('time-to-level').textContent = `约 ${Math.ceil(minsToLevel)} 分钟升级`;
                    } else {
                        $('time-to-level').textContent = `约 ${(minsToLevel/60).toFixed(1)} 小时升级`;
                    }
                } else {
                    $('time-to-level').textContent = '即将升级';
                }
            } else if (finalRatePerHour <= 0) {
                $('time-to-level').textContent = '等待收益...';
            }
        } else {
            $('exp-rate').textContent = '等待数据...';
            $('time-to-level').textContent = '';
        }
    }

    // Automation Switches
    const auto = data.automation || {};
    if (!pendingAutomationKeys.has('farm')) $('auto-farm').checked = !!auto.farm;
    if (!pendingAutomationKeys.has('farm_push')) $('auto-farm-push').checked = !!auto.farm_push;
    if (!pendingAutomationKeys.has('land_upgrade')) $('auto-land-upgrade').checked = !!auto.land_upgrade;
    if (!pendingAutomationKeys.has('friend')) $('auto-friend').checked = !!auto.friend;
    if (!pendingAutomationKeys.has('task')) $('auto-task').checked = !!auto.task;
    if (!pendingAutomationKeys.has('sell')) $('auto-sell').checked = !!auto.sell;
    
    // 只有当用户没有正在操作时才更新下拉框，避免打断用户
    if (document.activeElement !== $('fertilizer-select') && auto.fertilizer) {
        $('fertilizer-select').value = auto.fertilizer;
    }
    
    // 好友细分开关
    if (!pendingAutomationKeys.has('friend_steal')) $('auto-friend-steal').checked = !!auto.friend_steal;
    if (!pendingAutomationKeys.has('friend_help')) $('auto-friend-help').checked = !!auto.friend_help;
    if (!pendingAutomationKeys.has('friend_bad')) $('auto-friend-bad').checked = !!auto.friend_bad;
    updateFriendSubControlsState();

    // Operations Stats
    const opsPayload = (data.operations && typeof data.operations === 'object')
        ? data.operations
        : lastOperationsData;
    renderOpsList(opsPayload || {});

    // Seed Pref
    if (document.activeElement !== $('seed-select') && data.preferredSeed !== undefined) {
        const sel = $('seed-select');
        if (sel.dataset.loaded !== '1') {
            await loadSeeds(data.preferredSeed);
        } else {
            sel.value = String(data.preferredSeed || 0);
        }
    }
}

async function pollLogs() {
    const list = await api(`/api/logs?${buildLogQuery()}`);
    const wrap = $('logs-list');
    const normalized = (Array.isArray(list) ? list : []).filter((l) => !shouldHideLogEntry(l));
    if (!normalized.length) { wrap.innerHTML = '<div class="log-row">暂无日志</div>'; return; }
    const renderKey = JSON.stringify(normalized.map(l => [l.time, l.tag, l.msg, !!l.isWarn, l.accountId, (l.meta && l.meta.event) || '', (l.meta && l.meta.module) || '']));
    if (renderKey === lastLogsRenderKey) return;
    lastLogsRenderKey = renderKey;
    wrap.innerHTML = normalized.slice().reverse().map(l => {
        const name = l.accountName ? `【${l.accountName}】` : '';
        const timeStr = ((l.time || '').split(' ')[1] || (l.time || ''));
        const moduleKey = (l.meta && l.meta.module) ? String(l.meta.module) : '';
        const eventKey = (l.meta && l.meta.event) ? String(l.meta.event) : '';
        const mod = moduleKey ? `(${LOG_MODULE_LABELS[moduleKey] || moduleKey})` : '';
        const eventLabel = LOG_EVENT_LABELS[eventKey] || '';
        const ev = eventLabel ? `[${eventLabel}]` : '';
        return `<div class="log-row ${l.isWarn?'warn':''}">
            <span class="log-time">${escapeHtml(timeStr)}</span>
            <span class="log-tag">[${escapeHtml(l.tag || '系统')}]</span>
            <span class="log-msg">${escapeHtml(`${name}${ev}${mod} ${l.msg}`)}</span>
        </div>`;
    }).join('');
}

function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// ============ 功能模块 ============

// 农场加载
async function loadFarm() {
    if (!currentAccountId) {
        clearFarmView('暂无账号，请先添加或选择账号');
        return;
    }
    const data = await api('/api/lands');
    const grid = $('farm-grid');
    const sum = $('farm-summary');
    
    if (!data || !data.lands) { 
        grid.innerHTML = '<div style="padding:20px;text-align:center;color:#666">无法获取数据，请确保账号已登录</div>'; 
        sum.textContent = ''; 
        return; 
    }

    const statusClass = { locked: 'locked', empty: 'empty', harvestable: 'harvestable', growing: 'growing', dead: 'dead', stealable: 'stealable', harvested: 'empty' };
    grid.innerHTML = data.lands.map(l => {
        let cls = statusClass[l.status] || 'empty';
        if (l.status === 'stealable') cls = 'harvestable'; // 复用样式
        const landLevel = Number(l.level || 0);
        const landLevelClass = `land-level-${Math.max(0, Math.min(4, landLevel))}`;
        const landTypeNameMap = {
            0: '未解锁',
            1: '黄土地',
            2: '红土地',
            3: '黑土地',
            4: '金土地'
        };
        const landTypeName = landTypeNameMap[Math.max(0, Math.min(4, landLevel))] || '土地';
        let phaseText = landLevel <= 0 ? '未解锁' : (l.phaseName || '');
        if (landLevel > 0 && Number(l.matureInSec || 0) > 0) {
            phaseText = `${phaseText} · ${fmtRemainSec(l.matureInSec)}后成熟`;
        }
        
        let needs = [];
        if (l.needWater) needs.push('水');
        if (l.needWeed) needs.push('草');
        if (l.needBug) needs.push('虫');
        return `
            <div class="land-cell ${cls} ${landLevelClass}">
                <span class="id">#${l.id}</span>
                <span class="plant-name">${l.plantName || '-'}</span>
                <span class="phase-name">${phaseText}</span>
                <span class="land-meta">${landTypeName}</span>
                ${needs.length ? `<span class="needs">${needs.join(' ')}</span>` : ''}
            </div>`;
    }).join('');
    
    const s = data.summary || {};
    sum.textContent = `可收:${s.harvestable||0} 长:${s.growing||0} 空:${s.empty||0} 枯:${s.dead||0}`;
}

// 好友列表加载
async function loadFriends() {
    if (!currentAccountId) {
        clearFriendsView('暂无账号，请先添加或选择账号');
        return;
    }
    const list = await api('/api/friends');
    const wrap = $('friends-list');
    
    if (!list || !list.length) { 
        wrap.innerHTML = '<div style="padding:20px;text-align:center;color:#666">暂无好友或数据加载失败</div>'; 
        return; 
    }

    wrap.innerHTML = list.map(f => {
        const p = f.plant || {};
        const info = [];
        if (p.stealNum) info.push(`偷${p.stealNum}`);
        if (p.dryNum) info.push(`水${p.dryNum}`);
        if (p.weedNum) info.push(`草${p.weedNum}`);
        if (p.insectNum) info.push(`虫${p.insectNum}`);
        const preview = info.length ? info.join(' ') : '无操作';
        
        return `
            <div class="friend-item">
                <div class="friend-header" onclick="toggleFriend('${f.gid}')">
                    <span class="name">${f.name}</span>
                    <span class="preview ${info.length?'has-work':''}">${preview}</span>
                </div>
                <div class="friend-actions">
                    <button class="btn btn-sm" onclick="friendQuickOp(event, '${f.gid}', 'steal')">一键偷取</button>
                    <button class="btn btn-sm" onclick="friendQuickOp(event, '${f.gid}', 'water')">一键浇水</button>
                    <button class="btn btn-sm" onclick="friendQuickOp(event, '${f.gid}', 'weed')">一键除草</button>
                    <button class="btn btn-sm" onclick="friendQuickOp(event, '${f.gid}', 'bug')">一键除虫</button>
                    <button class="btn btn-sm" onclick="friendQuickOp(event, '${f.gid}', 'bad')">一键捣乱</button>
                </div>
                <div id="friend-lands-${f.gid}" class="friend-lands" style="display:none">
                    <div style="padding:10px;text-align:center;color:#888"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>
                </div>
            </div>
        `;
    }).join('');
}

window.toggleFriend = async (gid) => {
    const el = document.getElementById(`friend-lands-${gid}`);
    if (el.style.display === 'block') {
        el.style.display = 'none';
        return;
    }
    
    // 收起其他
    document.querySelectorAll('.friend-lands').forEach(e => e.style.display = 'none');
    
    el.style.display = 'block';
    
    const data = await api(`/api/friend/${gid}/lands`);
    if (!data || !data.lands) {
        el.innerHTML = '<div style="padding:10px;text-align:center;color:#F44336">加载失败</div>';
        return;
    }
    
    const statusClass = { empty: 'empty', locked: 'empty', stealable: 'harvestable', harvested: 'empty', dead: 'dead', growing: 'growing' };
    const landTypeNameMap = {
        0: '未解锁',
        1: '黄土地',
        2: '红土地',
        3: '黑土地',
        4: '金土地'
    };
    el.innerHTML = `
        <div class="farm-grid mini">
            ${data.lands.map(l => {
                let cls = statusClass[l.status] || 'empty';
                const landLevel = Number(l.level || 0);
                const landLevelClass = `land-level-${Math.max(0, Math.min(4, landLevel))}`;
                const landTypeName = landTypeNameMap[Math.max(0, Math.min(4, landLevel))] || '土地';
                let phaseText = landLevel <= 0 ? '未解锁' : (l.phaseName || '');
                if (landLevel > 0 && Number(l.matureInSec || 0) > 0) {
                    phaseText = `${phaseText} · ${fmtRemainSec(l.matureInSec)}后成熟`;
                }
                let needs = [];
                if (l.needWater) needs.push('水');
                if (l.needWeed) needs.push('草');
                if (l.needBug) needs.push('虫');
                return `
                    <div class="land-cell ${cls} ${landLevelClass}">
                        <span class="id">#${l.id}</span>
                        <span class="plant-name">${l.plantName || '-'}</span>
                        <span class="phase-name">${phaseText}</span>
                        <span class="land-meta">${landTypeName}</span>
                         ${needs.length ? `<span class="needs">${needs.join(' ')}</span>` : ''}
                    </div>`;
            }).join('')}
        </div>
    `;
};

window.friendQuickOp = async (event, gid, opType) => {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    if (!currentAccountId) return;
    const opMap = { steal: '偷取', water: '浇水', weed: '除草', bug: '除虫', bad: '捣乱' };
    const btn = event && event.currentTarget ? event.currentTarget : null;
    if (btn) btn.disabled = true;
    try {
        const ret = await api(`/api/friend/${gid}/op`, 'POST', { opType });
        if (!ret) {
            alert(`一键${opMap[opType] || '操作'}失败`);
            return;
        }
        if (ret.message) alert(ret.message);
        const landsEl = document.getElementById(`friend-lands-${gid}`);
        if (landsEl && landsEl.style.display === 'block') {
            landsEl.innerHTML = '<div style="padding:10px;text-align:center;color:#888"><i class="fas fa-spinner fa-spin"></i> 刷新中...</div>';
            const data = await api(`/api/friend/${gid}/lands`);
            if (data && data.lands) {
                const statusClass = { empty: 'empty', locked: 'empty', stealable: 'harvestable', harvested: 'empty', dead: 'dead', growing: 'growing' };
                const landTypeNameMap = { 0: '未解锁', 1: '黄土地', 2: '红土地', 3: '黑土地', 4: '金土地' };
                landsEl.innerHTML = `
                    <div class="farm-grid mini">
                        ${data.lands.map(l => {
                            const cls = statusClass[l.status] || 'empty';
                            const landLevel = Number(l.level || 0);
                            const landLevelClass = `land-level-${Math.max(0, Math.min(4, landLevel))}`;
                            const landTypeName = landTypeNameMap[Math.max(0, Math.min(4, landLevel))] || '土地';
                            let phaseText = landLevel <= 0 ? '未解锁' : (l.phaseName || '');
                            if (landLevel > 0 && Number(l.matureInSec || 0) > 0) {
                                phaseText = `${phaseText} · ${fmtRemainSec(l.matureInSec)}后成熟`;
                            }
                            const needs = [];
                            if (l.needWater) needs.push('水');
                            if (l.needWeed) needs.push('草');
                            if (l.needBug) needs.push('虫');
                            return `
                                <div class="land-cell ${cls} ${landLevelClass}">
                                    <span class="id">#${l.id}</span>
                                    <span class="plant-name">${l.plantName || '-'}</span>
                                    <span class="phase-name">${phaseText}</span>
                                    <span class="land-meta">${landTypeName}</span>
                                    ${needs.length ? `<span class="needs">${needs.join(' ')}</span>` : ''}
                                </div>`;
                        }).join('')}
                    </div>
                `;
            }
        }
        loadFriends();
    } finally {
        if (btn) btn.disabled = false;
    }
};

// 种子加载
async function loadSeeds(preferredSeed) {
    if (seedLoadPromise) return seedLoadPromise;
    seedLoadPromise = (async () => {
    const list = await api('/api/seeds');
    const sel = $('seed-select');
    sel.innerHTML = '<option value="0">自动选择 (等级最高)</option>';
    if (list && list.length) {
        list.forEach(s => {
            const o = document.createElement('option');
            o.value = s.seedId;
            const levelText = (s.requiredLevel === null || s.requiredLevel === undefined) ? 'Lv?' : `Lv${s.requiredLevel}`;
            const priceText = (s.price === null || s.price === undefined) ? '价格未知' : `${s.price}金`;
            let text = `${levelText} ${s.name} (${priceText})`;
            if (s.locked) {
                text += ' [未解锁]';
                o.disabled = true;
                o.style.color = '#666';
            } else if (s.soldOut) {
                text += ' [售罄]';
                o.disabled = true;
                o.style.color = '#666';
            }
            o.textContent = text;
            sel.appendChild(o);
        });
    }
    sel.dataset.loaded = '1';
    if (preferredSeed !== undefined && preferredSeed !== null) {
        const preferredVal = String(preferredSeed || 0);
        if (preferredVal !== '0' && !Array.from(sel.options).some(opt => opt.value === preferredVal)) {
            const fallbackOption = document.createElement('option');
            fallbackOption.value = preferredVal;
            fallbackOption.textContent = `种子${preferredVal} (当前不可购买/详情未知)`;
            sel.appendChild(fallbackOption);
        }
        sel.value = preferredVal;
    }
    })().finally(() => {
        seedLoadPromise = null;
    });
    return seedLoadPromise;
}

// 绑定自动化开关
$('fertilizer-select').addEventListener('change', async () => {
    if (!currentAccountId) return;
    const resp = await api('/api/automation', 'POST', { fertilizer: $('fertilizer-select').value });
    updateRevisionState(resp);
});

['auto-farm', 'auto-farm-push', 'auto-land-upgrade', 'auto-friend', 'auto-task', 'auto-sell', 'auto-friend-steal', 'auto-friend-help', 'auto-friend-bad'].forEach((id, i) => {
    // 这里原来的 id 是数组里的元素，key 需要处理
    // id: auto-farm -> key: farm
    // id: auto-friend-steal -> key: friend_steal
    const key = id.replace('auto-', '').replace(/-/g, '_');
    const el = document.getElementById(id);
    if(el) {
        el.addEventListener('change', async () => {
            if (!currentAccountId) return;
            pendingAutomationKeys.add(key);
            const oldDisabled = el.disabled;
            el.disabled = true;
            const resp = await api('/api/automation', 'POST', { [key]: el.checked });
            if (resp === null) {
                // 保存失败，触发一次状态刷新回滚 UI
                await pollStatus();
            } else {
                updateRevisionState(resp);
            }
            setTimeout(() => {
                if (latestConfigRevision >= expectedConfigRevision) {
                    pendingAutomationKeys.delete(key);
                }
                el.disabled = oldDisabled;
            }, 600);
            if (id === 'auto-friend') {
                updateFriendSubControlsState();
            }
        });
    }
});
updateFriendSubControlsState();

$('seed-select').addEventListener('change', async () => {
    const v = parseInt($('seed-select').value) || 0;
    const resp = await api('/api/seed', 'POST', { seedId: v });
    updateRevisionState(resp);
});

const debugSellBtn = document.getElementById('btn-debug-sell');
if (debugSellBtn) {
    debugSellBtn.addEventListener('click', async () => {
        if (!currentAccountId) return;
        await api('/api/sell/debug', 'POST');
        pollLogs();
    });
}

$('btn-save-settings').addEventListener('click', async () => {
    const strategy = $('strategy-select').value;
    const farmInt = parseInt($('interval-farm').value);
    const friendInt = parseInt($('interval-friend').value);
    const seedId = parseInt($('seed-select').value) || 0;
    const friendQuietEnabled = !!$('friend-quiet-enabled').checked;
    const friendQuietStart = $('friend-quiet-start').value || '23:00';
    const friendQuietEnd = $('friend-quiet-end').value || '07:00';
    
    updateRevisionState(await api('/api/settings/strategy', 'POST', { strategy }));
    updateRevisionState(await api('/api/settings/interval', 'POST', { type: 'farm', value: farmInt }));
    updateRevisionState(await api('/api/settings/interval', 'POST', { type: 'friend', value: friendInt }));
    updateRevisionState(await api('/api/settings/friend-time', 'POST', {
        enabled: friendQuietEnabled,
        start: friendQuietStart,
        end: friendQuietEnd
    }));
    updateRevisionState(await api('/api/seed', 'POST', { seedId }));
    await loadSettings();
    alert('设置已保存');
});

// 加载额外设置
async function loadSettings() {
    const data = await api('/api/settings');
    if (data) {
        if (data.strategy) $('strategy-select').value = data.strategy;
        if (data.intervals) {
            $('interval-farm').value = data.intervals.farm || 60;
            $('interval-friend').value = data.intervals.friend || 60;
        }
        if (data.preferredSeed !== undefined) {
            const sel = $('seed-select');
            if (currentAccountId && sel.dataset.loaded !== '1') {
                await loadSeeds(data.preferredSeed);
            } else {
                sel.value = String(data.preferredSeed || 0);
            }
        }
        if (data.friendQuietHours) {
            $('friend-quiet-enabled').checked = !!data.friendQuietHours.enabled;
            $('friend-quiet-start').value = data.friendQuietHours.start || '23:00';
            $('friend-quiet-end').value = data.friendQuietHours.end || '07:00';
        }
        const enabled = !!$('friend-quiet-enabled').checked;
        $('friend-quiet-start').disabled = !enabled;
        $('friend-quiet-end').disabled = !enabled;
    }
}

const friendQuietEnabledEl = document.getElementById('friend-quiet-enabled');
if (friendQuietEnabledEl) {
    friendQuietEnabledEl.addEventListener('change', () => {
        const enabled = !!friendQuietEnabledEl.checked;
        $('friend-quiet-start').disabled = !enabled;
        $('friend-quiet-end').disabled = !enabled;
    });
}

// ============ UI 交互 ============
// 导航切换
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => {
        e.preventDefault();
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        item.classList.add('active');
        const pageId = 'page-' + item.dataset.page;
        const page = document.getElementById(pageId);
        if (page) page.classList.add('active');
        
        $('page-title').textContent = item.textContent.trim();
        if (item.dataset.page === 'dashboard') renderOpsList(lastOperationsData);
        
        if (item.dataset.page === 'farm') loadFarm();
        if (item.dataset.page === 'friends') loadFriends();
        if (item.dataset.page === 'analytics') loadAnalytics();
        if (item.dataset.page === 'settings') loadSettings();
        if (item.dataset.page === 'accounts') {
            renderAccountManager();
            pollAccountLogs();
        }
    });
});

// 数据分析
async function loadAnalytics() {
    const container = $('analytics-list');
    if (!container) return;
    container.innerHTML = '<div style="padding:20px;text-align:center;color:#888"><i class="fas fa-spinner fa-spin"></i> 加载中...</div>';
    
    const sort = $('analytics-sort').value;
    const list = await api(`/api/analytics?sort=${sort}`);
    
    if (!list || !list.length) {
        container.innerHTML = '<div style="padding:24px;text-align:center;color:#666;font-size:16px">暂无数据</div>';
        return;
    }
    
    // 表格头
    let html = `
    <table style="width:100%;border-collapse:collapse;font-size:16px;color:var(--text-main)">
        <thead>
            <tr style="border-bottom:1px solid var(--border);text-align:left;color:var(--text-sub)">
                <th style="padding:12px 10px">排名</th>
                <th style="padding:12px 10px">作物 (Lv)</th>
                <th style="padding:12px 10px">时间</th>
                <th style="padding:12px 10px">经验/时</th>
                <th style="padding:12px 10px">普通肥经验/时</th>
            </tr>
        </thead>
        <tbody>
    `;
    
    list.forEach((item, index) => {
        const lvText = (item.level === null || item.level === undefined || item.level === '' || Number(item.level) < 0)
            ? '未知'
            : String(item.level);
        html += `
            <tr style="border-bottom:1px solid var(--border);">
                <td style="padding:12px 10px">#${index + 1}</td>
                <td style="padding:12px 10px">
                    <div>${item.name}</div>
                    <div style="font-size:13px;color:var(--text-sub)">Lv${lvText}</div>
                </td>
                <td style="padding:12px 10px">${item.growTimeStr}</td>
                <td style="padding:12px 10px;font-weight:bold;color:var(--accent)">${item.expPerHour}</td>
                <td style="padding:12px 10px;font-weight:bold;color:var(--primary)">${item.normalFertilizerExpPerHour ?? '-'}</td>
            </tr>
        `;
    });
    
    html += '</tbody></table>';
    container.innerHTML = html;
}

$('analytics-sort').addEventListener('change', loadAnalytics);

// 农场操作
window.doFarmOp = async (type) => {
    if (!currentAccountId) return;
    if (confirm('确定执行此操作吗?')) {
        await api('/api/farm/operate', 'POST', { opType: type });
        loadFarm(); // 刷新
    }
};

// 任务列表相关代码已删除

// 账号管理页面
function renderAccountManager() {
    const wrap = $('accounts-list');
    wrap.innerHTML = accounts.map(a => `
        <div class="acc-item">
            <div class="name">${a.name}</div>
            <div style="margin-top:10px;display:flex;gap:10px;justify-content:flex-end">
                ${a.running 
                    ? `<button class="btn" style="font-size:12px;padding:5px 10px;background:#FF9800;color:#fff" onclick="stopAccount('${a.id}')">停止</button>`
                    : `<button class="btn btn-primary" style="font-size:12px;padding:5px 10px" onclick="startAccount('${a.id}')">启动</button>`
                }
                <button class="btn btn-primary" style="font-size:12px;padding:5px 10px" onclick="editAccount('${a.id}')">编辑</button>
                <button class="btn" style="font-size:12px;padding:5px 10px;color:#F44336" onclick="deleteAccount('${a.id}')">删除</button>
            </div>
        </div>
    `).join('');
}

async function pollAccountLogs() {
    const wrap = $('account-logs-list');
    if (!wrap) return;
    const list = await api('/api/account-logs?limit=100');
    if (!list || !list.length) {
        wrap.innerHTML = '<div class="log-row">暂无账号日志</div>';
        return;
    }
    wrap.innerHTML = list.slice().reverse().map(l => {
        const actionMap = {
            add: '添加',
            update: '更新',
            delete: '删除',
            kickout_delete: '踢下线删除',
        };
        const action = actionMap[l.action] || l.action || '操作';
        const reason = l.reason ? ` (原因: ${escapeHtml(String(l.reason))})` : '';
        return `<div class="log-row">
            <span class="log-time">${(l.time || '').split(' ')[1] || ''}</span>
            <span class="log-tag">[${action}]</span>
            <span class="log-msg">${escapeHtml(l.msg || '')}${reason}</span>
        </div>`;
    }).join('');
}

window.startAccount = async (id) => {
    await api(`/api/accounts/${id}/start`, 'POST');
    loadAccounts();
    pollAccountLogs();
    setTimeout(loadAccounts, 1000);
};

window.stopAccount = async (id) => {
    await api(`/api/accounts/${id}/stop`, 'POST');
    loadAccounts();
    pollAccountLogs();
    setTimeout(loadAccounts, 1000);
};

// 模态框逻辑
const modal = $('modal-add-acc');
const chartModal = $('modal-chart');
let editingAccountId = null;

// QR 登录相关变量
let currentQRCode = '';
let qrCheckInterval = null;

// ============ 扫码登录相关函数 ============
function switchTab(tabName) {
    // 隐藏所有标签页
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.style.display = 'none';
    });
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.style.color = 'var(--text-sub)';
        btn.style.borderBottom = 'none';
    });

    // 显示选中的标签页
    const tab = $(`tab-${tabName}`);
    if (tab) tab.style.display = 'block';

    // 高亮选中的按钮
    const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
    if (btn) {
        btn.style.color = 'var(--text-main)';
        btn.style.borderBottom = '2px solid var(--primary)';
    }

    // 切换底部按钮显示
    const footerManual = $('modal-footer-manual');
    const footerQR = $('modal-footer-qr');
    if (footerManual && footerQR) {
        if (tabName === 'qrcode') {
            footerManual.style.display = 'none';
            footerQR.style.display = 'flex';
        } else {
            footerManual.style.display = 'flex';
            footerQR.style.display = 'none';
        }
    }

    // 切换时清理扫码状态
    if (tabName === 'qrcode') {
        generateQRCode();
    } else {
        stopQRCheck();
    }
}

async function generateQRCode() {
    const btn = $('btn-qr-generate');
    if (btn) btn.disabled = true;
    const status = $('qr-status');
    if (status) {
        status.textContent = '正在生成二维码...';
        status.style.color = 'var(--sub)';
    }

    try {
        const result = await fetch('/api/qr/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }).then(r => r.json());

        if (result.ok && result.data) {
            currentQRCode = result.data.code;
            const img = $('qr-code-img');
            const display = $('qr-code-display');
            
            if (img && display) {
                // 使用 qrcode 字段（QR 图片 URL）
                img.src = result.data.qrcode || result.data.url;
                img.style.display = 'block';
                display.style.display = 'grid';
            }
            startQRCheck();
        } else {
            alert('生成二维码失败: ' + (result.error || '未知错误'));
        }
    } catch (e) {
        alert('生成二维码出错: ' + e.message);
    } finally {
        if (btn) btn.disabled = false;
    }
}

function startQRCheck() {
    stopQRCheck();
    let checkCount = 0;
    qrCheckInterval = setInterval(async () => {
        checkCount++;
        if (checkCount > 120) {
            // 2分钟超时
            stopQRCheck();
            alert('二维码已过期，请重新生成');
            return;
        }

        try {
            const result = await fetch('/api/qr/check', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: currentQRCode })
            }).then(r => r.json());

            if (result.ok && result.data) {
                const status = $('qr-status');
                if (status) {
                    if (result.data.status === 'Wait') {
                        status.textContent = '等待扫码...';
                        status.style.color = 'var(--text-sub)';
                    } else if (result.data.status === 'OK') {
                        status.textContent = '✓ 登录成功，正在保存...';
                        status.style.color = 'var(--primary)';
                        stopQRCheck();
                        
                        // 自动填入 Code
                        const loginCode = result.data.code || '';
                        $('acc-code').value = loginCode;
                        
                        // 获取备注名，如果没输入就用默认名
                        let accName = $('acc-name-qr').value.trim();
                        if (!accName) {
                            // 默认备注名使用 QQ 号（uin）
                            accName = result.data.uin ? String(result.data.uin) : '扫码账号';
                        }
                        
                        // 直接保存账号
                        try {
                            const qq = result.data.uin ? String(result.data.uin) : '';
                            const payload = { 
                                name: accName, 
                                code: loginCode, 
                                platform: 'qq',
                                uin: qq,
                                qq,
                                avatar: result.data.avatar || (qq ? `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640` : '')
                            };
                            
                            const saveResult = await fetch('/api/accounts', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
                                body: JSON.stringify(payload)
                            }).then(r => r.json());
                            
                            if (saveResult.ok) {
                                status.textContent = '✓ 保存成功';
                                setTimeout(() => {
                                    modal.classList.remove('show');
                                    loadAccounts();
                                }, 1000);
                            } else {
                                status.textContent = '✗ 保存失败: ' + (saveResult.error || '未知错误');
                                status.style.color = '#F44336';
                            }
                        } catch (e) {
                            status.textContent = '✗ 保存出错: ' + e.message;
                            status.style.color = '#F44336';
                        }
                    } else if (result.data.status === 'Used') {
                        status.textContent = '二维码已失效';
                        status.style.color = '#F44336';
                        stopQRCheck();
                    }
                }
            }
        } catch (e) {
            console.error('QR Check Error:', e);
        }
    }, 1000);
}

function stopQRCheck() {
    if (qrCheckInterval) {
        clearInterval(qrCheckInterval);
        qrCheckInterval = null;
    }
}

// 图表关闭逻辑
if (chartModal) {
    chartModal.querySelector('.close-modal').addEventListener('click', () => chartModal.classList.remove('show'));
    // 点击背景关闭
    chartModal.addEventListener('click', (e) => {
        if (e.target === chartModal) chartModal.classList.remove('show');
    });
}

$('btn-add-acc-modal').addEventListener('click', () => {
    editingAccountId = null;
    $('acc-name').value = '';
    $('acc-code').value = '';
    $('acc-name-qr').value = '';
    $('acc-platform').value = 'qq';
    currentQRCode = '';
    switchTab('manual');
    stopQRCheck();
    modal.querySelector('h3').textContent = '添加账号';
    modal.classList.add('show');
});

// 标签页切换
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        switchTab(btn.dataset.tab);
    });
});

const btnQrGenerate = $('btn-qr-generate');
if (btnQrGenerate) {
    btnQrGenerate.addEventListener('click', () => {
        generateQRCode();
    });
}

window.editAccount = (id) => {
    const acc = accounts.find(a => a.id === id);
    if (!acc) return;
    editingAccountId = id;
    $('acc-name').value = acc.name;
    $('acc-code').value = acc.code;
    $('acc-platform').value = acc.platform;
    currentQRCode = '';
    switchTab('manual');
    stopQRCheck();
    modal.querySelector('h3').textContent = '编辑账号';
    modal.classList.add('show');
};

document.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => {
        stopQRCheck();
        modal.classList.remove('show');
    });
});
$('btn-cancel-acc').addEventListener('click', () => {
    stopQRCheck();
    modal.classList.remove('show');
});

const btnCancelQR = $('btn-cancel-acc-qr');
if (btnCancelQR) {
    btnCancelQR.addEventListener('click', () => {
        stopQRCheck();
        modal.classList.remove('show');
    });
}

$('btn-save-acc').addEventListener('click', async () => {
    // 判断当前使用的标签页
    const isQRMode = document.getElementById('tab-qrcode').style.display !== 'none';
    
    let name, code, platform;
    
    if (isQRMode) {
        name = $('acc-name-qr').value.trim();
        code = $('acc-code').value.trim(); // 扫码结果会自动填入
        platform = 'qq'; // 扫码登录固定是 QQ
    } else {
        name = $('acc-name').value.trim();
        code = $('acc-code').value.trim();
        platform = $('acc-platform').value;

        // 仅用正则提取 code=xxx（兼容完整URL/片段）
        const match = code.match(/[?&]code=([^&]+)/i);
        if (match && match[1]) {
            code = decodeURIComponent(match[1]);
            $('acc-code').value = code;
        }
    }
    
    if (!name) return alert('请输入名称');
    if (!code) return alert('请输入Code 或 先扫码');
    
    const payload = { name, code, platform };
    if (editingAccountId) payload.id = editingAccountId;
    
    await api('/api/accounts', 'POST', payload);
    stopQRCheck();
    modal.classList.remove('show');
    loadAccounts();
    pollAccountLogs();
});

window.deleteAccount = async (id) => {
    if (confirm('确定删除该账号?')) {
        const ret = await api('/api/accounts/' + id, 'DELETE');
        if (!ret) return;
        const sid = String(id);
        accounts = accounts.filter(a => String(a.id) !== sid);
        if (String(currentAccountId || '') === sid) {
            currentAccountId = null;
        }
        renderAccountSelector();
        renderAccountManager();
        renderLogFilterOptions();
        if (accounts.length > 0) {
            switchAccount(accounts[0].id);
        } else {
            $('current-account-name').textContent = '无账号';
            updateTopbarAccount({ name: '无账号' });
            resetDashboardStats();
        }
        await loadAccounts();
        await pollAccountLogs();
    }
};

function updateUptimeDisplay() {
    if (lastSyncTimestamp > 0) {
        const elapsed = (Date.now() - lastSyncTimestamp) / 1000;
        const currentUptime = lastServerUptime + elapsed;
        const el = $('stat-uptime');
        if (el) el.textContent = fmtTime(currentUptime);
    }
}

function updateTime() {
    const now = new Date();
    const el = document.getElementById('sys-time');
    if (el) el.textContent = now.toLocaleTimeString();
}
setInterval(() => {
    updateTime();
    updateUptimeDisplay();
}, 1000);
updateTime();
lockHorizontalSwipeOnMobile();
updateTopbarAccount(null);

// 初始化
$('btn-refresh').addEventListener('click', () => { window.location.reload(); });

$('btn-theme').addEventListener('click', () => {
    document.body.classList.toggle('light-theme');
    const isLight = document.body.classList.contains('light-theme');
    $('btn-theme').innerHTML = isLight ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
});

const loginBtn = $('btn-login');
if (loginBtn) loginBtn.addEventListener('click', doLogin);
const loginInput = $('login-password');
if (loginInput) {
    loginInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doLogin();
    });
}

const logsFilterSel = $('logs-account-filter');
if (logsFilterSel) {
    logsFilterSel.value = logFilterAccountId;
    logsFilterSel.addEventListener('change', () => {
        logFilterAccountId = logsFilterSel.value || 'all';
        localStorage.setItem('logFilterAccountId', logFilterAccountId);
        pollLogs();
    });
}

const logsModuleSel = $('logs-module-filter');
if (logsModuleSel) {
    logsModuleSel.value = logFilters.module;
    logsModuleSel.addEventListener('change', () => {
        logFilters.module = logsModuleSel.value || '';
        localStorage.setItem('logFilterModule', logFilters.module);
        pollLogs();
    });
}

const logsWarnSel = $('logs-warn-filter');
if (logsWarnSel) {
    logsWarnSel.value = logFilters.isWarn;
    logsWarnSel.addEventListener('change', () => {
        logFilters.isWarn = logsWarnSel.value || '';
        localStorage.setItem('logFilterIsWarn', logFilters.isWarn);
        pollLogs();
    });
}

const logsEventInput = $('logs-event-filter');
if (logsEventInput) {
    logsEventInput.value = logFilters.event;
    logsEventInput.addEventListener('change', () => {
        logFilters.event = logsEventInput.value.trim();
        localStorage.setItem('logFilterEvent', logFilters.event);
        pollLogs();
    });
}

const logsKeywordInput = $('logs-keyword-filter');
if (logsKeywordInput) {
    logsKeywordInput.value = logFilters.keyword;
    let keywordTimer = null;
    const onKeywordChange = () => {
        if (keywordTimer) clearTimeout(keywordTimer);
        keywordTimer = setTimeout(() => {
            logFilters.keyword = logsKeywordInput.value.trim();
            localStorage.setItem('logFilterKeyword', logFilters.keyword);
            pollLogs();
        }, 250);
    };
    logsKeywordInput.addEventListener('input', onKeywordChange);
    logsKeywordInput.addEventListener('change', onKeywordChange);
}

initLogFiltersUI();

checkLogin();

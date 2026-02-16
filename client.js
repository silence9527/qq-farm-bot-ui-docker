/**
 * 主程序 - 进程管理器
 * 负责启动 Web 面板，并管理多个 Bot 子进程
 */

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { startAdminServer } = require('./src/admin');
const store = require('./src/store');
const { getAccounts, deleteAccount } = store;

const AUTO_DELETE_OFFLINE_MS = 5 * 60 * 1000; // 连续离线 5 分钟后自动删除账号

// ============ 状态管理 ============
// workers: { [accountId]: { process, status, logs: [], requestQueue: Map } }
const workers = {};
const GLOBAL_LOGS = []; // 全局系统日志
const ACCOUNT_LOGS = []; // 账号操作日志
let configRevision = Date.now();
const OPERATION_KEYS = ['harvest', 'water', 'weed', 'bug', 'fertilize', 'plant', 'steal', 'helpWater', 'helpWeed', 'helpBug', 'taskClaim', 'sell', 'upgrade'];

function nextConfigRevision() {
    configRevision += 1;
    return configRevision;
}

function buildConfigSnapshot() {
    return {
        automation: store.getAutomation(),
        plantingStrategy: store.getPlantingStrategy(),
        preferredSeedId: store.getPreferredSeed(),
        intervals: store.getIntervals(),
        friendQuietHours: store.getFriendQuietHours(),
        __revision: configRevision,
    };
}

function broadcastConfigToWorkers() {
    const snapshot = buildConfigSnapshot();
    for (const worker of Object.values(workers)) {
        try {
            worker.process.send({ type: 'config_sync', config: snapshot });
        } catch (e) {
            // ignore
        }
    }
}

function log(tag, msg) {
    const time = new Date().toLocaleString();
    console.log(`[${tag}] ${msg}`);
    GLOBAL_LOGS.push({ time, tag, msg });
    if (GLOBAL_LOGS.length > 200) GLOBAL_LOGS.shift();
}

function addAccountLog(action, msg, accountId = '', accountName = '', extra = {}) {
    const entry = {
        time: new Date().toLocaleString(),
        action,
        msg,
        accountId: accountId ? String(accountId) : '',
        accountName: accountName || '',
        ...extra,
    };
    ACCOUNT_LOGS.push(entry);
    if (ACCOUNT_LOGS.length > 300) ACCOUNT_LOGS.shift();
}

function normalizeStatusForPanel(data, accountId, accountName) {
    const src = (data && typeof data === 'object') ? data : {};
    const ops = (src.operations && typeof src.operations === 'object') ? { ...src.operations } : {};
    for (const k of OPERATION_KEYS) {
        if (ops[k] === undefined || ops[k] === null || Number.isNaN(Number(ops[k]))) {
            ops[k] = 0;
        } else {
            ops[k] = Number(ops[k]);
        }
    }
    return {
        ...src,
        accountId,
        accountName,
        operations: ops,
    };
}

function buildDefaultOperations() {
    const ops = {};
    for (const k of OPERATION_KEYS) ops[k] = 0;
    return ops;
}

function buildDefaultStatus(accountId) {
    return {
        connection: { connected: false },
        status: { name: '', level: 0, gold: 0, exp: 0, platform: 'qq' },
        uptime: 0,
        operations: buildDefaultOperations(),
        sessionExpGained: 0,
        sessionGoldGained: 0,
        lastExpGain: 0,
        lastGoldGain: 0,
        limits: {},
        automation: store.getAutomation(),
        preferredSeed: store.getPreferredSeed(),
        expProgress: { current: 0, needed: 0, level: 0 },
        configRevision,
        accountId: String(accountId || ''),
    };
}

function filterLogs(list, filters = {}) {
    const f = filters || {};
    const keyword = String(f.keyword || '').trim().toLowerCase();
    const keywordTerms = keyword ? keyword.split(/\s+/).filter(Boolean) : [];
    const tag = String(f.tag || '').trim();
    const moduleName = String(f.module || '').trim();
    const eventName = String(f.event || '').trim();
    const isWarn = f.isWarn;
    return (list || []).filter((l) => {
        if (tag && String(l.tag || '') !== tag) return false;
        if (moduleName && String((l.meta || {}).module || '') !== moduleName) return false;
        if (eventName && String((l.meta || {}).event || '') !== eventName) return false;
        if (isWarn !== undefined && isWarn !== null && String(isWarn) !== '') {
            const expected = String(isWarn) === '1' || String(isWarn).toLowerCase() === 'true';
            if (!!l.isWarn !== expected) return false;
        }
        if (keywordTerms.length > 0) {
            const text = String(l._searchText || `${l.msg || ''} ${l.tag || ''}`).toLowerCase();
            for (const term of keywordTerms) {
                if (!text.includes(term)) return false;
            }
        }
        return true;
    });
}

// ============ Bot 进程管理 ============

function startWorker(account) {
    if (workers[account.id]) return; // 已运行

    log('系统', `正在启动账号: ${account.name}`);
    
    const workerPath = path.join(__dirname, 'src', 'worker.js');
    const child = fork(workerPath, [], {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc']
    });

    workers[account.id] = {
        process: child,
        status: null, // 最新状态快照
        logs: [],
        requests: new Map(), // pending API requests
        reqId: 1,
        name: account.name,
        stopping: false,
        disconnectedSince: 0,
        autoDeleteTriggered: false,
    };

    // 发送启动指令
    child.send({
        type: 'start',
        config: {
            code: account.code,
            platform: account.platform,
        }
    });
    child.send({ type: 'config_sync', config: buildConfigSnapshot() });

    // 监听消息
    child.on('message', (msg) => {
        handleWorkerMessage(account.id, msg);
    });

    child.on('exit', (code) => {
        log('系统', `账号 ${account.name} 进程退出 (code=${code})`);
        delete workers[account.id];
    });
}

function stopWorker(accountId) {
    const worker = workers[accountId];
    if (worker) {
        worker.stopping = true;
        worker.process.send({ type: 'stop' });
        // process.kill will happen in 'exit' handler or we can force it
        setTimeout(() => {
            if (workers[accountId]) {
                worker.process.kill();
                delete workers[accountId];
            }
        }, 1000);
    }
}

function handleWorkerMessage(accountId, msg) {
    const worker = workers[accountId];
    if (!worker) return;

    if (msg.type === 'status_sync') {
        // 合并状态
        worker.status = normalizeStatusForPanel(msg.data, accountId, worker.name);
        const connected = !!(msg.data && msg.data.connection && msg.data.connection.connected);
        if (connected) {
            worker.disconnectedSince = 0;
            worker.autoDeleteTriggered = false;
        } else if (!worker.stopping) {
            const now = Date.now();
            if (!worker.disconnectedSince) worker.disconnectedSince = now;
            const offlineMs = now - worker.disconnectedSince;
            if (!worker.autoDeleteTriggered && offlineMs >= AUTO_DELETE_OFFLINE_MS) {
                worker.autoDeleteTriggered = true;
                const offlineMin = Math.floor(offlineMs / 60000);
                log('系统', `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，自动删除账号信息`);
                addAccountLog(
                    'offline_delete',
                    `账号 ${worker.name} 持续离线 ${offlineMin} 分钟，已自动删除`,
                    accountId,
                    worker.name,
                    { reason: 'offline_timeout', offlineMs }
                );
                stopWorker(accountId);
                try {
                    deleteAccount(accountId);
                } catch (e) {
                    log('错误', `删除离线账号失败: ${e.message}`);
                }
            }
        }
    } else if (msg.type === 'log') {
        // 保存日志
        const logEntry = {
            ...msg.data,
            accountId,
            accountName: worker.name,
            meta: msg.data && msg.data.meta ? msg.data.meta : {},
        };
        logEntry._searchText = `${logEntry.msg || ''} ${logEntry.tag || ''} ${JSON.stringify(logEntry.meta || {})}`.toLowerCase();
        worker.logs.push(logEntry);
        if (worker.logs.length > 200) worker.logs.shift();
        GLOBAL_LOGS.push(logEntry);
        if (GLOBAL_LOGS.length > 200) GLOBAL_LOGS.shift();
    } else if (msg.type === 'error') {
        log('错误', `账号[${accountId}]进程报错: ${msg.error}`);
    } else if (msg.type === 'account_kicked') {
        const reason = msg.reason || '未知';
        log('系统', `账号 ${worker.name} 被踢下线，自动删除账号信息`);
        addAccountLog('kickout_delete', `账号 ${worker.name} 被踢下线，已自动删除`, accountId, worker.name, { reason });
        stopWorker(accountId);
        try {
            deleteAccount(accountId);
        } catch (e) {
            log('错误', `删除被踢账号失败: ${e.message}`);
        }
    } else if (msg.type === 'api_response') {
        const { id, result, error } = msg;
        const req = worker.requests.get(id);
        if (req) {
            if (error) req.reject(new Error(error));
            else req.resolve(result);
            worker.requests.delete(id);
        }
    }
}

// 代理 API 调用到子进程
function callWorkerApi(accountId, method, ...args) {
    const worker = workers[accountId];
    if (!worker) return Promise.reject(new Error('账号未运行'));

    return new Promise((resolve, reject) => {
        const id = worker.reqId++;
        worker.requests.set(id, { resolve, reject });
        
        // 超时处理
        setTimeout(() => {
            if (worker.requests.has(id)) {
                worker.requests.delete(id);
                reject(new Error('API Timeout'));
            }
        }, 10000);

        worker.process.send({ type: 'api_call', id, method, args });
    });
}

// ============ Data Provider for Admin Server ============
// 这是一个适配器，让 admin.js 可以通过统一接口获取数据
const dataProvider = {
    // 获取指定账号的状态 (如果 accountId 为空，返回概览?)
    getStatus: (accountId) => {
        if (!accountId) return buildDefaultStatus('');
        const w = workers[accountId];
        if (!w || !w.status) return buildDefaultStatus(accountId);
        return {
            ...buildDefaultStatus(accountId),
            ...normalizeStatusForPanel(w.status, accountId, w.name),
        };
    },
    
    getLogs: (accountId, optionsOrLimit) => {
        const opts = (typeof optionsOrLimit === 'object' && optionsOrLimit) ? optionsOrLimit : { limit: optionsOrLimit };
        const max = Math.max(1, Number(opts.limit) || 100);
        if (!accountId) {
            return filterLogs(GLOBAL_LOGS, opts).slice(-max).reverse();
        }
        const accId = String(accountId);
        return filterLogs(GLOBAL_LOGS.filter(l => String(l.accountId || '') === accId), opts).slice(-max).reverse();
    },
    getAccountLogs: (limit) => ACCOUNT_LOGS.slice(-limit).reverse(),
    addAccountLog: (action, msg, accountId, accountName, extra) => addAccountLog(action, msg, accountId, accountName, extra),

    // 透传方法
    getLands: (accountId) => callWorkerApi(accountId, 'getLands'),
    getFriends: (accountId) => callWorkerApi(accountId, 'getFriends'),
    getFriendLands: (accountId, gid) => callWorkerApi(accountId, 'getFriendLands', gid),
    doFriendOp: (accountId, gid, opType) => callWorkerApi(accountId, 'doFriendOp', gid, opType),
    getSeeds: (accountId) => callWorkerApi(accountId, 'getSeeds'),
    
    setAutomation: async (accountId, key, value) => {
        store.setAutomation(key, value);
        const rev = nextConfigRevision();
        broadcastConfigToWorkers();
        return { automation: store.getAutomation(), configRevision: rev };
    },
    setSeed: async (accountId, seedId) => {
        store.setPreferredSeed(seedId);
        const rev = nextConfigRevision();
        broadcastConfigToWorkers();
        return { preferredSeed: store.getPreferredSeed(), configRevision: rev };
    },
    reconnect: (accountId, code) => callWorkerApi(accountId, 'reconnect', { code }),
    
    getTasks: (accountId) => callWorkerApi(accountId, 'getTasks'),
    claimTask: (accountId, taskId) => callWorkerApi(accountId, 'claimTask', taskId),
    doFarmOp: (accountId, opType) => callWorkerApi(accountId, 'doFarmOp', opType),
    doAnalytics: (accountId, sortBy) => callWorkerApi(accountId, 'getAnalytics', sortBy),
    setPlantingStrategy: async (accountId, strategy) => {
        store.setPlantingStrategy(strategy);
        const rev = nextConfigRevision();
        broadcastConfigToWorkers();
        return { plantingStrategy: store.getPlantingStrategy(), configRevision: rev };
    },
    setIntervals: async (accountId, type, value) => {
        store.setIntervals(type, value);
        const rev = nextConfigRevision();
        broadcastConfigToWorkers();
        return { intervals: store.getIntervals(), configRevision: rev };
    },
    getIntervals: (accountId) => callWorkerApi(accountId, 'getIntervals'),
    getPlantingStrategy: (accountId) => callWorkerApi(accountId, 'getPlantingStrategy'),
    setFriendQuietHours: async (accountId, cfg) => {
        store.setFriendQuietHours(cfg || {});
        const rev = nextConfigRevision();
        broadcastConfigToWorkers();
        return { friendQuietHours: store.getFriendQuietHours(), configRevision: rev };
    },
    debugSellFruits: (accountId) => callWorkerApi(accountId, 'debugSellFruits'),

    // 账号管理直接操作 store
    getAccounts: () => {
        const data = getAccounts();
        // 注入运行状态
        data.accounts.forEach(a => {
            a.running = !!workers[a.id];
        });
        return data;
    },
    
    startAccount: (id) => {
        const data = getAccounts();
        const acc = data.accounts.find(a => a.id === id);
        if (acc) startWorker(acc);
    },
    
    stopAccount: (id) => stopWorker(id),
};

// ============ 主入口 ============
async function main() {
    console.log('正在启动 QQ农场多账号管理服务...');
    
    // 1. 启动 Admin Server
    startAdminServer(dataProvider);

    // 2. 自动启动所有账号 (可选，目前默认不自动启动，或者读取配置)
    const accounts = getAccounts().accounts || [];
    if (accounts.length > 0) {
        log('系统', `发现 ${accounts.length} 个账号，正在启动...`);
        accounts.forEach(acc => startWorker(acc));
    } else {
        log('系统', '未发现账号，请访问管理面板添加账号');
    }
}

main().catch(err => console.error(err));

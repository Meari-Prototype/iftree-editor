// 共享后端的本地管道服务端（projectneed 18-6-1）。
// 协议沿用 15-8 的 JSON-L 请求/响应 + 流式事件，只换传输层：stdio 是父子一对一管道，
// 结构上不能多客户端共享；这里用 net 本地管道（win 命名管道 / posix unix socket）。
// 多客户端要点：各客户端的请求 id 各自从 1 起会撞——服务端按连接重写 envelope id
// （c<连接序号>:<原 id>），宿主回流的响应与流事件按重写 id 找回连接、还原原 id 下发。
// 请求执行沿用单队列全局串行（单写者语义），取消/摘要类请求照旧插队。
import { createServer, connect } from 'node:net';
import { createInterface } from 'node:readline';
import { unlinkSync } from 'node:fs';

const IMMEDIATE_TYPES = new Set(['ping', 'agent.cancel', 'summary.cancelNode', 'summary.generateNode']);

function errorPayload(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || ''
  };
}

// 判活探测：能连上同名管道说明已有共享后端在跑。用于监听被拒后区分「活人占用（让位）」
// 与「posix 陈尸文件（清掉重试）」；也供测试自检。
export function probeBackendPipe(pipeName, timeoutMs = 500) {
  return new Promise((resolveProbe) => {
    let settled = false;
    const socket = connect(pipeName);
    const finish = (alive) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(alive);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

export function createSharedBackendServer({ handleRequest = null, onShutdown = null } = {}) {
  if (typeof handleRequest !== 'function') throw new Error('createSharedBackendServer requires handleRequest');
  let server = null;
  let connSeq = 0;
  let queue = Promise.resolve();
  let shuttingDown = false;
  // bulk 独占闸门：异步写 pragma 挂在共享连接上、对所有客户端生效（store.beginBulkImport），
  // 所以开启必须独占——有其他客户端在线即拒；期间其他连接的写一律拒；独占者掉线自动恢复安全设置。
  let bulkOwnerConn = null;
  const routes = new Map();
  const sockets = new Set();

  function sendEvent(envelope = {}) {
    const route = routes.get(String(envelope.id ?? ''));
    if (!route) return;
    route.write({ ...envelope, id: route.origId });
  }

  function handleConnection(socket) {
    const connId = ++connSeq;
    sockets.add(socket);
    const ownedIds = new Set();
    let rl = null;
    const dropConnection = () => {
      rl?.close();
      sockets.delete(socket);
      for (const id of ownedIds) routes.delete(id);
      ownedIds.clear();
      if (bulkOwnerConn === connId) {
        // 独占者掉线：不能让后端永久停在异步写（其余客户端还会被闸门永久拒写），排队补一个 end。
        bulkOwnerConn = null;
        if (!shuttingDown) {
          queue = queue.then(() => handleRequest({
            id: `c${connId}:auto-bulk-end`,
            type: 'database.write',
            payload: { action: 'stream.bulkEnd' }
          }).catch(() => { /* 恢复失败无路可报，store 下次 init 会重设 */ }));
        }
      }
    };
    // 监听先于首次写入：探测连接（probe）连上即断，ready 帧可能写进已断管道（EPIPE），
    // 无 error 监听时是 uncaughtException，会带崩整个共享后端。
    socket.on('close', dropConnection);
    socket.on('error', () => { /* close 紧随其后 */ });

    const write = (message, callback) => {
      if (socket.destroyed) {
        callback?.();
        return;
      }
      socket.write(`${JSON.stringify(message)}\n`, callback);
    };
    write({ id: null, type: 'ready', pid: process.pid, shared: true });

    rl = createInterface({ input: socket, crlfDelay: Infinity });
    // readline 会把 input 的 error 转发 re-emit 到 Interface 自身；不挂监听，
    // socket 的 EPIPE（探测连接连上即断）会以 uncaughtException 带崩共享后端。
    rl.on('error', () => { /* socket 侧已处理，close 紧随其后 */ });
    rl.on('line', (line) => {
      const raw = String(line || '').trim();
      if (!raw || shuttingDown) return;
      let request = null;
      try {
        request = JSON.parse(raw);
      } catch (error) {
        write({ id: null, type: 'error', error: errorPayload(error) });
        return;
      }
      const type = String(request.type || '').trim();
      const origId = request.id == null ? '' : String(request.id);
      const action = type === 'database.write' ? String(request.payload?.action || '').trim() : '';
      if (action === 'stream.bulkBegin' && sockets.size > 1) {
        write({ id: origId, type: 'error', error: errorPayload(new Error(`批量导入需要独占共享后端：当前还有 ${sockets.size - 1} 个其他客户端在线`)) });
        return;
      }
      if (action === 'stream.bulkEnd' && bulkOwnerConn !== null && bulkOwnerConn !== connId) {
        write({ id: origId, type: 'error', error: errorPayload(new Error('批量导入会话由其他客户端开启，只能由开启方结束')) });
        return;
      }
      if (bulkOwnerConn !== null && bulkOwnerConn !== connId && type === 'database.write') {
        write({ id: origId, type: 'error', error: errorPayload(new Error('批量导入进行中（独占），写请求暂被拒绝；读不受影响')) });
        return;
      }
      if (action === 'stream.bulkBegin') bulkOwnerConn = connId;
      if (action === 'stream.bulkEnd') bulkOwnerConn = null;
      const serverId = `c${connId}:${origId}`;
      routes.set(serverId, { write, origId });
      ownedIds.add(serverId);
      const run = async () => {
        try {
          const result = await handleRequest({ ...request, id: serverId });
          if (type === 'shutdown') {
            shuttingDown = true;
            // 先把响应冲出去再退场，避免 exit 截断缓冲。
            await new Promise((resolveWrite) => write({ id: origId, type: 'result', result }, resolveWrite));
            await onShutdown?.();
            return;
          }
          write({ id: origId, type: 'result', result });
        } catch (error) {
          write({ id: origId, type: 'error', error: errorPayload(error) });
        } finally {
          routes.delete(serverId);
          ownedIds.delete(serverId);
        }
      };
      if (IMMEDIATE_TYPES.has(type)) run();
      else queue = queue.then(run);
    });

  }

  function listenOnce(pipeName) {
    return new Promise((resolveListen, rejectListen) => {
      const candidate = createServer(handleConnection);
      const onError = (error) => {
        candidate.close();
        rejectListen(error);
      };
      candidate.once('error', onError);
      candidate.listen(pipeName, () => {
        candidate.removeListener('error', onError);
        server = candidate;
        resolveListen();
      });
    });
  }

  function backendExistsError(pipeName) {
    const error = new Error(`已有共享后端在监听：${pipeName}`);
    // @ts-ignore 自定义错误码
    error.code = 'IFTREE_BACKEND_EXISTS';
    return error;
  }

  // 抢座次序是 listen-first：直接监听，被占才探测判活。反过来（先探测再清残留再监听）
  // 在 posix 下有双活竞态——两进程同时探测失败，后清理者会把先监听者刚 bind 的 socket
  // 文件 unlink 掉，先者从此无人可达又永不退出（孤儿）。listen-first 让操作系统当裁判：
  // 同时抢只有一个 bind 成功，输家探测到赢家后让位；unlink 只发生在「监听被拒且探测
  // 无人应答」之后，删的必然是陈尸。残余窗口只剩陈尸+双启动+特定交错的三重巧合。
  async function listen(pipeName) {
    try {
      await listenOnce(pipeName);
      return;
    } catch (error) {
      if (error?.code !== 'EADDRINUSE' && error?.code !== 'EACCES') throw error;
    }
    if (await probeBackendPipe(pipeName)) throw backendExistsError(pipeName);
    if (process.platform !== 'win32') {
      // posix 下进程崩死会留下 socket 文件（陈尸），bind 报 EADDRINUSE；探测无人应答即清掉。
      try { unlinkSync(pipeName); } catch { /* 不存在 */ }
    }
    try {
      await listenOnce(pipeName);
    } catch (error) {
      // 重试又被占：窗口里有人抢先 bind 成功，判活后让位。
      if ((error?.code === 'EADDRINUSE' || error?.code === 'EACCES') && await probeBackendPipe(pipeName)) {
        throw backendExistsError(pipeName);
      }
      throw error;
    }
  }

  function close() {
    shuttingDown = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    routes.clear();
    server?.close();
    server = null;
  }

  return {
    listen,
    sendEvent,
    close,
    get connectionCount() {
      return sockets.size;
    }
  };
}

// 后台维护调度器（放主库位置，projectneed 4-6）：只决定「何时该维护」并派发信号，本身不含任何具体维护
// 逻辑——各子系统（主库自身、向量模块）注册自己的 handler、自给自足，调度器不内联它们的逻辑（避免耦合）。
//
// 触发：脏度计数（写收尾 O(1) 自增，不是每次读写的自检 hook）+ 低频 unref tick；脏度超阈值且距上次写
// 空闲足够才派发。串行：派发经注入的 serialize（共享后端单写队列）执行，与正常写硬串行，避免维护和写
// 撞 LanceDB manifest / SQLite 写锁。serialize 缺省直接执行（私有/测试场景），host 接线时注入真队列。
type MaintenanceHandler = (ctx: { reason: string; cleared: number }) => Promise<unknown> | unknown;
type Serializer = (fn: () => Promise<void>) => Promise<void>;

export function createMaintenanceScheduler({
  intervalMs = 300000,       // tick 周期，默认 5min
  dirtyThreshold = 200,      // 累计派生写次数阈值
  idleMs = 60000,            // 距上次写的空闲窗口，默认 60s
  now = () => Date.now(),
  serialize = ((fn: () => Promise<void>) => Promise.resolve().then(fn)) as Serializer
} = {}) {
  const handlers = new Map<string, MaintenanceHandler>();
  let dirty = 0;
  let lastMarkAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let serializer: Serializer = serialize;

  function markDirty(weight = 1) {
    dirty += Number(weight) || 1;
    lastMarkAt = now();
  }

  function register(name: string, handler: MaintenanceHandler) {
    if (typeof handler === 'function') handlers.set(String(name), handler);
  }

  function setSerialize(fn: Serializer) {
    if (typeof fn === 'function') serializer = fn;
  }

  // 真正跑维护：整体经单写队列串行一次，内部依次调各 handler（互不内联、各维护各的）。
  // 单个 handler 失败不致命、不影响其它 handler，下个 tick 再来。
  async function runMaintenance(reason = 'manual') {
    if (running) return { ok: true, skipped: 'already-running' };
    running = true;
    const cleared = dirty;
    dirty = 0;
    const results: Record<string, unknown> = {};
    try {
      await serializer(async () => {
        for (const [name, handler] of handlers) {
          try { results[name] = await handler({ reason, cleared }); }
          catch (error) { results[name] = { ok: false, error: (error as Error)?.message || String(error) }; }
        }
      });
    } finally {
      running = false;
    }
    return { ok: true, reason, cleared, results };
  }

  async function tick() {
    if (running) return;
    if (dirty < dirtyThreshold) return;
    if (now() - lastMarkAt < idleMs) return; // 还在活跃写，等空闲窗口再动手
    await runMaintenance('tick');
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    markDirty,
    register,
    setSerialize,
    runMaintenance,
    tick,
    start,
    stop,
    get pending() { return dirty; }
  };
}

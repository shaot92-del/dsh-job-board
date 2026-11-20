// 主机侧「这条任务该不该派给 remote-agent」的判定（v2.6.12）。
//
// 为什么单独一个文件：这段判断原来是一个内联的 `.filter(...)`，夹在 2400 行的
// dispatchOnce() 里，**零单元测试** —— 改坏了（比如把 maint 放回去当 agent 派）
// 没有任何测试会响。审计 P2 点名了这一点。判定本身是纯函数，抽出来就能锁住。
//
// 与副机侧的关系：副机 `lib/worker/task-spec.js` 用同一套 mode 归一化规则
// （去 BOM → trim → 小写 → 前缀认 maint），两边必须一致。板子把 mode 截到 10 字符
// （`maintenanc`），Python 的 `.strip()` 又不吃 BOM，所以判据只能认前缀。

/** 板子存下来的 mode 文本 → 归一化形式（去 BOM、去空白、小写） */
export function normalizeTaskMode(mode) {
  return String(mode ?? '').replace(/^\uFEFF/, '').trim().toLowerCase();
}

/** 是不是维护通道任务。`maintenance` 在板子上会被截成 `maintenanc`，所以用前缀。 */
export function isMaintMode(mode) {
  return normalizeTaskMode(mode).startsWith('maint');
}

/**
 * dispatch=auto 的任务是否该进本机派工队列。
 * 三个排除项各有来历：
 *   · `remote` 已绑 —— 别的机器认领后失联、但远端已经起来了，再派一遍就是双跑；
 *   · maint —— 只由副机 worker 自己认领，Host 派给 remote-agent 等于让一个会话「读版本号」；
 *   · status 不是 queued/stale —— 已在跑或已终结的任务不重复派。
 * @param {object} task 板子快照里的任务
 * @returns {boolean}
 */
export function shouldAutoDispatch(task) {
  if (!task || typeof task !== 'object') return false;
  if (task.dispatch !== 'auto') return false;
  if (task.remote) return false;
  if (isMaintMode(task.mode)) return false;
  return task.status === 'queued' || task.status === 'stale';
}

/**
 * v2.7.2：这条任务该不该交给远程桥（remote-agent / dsh headless）去跑。
 *
 * 来历：远程桥的 headless 后端**固定使用副机默认模型**，任何显式 model 都会被它拒绝，
 * 实测 note 是「远程 failed：headless 后端不支持指定模型（dsh headless 固定使用副机默认
 * 模型）。请在副机使用 in-process 后端（默认），或不指定 model 参数。」——而派工框选模型
 * 正是这个插件的卖点（用户 2026-11-21 原话：「派到副机时选具体模型是我们插件的特色」）。
 *
 * 所以带 model 的 agent 任务必须留给副机**自己的 worker** 认领（worker 支持 model），
 * 不能进远程桥队列；exec 任务远程桥本来就忽略 model，照旧放行。
 *
 * @param {object} task 板子快照里的任务
 * @returns {boolean} true = 可以派给远程桥
 */
export function canDispatchRemote(task) {
  if (!task || typeof task !== 'object') return false;
  if (isMaintMode(task.mode)) return false;
  const mode = normalizeTaskMode(task.mode) === 'exec' ? 'exec' : 'agent';
  if (mode === 'exec') return true;
  return !String(task.model ?? '').trim();
}

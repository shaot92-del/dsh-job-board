// 统一日志：白名单式脱敏 + 环形缓冲。
//
// 两条硬要求（handoff §3.3）：
//   · 永不打印 token —— 连日志行里出现的 token 子串都要打码；
//   · 错误文本里的路径/用户名要打码（%USERPROFILE% 替换），避免写进 board note
//     之后泄露到看板 UI。
//
// 环形缓冲存在内存里，worker_status 工具可以直接回看最近 N 行——副机上没有
// 终端可翻日志时，这是唯一的事后现场。

const LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * 把文本里出现的秘密与家目录打码。
 * @param {unknown} text
 * @param {{ secrets?: string[], home?: string }} [opts]
 * @returns {string}
 */
export function maskText(text, opts = {}) {
  let out = String(text ?? '');
  const home = typeof opts.home === 'string' ? opts.home.trim() : '';
  if (home) {
    // 家目录大小写可能不一致（Windows 不敏感），统一按大小写不敏感替换
    const re = new RegExp(escapeRegExp(home), 'gi');
    out = out.replace(re, '%USERPROFILE%');
  }
  for (const secret of Array.isArray(opts.secrets) ? opts.secrets : []) {
    if (typeof secret !== 'string' || secret.length < 6) continue;
    out = out.split(secret).join('***');
  }
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 序列化并打码：**在序列化之前**对每个字符串值打码。
 *
 * v2.6.16：以前是「JSON.stringify(extra) 之后再 maskText」，而 JSON 会把 Windows
 * 路径里的反斜杠转义成 `\\` —— 于是家目录 `C:\Users\Alice` 在序列化文本里变成
 * `C:\\Users\\Alice`，跟待替换的模式对不上，**extra 里的路径一直没被打码**
 * （看板是共享的，这叫信息泄露）。
 *
 * 用 replacer 而不是深拷贝：Date / Buffer / toJSON 的语义保持原样，只改字符串。
 * 外层再打一次码，兜住「秘密出现在 key 名里」这种边角。
 */
function stringifyMasked(value, opts) {
  return maskText(
    JSON.stringify(value, (key, val) => (typeof val === 'string' ? maskText(val, opts) : val)),
    opts,
  );
}

/**
 * 建一个 logger。sink 可选（默认不写 stdout：插件在 Host 进程里，console 会被
 * DSH 的启动日志吞掉/串行化；显式 sink 交给调用方决定）。
 */
export function createLogger(opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 200;
  const secrets = Array.isArray(opts.secrets) ? opts.secrets.filter(Boolean) : [];
  const home = typeof opts.home === 'string' ? opts.home : '';
  const sink = typeof opts.sink === 'function' ? opts.sink : null;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const minLevel = LEVELS.includes(opts.level) ? opts.level : 'info';
  const ring = [];
  let counter = 0;

  const record = (level, text, extra) => {
    if (LEVELS.indexOf(level) < LEVELS.indexOf(minLevel)) return;
    let extraText = '';
    if (extra && typeof extra === 'object') {
      try {
        extraText = stringifyMasked(extra, { secrets, home });
      } catch {
        // 序列化失败（BigInt、循环引用等）不能让日志本身抛错
        extraText = maskText(String(extra), { secrets, home });
      }
    }
    const entry = {
      n: ++counter,
      at: now(),
      level,
      text: maskText(text, { secrets, home }),
      extra: extraText,
    };
    ring.push(entry);
    while (ring.length > limit) ring.shift();
    if (sink) {
      try {
        sink(`[dsh-job-board/worker] ${level.toUpperCase()} ${entry.text}${entry.extra ? ' ' + entry.extra : ''}`);
      } catch {
        /* 日志失败不能影响主循环 */
      }
    }
  };

  return {
    debug: (t, e) => record('debug', t, e),
    info: (t, e) => record('info', t, e),
    warn: (t, e) => record('warn', t, e),
    error: (t, e) => record('error', t, e),
    /** 最近 n 条（默认全部缓冲） */
    recent: (n) => (Number.isInteger(n) ? ring.slice(-n) : ring.slice()),
    /** 纯文本行，给工具/面板展示 */
    tail: (n = 20) => {
      const lines = (Number.isInteger(n) ? ring.slice(-n) : ring).map((x) => {
        const t = new Date(x.at).toISOString().slice(11, 19);
        return `${t} ${x.level.toUpperCase()} ${x.text}${x.extra ? ' ' + x.extra : ''}`;
      });
      return lines;
    },
    /**
     * 派生一个带前缀的 logger（同一个环形缓冲，前缀进 text 便于 grep）。
     * @param {string} prefix
     */
    child(prefix) {
      const p = String(prefix || '').trim();
      const wrap = (fn) => (t, e) => fn(p ? `${p} ${t}` : t, e);
      return {
        debug: wrap(record.bind(null, 'debug')),
        info: wrap(record.bind(null, 'info')),
        warn: wrap(record.bind(null, 'warn')),
        error: wrap(record.bind(null, 'error')),
        recent: this.recent,
        tail: this.tail,
      };
    },
  };
}

export { LEVELS };

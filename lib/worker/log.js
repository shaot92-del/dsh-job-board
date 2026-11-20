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
  // v2.6.28（盘古审计 S-10）：secret 必须先于家目录替换——反过来的话，
  // secret 里若含家目录子串（例如 `C:\Users\Alice\key-123` 这种把家目录拼进
  // token 的用法），家目录会先把 secret 拆成 `%USERPROFILE%\key-123`，
  // 后面的整串匹配就再也命中不了，剩下的片段原样泄露。
  const secrets = (Array.isArray(opts.secrets) ? opts.secrets : [])
    .filter((s) => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length >= 6)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    out = out.split(secret).join('***');
    // JSON 序列化会把反斜杠/引号转义：secret 出现在 key 名里时，序列化文本里是转义
    // 后的形态，原始串匹配不上（v2.6.18 补）。对普通文本替换转义形态无害。
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) out = out.split(escaped).join('***');
  }
  const home = typeof opts.home === 'string' ? opts.home.trim() : '';
  if (home) {
    // 同一个家目录可能以三种形态出现在日志里：Windows 反斜杠、正斜杠（Node ESM 栈 /
    // 工具输出常见）、以及 file:/// 前缀的 URL。v2.6.18 之前只替换反斜杠形态，
    // `C:/Users/Alice` 与 `file:///C:/Users/Alice` 都会原样漏出去（子进程 stderr 拼进
    // note 后有生产路径）。
    //
    // 末尾的边界守卫防止前缀过度匹配：home 是 `C:\Users\Al` 时不能把 `C:\Users\Alice`
    // 打成 `%USERPROFILE%ice`。
    const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')]);
    for (const variant of variants) {
      if (!variant) continue;
      // 家目录大小写可能不一致（Windows 不敏感），统一按大小写不敏感替换
      const re = new RegExp(escapeRegExp(variant) + '(?![\\w$-])', 'gi');
      out = out.replace(re, '%USERPROFILE%');
    }
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
 * 外层再打一次码，兜住「秘密出现在 key 名里」这种边角（key 的转义形态由 maskText
 * 里的「转义变体替换」负责，v2.6.18 补）。
 */
function stringifyMasked(value, opts) {
  return maskText(
    JSON.stringify(value, (key, val) => {
      if (typeof val === 'string') return maskText(val, opts);
      // 数字形态的秘密：序列化后再按文本替换会把 JSON 打坏（`{"pin":***}`），
      // 所以在 replacer 里就地换成一个打码后的字符串。
      if (typeof val === 'number' || typeof val === 'bigint') {
        const raw = String(val);
        const masked = maskText(raw, opts);
        return masked === raw ? val : masked;
      }
      return val;
    }),
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
        // 序列化失败（BigInt、循环引用等）不能让日志本身抛错；兜底自己也可能抛
        // （对象自定义 toString 抛错），再兜一层。
        try {
          extraText = maskText(String(extra), { secrets, home });
        } catch {
          extraText = '[unserializable extra]';
        }
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

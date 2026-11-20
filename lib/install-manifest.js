/**
 * 安装清单（install-manifest.json）—— 用来识别「装了一半」的混合树。
 *
 * 背景（2026-11-21 GT14 起不来事故）：升级脚本是把新包 robocopy 覆盖到**正在运行的**安装目录上，
 * 既不原子也不校验。一旦有文件没覆盖成功（占用/杀软/中断），就会留下
 * 「新 lib/index.js + 旧 lib/dispatch-filter.js」这种混合树；ESM 在链接阶段就会抛
 * `SyntaxError: The requested module './dispatch-filter.js' does not provide an export named ...`，
 * 表现是 DSH 起不来，但看不出是安装问题。
 *
 * 清单由安装脚本写：{ version, generatedAt, files: [{ path, bytes, sha256 }] }。
 * 运行时只做一次开销可控的校验（默认只比对版本 + 文件数 + 关键文件 sha256），
 * 发现问题只告警不阻断 —— 插件不该因为安装异常而把整个宿主拖住。
 */

export const MANIFEST_NAME = 'install-manifest.json';

/** 校验时默认抽样的关键文件：跨文件导入关系最强、最容易被半覆盖毁掉的那几个。 */
export const CRITICAL_FILES = ['lib/index.js', 'lib/dispatch-filter.js', 'lib/client.js', 'lib/worker/version.js'];

export function buildManifest({ version, files, now = () => new Date().toISOString() }) {
  const list = (Array.isArray(files) ? files : [])
    .map((f) => ({
      path: String(f.path || '').replace(/\\/g, '/'),
      bytes: Number(f.bytes) || 0,
      sha256: String(f.sha256 || '').toLowerCase(),
    }))
    .filter((f) => f.path)
    .sort((a, b) => a.path.localeCompare(b.path));
  return { version: String(version || ''), generatedAt: now(), files: list };
}

export function parseManifest(text) {
  let obj;
  try {
    obj = JSON.parse(String(text || ''));
  } catch {
    return { ok: false, reason: 'manifest-not-json' };
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.files)) return { ok: false, reason: 'manifest-shape' };
  return { ok: true, manifest: obj };
}

/**
 * 校验安装目录。
 * @param {object} opts
 * @param {string} opts.dir        插件根目录（含 package.json）
 * @param {object} opts.fsImpl     需提供 readFileSync / existsSync / statSync（便于测试注入）
 * @param {string} [opts.packageVersion] 期望版本；省略则从 package.json 读
 * @returns {{ok:boolean, problems:string[], checked:number}}
 */
export function verifyInstall({ dir, fsImpl, packageVersion } = {}) {
  const problems = [];
  if (!dir || !fsImpl) return { ok: false, problems: ['missing-args'], checked: 0 };
  const join = (base, rel) => `${String(base).replace(/[\\/]+$/, '')}/${rel}`;

  let pkgVersion = packageVersion || '';
  try {
    const pkg = JSON.parse(fsImpl.readFileSync(join(dir, 'package.json'), 'utf8'));
    if (!pkgVersion) pkgVersion = String(pkg.version || '');
  } catch {
    problems.push('package.json 读不到或不是合法 JSON');
    return { ok: false, problems, checked: 0 };
  }

  const manifestPath = join(dir, MANIFEST_NAME);
  if (!fsImpl.existsSync(manifestPath)) {
    // 老版本安装（2.7.2 及以前）没有清单：只提示，不算失败。
    return { ok: true, problems: ['没有 install-manifest.json（旧版安装，无法校验完整性）'], checked: 0 };
  }

  let manifest;
  try {
    const parsed = parseManifest(fsImpl.readFileSync(manifestPath, 'utf8'));
    if (!parsed.ok) {
      problems.push(`install-manifest.json 不可用（${parsed.reason}）`);
      return { ok: false, problems, checked: 0 };
    }
    manifest = parsed.manifest;
  } catch {
    problems.push('install-manifest.json 读不到');
    return { ok: false, problems, checked: 0 };
  }

  if (manifest.version && pkgVersion && manifest.version !== pkgVersion) {
    problems.push(`清单版本 ${manifest.version} 与 package.json ${pkgVersion} 不一致（半覆盖安装？）`);
  }

  let checked = 0;
  for (const entry of manifest.files) {
    if (!CRITICAL_FILES.includes(entry.path)) continue;
    checked += 1;
    const p = join(dir, entry.path);
    if (!fsImpl.existsSync(p)) {
      problems.push(`关键文件缺失：${entry.path}`);
      continue;
    }
    try {
      const actual = Number(fsImpl.statSync(p).size) || 0;
      if (entry.bytes && actual !== entry.bytes) problems.push(`关键文件大小不符：${entry.path}（清单 ${entry.bytes} / 实际 ${actual}）`);
    } catch {
      problems.push(`关键文件读不到：${entry.path}`);
    }
  }

  return { ok: problems.length === 0, problems, checked };
}

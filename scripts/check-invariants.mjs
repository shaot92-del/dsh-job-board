// check-invariants.mjs — 发布前「配置写入不变量」硬检查（进 gate，违反即红）
// 这些不变量来自 2026-11-24 的 key 轮换 / allowlist 丢失 / workerMode 被安装重置三起事故。
// 全部可执行：要么真跑一遍，要么对源码做精确断言；不做“看起来对”的检查。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicKey } from 'node:crypto';
import { ensureMaintKeyPair, loadPrivateKey } from '../lib/worker/maint-key-store.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const results = [];

function check(id, title, fn) {
  try {
    const detail = fn();
    results.push({ id, title, ok: true, detail: detail || '' });
  } catch (err) {
    results.push({ id, title, ok: false, detail: err && err.message ? err.message : String(err) });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function tmpDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `dsb-inv-${tag}-`));
  return d;
}

// I-1 信任根：两种 key 格式都必须被复用，文件字节不变；坏文件不许覆盖
check('I-1', 'maint key 双格式复用且绝不覆盖', () => {
  const dir = tmpDir('key');
  const f = path.join(dir, 'maint-key.json');

  // CLI 格式（scripts/maint-ticket.mjs keygen 写出的形状）
  const keyPairRes = ensureMaintKeyPair({ file: f });
  assert(keyPairRes.ok, '首次生成失败：' + (keyPairRes.reason || ''));
  const hostRaw = JSON.parse(fs.readFileSync(f, 'utf8'));
  const cli = { version: 1, privateKeyB64: hostRaw.privateKey, publicKeyB64: hostRaw.publicKey };
  const cliBytes = JSON.stringify(cli, null, 2) + '\n';
  fs.writeFileSync(f, cliBytes);
  const r1 = ensureMaintKeyPair({ file: f });
  assert(r1.ok, 'CLI 格式应可用，实际：' + (r1.reason || ''));
  assert(fs.readFileSync(f, 'utf8') === cliBytes, 'CLI 格式文件被改写（违反「存在即复用」）');
  const pk1 = loadPrivateKey(f);
  assert(pk1 && pk1.type === 'private', 'CLI 格式读不出私钥');
  const derived = createPublicKey(pk1).export({ type: 'spki', format: 'der' }).toString('base64');
  assert(derived === cli.publicKeyB64, '私钥派生出的公钥与文件不一致');

  // 坏文件：必须报不可用且不覆盖
  const badBytes = '{"garbage":true}\n';
  fs.writeFileSync(f, badBytes);
  const r2 = ensureMaintKeyPair({ file: f });
  assert(!r2.ok, '坏 key 文件应判不可用，实际 ok=true');
  assert(fs.readFileSync(f, 'utf8') === badBytes, '坏 key 文件被覆盖（违反「绝不静默轮换」）');
  return `cli-reuse/pk-ok/badfile=${r2.reason}`;
});

// I-2 安装脚本不得改 workerMode（安装只装文件，不碰“是否接活”的开关）
check('I-2', '安装脚本不写 workerMode', () => {
  const p = 'scripts/deploy/install-agent-worker.ps1';
  assert(fs.existsSync(path.join(root, p)), p + ' 不存在');
  const t = read(p);
  assert(!/workerMode/i.test(t), p + ' 出现 workerMode —— 安装不应改「是否接活」开关');
  return 'no-workerMode';
});

// I-3 安装脚本不得删 agentAllowlist / maintenanceWriteEnabled
check('I-3', '安装脚本不删派工白名单与写通道开关', () => {
  const t = read('scripts/deploy/install-agent-worker.ps1');
  for (const key of ['agentAllowlist', 'maintenanceWriteEnabled', 'maintAuthPublicKeys']) {
    const re = new RegExp(`(Remove|Clear)[^\\n]*${key}`, 'i');
    assert(!re.test(t), `${key} 在安装脚本里被删除/清空`);
  }
  return 'no-destructive-key-op';
});

// I-4 零运行时依赖（副机部署是文件复制，不做 npm install）
check('I-4', '零运行时依赖', () => {
  const pkg = JSON.parse(read('package.json'));
  assert(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'package.json 出现 runtime dependencies');
  return 'dependencies=0';
});

// I-5 doctor 必须能自证维护写通道状态（否则用户只能靠猜）
check('I-5', 'doctor 自证 maint-write-off', () => {
  const t = read('lib/index.js');
  assert(t.includes("'maint-write-off'"), 'doctor 缺 maint-write-off 检查项');
  return 'present';
});

// I-6 config 读动词必须暴露公钥指纹（badsig 排障唯一线索）
check('I-6', 'config 读动词暴露公钥指纹', () => {
  const t = read('lib/worker/maintenance.js');
  assert(t.includes('maintAuthPublicKeyFingerprints'), 'maintenance.js 缺公钥指纹');
  assert(/createHash\('sha256'\)/.test(t), '指纹未用 sha256（可能是可逆/短串）');
  return 'sha256-fp';
});

// I-7 一键开关脚本必须自带备份 + 写后复核 + 回滚
check('I-7', 'enable-agent-dispatch 有备份/复核/回滚', () => {
  const p = 'scripts/deploy/enable-agent-dispatch.ps1';
  assert(fs.existsSync(path.join(root, p)), p + ' 不存在');
  const t = read(p);
  for (const kw of ['.bak-agent-', '复核失败', 'Copy-Item -LiteralPath $bak -Destination $patch']) {
    assert(t.includes(kw), `缺少「${kw}」`);
  }
  return 'backup+verify+rollback';
});

// I-8 禁止手写补丁残留：仓库根目录不允许出现一次性补丁脚本（scripts/ 下的运维脚本是正式的）
check('I-8', '仓库根目录无一次性补丁脚本', () => {
  const bad = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && /^(patch|tmp|hand|hotfix)[-_.]/i.test(e.name))
    .map((e) => e.name);
  assert(bad.length === 0, '根目录发现一次性脚本：' + bad.join(', '));
  return 'none';
});

let failed = 0;
for (const r of results) {
  const tag = r.ok ? 'PASS' : 'FAIL';
  if (!r.ok) failed++;
  console.log(`[${tag}] ${r.id} ${r.title}${r.detail ? ' — ' + r.detail : ''}`);
}
if (failed > 0) {
  console.error(`\n不变量检查失败 ${failed} 项`);
  process.exit(1);
}
console.log(`\n不变量检查全部通过（${results.length} 项）`);

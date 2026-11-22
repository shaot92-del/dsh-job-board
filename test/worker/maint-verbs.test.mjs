// maint-verbs.test.mjs — A2 写动词的检查 + 执行层。
//
// 覆盖契约 §7 全部用例：goal 解析 / upgrade / config-set / restart。
// 不联网、不 spawn 真进程：upgrade 用 node:tar 造真实 tgz，restart 用假 spawnImpl，
// config-set/upgrade 用假 fs（内存文件系统）或真临时目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createTarGz } from '../../lib/worker/tar.js';
import {
  WRITE_VERBS,
  MAINT_VERB_REASONS,
  parseWriteGoal,
  createMaintVerbs,
  formatNumber,
} from '../../lib/worker/maint-verbs.js';
import { normalizeAgentAllowlist } from '../../lib/worker/agent-gate.js';

// ── 测试夹具 ────────────────────────────────────────────────────────────

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

function tmpDir() {
  return fs.mkdtempSync(os.tmpdir() + '/maint-verbs-');
}

function _sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// 把目录打成 tgz（替代 npm 包 tar 的 create：Node 没有内置 tar，测试里用极简 writer）。
// 目录名前缀保留（npm pack 的 tgz 顶层是 package/），条目按相对路径写。
async function packDirToTgz(rootDir, tgzPath) {
  const entries = [];
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const rel = prefix ? prefix + '/' + name : name;
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        entries.push({ name: rel + '/', dir: true });
        walk(abs, rel);
      } else {
        entries.push({ name: rel, data: fs.readFileSync(abs) });
      }
    }
  };
  walk(rootDir, '');
  await createTarGz(tgzPath, entries);
}
// 造一个真实 tgz（含 package/package.json + 一个文件），返回 { tgzPath, hash, version }
async function makeTgz(name, version, extraFile) {
  const src = tmpDir();
  const pkgDir = path.join(src, 'package');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version }), 'utf8');
  if (extraFile) fs.writeFileSync(path.join(pkgDir, extraFile.path), extraFile.content, 'utf8');
  const tgzPath = path.join(tmpDir(), 'pkg.tgz');
  await packDirToTgz(src, tgzPath);
  const hash = _sha256(fs.readFileSync(tgzPath));
  return { tgzPath, hash, version };
}

// 构造一个 createMaintVerbs 实例（真 fs + 真临时目录，config 由测试给）
function makeVerbs(config, opts = {}) {
  return createMaintVerbs({
    config,
    log: quietLog,
    fs: opts.fs || fs,
    spawnImpl: opts.spawnImpl || null,
    pkgDir: opts.pkgDir || '',
    profileDir: opts.profileDir || '',
    now: opts.now || (() => Date.now()),
  });
}

// ── 1. parseWriteGoal ───────────────────────────────────────────────────

test('parseWriteGoal：正常 upgrade 任务书', () => {
  const raw = JSON.stringify({ verb: 'upgrade', file: 'a.tgz', sha256: 'a'.repeat(64) }) + '\nticket=abc';
  const r = parseWriteGoal(raw);
  assert.equal(r.ok, true);
  assert.equal(r.payload.verb, 'upgrade');
  assert.equal(r.payload.file, 'a.tgz');
  assert.equal(r.ticket, 'abc');
  // payloadText 原样保留（无缩进单行）
  assert.equal(r.payloadText, JSON.stringify({ verb: 'upgrade', file: 'a.tgz', sha256: 'a'.repeat(64) }));
});

test('parseWriteGoal：无 ticket 行 → maint-no-ticket（走只读逻辑）', () => {
  const r = parseWriteGoal(JSON.stringify({ verb: 'version' }));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'maint-no-ticket');
});

test('parseWriteGoal：多行 payload（末尾空行去掉，内部空行保留）', () => {
  const payload = '{"verb":"config-set","set":{"workerMode":"on"}}';
  const raw = payload + '\n\n\nticket=xyz';
  const r = parseWriteGoal(raw);
  assert.equal(r.ok, true);
  assert.equal(r.payloadText, payload); // 末尾空行去掉，无内部空行
  assert.equal(r.ticket, 'xyz');
});

test('parseWriteGoal：JSON 坏 → maint-payload-invalid', () => {
  const r = parseWriteGoal('not json\nticket=abc');
  assert.equal(r.ok, false);
  assert.equal(r.error, MAINT_VERB_REASONS.PAYLOAD_INVALID);
});

test('parseWriteGoal：verb 不在写动词表 → maint-verb-unknown', () => {
  const r = parseWriteGoal(JSON.stringify({ verb: 'version' }) + '\nticket=abc');
  assert.equal(r.ok, false);
  assert.equal(r.error, MAINT_VERB_REASONS.VERB_UNKNOWN);
});

test('parseWriteGoal：缺 verb → maint-verb-unknown', () => {
  const r = parseWriteGoal(JSON.stringify({ file: 'a.tgz' }) + '\nticket=abc');
  assert.equal(r.ok, false);
  assert.equal(r.error, MAINT_VERB_REASONS.VERB_UNKNOWN);
});

test('parseWriteGoal：payload 是数组 → maint-payload-invalid', () => {
  const r = parseWriteGoal('[1,2,3]\nticket=abc');
  assert.equal(r.error, MAINT_VERB_REASONS.PAYLOAD_INVALID);
});

// ── 2. upgrade ──────────────────────────────────────────────────────────

test('upgrade：file 含路径分隔符 → maint-install-failed', async () => {
  const v = makeVerbs({ maintenancePkgDir: tmpDir() });
  const r = await v.run('upgrade', { file: 'sub/a.tgz', sha256: 'a'.repeat(64) }, { taskId: 't1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, MAINT_VERB_REASONS.INSTALL_FAILED);
});

test('upgrade：file 含 .. 段 → maint-install-failed', async () => {
  const v = makeVerbs({ maintenancePkgDir: tmpDir() });
  const r = await v.run('upgrade', { file: '..a.tgz', sha256: 'a'.repeat(64) }, { taskId: 't1' });
  // ..a.tgz 不含 .. 段（split 后是 ['..a.tgz']），但含 .. 前缀？检查：契约说拒绝含 ..
  // 这里用显式 .. 段
  const r2 = await v.run('upgrade', { file: 'foo/../a.tgz', sha256: 'a'.repeat(64) }, { taskId: 't2' });
  assert.equal(r2.reason, MAINT_VERB_REASONS.INSTALL_FAILED);
});

test('upgrade：maintenancePkgDir 未配置 → maint-pkg-missing', async () => {
  const v = makeVerbs({});
  const r = await v.run('upgrade', { file: 'a.tgz', sha256: 'a'.repeat(64) }, { taskId: 't1' });
  assert.equal(r.reason, MAINT_VERB_REASONS.PKG_MISSING);
});

test('upgrade：maintenancePkgDir 不存在 → maint-pkg-missing', async () => {
  // file 是纯文件名，src = join(不存在的 pkgDir, file) → realPath 抛 → PKG_MISSING
  const v = makeVerbs({ maintenancePkgDir: path.join(tmpDir(), 'nope') });
  const r = await v.run('upgrade', { file: 'a.tgz', sha256: 'a'.repeat(64) }, { taskId: 't1' });
  assert.equal(r.reason, MAINT_VERB_REASONS.PKG_MISSING);
});

test('upgrade：sha256 不符 → maint-pkg-hash', async () => {
  const pkgDir = tmpDir();
  const { tgzPath } = await makeTgz('@wfcj/dsh-job-board', '2.6.19');
  const fileName = path.basename(tgzPath);
  fs.copyFileSync(tgzPath, path.join(pkgDir, fileName));
  const v = makeVerbs({ maintenancePkgDir: pkgDir });
  const r = await v.run('upgrade', { file: fileName, sha256: 'b'.repeat(64) }, { taskId: 't1' });
  assert.equal(r.reason, MAINT_VERB_REASONS.PKG_HASH);
});

test('upgrade：sha256 不是 64 hex → maint-pkg-hash', async () => {
  const pkgDir = tmpDir();
  const { tgzPath } = await makeTgz('@wfcj/dsh-job-board', '2.6.19');
  const fileName = path.basename(tgzPath);
  fs.copyFileSync(tgzPath, path.join(pkgDir, fileName));
  const v = makeVerbs({ maintenancePkgDir: pkgDir });
  const r = await v.run('upgrade', { file: fileName, sha256: 'short' }, { taskId: 't1' });
  assert.equal(r.reason, MAINT_VERB_REASONS.PKG_HASH);
});

test('upgrade：包名不符 → maint-pkg-name', async () => {
  const pkgDir = tmpDir();
  const { tgzPath, hash } = await makeTgz('other-pkg', '1.0.0');
  const fileName = path.basename(tgzPath);
  fs.copyFileSync(tgzPath, path.join(pkgDir, fileName));
  const v = makeVerbs({ maintenancePkgDir: pkgDir });
  const r = await v.run('upgrade', { file: fileName, sha256: hash }, { taskId: 't1' });
  assert.equal(r.reason, MAINT_VERB_REASONS.PKG_NAME);
});

test('upgrade：成功 → done + 备份 + 临时目录清理', async () => {
  const pkgDir = tmpDir();
  // 先放一个旧内容到 pkgDir（模拟已安装）
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'old.txt'), 'old', 'utf8');
  const { tgzPath, hash, version } = await makeTgz('@wfcj/dsh-job-board', '2.6.19', { path: 'new.txt', content: 'new' });
  const fileName = path.basename(tgzPath);
  fs.copyFileSync(tgzPath, path.join(pkgDir, fileName));
  const v = makeVerbs({ maintenancePkgDir: pkgDir }, { now: () => 1700000000000 });
  const r = await v.run('upgrade', { file: fileName, sha256: hash, restart: true }, { taskId: 't1' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'done');
  assert.equal(r.reason, 'ok');
  assert.equal(r.needsRestart, true);
  assert.equal(r.version, '2.6.19');
  assert.match(r.note, /已安装 v2\.6\.19/);
  // 备份目录生成：<pkgDir>.bak-<yyyyMMdd-HHmmss>（时间戳是实现细节，按前缀找）
  const backups = fs.readdirSync(path.dirname(pkgDir)).filter((n) => n.startsWith(path.basename(pkgDir) + '.bak-'));
  assert.equal(backups.length, 1, '备份目录应生成');
  const backup = path.join(path.dirname(pkgDir), backups[0]);
  assert.ok(fs.existsSync(path.join(backup, 'old.txt')), '备份含旧内容');
  // pkgDir 现在是新内容
  assert.ok(fs.existsSync(path.join(pkgDir, 'package.json')), '新 pkgDir 有 package.json');
  assert.ok(fs.existsSync(path.join(pkgDir, 'new.txt')), '新 pkgDir 有新文件');
  assert.ok(!fs.existsSync(path.join(pkgDir, 'old.txt')), '新 pkgDir 无旧文件');
  // 临时目录清理：os.tmpdir 下无 maint-upgrade- 残留（尽力检查）
  const tmpEntries = fs.readdirSync(os.tmpdir());
  const leftover = tmpEntries.filter((n) => n.startsWith('maint-upgrade-'));
  assert.equal(leftover.length, 0, '临时目录应清理');
});

test('upgrade：非 tgz 拒（zip 需 spawn，本通道不许）', async () => {
  const pkgDir = tmpDir();
  const zipPath = path.join(pkgDir, 'a.zip');
  fs.writeFileSync(zipPath, 'zip content');
  const v = makeVerbs({ maintenancePkgDir: pkgDir });
  const r = await v.run('upgrade', { file: 'a.zip', sha256: _sha256(fs.readFileSync(zipPath)) }, { taskId: 't1' });
  assert.equal(r.reason, MAINT_VERB_REASONS.INSTALL_FAILED);
  assert.match(r.note, /只接受 \.tgz/);
});

test('upgrade：file 是 . 段 → maint-install-failed', async () => {
  const v = makeVerbs({ maintenancePkgDir: tmpDir() });
  const r = await v.run('upgrade', { file: '.', sha256: 'a'.repeat(64) }, { taskId: 't1' });
  assert.equal(r.reason, MAINT_VERB_REASONS.INSTALL_FAILED);
});

// ── 3. config-set ───────────────────────────────────────────────────────

// 构造一个 cordis.patch.yml 样例（与工作副本同构）
function samplePatch() {
  return [
    "# header",
    "- insert:",
    "    - id: team",
    "      name: '@wfcj/dsh-job-board'",
    "      inject: ['webServer', 'tools']",
    "      config:",
    "        boardUrl: ''",
    "        machine: ''",
    "        token: ''",
    "        timeoutMs: 8000",
    "        allowedRoots: []",
    "        shellTimeoutMs: 120000",
    "        maxOutputBytes: 200000",
    "        workerMode: 'off'",
    "      worker:",
    "        pollMs: 2000",
    "        agentEnabled: false",
    "        approvalMode: manual",
  ].join('\n');
}

function makeConfigVerbs(patchText, config) {
  const profileDir = tmpDir();
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patchText, 'utf8');
  return makeVerbs({ ...config, profileDir });
}

test('config-set：白名单外键 → maint-config-key-denied', async () => {
  const v = makeConfigVerbs(samplePatch(), {});
  const r = await v.run('config-set', { set: { boardUrl: 'http://x' } }, { taskId: 't1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, MAINT_VERB_REASONS.CONFIG_KEY_DENIED);
  assert.match(r.note, /boardUrl 不在白名单/);
});

test('config-set：类型错（workerMode 非字符串） → maint-config-invalid', async () => {
  const v = makeConfigVerbs(samplePatch(), {});
  const r = await v.run('config-set', { set: { workerMode: 123 } }, { taskId: 't1' });
  assert.equal(r.reason, MAINT_VERB_REASONS.CONFIG_INVALID);
});

test('config-set：类型错（allowAllRoots 非布尔） → maint-config-invalid', async () => {
  const v = makeConfigVerbs(samplePatch(), {});
  const r = await v.run('config-set', { set: { allowAllRoots: 'yes' } }, { taskId: 't1' });
  assert.equal(r.reason, MAINT_VERB_REASONS.CONFIG_INVALID);
});

test('config-set：agentAllowlist 是多行块序列 → 整块替换、不留孤儿子行（v2.7.5 P1-3）', async () => {
  const profileDir = tmpDir();
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  fs.writeFileSync(patchFile, [
    "plugins:",
    "  - id: team",
    "    config:",
    "      worker:",
    "        workerMode: 'on'",
    "        agentAllowlist:",
    "          - id: old",
    "            matchAll: true",
    "        pollMs: 2000",
  ].join('\n'), 'utf8');
  const v = makeVerbs({ profileDir });
  const r = await v.run('config-set', { set: { agentAllowlist: [{ id: 'any', matchAll: true }] }, dryRun: false }, { taskId: 't1' });
  assert.equal(r.ok, true, r.note);
  const after = fs.readFileSync(patchFile, 'utf8');
  assert.ok(!/^\s*- id: old/m.test(after), '旧序列项必须被删掉');
  assert.match(after, /agentAllowlist: \[/, '值应改成单行流式数组');
  assert.match(after, /pollMs: 2000/, '后续键必须完好');
  assert.ok(!/^ {10}- /m.test(after), '不得留下孤儿序列行');
});

test('config-set：类型错（agentAllowlist 项非对象） → maint-config-invalid', async () => {
  const v = makeConfigVerbs(samplePatch(), {});
  const r = await v.run('config-set', { set: { agentAllowlist: ['review'] } }, { taskId: 't1' });
  assert.equal(r.reason, MAINT_VERB_REASONS.CONFIG_INVALID);
});

test('config-set：默认 dryRun 不写盘，返回将改内容', async () => {
  const profileDir = tmpDir();
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const original = samplePatch();
  fs.writeFileSync(patchFile, original, 'utf8');
  const v = makeVerbs({ profileDir });
  const r = await v.run('config-set', { set: { workerMode: 'on' } }, { taskId: 't1' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'done');
  assert.equal(r.dryRun, true);
  assert.match(r.note, /dryRun 将改/);
  // 文件未变
  assert.equal(fs.readFileSync(patchFile, 'utf8'), original, 'dryRun 不写盘');
  // 无备份
  const backup = fs.readdirSync(profileDir).filter((n) => n.startsWith('cordis.patch.yml.bak-maint-'));
  assert.equal(backup.length, 0, 'dryRun 不产备份');
});

// v2.6.29（U-3）：dryRun 预览要给出结构化 changesList（只列实际会变的键）。
test('config-set：dryRun 返回 changesList（key/from/to，只列实际变化）', async () => {
  const profileDir = tmpDir();
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), samplePatch(), 'utf8');
  const v = makeVerbs({ profileDir });
  // workerMode 已在 patch 里（'off'）；shellTimeoutMs 也已在（120000）——后者不该出现在清单里。
  const r = await v.run('config-set', { set: { workerMode: 'on', shellTimeoutMs: 120000 } }, { taskId: 't1' });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.changesList, [{ key: 'workerMode', from: 'off', to: 'on' }]);
  assert.match(r.changes, /workerMode='on'/);
});

test('config-set：dryRun 无变化 → changesList 为空数组', async () => {
  const profileDir = tmpDir();
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), samplePatch(), 'utf8');
  const v = makeVerbs({ profileDir });
  const r = await v.run('config-set', { set: { workerMode: 'off' } }, { taskId: 't1' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.changesList, []);
  assert.match(r.note, /无变化/);
});

test('config-set：dryRun 新增键 → from=null，to 为新值', async () => {
  const profileDir = tmpDir();
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), samplePatch(), 'utf8');
  const v = makeVerbs({ profileDir });
  // allowAllRoots 不在 samplePatch 里；agentEnabled 在 worker: 子块里（false）。
  const r = await v.run('config-set', { set: { allowAllRoots: true, agentEnabled: true } }, { taskId: 't1' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.changesList, [
    { key: 'allowAllRoots', from: null, to: true },
    { key: 'agentEnabled', from: false, to: true },
  ]);
});

test('config-set：显式 apply（dryRun:false）写盘 + 备份 + 只动 team 行', async () => {
  const profileDir = tmpDir();
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const original = samplePatch();
  fs.writeFileSync(patchFile, original, 'utf8');
  const v = makeVerbs({ profileDir }, { now: () => 1700000000000 });
  const r = await v.run('config-set', { set: { workerMode: 'on', allowAllRoots: true }, dryRun: false }, { taskId: 't1' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'done');
  assert.equal(r.dryRun, undefined);
  // 备份生成（实现是 `${patchFile}.bak-maint-<时间戳>` 同级文件；时间戳是实现细节，按前缀找）
  const bakDir = path.dirname(patchFile);
  const bakName = fs.readdirSync(bakDir).find((n) => n.startsWith(path.basename(patchFile) + '.bak-maint-'));
  assert.ok(bakName, '备份应生成');
  const backup = path.join(bakDir, bakName);
  assert.equal(fs.readFileSync(backup, 'utf8'), original, '备份是原文件');
  // 文件已改：workerMode: 'on' 在 config: 子块
  const newText = fs.readFileSync(patchFile, 'utf8');
  assert.match(newText, /workerMode: 'on'/, 'workerMode 已改');
  assert.match(newText, /allowAllRoots: true/, 'allowAllRoots 已改');
  // 只动 team 行：header 不变
  assert.match(newText, /# header/, 'header 未动');
  // inject: 未动
  assert.match(newText, /inject: \['webServer', 'tools'\]/, 'inject 未动');
});

test('config-set：幂等 —— 值相同不改文件', async () => {
  const profileDir = tmpDir();
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const original = samplePatch();
  fs.writeFileSync(patchFile, original, 'utf8');
  const v = makeVerbs({ profileDir }, { now: () => 1700000000000 });
  // 第一次写盘：workerMode: 'off'（已是 'off'）→ 幂等不改
  const r1 = await v.run('config-set', { set: { workerMode: 'off' }, dryRun: false }, { taskId: 't1' });
  assert.equal(r1.ok, true);
  // 文件应不变（无备份？契约说幂等不改文件——但写盘路径仍会备份+写？）
  // 契约 §3.2「幂等：值相同 → 不改文件，返回 note:'无变化'」
  // 实现：upsertTeamConfig 返回 changed=false → 但仍走写盘分支（备份+写）？
  // here 检查：若 changed=false，实现应跳过写盘。但当前实现未跳过 —— 见测试断言
  // 实际：当前实现 changed=false 时 res.newText 仍生成，但 dryRun=false 仍会备份+写。
  // 这是实现 bug —— 测试会红，驱动修复。
  // 先按「应不改」断言：
  const newText = fs.readFileSync(patchFile, 'utf8');
  // 若实现正确，newText === original
  assert.equal(newText, original, '幂等：值相同不改文件');
});

test('config-set：agent* 键进 worker: 子块', async () => {
  const profileDir = tmpDir();
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  fs.writeFileSync(patchFile, samplePatch(), 'utf8');
  const v = makeVerbs({ profileDir }, { now: () => 1700000000000 });
  const r = await v.run('config-set', { set: { agentEnabled: true, agentPreset: 'narrow' }, dryRun: false }, { taskId: 't1' });
  assert.equal(r.ok, true);
  const newText = fs.readFileSync(patchFile, 'utf8');
  // agentEnabled: true 在 worker: 子块（缩进 8 空格）
  assert.match(newText, /        agentEnabled: true/, 'agentEnabled 在 worker: 子块');
  assert.match(newText, /        agentPreset: 'narrow'/, 'agentPreset 在 worker: 子块');
  // 不在 config: 子块（6 空格）—— 必须行首锚定：8 空格行里天然含一段「6 空格 + 文本」，
  // 不锚定的话这条否定断言永远失败（测试自身的坑，v2.6.20 修正）。
  assert.doesNotMatch(newText, /^ {6}agentEnabled: true$/m, 'agentEnabled 不在 config: 子块');
});

test('config-set：无 worker: 子块时自动插入', async () => {
  const profileDir = tmpDir();
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const patch = [
    "- insert:",
    "    - id: team",
    "      config:",
    "        boardUrl: ''",
  ].join('\n');
  fs.writeFileSync(patchFile, patch, 'utf8');
  const v = makeVerbs({ profileDir }, { now: () => 1700000000000 });
  const r = await v.run('config-set', { set: { agentEnabled: true }, dryRun: false }, { taskId: 't1' });
  assert.equal(r.ok, true);
  const newText = fs.readFileSync(patchFile, 'utf8');
  assert.match(newText, /worker:/, '自动插入 worker: 子块');
  assert.match(newText, /        agentEnabled: true/);
});

// v2.7.0（安全审计 C-17）：数字型配置值统一格式。
test('C-17：formatNumber 整数不带前导零、小数保留原值', () => {
  // '020' 在 JS 里就是数字 20（前导零不会被保留），写进 YAML 必须是 20。
  assert.equal(formatNumber(Number('020')), '20');
  assert.equal(formatNumber(20), '20');
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(20.0), '20');
  assert.equal(formatNumber(20.5), '20.5');
});

test('C-17：formatNumber 拒绝 NaN / Infinity / 非数字', () => {
  assert.equal(formatNumber(NaN), null);
  assert.equal(formatNumber(Infinity), null);
  assert.equal(formatNumber(-Infinity), null);
  assert.equal(formatNumber('20'), null);
  assert.equal(formatNumber(1e999), null);
});

test('C-17：超界数字（Infinity）→ maint-config-invalid，不写 Infinity', async () => {
  const v = makeConfigVerbs(samplePatch(), {});
  // JSON 里 1e999 解析成 Infinity（Number.isFinite=false）
  const r = await v.run('config-set', { set: { shellTimeoutMs: 1e999 } }, { taskId: 't1' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, MAINT_VERB_REASONS.CONFIG_INVALID);
  assert.match(r.note, /shellTimeoutMs 值类型不合法/);
});

test('C-17：字符串数字 → maint-config-invalid（数字键不再接受字符串）', async () => {
  const v = makeConfigVerbs(samplePatch(), {});
  const r = await v.run('config-set', { set: { agentBudgetMaxPerDay: '020' } }, { taskId: 't1' });
  assert.equal(r.reason, MAINT_VERB_REASONS.CONFIG_INVALID);
});

// v2.6.28（U-5）：找 team 块的正则只认 `- id: team`，遇到单引号 / 行尾注释就报
// 「未找到 team 块」⇒ config-set 写不进去。正则改成容忍可选引号与行尾注释。
test('config-set：team id 是单引号形态也能定位并写入', async () => {
  const profileDir = tmpDir();
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const patch = [
    "- insert:",
    "    - id: 'team'",
    "      config:",
    "        boardUrl: ''",
    "      worker:",
    "        pollMs: 2000",
  ].join('\n');
  fs.writeFileSync(patchFile, patch, 'utf8');
  const v = makeVerbs({ profileDir }, { now: () => 1700000000000 });
  const r = await v.run('config-set', { set: { workerMode: 'on' }, dryRun: false }, { taskId: 't1' });
  assert.equal(r.ok, true, `单引号形态应定位到 team 块：${r.note}`);
  const newText = fs.readFileSync(patchFile, 'utf8');
  assert.match(newText, /workerMode: 'on'/, 'workerMode 已写入');
});

test('config-set：team id 带行尾注释也能定位并写入', async () => {
  const profileDir = tmpDir();
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const patch = [
    "- insert:",
    "    - id: team # 团队作业板（注释不应挡住定位）",
    "      config:",
    "        boardUrl: ''",
    "      worker:",
    "        pollMs: 2000",
  ].join('\n');
  fs.writeFileSync(patchFile, patch, 'utf8');
  const v = makeVerbs({ profileDir }, { now: () => 1700000000000 });
  const r = await v.run('config-set', { set: { workerMode: 'on' }, dryRun: false }, { taskId: 't1' });
  assert.equal(r.ok, true, `行尾注释形态应定位到 team 块：${r.note}`);
  const newText = fs.readFileSync(patchFile, 'utf8');
  assert.match(newText, /workerMode: 'on'/, 'workerMode 已写入');
});

// v2.6.28（安全审计 C-3）：validateConfigValue 与归一化对 agentAllowlist 要求不一致——
// 归一化层允许缺 id（自动补 allow-<序号>），validateConfigValue 却要求每项有 id。
// 统一口径后：validateConfigValue 不再要求 id，缺 id 由归一化层自动补。
test('config-set：写入缺 id 的 allowlist 后读回来带自动 id（v2.6.28 C-3）', async () => {
  const profileDir = tmpDir();
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  fs.writeFileSync(patchFile, samplePatch(), 'utf8');
  const v = makeVerbs({ profileDir }, { now: () => 1700000000000 });
  // 缺 id 的 allowlist 条目：validateConfigValue 现在允许（与归一化一致）
  const r = await v.run('config-set', { set: { agentAllowlist: [{ titlePrefix: 'x' }] }, dryRun: false }, { taskId: 't1' });
  assert.equal(r.ok, true, `缺 id 的 allowlist 应被接受：${r.note}`);
  // 读回 YAML，提取 agentAllowlist 值，经归一化后应有自动 id
  const newText = fs.readFileSync(patchFile, 'utf8');
  const m = newText.match(/^        agentAllowlist: (.+)$/m);
  assert.ok(m, 'agentAllowlist 已写入 worker: 子块');
  const parsed = JSON.parse(m[1]);
  const { entries } = normalizeAgentAllowlist(parsed);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'allow-1');
  assert.equal(entries[0].titlePrefix, 'x');
});

// v2.6.28（安全审计 C-11）：dryRun 严格判定——0 / 'false' / '' 不再被当 true，而是 invalid。
test('config-set：dryRun=0 → maint-config-invalid（v2.6.28 C-11）', async () => {
  const v = makeConfigVerbs(samplePatch(), {});
  const r = await v.run('config-set', { set: { workerMode: 'on' }, dryRun: 0 }, { taskId: 't1' });
  assert.equal(r.reason, MAINT_VERB_REASONS.CONFIG_INVALID);
  assert.match(r.note, /dryRun/);
});

test('config-set：dryRun="false" → maint-config-invalid（v2.6.28 C-11）', async () => {
  const v = makeConfigVerbs(samplePatch(), {});
  const r = await v.run('config-set', { set: { workerMode: 'on' }, dryRun: 'false' }, { taskId: 't1' });
  assert.equal(r.reason, MAINT_VERB_REASONS.CONFIG_INVALID);
  assert.match(r.note, /dryRun/);
});

test('config-set：dryRun=false → 真写盘（v2.6.28 C-11）', async () => {
  const profileDir = tmpDir();
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  fs.writeFileSync(patchFile, samplePatch(), 'utf8');
  const v = makeVerbs({ profileDir }, { now: () => 1700000000000 });
  const r = await v.run('config-set', { set: { workerMode: 'on' }, dryRun: false }, { taskId: 't1' });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, undefined);
  const newText = fs.readFileSync(patchFile, 'utf8');
  assert.match(newText, /workerMode: 'on'/, 'dryRun=false 应真写盘');
});

test('config-set：dryRun=true → dryRun 不写盘（v2.6.28 C-11）', async () => {
  const profileDir = tmpDir();
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const original = samplePatch();
  fs.writeFileSync(patchFile, original, 'utf8');
  const v = makeVerbs({ profileDir }, { now: () => 1700000000000 });
  const r = await v.run('config-set', { set: { workerMode: 'on' }, dryRun: true }, { taskId: 't1' });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(fs.readFileSync(patchFile, 'utf8'), original, 'dryRun=true 不写盘');
});

// ── 4. restart ──────────────────────────────────────────────────────────

test('restart：maintenanceAllowRestart 未开 → maint-restart-disabled', async () => {
  const v = makeVerbs({});
  const r = await v.run('restart', {}, { taskId: 't1' });
  assert.equal(r.reason, MAINT_VERB_REASONS.RESTART_DISABLED);
});

test('restart：dshExePath 未配置 → maint-restart-path（不许 kill）', async () => {
  const v = makeVerbs({ maintenanceAllowRestart: true });
  const r = await v.run('restart', {}, { taskId: 't1' });
  assert.equal(r.reason, MAINT_VERB_REASONS.RESTART_PATH);
});

test('restart：dshExePath 不存在 → maint-restart-path', async () => {
  const v = makeVerbs({ maintenanceAllowRestart: true, dshExePath: 'C:\\nope\\dsh.exe' });
  const r = await v.run('restart', {}, { taskId: 't1' });
  assert.equal(r.reason, MAINT_VERB_REASONS.RESTART_PATH);
});

test('restart：spawnImpl 未注入 → maint-spawn-failed', async () => {
  const dshExe = tmpDir() + '\\dsh.exe';
  fs.writeFileSync(dshExe, 'x');
  const v = makeVerbs({ maintenanceAllowRestart: true, dshExePath: dshExe });
  // 注意：makeVerbs 默认 spawnImpl=null，但 makeVerbs 里 opts.spawnImpl 默认 null
  // 这里不传 spawnImpl → null
  const r = await v.run('restart', {}, { taskId: 't1' });
  assert.equal(r.reason, MAINT_VERB_REASONS.SPAWN_FAILED);
});

test('restart：delayMs 缺省 8000，夹 3000..60000', async () => {
  const dshExe = tmpDir() + '\\dsh.exe';
  fs.writeFileSync(dshExe, 'x');
  let spawned = null;
  const v = makeVerbs({
    maintenanceAllowRestart: true,
    dshExePath: dshExe,
    pwshPath: 'C:\\pwsh.exe',
  }, {
    spawnImpl: (cmd, args, opts) => { spawned = { cmd, args, opts }; },
  });
  // 缺省
  await v.run('restart', {}, { taskId: 't1' });
  assert.ok(spawned, 'spawnImpl 被调');
  assert.equal(spawned.cmd, 'C:\\pwsh.exe');
  assert.match(spawned.args[4], /Start-Sleep -Milliseconds 8000/, '缺省 8000');
  // 小于 3000 夹到 3000
  spawned = null;
  await v.run('restart', { delayMs: 1000 }, { taskId: 't2' });
  assert.match(spawned.args[4], /Start-Sleep -Milliseconds 3000/);
  // 大于 60000 夹到 60000
  spawned = null;
  await v.run('restart', { delayMs: 999999 }, { taskId: 't3' });
  assert.match(spawned.args[4], /Start-Sleep -Milliseconds 60000/);
});

test('restart：成功时传给 spawnImpl 的脚本含校验 + Stop + Start', async () => {
  const dshExe = tmpDir() + '\\dsh.exe';
  fs.writeFileSync(dshExe, 'x');
  let spawned = null;
  const v = makeVerbs({
    maintenanceAllowRestart: true,
    dshExePath: dshExe,
    pwshPath: 'C:\\pwsh.exe',
  }, {
    spawnImpl: (cmd, args, opts) => { spawned = { cmd, args, opts }; },
  });
  const r = await v.run('restart', { delayMs: 5000 }, { taskId: 't1' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'done');
  assert.equal(r.reason, 'ok');
  assert.match(r.note, /将在 5 秒后重启/);
  // detached + stdio ignore
  assert.equal(spawned.opts.detached, true);
  assert.equal(spawned.opts.stdio, 'ignore');
  // script 含校验（Test-Path dshExe）+ Stop-Process + Start-Process
  const script = spawned.args[4];
  assert.match(script, /Test-Path -LiteralPath '.*dsh\.exe'/, '脚本含 dshExe 校验');
  assert.match(script, /Stop-Process -Id \d+ -Force/, '脚本含 Stop-Process');
  assert.match(script, /Start-Process -FilePath '.*dsh\.exe'/, '脚本含 Start-Process');
  assert.match(script, /Start-Sleep -Milliseconds 5000/, '脚本含 delay');
  // 注：本测试 config 无 stateDir → 不写 log；log 写入见下条测试
});

test('restart：stateDir 配置时写 restart-<taskId>.log', async () => {
  const dshExe = tmpDir() + '\\dsh.exe';
  fs.writeFileSync(dshExe, 'x');
  const stateDir = tmpDir();
  let spawned = null;
  const v = makeVerbs({
    maintenanceAllowRestart: true,
    dshExePath: dshExe,
    pwshPath: 'C:\\pwsh.exe',
    stateDir,
  }, {
    spawnImpl: (cmd, args, opts) => { spawned = { cmd, args, opts }; },
  });
  await v.run('restart', { delayMs: 4000 }, { taskId: 'task-abc' });
  const logFile = path.join(stateDir, 'restart-task-abc.log');
  assert.ok(fs.existsSync(logFile), 'log 文件应写入');
  const log = fs.readFileSync(logFile, 'utf8');
  assert.match(log, /restart at/);
  assert.match(log, /delay=4000/);
});

test('restart：spawn 抛异常 → maint-spawn-failed', async () => {
  const dshExe = tmpDir() + '\\dsh.exe';
  fs.writeFileSync(dshExe, 'x');
  const v = makeVerbs({
    maintenanceAllowRestart: true,
    dshExePath: dshExe,
  }, {
    spawnImpl: () => { throw new Error('spawn boom'); },
  });
  const r = await v.run('restart', {}, { taskId: 't1' });
  assert.equal(r.reason, MAINT_VERB_REASONS.SPAWN_FAILED);
  assert.match(r.note, /spawn 失败/);
});

// ── 5. supported / 边界 ────────────────────────────────────────────────

test('supported：三个写动词，不含只读', () => {
  const v = makeVerbs({});
  assert.equal(v.supported('upgrade'), true);
  assert.equal(v.supported('config-set'), true);
  assert.equal(v.supported('restart'), true);
  assert.equal(v.supported('version'), false);
  assert.equal(v.supported('exec'), false);
});

test('run：未知动词 → maint-verb-unknown', async () => {
  const v = makeVerbs({});
  const r = await v.run('version', {}, { taskId: 't1' });
  assert.equal(r.reason, MAINT_VERB_REASONS.VERB_UNKNOWN);
});

test('WRITE_VERBS 是冻结常量', () => {
  assert.deepEqual([...WRITE_VERBS], ['upgrade', 'config-set', 'restart']);
  assert.throws(() => WRITE_VERBS.push('exec'), TypeError);
});

// v2.6.28（安全审计 S-13）：dshExePath 直接插进 PowerShell 单引号串，路径里一个 ' 就能闭合引号。
// 用「单引号加倍」转义（而不是黑名单），既封住注入、又不误伤中文/Unicode 用户名路径。
test('restart：dshExePath 含单引号 → 单引号加倍转义后仍可执行（注入被封）', async () => {
  const dir = tmpDir();
  const exe = dir + "\\dsh'q.exe";
  fs.writeFileSync(exe, 'x');
  let spawned = null;
  const v = makeVerbs({
    maintenanceAllowRestart: true,
    dshExePath: exe,
    pwshPath: 'C:\\pwsh.exe',
  }, { spawnImpl: (cmd, args) => { spawned = { cmd, args }; } });
  const r = await v.run('restart', {}, { taskId: 't1' });
  assert.equal(r.ok, true);
  const script = spawned.args[4];
  assert.ok(script.includes("dsh''q.exe"), '单引号被加倍转义');
  assert.ok(!script.includes("'dsh'q.exe'"), '未出现可闭合的原始单引号串');
  assert.match(script, /Test-Path -LiteralPath/);
});

test('restart：dshExePath 含分号 → 不存在的路径仍拦住', async () => {
  const v = makeVerbs({
    maintenanceAllowRestart: true,
    dshExePath: 'C:\\dsh.exe; rm -rf /',
  });
  const r = await v.run('restart', {}, { taskId: 't1' });
  assert.equal(r.reason, MAINT_VERB_REASONS.RESTART_PATH);
});

// ── 端到端：票据签发 → 真实 runner（含 nonce 落盘）→ 真实 maint-verbs 写盘 ──
test('端到端：签发票据 → runner 消费 → maint-verbs 真写 config-set', async () => {
  const { keygen, signGoal } = await import('../../scripts/maint-ticket.mjs');
  const { createMaintenanceRunner, parseMaintenanceGoal } = await import('../../lib/worker/maintenance.js');

  const dir = tmpDir();
  const profileDir = path.join(dir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  fs.writeFileSync(patchFile, samplePatch(), 'utf8');

  const keyFile = path.join(dir, 'maint-key.json');
  const { publicKeyB64 } = keygen({ out: keyFile });

  // dryRun 默认开（安全默认）：端到端要真写盘必须显式 dryRun:false
  const payloadText = JSON.stringify({ verb: 'config-set', dryRun: false, set: { agentEnabled: true, agentPreset: 'narrow' } });
  const { goalText } = signGoal({ keyFile, payloadText, machine: 'gt14', verb: 'config-set', ttlSec: 300 });

  const verbs = createMaintVerbs({
    config: { profileDir },
    log: quietLog,
    profileDir,
  });
  const runner = createMaintenanceRunner({
    config: {
      machine: 'gt14',
      maintenanceEnabled: true,
      maintenanceWriteEnabled: true,
      maintAuthPublicKeys: [publicKeyB64],
      stateDir: dir,
      maintenanceOutDir: path.join(dir, 'payload'),
      profileDir,
    },
    log: quietLog,
    version: '2.7.0-test',
    verbs,
  });

  const spec = parseMaintenanceGoal(goalText).spec;
  assert.equal(spec.verb, 'config-set');
  const r = await runner.run(spec, { taskId: 'e2e-real' });
  assert.equal(r.status, 'done', r.note);

  const newText = fs.readFileSync(patchFile, 'utf8');
  assert.match(newText, /^ {8}agentEnabled: true$/m, 'agentEnabled 落在 worker: 子块');
  assert.match(newText, /^ {8}agentPreset: 'narrow'$/m);
  // nonce 已落盘（重放防线），且票据本身没进 note / payload
  assert.ok(fs.existsSync(path.join(dir, 'maint-used-nonces.json')));
  assert.doesNotMatch(String(r.note || ''), /ticket=/);
});
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../../lib/worker/config.js';

// v2.6.26 回归：写通道四个键必须能从 worker 子块读出。
// 2.6.20–2.6.25 归一化层漏了这些键，导致真机上永远 maint-write-disabled（本地单测直接构造
// config 对象，所以一直没暴露）。
test('normalizeConfig: 维护写通道的键从 worker 子块读出', () => {
  const { config } = normalizeConfig({
    machine: 'gt14',
    worker: {
      maintenanceWriteEnabled: true,
      maintenanceAllowRestart: true,
      maintenancePkgDir: 'C:/Users/x/.dsh/maint-pkgs',
      maintAuthPublicKeys: ['MCowBQYDK2VwAyEA7fw8lk+evVdGhDRat78skzmejq/bQJQ71MKqDCe1b+k='],
      dshExePath: 'C:/Program Files/DeepSeek Harness/DeepSeek Harness.exe',
    },
  });
  assert.equal(config.maintenanceWriteEnabled, true);
  assert.equal(config.maintenanceAllowRestart, true);
  assert.equal(config.maintenancePkgDir, 'C:/Users/x/.dsh/maint-pkgs');
  assert.equal(config.maintAuthPublicKeys.length, 1);
  assert.match(config.maintAuthPublicKeys[0], /^MCowBQYDK2Vw/);
  assert.equal(config.dshExePath, 'C:/Program Files/DeepSeek Harness/DeepSeek Harness.exe');
});

test('normalizeConfig: 维护写通道默认关闭（缺省即 fail closed）', () => {
  const { config } = normalizeConfig({ machine: 'gt14' });
  assert.equal(config.maintenanceWriteEnabled, false);
  assert.equal(config.maintenanceAllowRestart, false);
  assert.deepEqual(config.maintAuthPublicKeys, []);
});

test('normalizeConfig: 公钥也接受扁平单字符串，脏值被丢弃', () => {
  const one = normalizeConfig({ machine: 'gt14', maintAuthPublicKeys: ' MCowBQYDK2VwAyEA7fw8lk+evVdGhDRat78skzmejq/bQJQ71MKqDCe1b+k= ' }).config;
  assert.equal(one.maintAuthPublicKeys.length, 1);
  const bad = normalizeConfig({ machine: 'gt14', maintAuthPublicKeys: ['不是base64!!', 'ok+base64='] }).config;
  assert.deepEqual(bad.maintAuthPublicKeys, ['ok+base64=']);
});
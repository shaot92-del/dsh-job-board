// inline-shell 的斜杠长旗标（第三遍审计 N5）：归一化会把 `/` 折成 `\`，
// 所以 `powershell /Command …` 归一化后是 `powershell \Command …`，规则必须认这种形态。
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAgentPrompt, normalizeAgentPromptGate } from '../../lib/worker/agent-gate.js';

const GATE = normalizeAgentPromptGate({}).gate;
const deny = (goal) => {
  const r = checkAgentPrompt(goal, GATE);
  assert.equal(r.ok, false, `应当拒绝：${goal}`);
  assert.equal(r.rule, 'inline-shell', `命中规则：${goal}`);
};
const allow = (goal) => {
  const r = checkAgentPrompt(goal, GATE);
  assert.equal(r.ok, true, `应当放行：${goal}（命中 ${r.rule}）`);
};

test('inline-shell：斜杠长旗标一律拒绝', () => {
  deny('powershell /Command "Get-Process"');
  deny('pwsh /NoProfile /Command Get-Process');
  deny('powershell /enc AAAA');
  deny('pwsh /ec AAAA');
  deny('pwsh /EncodedCommand AAAA');
});

test('inline-shell：普通路径与正常短旗标不被误拒', () => {
  allow('跑一下 C:\\scripts\\com\\build.ps1');
  allow('看看 C:\\repo\\ec\\notes.md');
  allow('git -c core.quotepath=false log --oneline -5');
  allow('rg -e TODO src');
  allow('docker run -e FOO=1 busybox env');
  allow('powershell -NoProfile -File .\\scripts\\build.ps1');
});

test('inline-shell：反斜杠短旗标（cmd \\c）仍然拒绝', () => {
  deny('cmd /c whoami');
  deny('sh -c whoami');
});

// 第四遍审计：`/c`、`/e` 与「引号把旗标裹起来」的写法都能真实执行，必须一并拒。
test('inline-shell：短斜杠旗标 /c、/e 也要拒', () => {
  deny('powershell /c whoami');
  deny('pwsh /c whoami');
  deny('pwsh /e AAAA');
  deny('cmd /c ver');
});

test('inline-shell：引号包裹的旗标同样要拒', () => {
  deny('powershell "/Command" whoami');
  deny("powershell '/c' whoami");
  deny('cmd /c powershell "/Command" ping -n 1 127.0.0.1');
});

test('inline-shell：这些正常任务不能被上面的收紧误拒', () => {
  allow('docker run -e FOO=1 -e BAR=2 busybox env');
  allow('git -c core.pager=cat log');
  allow('Get-Content C:\\scripts\\com\\x.ps1');
  allow('open ./ec/notes.md');
});

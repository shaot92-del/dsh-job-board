import assert from 'node:assert/strict';
import test from 'node:test';

import { checkAgentPrompt, normalizeAgentPromptGate } from '../../lib/worker/agent-gate.js';

// 第五遍/第六遍审计的结论：PowerShell 参数按「无歧义前缀」绑定，bash 族靠 -c 执行命令，
// 于是闸门不能只认全名（-Command / -EncodedCommand），也不能只看「解释器后 N 个字符」
// （空格/换行能撑破窗口），更不能漏掉 ${env:...}、cmd /r 与 Start-Process 这类间接调用。
const gate = normalizeAgentPromptGate({}).gate;
const deny = (goal) => checkAgentPrompt(goal, gate).ok === false;
const pad = ' '.repeat(130);

test('checkAgentPrompt：-Command 的前缀缩写一律拒', () => {
  for (const goal of [
    'pwsh -NoProfile -Comman whoami',
    'pwsh -NoProfile /Comman whoami',
    'pwsh -NoProfile -comm whoami',
    'pwsh -NoProfile -com whoami',
    'pwsh -NoProfile -command whoami',
    'powershell "/Comman" whoami',
    'cmd /c powershell "/Comman" whoami',
    `pwsh${pad}-Comman whoami`,
    `& pwsh -NoProfile${pad}-Comman "Write-Output pad-ok"`,
  ]) {
    assert.equal(deny(goal), true, goal);
  }
});

test('checkAgentPrompt：-EncodedCommand 的前缀缩写（-en / -enco / -encoded）一律拒', () => {
  for (const goal of [
    'pwsh -NoProfile -en YQ==',
    'pwsh -NoProfile -enco YQ==',
    'pwsh -NoProfile -encoded YQ==',
    'powershell.exe -EncodedCommand AAAA',
    'powershell /ec AAAA',
  ]) {
    assert.equal(deny(goal), true, goal);
  }
});

test('checkAgentPrompt：长选项链、换行、COMSPEC（含 ${...}）、cmd /r、wsl -e 都不能漏', () => {
  for (const goal of [
    'pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -c whoami',
    'powershell\n-c whoami',
    '%COMSPEC% /c whoami',
    '$env:ComSpec /k dir',
    '${env:ComSpec} /c "echo envbrace-ok"',
    'cmd /r "echo cmd-r-ok"',
    'cmd.exe /R "whoami"',
    'wsl.exe -e bash -c id',
  ]) {
    assert.equal(deny(goal), true, goal);
  }
});

test('checkAgentPrompt：bash 族的 -c（含分离旗标、连写）都要拒', () => {
  for (const goal of [
    'bash -lc "whoami"',
    'bash -l -c "whoami"',
    'bash --noprofile -c whoami',
    'bash -ce whoami',
    'bash -cx whoami',
    'sh -c whoami',
  ]) {
    assert.equal(deny(goal), true, goal);
  }
});

test('checkAgentPrompt：Start-Process 间接调用同样要拒', () => {
  const goal =
    "Start-Process pwsh -ArgumentList '-NoProfile','-Comman','Write-Output startproc-ok' -NoNewWindow -Wait";
  assert.equal(deny(goal), true, goal);
});

test('checkAgentPrompt：CR 指出的长度填充与 cmd /q /k、/d /c、wsl --exec 都要拒', () => {
  const longChain =
    'pwsh -NoLogo -NoProfile -NonInteractive -InputFormat Text -OutputFormat Text ' +
    '-ExecutionPolicy Bypass -WorkingDirectory C:/Users/averylongworkspacepath_example/' +
    'anotherlevel/default-workspace -c whoami';
  for (const goal of [
    // 第六遍 CR：ff49c86 曾把这些从 DENY 变 ALLOW
    'bash -l -c whoami',
    'bash --noprofile -c whoami',
    'sh -x -c whoami',
    'bash -o pipefail -c "echo x"',
    'zsh -f -c id',
    'bash -e -c whoami',
    // 长度填充：188 字符的规范长链
    longChain,
    // cmd 的开关可以叠在 /c /k 前面
    'cmd /q /k "echo HELLO_K"',
    '%COMSPEC% /d /c whoami',
    // wsl 的 --exec 等价于直接起 Linux 进程
    'wsl --exec whoami',
  ]) {
    assert.equal(deny(goal), true, goal);
  }
});

test('checkAgentPrompt：超长空白填充、引号/括号包住的 ComSpec、多开关与引号开关都要拒', () => {
  const giant = (n) => 'pwsh -NoProfile' + ' '.repeat(n) + '-Comman "Write-Output pad-ok"';
  const dollar = String.fromCharCode(36);
  for (const goal of [
    // 第七遍审计 P2-1：2000 字符段上限可被空白撑破
    giant(2001),
    giant(2100),
    // P2-2：环境变量被引号/括号包住时旧正则臂不匹配
    '& "' + dollar + 'env:ComSpec" /c "echo quoted-env-ok"',
    '& ("' + dollar + 'env:ComSpec") /c "echo paren-env-ok"',
    '& "' + dollar + '{env:ComSpec}" /c whoami',
    // P2-3：中间开关多于 3 个、或开关带引号
    '%COMSPEC% /q /d /s /v /c whoami',
    '%COMSPEC% "/q" "/d" "/c" whoami',
  ]) {
    assert.equal(deny(goal), true, goal.slice(0, 60));
  }
});

test('checkAgentPrompt：赋值拼接出来的 -c / -k 也要拒（分隔符含等号）', () => {
  for (const goal of [
    '$a=' + String.fromCharCode(39) + '/c' + String.fromCharCode(39) + '; & $env:ComSpec $a $b',
    '$a = ' + String.fromCharCode(39) + '/c' + String.fromCharCode(39) + '; cmd $a whoami',
    '$f=' + String.fromCharCode(39) + '/r' + String.fromCharCode(39) + '; %COMSPEC% $f whoami',
  ]) {
    assert.equal(deny(goal), true, goal);
  }
});

test('checkAgentPrompt：正常任务与路径不能被旗标规则误拒', () => {
  for (const goal of [
    'git -c core.quotepath=false log',
    'rg -e TODO src',
    'docker run -e FOO=1 alpine',
    'bash -e rc.sh',
    'sh -e run.sh',
    'ls -la /tmp',
    '跑一下 C:\\scripts\\com\\x.ps1',
    '把 C:\\repo\\ec\\notes.md 里的说明抄出来',
    '用 powershell 打开 C:\\com\\readme.md',
    'pwsh -NoProfile -File C:\\repo\\ec\\notes.md',
    '把 build.ps1 里的 -c 参数改成 -f',
    // 路径段里的 sh / cmd 不是解释器（CR 第七轮 P3）
    '把 C:\\repo\\sh\\run.ps1 里的 -c 参数改成 -f',
    '把 C:\\tools\\cmd\\notes.md 里的 -k 参数说明抄出来',
  ]) {
    assert.equal(deny(goal), false, goal);
  }
});

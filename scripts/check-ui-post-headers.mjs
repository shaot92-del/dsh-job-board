#!/usr/bin/env node
import fs from 'node:fs';

// 默认检查 lib/client.js，支持自定义文件路径与 --json 参数
const argv = process.argv.slice(2);
const jsonMode = argv.includes('--json');
const targetFile = argv.find((a) => !a.startsWith('-')) || 'lib/client.js';
const WRITE_METHOD_RE = /\bmethod\s*:\s*['"`](POST|PUT|DELETE)['"`]/i;
const ALLOW_RE = /\/\/\s*allow-no-ui-header\b/;

/** 跳过注释与字符串（含模板字符串 ${...} 嵌套），保证括号配平准确 */
function skipTrivia(src, i) {
  const ch = src[i], next = src[i + 1];
  if (ch === '/' && next === '/') return (src.indexOf('\n', i + 2) + 1) || src.length;
  if (ch === '/' && next === '*') {
    const end = src.indexOf('*/', i + 2);
    return end === -1 ? src.length : end + 2;
  }
  if (ch === "'" || ch === '"') {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === ch) return j + 1;
    }
    return src.length;
  }
  if (ch === '`') {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue; }
      if (src[j] === '`') return j + 1;
      if (src[j] === '$' && src[j + 1] === '{') {
        for (let d = 1, k = j + 2; k < src.length && d > 0; k++) {
          const s = skipTrivia(src, k);
          if (s > k) { k = s - 1; continue; }
          if (src[k] === '{') d++;
          else if (src[k] === '}') { d--; if (d === 0) j = k; }
        }
      }
    }
    return src.length;
  }
  return i;
}

/** 括号配平提取 fetch(...) 的顶层实参列表 */
function extractCallArgs(src, openIdx) {
  const args = [];
  let depth = 0, argStart = openIdx + 1;
  for (let i = openIdx; i < src.length; i++) {
    if (i > openIdx) {
      const s = skipTrivia(src, i);
      if (s > i) { i = s - 1; continue; }
    }
    const ch = src[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      if (--depth === 0) {
        const last = src.slice(argStart, i).trim();
        if (last) args.push(last);
        return args;
      }
    } else if (ch === ',' && depth === 1) {
      args.push(src.slice(argStart, i).trim());
      argStart = i + 1;
    }
  }
  return args;
}

/** 排除函数声明、标识符后缀与非全局成员方法（仅放行 window/globalThis.fetch） */
function isFetchCall(src, idx) {
  if (idx > 0 && /[A-Za-z0-9_$]/.test(src[idx - 1])) return false;
  const prev = src.slice(Math.max(0, idx - 32), idx).trimEnd();
  if (/\bfunction$/.test(prev)) return false;
  return !prev.endsWith('.') || /(?:^|[^A-Za-z0-9_$])(?:window|globalThis)\.$/.test(prev);
}

/** 剔除 options 内的注释，防止注释掉的 header 被误判为合规 */
function stripComments(code) {
  let out = '';
  for (let i = 0; i < code.length; ) {
    const ch = code[i];
    if (ch === '/' && (code[i + 1] === '/' || code[i + 1] === '*')) { i = skipTrivia(code, i); continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = skipTrivia(code, i);
      out += code.slice(i, end);
      i = end;
      continue;
    }
    out += code[i++];
  }
  return out;
}

/** 规范化 URL 参数文本用于输出展示 */
const formatUrl = (raw) => {
  const s = (raw || '').trim().replace(/\s+/g, ' ');
  return !s ? '<unknown>' : (`'"\``.includes(s[0]) && s.endsWith(s[0]) ? s.slice(1, -1) : s);
};

// 读取目标文件并构建行号二分索引
const source = fs.readFileSync(targetFile, 'utf8');
const lines = source.split('\n');
const lineStarts = [0];
for (let i = 0; i < source.length; i++) if (source[i] === '\n') lineStarts.push(i + 1);
const getLine = (pos) => {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; lineStarts[mid] <= pos ? (lo = mid + 1) : (hi = mid - 1); }
  return hi + 1;
};

let checked = 0, post = 0, allowed = 0;
const violations = [];
for (let i = 0; i < source.length; i++) {
  const s = skipTrivia(source, i);
  if (s > i) { i = s - 1; continue; }
  if (!source.startsWith('fetch', i) || !isFetchCall(source, i)) continue;
  let openIdx = i + 5;
  while (openIdx < source.length && /\s/.test(source[openIdx])) openIdx++;
  if (source[openIdx] !== '(') continue;

  checked++;
  const [urlRaw = '', optsRaw = ''] = extractCallArgs(source, openIdx);
  const methodMatch = (optsRaw || urlRaw).match(WRITE_METHOD_RE);
  if (!methodMatch) continue;

  post++;
  const line = getLine(i);
  // 白名单校验：同行或上一行含 // allow-no-ui-header 则放行并计数
  if (ALLOW_RE.test(lines[line - 1] || '') || ALLOW_RE.test(lines[line - 2] || '')) { allowed++; continue; }

  const method = methodMatch[1].toUpperCase();
  const url = formatUrl(urlRaw);
  const optsClean = stripComments(optsRaw).trim();
  // 写请求必须具备对象字面量 options，且同时含 UI 守卫头与 content-type
  if (!optsClean || !optsClean.startsWith('{')) { violations.push({ line, method, url, reason: 'no-options-object' }); continue; }
  if (!/x-dsh-team-ui/i.test(optsClean) && !/\bUI_HEADERS\b/.test(optsClean)) violations.push({ line, method, url, reason: 'missing-ui-header' });
  if (!/content-type/i.test(optsClean)) violations.push({ line, method, url, reason: 'missing-content-type' });
}

const summary = `checked=${checked} post=${post} violations=${violations.length} allowed=${allowed}`;
if (jsonMode) {
  console.log(JSON.stringify(violations, null, 2));
  console.error(summary);
} else {
  for (const v of violations) console.log(`${targetFile}:${v.line}  ${v.method} ${v.url}  ${v.reason}`);
  console.log(summary);
}
process.exit(violations.length > 0 ? 1 : 0);

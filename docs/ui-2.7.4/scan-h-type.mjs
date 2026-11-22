#!/usr/bin/env node
/**
 * scan-h-type.mjs —— lib/client.js 里每个 h(...) 的 type（首参）静态扫描（一次性脚本，v2.7.4）。
 *
 * 背景：React #130（2.7.0 白屏事故）的根因是 `h(h('div',…), …)` —— 把「元素对象」当成了
 * 节点 type。渲染冒烟能抓运行时崩溃，但防线应该前移到静态：type 实参只允许
 *   1) 字符串字面量（'div' / "span"），或
 *   2) 函数组件标识符（本包当前没有，但规则允许），
 * 其它（表达式、嵌套 h()、对象、三元）一律报告。
 *
 * 用法：
 *   node docs/ui-2.7.4/scan-h-type.mjs [文件路径]        # 默认 lib/client.js，exit 0/1
 *   node docs/ui-2.7.4/scan-h-type.mjs --all <文件>       # 额外打印每个 h( 的分类（调试用）
 *
 * 负向验证（2026-11-22 实测）：
 *   node docs/ui-2.7.4/scan-h-type.mjs crashcase-2.7.0/case/lib-client-2.7.0-crash.bak
 *   → 精确抓出 #130 崩溃点（h(h('div',…))），exit 1。
 *   node docs/ui-2.7.4/scan-h-type.mjs
 *   → 0 violation，exit 0。
 *
 * 实现：正则定位 `\bh\s*\(`（前一个字符必须非 [A-Za-z0-9_$.]），从调用点做括号感知
 * 扫描取首个实参表达式（处理字符串/模板串内的逗号与括号），再按规则分类。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const target = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(root, 'lib', 'client.js'))
const verbose = process.argv.includes('--all')

const src = fs.readFileSync(target, 'utf8')
const lines = [] // 每个字符偏移对应的行号（懒对齐：按需换算）
function lineOf(off) {
  let line = 1
  for (let i = 0; i < off && i < src.length; i++) if (src.charCodeAt(i) === 10) line++
  return line
}

// 在 offset 处开始做括号感知扫描，返回首个实参的内容与结束偏移。
// start 位于 `h(` 的右括号之后：把这次调用视为已打开 depth=1。
// 遇到 depth===1 的逗号（首个实参结束）或配对右括号（无实参/结束）即返回。
function firstArg(start) {
  let depth = 1
  let i = start
  while (i < src.length) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      i++
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2
          continue
        }
        if (src[i] === q) break
        i++
      }
      i++
      continue
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++
      i++
      continue
    }
    if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) return { text: src.slice(start, i).trim(), end: i }
      i++
      continue
    }
    if (c === ',' && depth === 1) return { text: src.slice(start, i).trim(), end: i }
    i++
  }
  return { text: src.slice(start).trim(), end: src.length }
}

const results = []
const re = /(?<![A-Za-z0-9_$.])h\s*\(/g
let m
while ((m = re.exec(src))) {
  const callStart = m.index + m[0].length // 第一个实参起点
  const arg = firstArg(callStart)
  const t = arg.text
  let kind = 'VIOLATION'
  let detail = ''
  if (/^(['"`]).*\1$/s.test(t)) {
    kind = 'string-literal'
  } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t)) {
    // 标识符：必须是本文件里定义过的函数组件（function NAME / const NAME = …=>）
    const name = t
    const isFn =
      new RegExp('function\\s+' + name + '\\s*\\(').test(src) ||
      new RegExp('(?:const|let|var)\\s+' + name + '\\s*=\\s*(?:async\\s*)?(?:function|\\()').test(src)
    if (isFn) {
      kind = 'function-component'
    } else {
      kind = 'VIOLATION'
      detail = '标识符「' + name + '」在本文件里不是函数组件定义'
    }
  } else if (t === '') {
    kind = 'VIOLATION'
    detail = 'type 实参为空'
  } else {
    detail = 'type 是表达式（非字符串字面量/函数标识符）—— React #130 同型风险'
  }
  results.push({ line: lineOf(m.index), type: t.slice(0, 60), kind, detail })
  re.lastIndex = arg.end // 从实参结束处继续找，避免在同一次调用的实参里重复命中
}

if (verbose) {
  for (const r of results) console.log(`  L${String(r.line).padEnd(5)} ${r.kind.padEnd(18)} ${r.type}`)
}

const bad = results.filter((r) => r.kind === 'VIOLATION')
console.log(`scan-h-type: ${target}`)
console.log(`  h(...) 调用总数: ${results.length}`)
console.log(`  string-literal: ${results.filter((r) => r.kind === 'string-literal').length}`)
console.log(`  function-component: ${results.filter((r) => r.kind === 'function-component').length}`)
console.log(`  VIOLATION: ${bad.length}`)
for (const r of bad) console.log(`  FAIL  L${r.line}  type=${r.type || '(空)'}  ${r.detail}`)
if (bad.length) {
  console.log('FAIL  scan-h-type：存在把非字符串/非函数实参当 React type 的调用（#130 同型）')
  process.exitCode = 1
} else {
  console.log('PASS  scan-h-type：全部 h(...) 的 type 均为字符串字面量或函数组件标识符')
}

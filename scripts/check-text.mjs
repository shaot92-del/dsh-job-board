#!/usr/bin/env node
/**
 * Text hygiene check for tracked repo files.
 *
 * Why: review rounds kept finding the same class of defects — BOM/CRLF,
 * control characters from here-string escapes, duplicated phrases from
 * careless replacements, version drift between package.json and CHANGELOG,
 * and common English misspellings. These are cheap to catch mechanically,
 * so they should not consume a human/model review pass.
 *
 * Safety: only reads regular files under the repo (skips symlinks), caps each
 * file at 2 MiB and each line at 4000 chars, and exits 0 with a notice when
 * run outside a git checkout (the script ships inside the npm package).
 *
 * Usage: node scripts/check-text.mjs [--root <dir>]
 * Exit code: 0 = clean or only warnings, 1 = errors, 2 = not a usable repo.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = path.basename(import.meta.filename)
const MAX_BYTES = 2 * 1024 * 1024
const MAX_LINE = 4000
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml',
  '.ps1', '.py', '.txt', '.html', '.css', '.sh', '.cmd',
])
const EXTENSIONLESS_NAMES = new Set([
  '.gitattributes', '.gitignore', '.npmignore', '.editorconfig', 'LICENSE', 'NOTICE',
])

const MISSPELLINGS = [
  'recieve', 'recieved', 'occured', 'occurence', 'seperate', 'seperated',
  'definately', 'enviroment', 'teh', 'adress', 'sucess', 'sucessful',
  'faild', 'retrun', 'lenght', 'lenth', 'paramter', 'paramater',
  'commnad', 'comamnd', 'docuemnt', 'exmaple', 'refernce', 'dependancy',
  'compatability', 'avaliable', 'begining', 'calender', 'catagory',
  'changng', 'chekc', 'concurent', 'configuartion', 'connetion', 'contnet',
  'correcly', 'creatd', 'delte', 'deply', 'disbale', 'errorneous',
  'excpetion', 'existng', 'failue', 'fetaure', 'fileld', 'funciton',
  'gaurd', 'hanlder', 'immediatly', 'implmentation', 'inital', 'insted',
  'invlaid', 'langauge', 'libary', 'loggin', 'mananger', 'messsage',
  'neccessary', 'notificaton', 'permisson', 'preceed', 'prefered',
  'priviledge', 'refered', 'relevent', 'remaing', 'reponse', 'requets',
  'resouce', 'resposne', 'retreive', 'sepcific', 'similiar', 'specifc',
  'succes', 'suport', 'syncronize', 'tempory', 'ther', 'threshhold',
  'tiemout', 'tommorow', 'transfered', 'truely', 'udpate', 'unkown',
  'usefull', 'verison', 'wierd', 'withing', 'writen',
]
const MISS_SET = new Set(MISSPELLINGS)
const SKIP_TEXT_CHECK = new Set([SELF, 'check-text-smoke.mjs'])
const CODE_LIKE = /[{}()[\];=<>|\\]|^\s{4,}|^\t|https?:\/\//

const problems = []
const warnings = []

function addProblem(file, line, kind, detail) {
  problems.push({ file, line, kind, detail })
}

function addWarning(file, line, kind, detail) {
  warnings.push({ file, line, kind, detail })
}

function readRootArg() {
  const index = process.argv.indexOf('--root')
  if (index >= 0 && process.argv[index + 1]) return path.resolve(process.argv[index + 1])
  return fileURLToPath(new URL('..', import.meta.url))
}

const ROOT = readRootArg()

function listFiles() {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: ROOT,
      stdio: 'ignore',
    })
  } catch {
    console.log('check-text: 不在 git 工作区，跳过（npm 包内没有 .git）')
    return null
  }
  const raw = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
  )
  return raw
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((f) => {
      const ext = path.extname(f).toLowerCase()
      if (TEXT_EXT.has(ext)) return true
      if (ext === '') return EXTENSIONLESS_NAMES.has(path.basename(f))
      return false
    })
}

function checkDupCjk(line, rel, lineNo) {
  // Direct back-reference: a 4+ Han run repeated with a short connector between.
  // Bounded by MAX_LINE, so the backtracking stays cheap.
  const m = line.match(/([\p{Script=Han}]{4,})([或和与、,，\s]{0,3})\1/u)
  if (!m) return
  addProblem(rel, lineNo, 'dup-cjk', `重复短语：${m[1]}`)
}

function checkFences(lines, rel) {
  let open = ''
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s*(`{3,}|~{3,})/)
    if (!m) continue
    if (!open) {
      open = m[1]
      continue
    }
    if (m[1][0] === open[0] && m[1].length >= open.length) open = ''
  }
  if (open) addProblem(rel, 1, 'fence', '代码围栏未闭合')
}

function isBinary(buf) {
  const limit = Math.min(buf.length, 8192)
  for (let i = 0; i < limit; i += 1) if (buf[i] === 0) return true
  return false
}

function checkFile(rel) {
  const abs = path.join(ROOT, rel)
  let st
  try {
    st = fs.lstatSync(abs)
  } catch {
    return
  }
  if (st.isSymbolicLink()) {
    addWarning(rel, 1, 'symlink', '跳过符号链接')
    return
  }
  if (!st.isFile()) return
  if (st.size > MAX_BYTES) {
    addWarning(rel, 1, 'too-large', `文件 ${st.size} B 超过 2 MiB，跳过`)
    return
  }

  const buf = fs.readFileSync(abs)
  const utf8Bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  const utf16Bom = buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))
  if (utf8Bom) addProblem(rel, 1, 'bom', '文件以 UTF-8 BOM 开头')
  if (utf16Bom) {
    addProblem(rel, 1, 'bom', '文件以 UTF-16 BOM 开头')
    return
  }
  if (isBinary(buf)) {
    addWarning(rel, 1, 'binary', '含 NUL 字节，按二进制跳过')
    return
  }

  const isCmd = rel.toLowerCase().endsWith('.cmd')
  const text = buf.toString('utf8')

  let crlfLine = 0
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) {
      if (!isCmd) {
        let n = 1
        for (let j = 0; j < i; j += 1) if (buf[j] === 0x0a) n += 1
        crlfLine = n
      }
      break
    }
  }
  if (!isCmd && crlfLine) addProblem(rel, crlfLine, 'crlf', '含 CRLF 换行（仓库统一用 LF，.cmd 除外）')

  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0d && buf[i + 1] !== 0x0a) {
      addProblem(rel, 1, 'lone-cr', '含孤立 CR（不是 CRLF）')
      break
    }
  }

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i]
    const lineNo = i + 1
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    const ctrl = line.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/)
    if (ctrl) {
      addProblem(rel, lineNo, 'control-char', `含控制字符 U+${ctrl[0].codePointAt(0).toString(16).padStart(4, '0')}`)
    }

    if (line !== line.replace(/[ \t]+$/, '')) {
      const trailing = line.match(/[ \t]+$/)?.[0] ?? ''
      if (rel.endsWith('.md')) {
        // Exactly two spaces is a Markdown hard line break; anything else is noise.
        if (trailing !== '  ') addWarning(rel, lineNo, 'trailing-space-md', '行尾空白不是标准的两个空格硬换行')
      } else {
        addProblem(rel, lineNo, 'trailing-space', '行尾有多余空白')
      }
    }

    if (SKIP_TEXT_CHECK.has(path.basename(rel))) continue
    if (line.length > MAX_LINE) {
      addWarning(rel, lineNo, 'long-line', `单行 ${line.length} 字符，跳过重复检测`)
      continue
    }

    const prose = (rel.endsWith('.md') || rel.endsWith('.txt'))
    const hasHan = /[\p{Script=Han}]/u.test(line)
    if (prose && hasHan) checkDupCjk(line, rel, lineNo)

    if (CODE_LIKE.test(line)) continue

    const wordsForSpell = line.match(/\b[A-Za-z][A-Za-z'-]{2,}\b/g) ?? []
    for (const w of wordsForSpell) {
      if (MISS_SET.has(w.toLowerCase())) {
        addProblem(rel, lineNo, 'spelling', `疑似拼写错误：${w}`)
      }
    }
  }

  if (rel.endsWith('.md')) checkFences(lines, rel)
}

function readGuarded(abs) {
  let st
  try {
    st = fs.lstatSync(abs)
  } catch {
    return null
  }
  if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_BYTES) return null
  return fs.readFileSync(abs)
}

function checkVersionConsistency() {
  const pkgPath = path.join(ROOT, 'package.json')
  const pkgBuf = readGuarded(pkgPath)
  if (!pkgBuf) {
    addProblem('package.json', 1, 'version', 'package.json 是符号链接/非文件/超过 2 MiB，拒绝读取')
    return true
  }
  const pkg = (() => {
    try {
      return JSON.parse(pkgBuf.toString('utf8'))
    } catch (error) {
      addProblem('package.json', 1, 'version', `package.json 不是合法 JSON：${error.message}`)
      return null
    }
  })()
  if (!pkg) return true
  const changelogPath = path.join(ROOT, 'CHANGELOG.md')
  let logStat
  try {
    logStat = fs.lstatSync(changelogPath)
  } catch {
    return true
  }
  if (logStat.isSymbolicLink()) {
    addProblem('CHANGELOG.md', 1, 'version', 'CHANGELOG.md 是符号链接，拒绝读取')
    return true
  }
  const logBuf = readGuarded(changelogPath)
  if (!logBuf) {
    addProblem('CHANGELOG.md', 1, 'version', 'CHANGELOG.md 是符号链接/非文件/超过 2 MiB，拒绝读取')
    return true
  }
  const match = logBuf.toString('utf8').match(/^##\s+v?(\d+\.\d+\.\d+)/m)
  if (!match) {
    addProblem('CHANGELOG.md', 1, 'version', '找不到首个 `## vX.Y.Z` 版本标题')
    return true
  }
  if (match[1] !== pkg.version) {
    addProblem(
      'CHANGELOG.md',
      1,
      'version',
      `CHANGELOG 顶部版本 ${match[1]} 与 package.json ${pkg.version} 不一致`,
    )
  }
  return true
}

if (!fs.existsSync(path.join(ROOT, 'package.json'))) {
  console.error(`check-text: ${ROOT} 不像仓库根（缺 package.json）`)
  process.exit(2)
}

const files = listFiles()
if (files === null) process.exit(0)
if (files.length === 0) {
  console.error('check-text: 没有可扫描文件（git 索引为空？）')
  process.exit(2)
}
for (const f of files) checkFile(f)
checkVersionConsistency()

function printGroup(title, rows) {
  if (!rows.length) return
  console.log(`\n${title}（${rows.length}）`)
  for (const r of rows.slice(0, 200)) {
    console.log(`  ${r.file}:${r.line} [${r.kind}] ${r.detail}`)
  }
  if (rows.length > 200) console.log(`  … 其余 ${rows.length - 200} 条省略`)
}

console.log(`check-text: 扫描 ${files.length} 个文件（root=${ROOT}）`)
printGroup('ERROR', problems)
printGroup('WARN', warnings)

if (problems.length) {
  console.error(`\ncheck-text FAILED: ${problems.length} error(s)`)
  process.exitCode = 1
} else {
  console.log(`\ncheck-text PASSED${warnings.length ? `（${warnings.length} warning(s)）` : ''}`)
}


/**
 * dsh-team/lib/shell.js —— shell 与文件读写工具（原 dsh-shell，合并进单包）。
 *
 * 为什么需要：dsh-remote-agent 的 in-process worker 会话里，工具面只有「插件注册的工具」
 * 加 working_directory 一类环境工具，没有 pwsh / read / write / edit。
 * 副机 agent 因此建不了文件、跑不了命令。这里把能力做成插件工具注册进去。
 *
 * 工具：sh_run / sh_read / sh_write / sh_list
 *
 * 契约提醒（踩过的坑）：
 *   1. execute 必须返回无损 JSON（不能有 undefined）；
 *   2. output.render 必须返回 [{ type:'text', text }]，裸字符串会毒化会话历史。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

function toText(text) {
  return [{ type: 'text', text: String(text ?? '') }]
}

function lossless(value) {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return { ok: false, error: '返回值不是合法 JSON' }
  }
}

function parseArgs(args) {
  if (typeof args === 'string') {
    try {
      return JSON.parse(args)
    } catch {
      return {}
    }
  }
  return args && typeof args === 'object' ? args : {}
}

function pick(args, keys) {
  for (const k of keys) {
    const v = args[k]
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v)
  }
  return ''
}

function keysOf(args) {
  const ks = Object.keys(args || {})
  return ks.length ? ks.join(', ') : '(空对象)'
}

function withinRoots(target, roots) {
  if (!roots || roots.length === 0) return true
  const t = path.resolve(target)
  return roots.some((r) => {
    const rr = path.resolve(r)
    return t === rr || t.toLowerCase().startsWith(rr.toLowerCase() + path.sep)
  })
}

function truncate(buf, limit) {
  if (buf.length <= limit) return { text: buf.toString('utf8'), truncated: false, bytes: buf.length }
  return { text: buf.subarray(0, limit).toString('utf8'), truncated: true, bytes: buf.length }
}

const IS_WIN = process.platform === 'win32'

function runOnce(file, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, {
        cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      })
    } catch (error) {
      resolve({ ok: false, spawnError: true, message: String(error && error.message ? error.message : error) })
      return
    }
    const out = []
    const err = []
    let done = false
    const finish = (payload) => {
      if (done) return
      done = true
      resolve(payload)
    }
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => err.push(d))
    child.on('error', (error) => finish({ ok: false, spawnError: true, message: String(error.message) }))
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish({ ok: false, timedOut: true, timeoutMs })
    }, Math.max(1000, timeoutMs))
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ ok: true, code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) })
    })
  })
}

function runCommand(command, opts) {
  if (!IS_WIN) return runOnce('/bin/sh', ['-c', command], opts)
  const pwshArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
  return runOnce('pwsh.exe', pwshArgs, opts).then((r) => {
    if (r && r.spawnError && /ENOENT|not found/i.test(String(r.message || ''))) {
      return runOnce('powershell.exe', pwshArgs, opts)
    }
    return r
  })
}

function renderRun(value) {
  if (!value) return '(无结果)'
  if (value.timedOut) return '超时未完成（' + value.timeoutMs + 'ms）'
  if (value.spawnError) return '启动失败: ' + (value.message || '')
  const lines = ['exit=' + value.code]
  if (value.stdout) lines.push('--- stdout ---', value.stdout)
  if (value.stderr) lines.push('--- stderr ---', value.stderr)
  if (value.truncated) lines.push('（输出已截断）')
  return lines.join('\n')
}

function renderList(value) {
  const head = value.path + '  共 ' + value.total + ' 项'
  const rows = (value.items || []).map((it) => (it.isDir ? '[D] ' : '    ') + it.name + (it.isDir ? '/' : '  ' + it.bytes + 'B'))
  return [head].concat(rows).join('\n')
}

/** 注册 sh_* 四个工具。ctx 需要 inject 'tools'。 */
export function registerShellTools(ctx, config = {}) {
  const roots = Array.isArray(config.allowedRoots) ? config.allowedRoots.filter(Boolean) : []
  const defaultTimeout = Number(config.timeoutMs) || 120000
  const maxOut = Number(config.maxOutputBytes) || 200000

  ctx.tools.register({
    name: 'sh_run',
    description:
      '执行一条 shell 命令并返回退出码与输出（Windows 用 pwsh，Linux/macOS 用 /bin/sh）。'
      + '想建文件可以直接用重定向，例如：echo hi > notes.txt。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录（绝对路径，可选）' },
        timeoutMs: { type: 'number', description: '超时毫秒（可选）' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          code: { type: 'number' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          truncated: { type: 'boolean' },
          timedOut: { type: 'boolean' },
          message: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: (_args, value) => toText(renderRun(value)),
    },
    async execute(rawArgs) {
      const args = parseArgs(rawArgs)
      const command = pick(args, ['command', 'cmd', 'script', 'command_line', 'line']).trim()
      if (!command) return { ok: false, message: 'command 必填（收到的参数键：' + keysOf(args) + '）' }
      const cwd = pick(args, ['cwd', 'workdir', 'working_directory', 'dir'])
      if (cwd && !withinRoots(cwd, roots)) return { ok: false, message: 'cwd 不在 allowedRoots 之内: ' + cwd }
      const timeoutMs = Number(args && args.timeoutMs) || defaultTimeout
      const r = await runCommand(command, { cwd, timeoutMs })
      if (!r.ok) return lossless(r)
      const o = truncate(r.stdout, maxOut)
      const e = truncate(r.stderr, maxOut)
      return lossless({
        ok: r.code === 0,
        code: r.code,
        stdout: o.text,
        stderr: e.text,
        truncated: o.truncated || e.truncated,
      })
    },
  })

  ctx.tools.register({
    name: 'sh_read',
    description: '读取一个文本文件（UTF-8），超大文件按 maxBytes 截断。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        maxBytes: { type: 'number', description: '最多读多少字节（可选）' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          text: { type: 'string' },
          bytes: { type: 'number' },
          truncated: { type: 'boolean' },
          message: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: (_args, value) => toText(value && value.ok ? String(value.text ?? '') : '读取失败: ' + String(value && value.message ? value.message : '')),
    },
    async execute(rawArgs) {
      const args = parseArgs(rawArgs)
      const p = pick(args, ['path', 'file_path', 'filename', 'file'])
      if (!p) return { ok: false, message: 'path 必填（收到的参数键：' + keysOf(args) + '）' }
      if (!withinRoots(p, roots)) return { ok: false, message: 'path 不在 allowedRoots 之内: ' + p }
      try {
        const stat = fs.statSync(p)
        if (!stat.isFile()) return { ok: false, message: '不是文件: ' + p }
        const limit = Number(args && args.maxBytes) || maxOut
        const fd = fs.openSync(p, 'r')
        const buf = Buffer.alloc(Math.min(limit, stat.size))
        const n = fs.readSync(fd, buf, 0, buf.length, 0)
        fs.closeSync(fd)
        return lossless({ ok: true, path: p, text: buf.subarray(0, n).toString('utf8'), bytes: stat.size, truncated: stat.size > n })
      } catch (error) {
        return { ok: false, message: String(error && error.message ? error.message : error) }
      }
    },
  })

  ctx.tools.register({
    name: 'sh_write',
    description: '写文本文件（UTF-8 无 BOM），父目录不存在会自动创建；append=true 追加。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        text: { type: 'string', description: '要写入的内容' },
        append: { type: 'boolean', description: '是否追加（默认覆盖）' },
      },
      required: ['path', 'text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          bytes: { type: 'number' },
          message: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: (_args, value) => toText(value && value.ok ? '已写入 ' + value.path + '（' + value.bytes + ' 字节）' : '写入失败: ' + String(value && value.message ? value.message : '')),
    },
    async execute(rawArgs) {
      const args = parseArgs(rawArgs)
      const p = pick(args, ['path', 'file_path', 'filename', 'file', 'output'])
      const text = String(args.text ?? args.content ?? args.data ?? args.body ?? '')
      if (!p) return { ok: false, message: 'path 必填（收到的参数键：' + keysOf(args) + '）' }
      if (!withinRoots(p, roots)) return { ok: false, message: 'path 不在 allowedRoots 之内: ' + p }
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true })
        if (args && args.append) fs.appendFileSync(p, text, 'utf8')
        else fs.writeFileSync(p, text, 'utf8')
        return lossless({ ok: true, path: p, bytes: Buffer.byteLength(text, 'utf8') })
      } catch (error) {
        return { ok: false, message: String(error && error.message ? error.message : error) }
      }
    },
  })

  ctx.tools.register({
    name: 'sh_list',
    description: '列目录（返回 name/isDir/bytes/mtime），按名字排序。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录绝对路径' },
        limit: { type: 'number', description: '最多返回多少项（默认 200）' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          total: { type: 'number' },
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
          message: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: (_args, value) => toText(value && value.ok ? renderList(value) : '列目录失败: ' + String(value && value.message ? value.message : '')),
    },
    async execute(rawArgs) {
      const args = parseArgs(rawArgs)
      const p = pick(args, ['path', 'dir', 'directory', 'folder'])
      if (!p) return { ok: false, message: 'path 必填（收到的参数键：' + keysOf(args) + '）' }
      if (!withinRoots(p, roots)) return { ok: false, message: 'path 不在 allowedRoots 之内: ' + p }
      try {
        const limit = Number(args && args.limit) || 200
        const entries = fs.readdirSync(p, { withFileTypes: true })
        const items = entries.slice(0, limit).map((e) => {
          const full = path.join(p, e.name)
          let bytes = 0
          let mtime = 0
          try {
            const st = fs.statSync(full)
            bytes = st.size
            mtime = Math.round(st.mtimeMs)
          } catch {
            /* ignore */
          }
          return { name: e.name, isDir: e.isDirectory(), bytes, mtime }
        })
        return lossless({ ok: true, path: p, total: entries.length, items })
      } catch (error) {
        return { ok: false, message: String(error && error.message ? error.message : error) }
      }
    },
  })
}

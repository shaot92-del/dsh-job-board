/**
 * dsh-team —— Client 半边（浏览器静态 bundle，多机调度台 + 桌宠）。
 *
 * 只做 GUI：侧栏一个图标 + 主面板一张任务表。
 * 所有数据都走 Host 半边注册的 /api/board/ui/*，浏览器不直接跨网访问板子。
 *
 * 打包约定（与 dsh-remote-agent / imagegen 一致）：
 *   window.__ModuleLoader__.load({ id, factory(require) { ... return { inject, apply } } })
 * 只能 require('react')，不能 import 任何 @deepseek-ai/*。
 */
window.__ModuleLoader__.load({
  // v2.0.2：改名后这里必须跟着包名走。loader 用 id 把静态 bundle 挂到插件注册表上，
  // 留在 'dsh-team' 会让客户端找不到这个模块 —— 表现为 DSH 启动后界面起不来。
  id: '@wfcj/dsh-job-board',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    // v2.7.1：任何来自接口/状态的文本，落到渲染树之前统一转字符串。
    // 直接渲染对象会触发 React #31（Objects are not valid as a React child）；
    // 服务端有若干分支会把 out.reason / out.error 原样透传，这里做一次兜底归一。
    function asText(value, fallback) {
      const fb = fallback === undefined ? '' : String(fallback)
      if (value === null || value === undefined || value === '') return fb
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    }

    // F1：耗时格式化与纯展示辅助（不读 state.json、不在浏览器算历史 P50 桶）
    function fmtEta(sec) {
      if (sec === null || sec === undefined || sec === '') return '约 ?'
      const n = Number(sec)
      if (!Number.isFinite(n) || n <= 0) return '约 ?'
      const s = Math.round(n)
      if (s < 60) return '约 ' + s + ' 秒'
      if (s < 3600) {
        const m = Math.floor(s / 60)
        const r = s % 60
        return '约 ' + m + ' 分' + (r ? ' ' + r + ' 秒' : '')
      }
      const hr = Math.floor(s / 3600)
      const m = Math.floor((s % 3600) / 60)
      return '约 ' + hr + ' 小时' + (m ? ' ' + m + ' 分' : '')
    }

    function f1PerfOf(m) {
      const p = m && m.perf && typeof m.perf === 'object' ? m.perf : null
      if (!p) {
        return { cores: null, memFreeGb: null, memTotalGb: null, diskFreeGb: null, gpu: null, models: null, ffmpeg: null, pwsh: null }
      }
      return {
        cores: p.cores === null || p.cores === undefined ? null : p.cores,
        memFreeGb: p.memFreeGb === null || p.memFreeGb === undefined ? null : p.memFreeGb,
        memTotalGb: p.memTotalGb === null || p.memTotalGb === undefined ? null : p.memTotalGb,
        diskFreeGb: p.diskFreeGb === null || p.diskFreeGb === undefined ? null : p.diskFreeGb,
        gpu: p.gpu ? String(p.gpu) : null,
        models: p.models === null || p.models === undefined ? null : p.models,
        ffmpeg: typeof p.ffmpeg === 'boolean' ? p.ffmpeg : null,
        pwsh: typeof p.pwsh === 'boolean' ? p.pwsh : null,
      }
    }

    function f1LookupNodeModels(nm, machineId) {
      if (!nm || typeof nm !== 'object') return null
      const low = String(machineId || '').trim().toLowerCase()
      if (!low) return null
      if (Object.prototype.hasOwnProperty.call(nm, low)) return nm[low]
      for (const k of Object.keys(nm)) {
        if (String(k).toLowerCase() === low) return nm[k]
      }
      return null
    }

    function f1Fit(profile, m, nodeModels, busyOverride) {
      const pf = profile && typeof profile === 'object' ? profile : {}
      const mm = m && typeof m === 'object' ? m : {}
      const id = String(mm.id || mm.machine || mm.name || '')
      const mode = String(pf.mode || 'agent').trim().toLowerCase()
      const wantModel = String(pf.model || '').trim()
      const busy = typeof busyOverride === 'number' && Number.isFinite(busyOverride)
        ? Math.max(0, Math.floor(busyOverride))
        : (typeof mm.busy === 'number' && Number.isFinite(mm.busy) ? Math.max(0, Math.floor(mm.busy)) : 0)

      if (
        !wantModel &&
        !pf.needGpu &&
        !pf.needFfmpeg &&
        !pf.needPwsh &&
        mm.fit &&
        typeof mm.fit === 'object' &&
        typeof mm.fit.score === 'number' &&
        Array.isArray(mm.fit.reasons) &&
        (mm.busy === undefined || mm.busy === null || mm.busy === busy)
      ) {
        return mm.fit
      }
      if (mm.online !== true) return { machine: id, score: 0, reasons: ['离线'] }
      const perf = f1PerfOf(mm)
      const blockers = []
      if (wantModel && mode !== 'exec' && mode !== 'maint') {
        const full = new Set()
        const bare = new Set()
        let hasList = false
        const addItem = (item) => {
          if (!item) return
          if (typeof item === 'string') {
            const s = item.trim().toLowerCase()
            if (!s) return
            full.add(s)
            const idx = s.indexOf('/')
            bare.add(idx >= 0 ? s.slice(idx + 1) : s)
            return
          }
          if (typeof item === 'object') {
            const mid = String(item.model || item.id || '').trim().toLowerCase()
            const pid = String(item.provider || '').trim().toLowerCase()
            if (!mid) return
            bare.add(mid)
            full.add(pid ? pid + '/' + mid : mid)
          }
        }
        const nmEntry = f1LookupNodeModels(nodeModels, id)
        if (nmEntry && Array.isArray(nmEntry.models)) {
          hasList = true
          for (const x of nmEntry.models) addItem(x)
        }
        if (mm.caps && Array.isArray(mm.caps.models)) {
          hasList = true
          for (const x of mm.caps.models) addItem(x)
        }
        const wantLow = wantModel.toLowerCase()
        const ok = wantLow.indexOf('/') >= 0 ? full.has(wantLow) : (bare.has(wantLow) || full.has(wantLow))
        if (!ok) blockers.push(hasList ? ('无此模型（' + wantModel + '）') : '无此模型（未上报模型清单）')
      }
      if (pf.needGpu === true && !perf.gpu) blockers.push('缺少 GPU')
      if (pf.needFfmpeg === true && perf.ffmpeg !== true) blockers.push('缺少 ffmpeg')
      if (pf.needPwsh === true && perf.pwsh !== true) blockers.push('缺少 pwsh')
      if (blockers.length > 0) return { machine: id, score: 0, reasons: blockers }

      const busyScore = busy === 0 ? 35 : busy === 1 ? 20 : busy === 2 ? 10 : 0
      const memScore = perf.memFreeGb !== null ? Math.min(1, Math.max(0, Number(perf.memFreeGb)) / 32) * 25 : 12.5
      const coreScore = perf.cores !== null ? Math.min(1, Math.max(0, Number(perf.cores)) / 16) * 20 : 10
      const diskScore = perf.diskFreeGb !== null ? Math.min(1, Math.max(0, Number(perf.diskFreeGb)) / 200) * 20 : 10
      const score = Math.max(0, Math.min(100, Math.round(busyScore + memScore + coreScore + diskScore)))
      const reasons = []
      const hw = []
      if (perf.cores !== null) hw.push(perf.cores + ' 核')
      if (perf.memFreeGb !== null) hw.push('内存余 ' + perf.memFreeGb + 'G')
      else if (perf.memTotalGb !== null) hw.push('内存总量 ' + perf.memTotalGb + 'G（余量未知）')
      if (perf.diskFreeGb !== null) hw.push('磁盘余 ' + perf.diskFreeGb + 'G')
      if (perf.gpu) hw.push('GPU ' + String(perf.gpu).replace(/^NVIDIA GeForce\s+/i, ''))
      reasons.push(hw.length > 0 ? hw.join(' / ') : '硬件指标未知（按中性基线评估）')
      reasons.push(busy > 0 ? ('正在跑 ' + busy + ' 个任务 ⇒ 排后') : '当前空闲')
      if (wantModel && mode !== 'exec' && mode !== 'maint') reasons.push('具备模型 ' + wantModel)
      return { machine: id, score, reasons }
    }

    function f1LookupEtaSec(data, m, mode, model) {
      const etaMap = data && data.etaByKey && typeof data.etaByKey === 'object' ? data.etaByKey : null
      const mk = String((m && (m.id || m.machine)) || '').trim().toLowerCase()
      const mo = String(mode || 'agent').trim().toLowerCase()
      const md = String(model || '').trim().toLowerCase()
      if (etaMap && mk) {
        const k1 = mk + '|' + mo + '|' + md
        if (Object.prototype.hasOwnProperty.call(etaMap, k1) && etaMap[k1] && typeof etaMap[k1].p50Sec === 'number') {
          return etaMap[k1].p50Sec
        }
        if (!md) {
          const defMd = String((data && data.defaultModel) || '').trim().toLowerCase()
          if (defMd) {
            const kDef = mk + '|' + mo + '|' + defMd
            if (Object.prototype.hasOwnProperty.call(etaMap, kDef) && etaMap[kDef] && typeof etaMap[kDef].p50Sec === 'number') {
              return etaMap[kDef].p50Sec
            }
          }
        }
      }
      if (mo === 'agent' && !md && m && typeof m.etaSec === 'number' && Number.isFinite(m.etaSec) && m.etaSec > 0) {
        return m.etaSec
      }
      return null
    }

    const API = '/api/board/ui'
    const PANEL_KEY = 'dsh-board'
    // v2.6.13：面板标题旁的常显版本号。
    // 以前版本号只出现在「自检横幅」里，而横幅只在 checks 有 warn/error 时才渲染
    // （lib/client.js 的 doctorIssues 只收 warn/error）——doctor 全绿时用户永远看不到
    // 自己在跑哪个版本，只能去翻 package.json。这里用 doctor 未返回时的兜底常量。
    // 改版本号时三处同步：package.json / lib/worker/version.js / 这里；
    // scripts/plugcheck.mjs 会断言这三处一致，漏改会卡 gate。
    const CLIENT_VERSION = '2.7.23'

    const CSS = [
      '.dsb-root{--dsb-bg:var(--dsw-alias-bg-base,#161b22);--dsb-bg1:var(--dsw-alias-bg-layer-1,#0d1117);--dsb-bg2:var(--dsw-alias-bg-layer-2,#21262d);--dsb-bd:var(--dsw-alias-border-l1,#30363d);--dsb-bd2:var(--dsw-alias-border-l2,#3d444d);--dsb-fg:var(--dsw-alias-label-primary,#e6edf3);--dsb-fg2:var(--dsw-alias-label-secondary,#adbac7);--dsb-accent:#58a6ff;--dsb-ok:#3fb950;--dsb-warn:#d29922;--dsb-bad:#f85149;--dsb-accent-rgb:88,166,255;--dsb-ok-rgb:63,185,80;--dsb-warn-rgb:210,153,34;--dsb-bad-rgb:248,81,73;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsb-bg);color:var(--dsb-fg);--dsb-fs:16px;font-size:var(--dsb-fs)}',
  '.dsb-root[data-theme="dark"]{--dsb-bg:#161b22;--dsb-bg1:#0d1117;--dsb-bg2:#21262d;--dsb-bd:#30363d;--dsb-bd2:#3d444d;--dsb-fg:#e6edf3;--dsb-fg2:#adbac7;--dsb-accent:#58a6ff;--dsb-ok:#3fb950;--dsb-warn:#d29922;--dsb-bad:#f85149;--dsb-accent-rgb:88,166,255;--dsb-ok-rgb:63,185,80;--dsb-warn-rgb:210,153,34;--dsb-bad-rgb:248,81,73}',
  '.dsb-root[data-theme="light"]{--dsb-bg:#f6f8fa;--dsb-bg1:#ffffff;--dsb-bg2:#eaeef2;--dsb-bd:#d0d7de;--dsb-bd2:#afb8c1;--dsb-fg:#1f2328;--dsb-fg2:#656d76;--dsb-accent:#0969da;--dsb-ok:#1a7f37;--dsb-warn:#7a4f00;--dsb-bad:#a40e26;--dsb-accent-rgb:9,105,218;--dsb-ok-rgb:26,127,55;--dsb-warn-rgb:154,103,0;--dsb-bad-rgb:207,34,46}',
      '.dsb-head{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid var(--dsw-alias-border-l1, var(--dsb-bd));flex:0 0 auto;flex-wrap:wrap}',
      '.dsb-title{font-weight:600;font-size:calc(var(--dsb-fs) + 3px)}',
      '.dsb-sp{flex:1}',
      '.dsb-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;border:1px solid var(--dsb-bd2);background:var(--dsb-bg2);font-size:calc(var(--dsb-fs) - 1px);font-weight:700;white-space:nowrap;color:var(--dsb-fg)}',
      '.dsb-pill b{font-weight:600}',
      // ==== 头部收容（14 寸屏 / 窄栏）：三组各管一行，宽度不够时整组换行，而不是逐个按钮乱折 ====
      '.dsb-brand{display:flex;align-items:center;gap:10px;min-width:0;flex:0 1 auto}',
      '.dsb-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:0 1 auto;font-size:calc(var(--dsb-fs) - 4px);opacity:.55}',
      '.dsb-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;flex:0 1 auto}',
      '.dsb-head>.dsb-acts{flex:0 1 auto;flex-wrap:wrap;margin-left:auto}',
      '@media (max-width:1240px){.dsb-head{gap:6px 10px;padding:10px 12px}.dsb-head .dsb-btn{padding:4px 9px}.dsb-head .dsb-pill{padding:3px 9px}}',
      '@media (max-width:980px){.dsb-head .dsb-brand{flex:1 1 auto}.dsb-head .dsb-sub{display:none}.dsb-head>.dsb-acts{margin-left:0;width:100%;justify-content:flex-end}}',
      // v2.7.0（W4）：窄屏收敛。不做横向滚动条兜底 —— 必须靠布局自己收敛。
      // 1100px：机器卡改单列纵向（机器卡 → 任务列表），容器一律 100% 宽；
      //         不压字号，先把「右侧内存/磁盘被裁」这件事从布局上消掉。
      // 900px：任务行只留 状态/机器/时间/进度/操作，次要列（序号）直接 display:none。
      //         标题允许省略号收缩，避免行高翻倍、一屏只看得到三条。
      '@media (max-width:1100px){.dsb-mach-grid{flex-direction:column;max-height:none!important;overflow:visible!important;width:100%;max-width:100%}.dsb-mach-grid>.dsb-mach{flex:1 1 auto!important;width:100%!important;min-width:0!important}.dsb-main,.dsb-filt{width:100%;max-width:100%}}',
      '@media (max-width:900px){.dsb-col-id{display:none}.dsb-row{gap:8px;padding:10px 12px}.dsb-row .dsb-name{flex:1 1 60%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsb-line1{gap:6px}}',
      '.dsb-v{font-variant-numeric:tabular-nums;letter-spacing:.2px}',
      '.dsb-v-skew{color:var(--dsb-warn);font-weight:700}',
      '.dsb-v-new{color:var(--dsb-accent);font-weight:700}',
      '.dsb-q{background:#4a3a0f;border-color:#d8a53a;color:#ffd479}',
      '.dsb-r{background:#0d3550;border-color:#4aa3e0;color:#a8dbff}',
      '.dsb-d{background:#0f3a20;border-color:#3fbf6a;color:#a5f0bf}',
      '.dsb-b{background:#4a1410;border-color:#e0554a;color:#ffb8b0}',
      '.dsb-btn{appearance:none;border:1px solid var(--dsb-bd2);background:var(--dsb-bg1);color:var(--dsb-fg);border-radius:7px;padding:5px 13px;font-size:calc(var(--dsb-fs) - 1px);cursor:pointer;line-height:1.7}',
      '.dsb-btn:hover{background:var(--dsb-bg2)}',
      '.dsb-btn[disabled]{opacity:.45;cursor:not-allowed}',
      '.dsb-main{flex:1;min-height:0;overflow:auto}',

  '.dsb-row{display:flex;gap:14px;align-items:flex-start;padding:13px 18px;border-bottom:1px solid var(--dsw-alias-border-l1, var(--dsb-bd))}',

  '.dsb-row:hover{background:var(--dsb-bg1)}',
      '.dsb-id{font-family:ui-monospace,Consolas,monospace;font-size:calc(var(--dsb-fs) - 4px);opacity:.65;flex:0 0 auto;padding-top:2px}',
      '.dsb-body{flex:1;min-width:0}',
      '.dsb-line1{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '.dsb-name{font-weight:600;font-size:var(--dsb-fs)}',
      '.dsb-tag{font-size:calc(var(--dsb-fs) - 3px);padding:2px 8px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2, var(--dsb-bd2));opacity:.85}',
      '.dsb-note{font-size:calc(var(--dsb-fs) - 2px);line-height:1.65;opacity:.72;margin-top:4px;word-break:break-word}',
      '.dsb-acts{display:flex;gap:6px;flex:0 0 auto;align-items:center}',
      '.dsb-dot{width:auto;height:auto;border-radius:0;display:inline-block;font-weight:800;font-size:calc(var(--dsb-fs) - 1px);line-height:1}',
      '.dsb-dot.on{color:var(--dsb-ok)}.dsb-dot.off{color:var(--dsb-fg2)}',
      '.dsb-pill.off{opacity:.85}',
      '.dsb-empty{padding:44px 18px;text-align:center;opacity:.6;font-size:var(--dsb-fs)}',
      '.dsb-err{padding:12px 18px;font-size:calc(var(--dsb-fs) - 2px);color:var(--dsb-bad);border-bottom:1px solid var(--dsw-alias-border-l1, var(--dsb-bd))}',
      '.dsb-filt{display:flex;gap:8px;padding:10px 18px;border-bottom:1px solid var(--dsw-alias-border-l1, var(--dsb-bd));flex:0 0 auto;flex-wrap:wrap}',
      '.dsb-input{flex:1 1 auto;min-width:170px;background:var(--dsb-bg1);color:var(--dsb-fg);border:1px solid var(--dsb-bd2);border-radius:6px;padding:5px 10px;font-size:calc(var(--dsb-fs) - 2px);outline:none}',
      '.dsb-input:focus{border-color:var(--dsw-alias-border-l2, var(--dsb-bd2));box-shadow:0 0 0 1px var(--dsw-alias-border-l2, var(--dsb-bd2))}',
      '.dsb-detail{margin-top:10px;padding:12px;border:1px solid var(--dsb-bd);border-radius:8px;display:flex;flex-direction:column;gap:8px;background:var(--dsb-bg1)}',
      '.dsb-kv{font-size:calc(var(--dsb-fs) - 2px);opacity:.82;word-break:break-all;line-height:1.6}',
      '.dsb-root,.dsb-root *{box-sizing:border-box}',
      '.dsb-root{color:var(--dsb-fg);background:var(--dsb-bg)}',

  '.dsb-row,.dsb-line1,.dsb-head{min-width:0}',
      '.dsbp{position:fixed;z-index:2147483000;width:78px;height:104px;user-select:none;touch-action:none;cursor:grab;transition:opacity .35s ease}',
      '.dsbp.dragging{cursor:grabbing}',
      '.dsbp img{width:100%;height:100%;object-fit:contain;pointer-events:none;filter:drop-shadow(0 6px 14px rgba(0,0,0,.45))}',
      '.dsbp-ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:54px}',
      '.dsbp-bubble{position:absolute;right:100%;bottom:18px;margin-right:8px;min-width:170px;max-width:250px;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.18));background:var(--dsw-alias-bg-layer-2,#26262b);color:var(--dsw-alias-label-primary,#e6e6e8);font-size:13px;line-height:1.6;box-shadow:0 8px 26px rgba(0,0,0,.45)}',
      '.dsbp-bubble h4{margin:0 0 4px;font-size:13px;font-weight:600}',
      '.dsbp-bubble .m{opacity:.72;font-size:12px;line-height:1.5}',
      '.dsbp-bubble .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;font-size:12px;opacity:.9}',
      '.dsbp-strip{position:absolute;left:50%;transform:translateX(-50%);bottom:-4px;display:flex;gap:6px;padding:2px 7px;border-radius:8px;background:#080a0d;border:1px solid #59636f;white-space:nowrap;font-size:10px;font-weight:800;letter-spacing:0;box-shadow:0 3px 12px rgba(0,0,0,.6);pointer-events:none}',
      '.dsbp-strip span{color:#ffffff}',
      '.dsbp-strip .q{color:#ffc94d}.dsbp-strip .r{color:#7cc8ff}.dsbp-strip .b{color:#ff7a70}.dsbp-strip .d{color:#6ff3a0}.dsbp-strip .x{color:#ff7a70}',
      '.dsbp-bubble{font-size:14px;line-height:1.65}',
      '.dsbp-bubble h4{font-size:15px;font-weight:800}',
      '.dsbp-chip{display:inline-block;padding:2px 9px;border-radius:999px;font-weight:800;font-size:12px;border:1px solid}',
      '.dsbp-chip.q{background:#4a3a0f;border-color:#d8a53a;color:#ffd479}',
      '.dsbp-chip.r{background:#0d3550;border-color:#4aa3e0;color:#a8dbff}',
      '.dsbp-chip.b{background:#4a1410;border-color:#e0554a;color:#ffb8b0}',
      '.dsbp-chip.d{background:#0f3a20;border-color:#3fbf6a;color:#a5f0bf}',

      /* ── 视图 tab / 计数徽标 ──
         选中的 tab 以前是 disabled（全局规则把 disabled 压到 .45 透明），看起来像"点了
         没反应"的坏按钮。选中态改用蓝色底 + 左边竖条，并且不让 disabled 规则压暗它。 */
      '.dsb-btn.on{background:rgba(var(--dsb-accent-rgb),0.22);border-color:var(--dsb-accent);color:var(--dsb-fg);box-shadow:inset 3px 0 0 var(--dsb-accent)}',
      '.dsb-btn.on[disabled]{opacity:1;cursor:default}',
      '.dsb-n{display:inline-block;margin-left:6px;opacity:.72;font-weight:600;font-variant-numeric:tabular-nums}',
      '.dsb-btn.on .dsb-n{opacity:.95}',

      /* ── 清理入口（危险动作，但权重低于主操作） ── */
      '.dsb-btn.danger{border-color:rgba(var(--dsb-bad-rgb),.55);color:var(--dsb-bad)}',
      '.dsb-btn.danger:hover{background:rgba(224,85,74,0.16);border-color:#e0554a}',
      '.dsb-btn.danger[disabled]{border-color:var(--dsw-alias-border-l2, var(--dsb-bd2));color:inherit;opacity:.45}',

      /* ── 状态 tag 语义色（沿用既有 q/r/d/b 四色，色弱用户仍靠文字区分） ── */
      '.dsb-tag.st-ok{background:rgba(63,191,106,.15);border-color:#3fbf6a;color:#a5f0bf;opacity:1}',
      '.dsb-tag.st-run{background:rgba(74,163,224,.15);border-color:#4aa3e0;color:#a8dbff;opacity:1}',
      '.dsb-tag.st-q{background:rgba(216,165,58,.15);border-color:#d8a53a;color:#ffd479;opacity:1}',
      '.dsb-tag.st-bad{background:rgba(224,85,74,.15);border-color:#e0554a;color:#ffb8b0;opacity:1}',
      '.dsb-root[data-theme="light"] .dsb-tag.st-ok{background:rgba(17,99,41,.10);border-color:#116329;color:#116329}',
      '.dsb-root[data-theme="light"] .dsb-tag.st-run{background:rgba(5,80,174,.10);border-color:#0550ae;color:#0550ae}',
      '.dsb-root[data-theme="light"] .dsb-tag.st-q{background:rgba(122,79,0,.10);border-color:#7a4f00;color:#7a4f00}',
      '.dsb-root[data-theme="light"] .dsb-tag.st-bad{background:rgba(164,14,38,.10);border-color:#a40e26;color:#a40e26}',
      '.dsb-root[data-theme="light"] .dsb-note,.dsb-root[data-theme="light"] .dsb-lrow .s,.dsb-root[data-theme="light"] .dsb-empty,.dsb-root[data-theme="light"] .dsb-kv,.dsb-root[data-theme="light"] .dsb-id{opacity:1}',
      '.dsb-tag.st-off{opacity:.7}',
      '.dsb-tag.time{font-variant-numeric:tabular-nums}',
      '.dsb-machine{font-family:ui-monospace,Consolas,monospace;opacity:.92;letter-spacing:.2px}',
      '.dsb-row.is-done .dsb-name{font-weight:500}',

      /* ── 通用模态框（清理确认；配色与派工弹窗一致） ── */
      '.dsb-modal{position:fixed;inset:0;background:rgba(0,0,0,.62);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px}',
      '.dsb-card{background:var(--dsb-bg);border:1px solid var(--dsb-bd2);border-radius:10px;padding:18px;width:560px;max-width:100%;max-height:86vh;display:flex;flex-direction:column;gap:10px;color:var(--dsb-fg);box-shadow:0 18px 48px rgba(0,0,0,.55)}',
      '.dsb-card h3{margin:0;font-size:calc(var(--dsb-fs) + 2px);font-weight:700;color:var(--dsb-fg)}',
      '.dsb-card p{margin:0;line-height:1.7;font-size:calc(var(--dsb-fs) - 1px);color:var(--dsb-fg2)}',
      '.dsb-card .muted{color:var(--dsb-fg2)}',
      '.dsb-warn{border-left:3px solid var(--dsb-warn);background:rgba(var(--dsb-warn-rgb),.07);border-radius:6px;padding:8px 10px;font-size:calc(var(--dsb-fs) - 2px);line-height:1.65;color:var(--dsb-warn)}',
      '.dsb-list{overflow:auto;max-height:264px;border:1px solid var(--dsb-bd2);border-radius:8px;background:var(--dsb-bg1)}',
      '.dsb-lrow{display:flex;gap:8px;align-items:baseline;padding:6px 10px;border-bottom:1px solid var(--dsb-bg2);font-size:calc(var(--dsb-fs) - 2px);color:var(--dsb-fg2)}',
      '.dsb-lrow:last-child{border-bottom:0}',
      '.dsb-lrow .i{font-family:ui-monospace,Consolas,monospace;flex:0 0 auto;color:var(--dsb-fg2)}',
      '.dsb-lrow .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsb-lrow .s{flex:0 0 auto;opacity:.8}',
      '.dsb-bar{height:6px;border-radius:3px;background:var(--dsb-bg2);overflow:hidden}',
      '.dsb-bar>i{display:block;height:100%;background:var(--dsb-accent);transition:width .2s ease}',
      '.dsb-acts.end{justify-content:flex-end}',
      '.dsb-fail{color:var(--dsb-bad)}',
      '.dsb-ok{color:var(--dsb-ok)}',
      // 「跳过」不是失败：琥珀色，跟红色失败清单明确分开
      '.dsb-skip{color:var(--dsb-warn);line-height:1.6}',
      '.dsb-trunc{margin:2px 0 8px;padding:7px 10px;border:1px solid rgba(var(--dsb-warn-rgb),.45);border-radius:6px;background:rgba(var(--dsb-warn-rgb),.07);color:var(--dsb-warn);font-size:calc(var(--dsb-fs) - 2px);line-height:1.6}',
    ].join('\n')

    const STATUS_LABEL = {
      queued: '待办',
      claimed: '已认领',
      running: '进行中',
      stale: '超时',
      done: '完成',
      blocked: '卡住',
      failed: '失败',
      superseded: '被取代',
      cancelled: '已取消',
    }

    function ago(sec) {
      if (sec == null) return '—'
      if (sec < 60) return sec + ' 秒前'
      if (sec < 3600) return Math.round(sec / 60) + ' 分钟前'
      if (sec < 86400) return (sec / 3600).toFixed(1) + ' 小时前'
      return Math.round(sec / 86400) + ' 天前'
    }

    /* ───────────── 机器名归一（nodeId → 板子别名） ─────────────
       板子上同一台机器有三种写法：hub 的 nodeId（desktop-2gh05s7）和板子别名
       （MB14 / gt14 / GT14）。summary 里的 nodeMap 给出 nodeId → 别名的映射，
       剩下的大小写差异在这里抹平，保证"同一台机器只出现一个名字"。 */

    const squeezeKey = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '')

    /* v2.1.0：显示名以板子上的 machine.name（用户改的别名）为准，不再写死任何机器名。
       身份键（task.machine / remote-owners）不参与显示，只在找不到别名时兜底。 */
    function machineLabeler(nodeMap, machines) {
      const board = {}
      for (const m of (Array.isArray(machines) ? machines : [])) {
        const id = String((m && m.id) || '')
        if (!id) continue
        const name = String((m && m.name) || id)
        board[squeezeKey(id)] = name
        if (m && m.caps && m.caps.alias) board[squeezeKey(String(m.caps.alias))] = String(m.caps.alias)
      }
      const src = nodeMap && typeof nodeMap === 'object' ? nodeMap : {}
      const byNode = {}
      Object.keys(src).forEach((k) => {
        const v = src[k]
        if (!v) return
        const kk = squeezeKey(k)
        if (kk) byNode[kk] = String(v)
      })
      // 没见过的名字按"第一次看到的写法"定下来，免得同一次会话里 gt14 / GT14 两副面孔
      const seen = {}
      return function label(value) {
        const s = String(value == null ? '' : value).trim()
        if (!s) return ''
        const bm = board[squeezeKey(s)]
        if (bm) return bm
        const mapped = byNode[squeezeKey(s)]
        if (mapped) {
          const bm2 = board[squeezeKey(mapped)]
          if (bm2) return bm2
          const key = mapped.toLowerCase()
          if (!seen[key]) seen[key] = mapped
          return seen[key]
        }
        const key = s.toLowerCase()
        if (!seen[key]) seen[key] = s
        return seen[key]
      }
    }

    const STATUS_TONE = {
      done: 'st-ok',
      running: 'st-run',
      claimed: 'st-run',
      queued: 'st-q',
      stale: 'st-q',
      blocked: 'st-bad',
      failed: 'st-bad',
      superseded: 'st-off',
      cancelled: 'st-off',
    }

    // 「清理」只碰这些历史态：running / claimed 永远不在名单里（双保险见 runCleanup）。
    const CLEANABLE = ['queued', 'stale', 'failed', 'blocked']
    const ARCHIVED = ['superseded', 'cancelled']
    const CLEAN_NOTE = 'GUI 清理：归档未完成的历史任务'

    /* ───────────── 桌宠状态（把 D:\gp_video\pet 的判据搬到面板里） ─────────────
       桌宠是 C# 独立窗口（HWND 嵌不进网页），这里走方案 B：
       同一套判据 + 同一张立绘，在面板顶部重画一张状态卡。 */

    function petState(data, machines, counts) {
      if (!data || data.ok === false) {
        return {
          mood: 'down',
          head: '连不上调度台',
          detail: (data && data.error) || '检查 board_server.py 是否在跑',
        }
      }
      const off = machines.filter((m) => !m.online)
      if (counts.bad > 0) {
        return { mood: 'alert', head: '有 ' + counts.bad + ' 条被打回', detail: '去看看原因，别让它烂在板上' }
      }
      if (counts.running > 0) {
        const busy = machines.filter((m) => m.current).map((m) => m.id)
        return { mood: 'busy', head: counts.running + ' 条在跑', detail: busy.length ? '忙：' + busy.join('、') : '正在干活…' }
      }
      if (counts.queued > 0) {
        return { mood: 'todo', head: counts.queued + ' 条等人认领', detail: '挑一条开工？' }
      }
      if (off.length) {
        return { mood: 'warn', head: off.length + ' 台没报到', detail: off.map((m) => m.id).join('、') }
      }
      return {
        mood: 'idle',
        head: '一切正常',
        detail: data.updatedAgeSec != null ? '板子更新于 ' + ago(data.updatedAgeSec) : '板子在线',
      }
    }

    // v1.3.7（安全 F1）：插件路由现在要求写操作带自定义头 —— 浏览器对跨站请求
    // 加不了自定义头（preflight 会先被拒），这是挡 CSRF 的那道闸门。
    const UI_HEADERS = { 'x-dsh-team-ui': '1' }

    async function getJson(path, init) {
      const opts = Object.assign({ cache: 'no-store', credentials: 'same-origin' }, init || {})
      const method = String(opts.method || 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        opts.headers = Object.assign({ 'content-type': 'application/json' }, UI_HEADERS, opts.headers || {})
      }
      const res = await fetch(path, opts)
      const text = await res.text()
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = { ok: false, error: '返回不是 JSON：' + text.slice(0, 120) }
      }
      return data || { ok: false, error: 'HTTP ' + res.status }
    }

    /* ---------- v2.7.4（UI-1/UI-2）：评估卡四态 + 服务端写盘失败的本机兜底 ----------
     * 故障 A（2.7.3 挂死）：runAssess 裸 fetch 无超时（client.js:839），服务端 assess 卡住
     *   （index.js:1013 assess() → reportCaps({force:true})）⇒ assessing 永久 true，永久转圈。
     * 故障 B（2.7.3 反复重评）：评估成功与否只记在服务端磁盘；saveIdentity 写盘失败只 trace
     *   （index.js:817-827，825-826 行）⇒ identityState().needsAssessment = !same 恒 true
     *   （index.js:829-837）。面板重挂（切「对话」再回来）重新拉 /identity 就被拉回引导卡。
     *   客户端不能改服务端 ⇒ 在本机建第二事实源（localStorage）做降级。 */

    // v2.7.4（主控修订 MC-2）：超时从 8s 放宽到 15s —— 本机探测含 CPU/磁盘/GPU/PowerShell
    // 冷启动，实测慢机可到 8–12s；8s 会误杀「慢但成功」的响应（复核反证 2/P2）。
    const ASSESS_TIMEOUT_MS = 15000
    // v2.7.4（主控修订 MC-1）：本机兜底记录要过期时间 —— 否则服务端写盘长期失败时，
    // 客户端会永久压住服务端真实 needsAssessment（换硬件/环境变了也不再重评，复核反证 1/P1）。
    const ASSESS_DONE_TTL_MS = 7 * 24 * 60 * 60 * 1000
    const ASSESS_DONE_KEY = 'dsh-assess-done-v1'
    const ASSESS_DEGRADE_NOTIFIED_KEY = 'dsh-assess-degrade-notified-v1'
    let assessAbortCtl = null // 同一时刻最多一个评估请求；「取消」按钮与 8s 超时共用
    let assessCancelRequested = false // 「取消」路径不进 error 态的标记（与超时竞态）

    function lsGet(key) {
      try {
        return window.localStorage.getItem(key)
      } catch (e) {
        return null
      }
    }
    function lsSet(key, val) {
      try {
        window.localStorage.setItem(key, val)
        return true
      } catch (e) {
        return false
      }
    }
    function lsDel(key) {
      try {
        window.localStorage.removeItem(key)
      } catch (e) {
        /* 无 localStorage 时兜底不可用，退化为 2.7.3 原行为 */
      }
    }
    // v2.7.4（MC-1）：能力摘要 —— 用来判断「同一台机器的硬件/环境有没有变」。
    // 只做轻量散列，不落任何敏感字段；caps 变了视为兜底记录失效，强制重新评估。
    function capsDigest(caps) {
      if (!caps || typeof caps !== 'object') return ''
      let s = ''
      try {
        s = JSON.stringify(caps)
      } catch (e) {
        return ''
      }
      let h = 5381
      for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
      return h.toString(16)
    }
    // 读本机评估兜底记录；machine 不匹配（换机/改名）时视为不存在
    // v2.7.4（MC-1）：加 TTL（默认 7 天）与 caps 摘要比对 —— 过期或硬件变了都视为不存在，
    // 避免「服务端写盘一直失败 ⇒ 客户端永久压住 needsAssessment」。
    function readLocalAssess(machine, digest) {
      const raw = lsGet(ASSESS_DONE_KEY)
      if (!raw) return null
      try {
        const rec = JSON.parse(raw)
        if (!rec || !(rec.assessedAt > 0)) return null
        if (String(rec.machine) !== String(machine)) return null
        if (Date.now() - rec.assessedAt > ASSESS_DONE_TTL_MS) return null
        if (rec.capsDigest && digest && rec.capsDigest !== digest) return null
        return rec
      } catch (e) {
        /* 坏 JSON 同样视为不存在 */
      }
      return null
    }

    /* ---------- in-page draggable pet (plain DOM, no slot) ---------- */

    function mountPet() {
      if (typeof document === 'undefined' || typeof window === 'undefined') return null
      const POS_KEY = 'dsh-board-pet-pos'
      const HID_KEY = 'dsh-board-pet-hidden-v2'
      const COL_KEY = 'dsh-board-pet-collapsed'
      const SIZES = [[96, 128], [134, 180], [176, 236]]
      let sizeIdx = 1
      try {
        const rawSize = localStorage.getItem('dsh-board-pet-size')
        if (rawSize !== null) sizeIdx = Math.max(0, Math.min(2, parseInt(rawSize, 10) || 0))
      } catch { sizeIdx = 1 }
      let W = SIZES[sizeIdx][0]
      let H = SIZES[sizeIdx][1]
      const GAP = 12
      let hidden = false
      try { hidden = localStorage.getItem(HID_KEY) === '1' } catch { hidden = false }
      let collapsed = false
      try { collapsed = localStorage.getItem(COL_KEY) === '1' } catch { collapsed = false }

      try {
        const stale = document.querySelectorAll('#dsb-pet-root, .dsbp, img[src*="/api/board/ui/pet.png"]')
        for (let i = 0; i < stale.length; i++) {
          const n = stale[i]
          const t = (n.closest && n.closest('.dsbp')) || n
          if (t && t.parentNode) t.parentNode.removeChild(t)
        }
      } catch { /* ignore */ }
      const el = document.createElement('div')
      el.id = 'dsb-pet-root'
      el.className = 'dsbp'
      el.style.position = 'fixed'
      el.style.width = W + 'px'
      el.style.height = H + 'px'
      el.style.zIndex = '2147483000'
      el.style.userSelect = 'none'
      el.style.touchAction = 'none'
      el.style.cursor = 'grab'
      el.title = '\u5927\u80a5\u9c7c\uff1a\u62d6\u52a8\u6362\u4f4d\u7f6e\uff0c\u70b9\u4e00\u4e0b\u770b\u72b6\u6001\uff0c\u53f3\u952e\u6536\u8d77/\u5c55\u5f00'
      const img = document.createElement('img')
      img.src = API + '/pet.png'
      img.alt = '\u5927\u80a5\u9c7c'
      img.style.width = '100%'
      img.style.height = '100%'
      img.style.objectFit = 'contain'
      img.style.display = 'block'
      img.style.pointerEvents = 'none'
      img.draggable = false
      const ph = document.createElement('div')
      ph.className = 'dsbp-ph'
      ph.textContent = '\u{1F41F}'
      ph.style.display = 'none'
      img.addEventListener('error', function () {
        img.style.display = 'none'
        ph.style.display = 'flex'
      })
      el.appendChild(img)
      el.appendChild(ph)

      const bubble = document.createElement('div')
      bubble.className = 'dsbp-bubble'
      bubble.style.position = 'absolute'
      bubble.style.zIndex = '2'
      bubble.style.right = '100%'
      bubble.style.bottom = '18px'
      bubble.style.marginRight = '8px'
      bubble.style.minWidth = '170px'
      bubble.style.maxWidth = '250px'
      bubble.style.padding = '8px 10px'
      bubble.style.borderRadius = '10px'
      bubble.style.background = '#26262b'
      bubble.style.color = '#e6e6e8'
      bubble.style.border = '1px solid rgba(255,255,255,.18)'
      bubble.style.fontSize = '14px'
      bubble.style.lineHeight = '1.6'
      bubble.style.boxShadow = '0 8px 26px rgba(0,0,0,.45)'
      bubble.style.whiteSpace = 'normal'
      bubble.style.display = 'none'
      el.appendChild(bubble)

      function clampX(v) { return Math.max(-W * 0.4, Math.min(v, window.innerWidth - W * 0.6)) }
      function clampY(v) { return Math.max(0, Math.min(v, window.innerHeight - H * 0.5)) }

      let pos = { left: window.innerWidth - W - 18, top: window.innerHeight - H - 18 }
      try {
        const raw = localStorage.getItem(POS_KEY)
        if (raw) {
          const o = JSON.parse(raw)
          if (o && typeof o.left === 'number' && typeof o.top === 'number') pos = { left: o.left, top: o.top }
        }
      } catch { /* keep default */ }
      el.style.left = clampX(pos.left) + 'px'
      el.style.top = clampY(pos.top) + 'px'
      el.style.display = hidden ? 'none' : 'block'
      el.style.opacity = '0'
      document.body.appendChild(el)
      requestAnimationFrame(function () { el.style.opacity = '1' })

      function save() {
        try { localStorage.setItem(POS_KEY, JSON.stringify({ left: parseInt(el.style.left, 10) || 0, top: parseInt(el.style.top, 10) || 0 })) } catch { /* ignore */ }
      }
      function setHidden(v) {
        hidden = v
        el.style.display = v ? 'none' : 'block'
        try { localStorage.setItem(HID_KEY, v ? '1' : '0') } catch { /* ignore */ }
        if (v) bubble.style.display = 'none'
        else updateStrip()
      }

      const strip = document.createElement('div')
      strip.className = 'dsbp-strip'
      strip.style.position = 'absolute'
      strip.style.zIndex = '2'
      strip.style.left = '50%'
      strip.style.transform = 'translateX(-50%)'
      strip.style.bottom = '-4px'
      strip.style.display = 'flex'
      strip.style.gap = '6px'
      strip.style.padding = '2px 7px'
      strip.style.borderRadius = '8px'
      strip.style.background = '#080a0d'
      strip.style.border = '1px solid #59636f'
      strip.style.fontSize = '12px'
      strip.style.fontWeight = '800'
      strip.style.whiteSpace = 'nowrap'
      strip.style.color = '#ffffff'
      strip.style.pointerEvents = 'none'
      strip.style.boxShadow = '0 3px 12px rgba(0,0,0,.6)'
      strip.style.display = 'none'
      el.appendChild(strip)

      function paintStrip(data) {
        const counts = (data && data.counts) || { queued: 0, running: 0, done: 0, bad: 0 }
        const machines = (data && data.machines) || []
        const off = machines.filter(function (m) { return !m.online })
        strip.textContent = ''
        const parts = [
          ['\u5f85\u529e', counts.queued || 0, 'q'],
          ['\u8fdb\u884c', counts.running || 0, 'r'],
          ['\u6253\u56de', counts.bad || 0, 'b'],
        ]
        parts.forEach(function (it) {
          const sp = document.createElement('span')
          sp.className = it[2]
          sp.textContent = it[0] + ' ' + it[1]
          sp.style.color = it[2] === 'q' ? '#ffc94d' : it[2] === 'r' ? '#7cc8ff' : '#ff7a70'
          strip.appendChild(sp)
        })
        if (off.length) {
          const sp = document.createElement('span')
          sp.className = 'x'
          sp.textContent = '\u79bb\u7ebf ' + off.length
          sp.style.color = '#ff7a70'
          strip.appendChild(sp)
        }
        if (!collapsed) strip.style.display = 'flex'
      }
      async function updateStrip() {
        if (hidden || collapsed) return
        try { paintStrip(await getJson(API + '/summary')) } catch { /* ignore */ }
      }
      let poll = null
      let stripTimer = null
      async function refreshBubble() {
        bubble.textContent = '\u67e5\u8be2\u4e2d\u2026'
        const data = await getJson(API + '/summary')
        const counts = (data && data.counts) || { queued: 0, running: 0, done: 0, bad: 0 }
        const machines = (data && data.machines) || []
        const pet = petState(data, machines, counts)
        bubble.textContent = ''
        const h4 = document.createElement('h4')
        h4.textContent = pet.head
        const m1 = document.createElement('div')
        m1.className = 'm'
        m1.textContent = pet.detail
        const row = document.createElement('div')
        row.className = 'row'
        const bits = [
          ['\u5f85\u529e ', counts.queued || 0, 'q'],
          ['\u8fdb\u884c ', counts.running || 0, 'r'],
          ['\u6253\u56de ', counts.bad || 0, 'b'],
          ['\u5b8c\u6210 ', counts.done || 0, 'd'],
        ]
        bits.forEach(function (it) {
          const sp = document.createElement('span')
          sp.className = 'dsbp-chip ' + it[2]
          sp.textContent = it[0] + it[1]
          sp.style.display = 'inline-block'
          sp.style.padding = '2px 9px'
          sp.style.borderRadius = '999px'
          sp.style.fontWeight = '800'
          sp.style.fontSize = '12px'
          sp.style.border = '1px solid ' + (it[2] === 'q' ? '#d8a53a' : it[2] === 'r' ? '#4aa3e0' : it[2] === 'b' ? '#e0554a' : '#3fbf6a')
          sp.style.background = it[2] === 'q' ? '#4a3a0f' : it[2] === 'r' ? '#0d3550' : it[2] === 'b' ? '#4a1410' : '#0f3a20'
          sp.style.color = it[2] === 'q' ? '#ffd479' : it[2] === 'r' ? '#a8dbff' : it[2] === 'b' ? '#ffb8b0' : '#a5f0bf'
          row.appendChild(sp)
        })
        bubble.appendChild(h4)
        bubble.appendChild(m1)
        bubble.appendChild(row)
        if (data && data.updatedAgeSec != null) {
          const m2 = document.createElement('div')
          m2.className = 'm'
          m2.textContent = '\u677f\u5b50\u66f4\u65b0\u4e8e ' + ago(data.updatedAgeSec)
          bubble.appendChild(m2)
        }
      }
      function showBubble(on) {
        bubble.style.display = on ? 'block' : 'none'
        if (on) {
          refreshBubble()
          if (!poll) poll = setInterval(refreshBubble, 15000)
        } else if (poll) {
          clearInterval(poll)
          poll = null
        }
      }

      function applySize(idx) {
        sizeIdx = Math.max(0, Math.min(2, idx))
        W = SIZES[sizeIdx][0]
        H = SIZES[sizeIdx][1]
        try { localStorage.setItem('dsh-board-pet-size', String(sizeIdx)) } catch { /* ignore */ }
        if (!collapsed) {
          el.style.width = W + 'px'
          el.style.height = H + 'px'
          el.style.left = clampX(parseInt(el.style.left, 10) || 0) + 'px'
          el.style.top = clampY(parseInt(el.style.top, 10) || 0) + 'px'
        }
      }

      let dragging = false
      let moved = 0
      let sx = 0
      let sy = 0
      let ox = 0
      let oy = 0
      function onDown(ev) {
        if (ev.button !== 0) return
        dragging = true
        moved = 0
        sx = ev.clientX
        sy = ev.clientY
        ox = parseInt(el.style.left, 10) || 0
        oy = parseInt(el.style.top, 10) || 0
        el.classList.add('dragging')
        try { el.setPointerCapture(ev.pointerId) } catch { /* ignore */ }
        ev.preventDefault()
      }
      function onMove(ev) {
        if (!dragging) return
        const dx = ev.clientX - sx
        const dy = ev.clientY - sy
        moved = Math.max(moved, Math.abs(dx) + Math.abs(dy))
        el.style.left = clampX(ox + dx) + 'px'
        el.style.top = clampY(oy + dy) + 'px'
      }
      function onUp(ev) {
        if (!dragging) return
        dragging = false
        el.classList.remove('dragging')
        try { el.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
        if (moved < 6) {
          if (collapsed) applyCollapsed(false)
          else showBubble(bubble.style.display === 'none')
        } else save()
      }
      function applyCollapsed(v) {
        collapsed = !!v
        try { localStorage.setItem(COL_KEY, collapsed ? '1' : '0') } catch { /* ignore */ }
        if (collapsed) {
          el.style.width = '26px'
          el.style.height = '34px'
          el.style.opacity = '0.75'
          strip.style.display = 'none'
          showBubble(false)
        } else {
          el.style.width = W + 'px'
          el.style.height = H + 'px'
          el.style.opacity = '1'
          strip.style.display = 'flex'
          el.style.left = clampX(parseInt(el.style.left, 10) || 0) + 'px'
          el.style.top = clampY(parseInt(el.style.top, 10) || 0) + 'px'
          updateStrip()
        }
      }
      function onCtx(ev) {
        ev.preventDefault()
        applyCollapsed(!collapsed)
      }
      function onResize() {
        el.style.left = clampX(parseInt(el.style.left, 10) || 0) + 'px'
        el.style.top = clampY(parseInt(el.style.top, 10) || 0) + 'px'
      }
      function onToggle() { setHidden(!hidden) }

      function onEnter() {
        el.style.outline = '1px dashed rgba(255,255,255,.45)'
        el.style.outlineOffset = '2px'
        el.style.cursor = 'grab'
      }
      function onLeave() {
        el.style.outline = 'none'
      }
      function onDbl() { applySize((sizeIdx + 1) % 3) }

      el.addEventListener('pointerdown', onDown)
      el.addEventListener('mouseenter', onEnter)
      el.addEventListener('mouseleave', onLeave)
      el.addEventListener('dblclick', onDbl)
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      el.addEventListener('contextmenu', onCtx)
      window.addEventListener('resize', onResize)
      window.addEventListener('dsh-board-pet-toggle', onToggle)

      updateStrip()
      stripTimer = setInterval(updateStrip, 12000)
      applyCollapsed(collapsed)

      return {
        toggle: onToggle,
        dispose: function () {
          if (poll) clearInterval(poll)
          if (stripTimer) clearInterval(stripTimer)
          el.removeEventListener('pointerdown', onDown)
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          el.removeEventListener('contextmenu', onCtx)
          el.removeEventListener('mouseenter', onEnter)
          el.removeEventListener('mouseleave', onLeave)
          el.removeEventListener('dblclick', onDbl)
          window.removeEventListener('resize', onResize)
          window.removeEventListener('dsh-board-pet-toggle', onToggle)
          if (el.parentNode) el.parentNode.removeChild(el)
        },
      }
    }

    /* ───────────── 侧栏图标 ───────────── */

    function Icon() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
        h('rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2 }),
        h('path', { d: 'M1.5 6h13' }),
        h('path', { d: 'M6 6v7.5' }),
        h('path', { d: 'M2.5 9.2h3' }),
        h('path', { d: 'M9 9.2h3.6' }),
      )
    }

    /* ───────────── 主面板 ───────────── */

    function Panel() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [filter, setFilter] = React.useState('active')
      const [tick, setTick] = React.useState(0)
      // 字号三档：读和写必须是同一组值，否则刷新后回档到 16（复核 #20）。
      const cycles = [16, 18, 20]
      const [fs, setFs] = React.useState(function () {
        try {
          const v = parseInt(localStorage.getItem('dsh-board-fs') || '', 10)
          if (cycles.indexOf(v) >= 0) return v
        } catch {}
        return 16
      })
  // __R3_MERGE_UI__ 省一行开关（默认开）
  const [mergeOnState, setMergeOnState] = React.useState(function () {
    try { return localStorage.getItem('dsh-board-merge-entry') !== '0' } catch (e) { return true }
  })
      const [theme, setTheme] = React.useState(function () {
        try { return localStorage.getItem('dsh-board-theme') === 'light' ? 'light' : 'dark' } catch (e) { return 'dark' }
      })
      const toggleTheme = () => {
        setTheme((prev) => {
          const next = prev === 'light' ? 'dark' : 'light'
          try { localStorage.setItem('dsh-board-theme', next) } catch (e) { /* 忽略 */ }
          return next
        })
      }
      const bump = () => {
        const i = cycles.indexOf(fs) < 0 ? 0 : cycles.indexOf(fs)
        const next = cycles[(i + 1) % cycles.length]
        setFs(next)
        try { localStorage.setItem('dsh-board-fs', String(next)) } catch {}
      }
      const [q, setQ] = React.useState('')
      const [openId, setOpenId] = React.useState('')
      const [artText, setArtText] = React.useState('')
      const [noteText, setNoteText] = React.useState('')
      // __R3_TEAM__ 远程同事（同页）
      const [goal, setGoal] = React.useState('')
      const [pick, setPick] = React.useState('')
  // v2.7.5（GLM 可用性 S1/S2）：记住选中的机器是否离线，确认按钮据此禁用
  const [pickOff, setPickOff] = React.useState(false)
      // v2.1.0：派工前选模型（空 = 跟随副机默认）
      const [model, setModel] = React.useState('')
      // v2.6.27（盘古审计 P0）：维护通道的 mode 与票据。
      // 旧版只有 window.__dsbTaskMode 的读取点、没有任何写入点 ⇒ mode=maint 在面板上不可达；
      // 票据也没有入口 —— 写动词等于只能靠 API 手搓。
      const [taskMode, setTaskMode] = React.useState('agent')
      const [ticket, setTicket] = React.useState('')
      // v2.6.29（U-3）：维护派工 dryRun 预览的结果与忙碌态。
      const [diffBusy, setDiffBusy] = React.useState(false)
      const [diffRes, setDiffRes] = React.useState(null)
      // v2.1.0：本机显示名（身份 machine 不变）
      const [renaming, setRenaming] = React.useState(false)
      const [aliasDraft, setAliasDraft] = React.useState('')
      // 机器清单变化（离线/换 provider）后，旧的模型选择要清掉，否则会把已不存在的模型发出去。
      React.useEffect(() => {
        if (!model) return
        const nm = (data && data.nodeModels) || {}
        const val = (m) => (m && m.provider ? m.provider + '/' + m.model : m && m.model) || ''
        let ok = false
        if (pick !== '') {
          const e = nm[String(pick).toLowerCase()]
          ok = !!(e && Array.isArray(e.models) && e.models.some((m) => val(m) === model))
        } else {
          // 自动模式：与下拉保持一致，只认「在线、非 host 的机器」的交集。
          // 用并集会让界面里已经消失的模型继续留在 state 里，确认后被发给不支持它的机器。
          const allowed = Object.create(null)
          for (const bm of (data && Array.isArray(data.machines) ? data.machines : [])) {
            const id = String((bm && bm.id) || '')
            if (id && bm.online && id.toLowerCase() !== 'host') allowed[id.toLowerCase()] = true
          }
          const expected = Object.keys(allowed).length
          const lists = Object.keys(nm)
            .filter((k) => Object.prototype.hasOwnProperty.call(allowed, k))
            .map((k) => (nm[k] && Array.isArray(nm[k].models) ? nm[k].models : []))
            .filter((arr) => arr.length > 0)
            .map((arr) => arr.map((m) => val(m)).filter(Boolean))
          // 与渲染同判据：只有“所有在线副机都有清单”时才存在跨机交集，否则清空已选模型。
          ok = lists.length > 0 && lists.length === expected &&
            lists.reduce((acc, cur) => acc.filter((v) => cur.indexOf(v) >= 0)).indexOf(model) >= 0
        }
        if (!ok) setModel('')
      }, [data, pick, model])
      const [net, setNet] = React.useState(null)
      const [netErr, setNetErr] = React.useState('')
      const [ident, setIdent] = React.useState(null)
      // v2.7.4（UI-1）：评估卡四态 —— 原 assessing 布尔只有「转圈/不转圈」，没有超时与失败出口
      const [assessPhase, setAssessPhase] = React.useState('idle')
      const [assessErr, setAssessErr] = React.useState('')
      // v2.7.4（UI-2）：「稍后」按机器记一轮；否则 15s 轮询把 needsAssessment 翻回来又弹卡（原有缺陷顺带修）
      const [assessLater, setAssessLater] = React.useState('')
      const [notice, setNotice] = React.useState('')
      // v1.4.0：自检结果（配置/token/板子/hub/worker/调度器/版本），红条数据源
      const [doctor, setDoctor] = React.useState(null)
      // v2.7.5（U1）：自检报警横幅收缩开关 —— 笔记本小屏上报警条常驻太多行，挡住任务列表。
      // 默认展开（不丢报警）；用户收一次即记住（localStorage 键 dsh-doctor-collapsed-v1，'1'=收缩）。
      // doctor.ok===false（自检不可用）强制展开，不受折叠记忆影响。
      const [doctorOpen, setDoctorOpen] = React.useState(function () {
        try {
          return window.localStorage.getItem('dsh-doctor-collapsed-v1') !== '1'
        } catch (e) {
          return true
        }
      })
      const toggleDoctor = function () {
        setDoctorOpen(function (v) {
          try {
            window.localStorage.setItem('dsh-doctor-collapsed-v1', v ? '1' : '0')
          } catch (e) {
            /* 记不住就不记忆，本会话内功能仍可用 */
          }
          return !v
        })
      }
      // v2.2.0：评估卡收起来、卡片改名/移除、任务详情复制
      const [assessHidden, setAssessHidden] = React.useState(false)
      // v2.7.4（MC-4）：评估结果里的 caps 单独留一份 —— ident 还没刷新回来时能力条仍有数据可渲染
      const [assessCaps, setAssessCaps] = React.useState(null)
      const [cardRenameId, setCardRenameId] = React.useState('')
      const [cardRenameDraft, setCardRenameDraft] = React.useState('')
      const [capsProbe, setCapsProbe] = React.useState(null)
      const [capsBusy, setCapsBusy] = React.useState('')
      const [capsShowAll, setCapsShowAll] = React.useState(false)
  const [machinesCollapsed, setMachinesCollapsed] = React.useState(function () {
    try {
      const v = window.localStorage.getItem('dsh-board-machines-collapsed')
      if (v === '1') return true
      if (v === '0') return false
      return window.innerWidth < 1420
    } catch (e) { return false }
  })
  const [machineDetail, setMachineDetail] = React.useState(null)
      // v2.6.29（U-4）：本机 worker 状态小卡（enabled=false 时整卡不渲染）。
      const [workerStat, setWorkerStat] = React.useState(null)
      const [workerBusy, setWorkerBusy] = React.useState('')
      const [workerErr, setWorkerErr] = React.useState('')

      // v2.5.0：能力探测独立入口（与机器卡的能力卡配置分开）
      const [wlOpen, setWlOpen] = React.useState(false)
      const [wlCatalog, setWlCatalog] = React.useState([])
      const [wlSel, setWlSel] = React.useState({})
      const [wlRun, setWlRun] = React.useState({ busy: false, current: '', done: {} })
      const [wlNote, setWlNote] = React.useState('')
      // v2.5.3：可选压测（默认不做；老硬件由用户自己决定）。
      const [stressOpen, setStressOpen] = React.useState(false)
      const [stressMode, setStressMode] = React.useState('quick')
      const [stressBusy, setStressBusy] = React.useState('')
      const [stressRes, setStressRes] = React.useState(null)
  const stressActive = !!stressBusy || !!(stressRes && String(stressRes.error || '').indexOf('已有压测在跑') === 0)
      // 标签输入草稿：输入过程中不归一，失焦/保存时才拆词，避免逗号空格被受控回写吞掉。
      const [tagDraft, setTagDraft] = React.useState({})
      const [capsBase, setCapsBase] = React.useState('')
      const [cardBusy, setCardBusy] = React.useState({})
        const [nodeBusy, setNodeBusy] = React.useState({})
        const nodeLock = React.useRef({})
        const [nodeMsg, setNodeMsg] = React.useState({})
      // __CLEAN__ 清理未完成历史任务（归档为 superseded）
      const [cleanOpen, setCleanOpen] = React.useState(false)
      const [cleanBusy, setCleanBusy] = React.useState(false)
      const [cleanNote, setCleanNote] = React.useState('')
      const [cleanProg, setCleanProg] = React.useState({ i: 0, n: 0 })
      const [cleanRes, setCleanRes] = React.useState(null)
      // 打开弹窗时重新拉的 summary：避免用 30 秒前的快照算条数，也给"被认领"判断提供最新状态
      const [cleanSnap, setCleanSnap] = React.useState(null)
      const [cleanLoading, setCleanLoading] = React.useState(false)

      // Esc 关掉清理确认框（清理进行中不许关，避免"以为取消了其实还在写板子"）
      React.useEffect(() => {
        if (!cleanOpen) return undefined
        const onKey = (e) => {
          if (e.key === 'Escape' && !cleanBusy) {
            setCleanOpen(false)
            setCleanSnap(null)
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [cleanOpen, cleanBusy])

      React.useEffect(() => {
        let alive = true
        const load = () =>
          fetch(API + '/identity', { cache: 'no-store', credentials: 'same-origin' })
            .then((r) => r.json())
            .then((d) => {
              if (!alive || !d || !d.ok) return
              // v2.7.4（UI-2）：服务端写盘失败降级 —— needsAssessment=true 但本机有兜底记录
              // ⇒ 合并为已评估；降级提示只弹一次（之后不重复弹，见 docs/ui-2.7.4/design.md §2.2）
              if (d.needsAssessment) {
                const fb = readLocalAssess(d.machine, capsDigest(d.caps))
                if (fb) {
                  if (!lsGet(ASSESS_DEGRADE_NOTIFIED_KEY)) {
                    lsSet(ASSESS_DEGRADE_NOTIFIED_KEY, JSON.stringify({ machine: d.machine, at: Date.now() }))
                    setNotice('提示：上次评估没能写进服务端档案（identity 写盘失败），本面板先用本机记录代替，不再重复弹出；需要时点「评估」重测并重写档案。')
                  }
                  setIdent(Object.assign({}, d, { needsAssessment: false, assessed: true, assessedAt: fb.assessedAt }))
                  return
                }
              } else {
                // 服务端档案恢复正常 ⇒ 清掉「已提示」标记；下次写盘再失败还能提示一次
                lsDel(ASSESS_DEGRADE_NOTIFIED_KEY)
              }
              setIdent(d)
            })
            .catch(() => {})
        load()
        const t = setInterval(load, 15000)
        return () => {
          alive = false
          clearInterval(t)
        }
      }, [])

      // v2.7.4（UI-2）：渲染期派生（兜底双保险）—— /identity 轮询合并是主路径，这里保证
      // 即使轮询还没回来/标记丢失，渲染结果也正确（数据翻转 needsAssessment true→false→true 不再弹回卡）
      const assessLocal = ident ? readLocalAssess(ident.machine, capsDigest(ident.caps)) : null
      const needsAssessEff = !!(ident && ident.needsAssessment && !assessHidden && assessLater !== ident.machine && !assessLocal)
      const assessedEff = !!(ident && (ident.assessed || assessLocal) && !assessHidden)
      const assessAtShown = (ident && ident.assessedAt) || (assessLocal && assessLocal.assessedAt) || 0
      // v2.7.4（UI-1）：四态渲染派生 —— success 与「已评估」共用能力条（success 是评估刚落定的过渡态）
      // v2.7.4（MC-4）：success 态不再依赖 ident —— /identity 还没回来时也要显示能力条（复核反证 6/P2）
      const showAssessBar = assessedEff || assessPhase === 'success'
      // v2.7.4（MC-4 补强）：ident 可能为 null（identity.json 缺失/读取失败）。此时用本次评估返回的 caps 兜底；
      // 两者都没有就显示占位文案，绝不能让渲染体直接摸 ident.caps（会 TypeError 被 PanelSafe 降级）。
      const capsForBar = (ident && ident.caps) || assessCaps || null

      // v2.7.4（UI-1）：评估请求带 8s 客户端超时（AbortController）。任何路径都不会永久转圈：
      // 成功 → success；服务端拒绝/网络错 → error；8s 超时 → error（提示可重试）；点「取消」→ 回 idle。
      const runAssess = function () {
        if (assessPhase === 'loading') return
        setAssessPhase('loading')
        setAssessErr('')
        setNotice('正在测本机能力（CPU/内存/磁盘/PowerShell/ffmpeg/Python/GPU）…')
        assessCancelRequested = false
        assessAbortCtl = typeof AbortController === 'function' ? new AbortController() : null
        const timer = setTimeout(() => {
          if (assessAbortCtl) {
            try {
              assessAbortCtl.abort()
            } catch (e) {
              /* 已中止 */
            }
          }
        }, ASSESS_TIMEOUT_MS)
        fetch(API + '/assess', {
          method: 'POST',
          credentials: 'same-origin',
          headers: Object.assign({}, UI_HEADERS, { 'content-type': 'application/json' }),
          body: '{}',
          signal: assessAbortCtl ? assessAbortCtl.signal : undefined,
        })
          .then((r) => r.json())
          .then((d) => {
            if (d && d.ok === false) {
              setAssessPhase('error')
              setAssessErr('评估未完成：' + ((d && d.error) || '后端返回失败') + '（可点「重试」）')
              setAssessHidden(false)
              return null
            }
            setAssessPhase('success')
            setAssessCaps((d && d.caps) || null)
            setNotice((d && d.summary) || '评估完成')
            // v2.7.4（UI-2）：评估成功 ⇒ 写本机兜底记录（服务端写盘失败时面板据此降级）
            // v2.7.4（MC-1）：一并记 caps 摘要，供 readLocalAssess 判断硬件是否变过
            if (d && d.machine)
              lsSet(ASSESS_DONE_KEY, JSON.stringify({ machine: d.machine, assessedAt: Date.now(), capsDigest: capsDigest(d.caps) }))
            setAssessHidden(true)
            // v2.7.4（MC-3）：二段 /identity 刷新与「评估是否成功」解耦 —— 它失败不能把
            // success 态覆盖成 error 卡（复核反证 3/P1）。失败只让本次 ident 刷新作废。
            return fetch(API + '/identity', { cache: 'no-store', credentials: 'same-origin' })
              .then((r) => r.json())
              .catch(() => null)
          })
          .then((i) => {
            if (i && i.ok) {
              if (!i.needsAssessment) lsDel(ASSESS_DEGRADE_NOTIFIED_KEY)
              setIdent(i)
            }
            setTick((t) => t + 1)
          })
          .catch((e) => {
            const msg = String((e && e.message) || e)
            const aborted = !!(e && (e.name === 'AbortError' || msg.indexOf('abort') >= 0))
            if (aborted && assessCancelRequested) {
              // 用户主动取消：静默回 idle，不进错误卡（cancelAssess 已置 phase=idle）
              return
            }
            setAssessPhase('error')
            setNotice('')
            setAssessErr(
              aborted
                ? '评估超时（' + Math.round(ASSESS_TIMEOUT_MS / 1000) + ' 秒），本机探测或服务端响应卡住了 —— 可点「重试」再试一次'
                : '评估失败：' + msg + '（可点「重试」）',
            )
          })
          .then(() => {
            clearTimeout(timer)
            assessAbortCtl = null
          })
      }
      const cancelAssess = function () {
        assessCancelRequested = true
        if (assessAbortCtl) {
          try {
            assessAbortCtl.abort()
          } catch (e) {
            /* 无需处理 */
          }
        }
        assessAbortCtl = null
        setAssessPhase('idle')
        setAssessErr('')
        setNotice('')
      }
      const [sending, setSending] = React.useState(false)
      const [ask, setAsk] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        const load = async () => {
          const out = await getJson(API + '/summary')
          if (!alive) return
          if (out && out.ok) {
            setData(out)
            setError('')
          } else {
            setError((out && (out.error || out.hint)) || '取不到板子')
          }
        }
        load()
        const timer = setInterval(load, 8000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [tick])

      // v1.4.0：doctor 30 秒一轮；不抢 summary 的 8 秒节奏。
      React.useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const d = await getJson(API + '/doctor')
            if (alive && d) setDoctor(d)
          } catch (e) {
            /* doctor 自己挂了不该影响面板 */
          }
        }
        load()
        const timer = setInterval(load, 30000)
        return () => { alive = false; clearInterval(timer) }
      }, [tick])


      // __R3_TEAM__ 远程同事总览：与板子同频（8 秒）
      React.useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const res = await fetch('/api/remote-agent/ui/overview', { cache: 'no-store', credentials: 'same-origin' })
            const txt = await res.text()
            let out = null
            try { out = JSON.parse(txt) } catch (e) { out = null }
            if (!alive) return
            if (out && out.ok) { setNet(out); setNetErr('') }
            else setNetErr('远程同事接口 ' + res.status)
          } catch (e) {
            if (alive) setNetErr('连不上远程同事接口')
          }
        }
        load()
        const timer = setInterval(load, 8000)
        return () => { alive = false; clearInterval(timer) }
      }, [tick])

      // v1.1：派发权归 Host（复核 #6）。面板只建单并标 dispatch=auto，
      // Host 的调度器几秒内自己认领、派给 remote-agent、回绑 remote_id。
      const doDispatch = async (target, g, modelStr) => {
        const bid = 'bd-' + Date.now().toString(36).slice(-6) + '-' + Math.random().toString(36).slice(2, 6)
        const cre = await getJson(API + '/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            task_id: bid,
            goal: g,
            title: g.slice(0, 40),
            machine: target || '',
            model: String(modelStr || ''),
            dispatch: 'auto',
            mode: taskMode,
            maint_ticket: taskMode === 'maint' ? (String(ticket || '').trim() || undefined) : undefined,
            workspace: window.__dsbWorkspace || '',
          }),
        })
        if (!cre || !cre.ok) {
          setNetErr('建单失败：' + asText(cre && (cre.error || cre.message), '未知'))
          return false
        }
        setNetErr('')
        setTick((t) => t + 1)
        return true
      }

      const openDispatchModal = () => {
        const list = Array.isArray(data && data.machines) ? data.machines : []
        const allTasks = Array.isArray(data && data.tasks) ? data.tasks : []
        const load = Object.create(null)
        for (const t of allTasks) {
          if (t && (t.status === 'running' || t.status === 'claimed') && t.machine) {
            const k = String(t.machine).toLowerCase()
            load[k] = (load[k] || 0) + 1
          }
        }
        const nm = (data && data.nodeModels) || null
        const cands = list
          .filter((m) => m && m.online && String(m.id || '').toLowerCase() !== 'host')
          .map((m) => {
            const k = String(m.id || '').toLowerCase()
            const b = load[k] || 0
            return { id: String(m.id), busyN: b, fit: f1Fit({ mode: taskMode, model }, m, nm, b) }
          })
          .filter((c) => c.fit.score > 0)
          .sort((a, b) => b.fit.score - a.fit.score || a.busyN - b.busyN || a.id.toLowerCase().localeCompare(b.id.toLowerCase()))
        if (cands.length > 0) {
          setPick(cands[0].id)
          setPickOff(false)
        }
        setAsk(true)
      }

      // __R3_TEAM__ 弹窗确认
      const confirmDispatch = async () => {
        const g = goal.trim()
        if (g === '') return
        if (taskMode === 'maint' && String(ticket || '').trim() === '' && /"(upgrade|config-set|restart)"/.test(g)) {
          // 写动词需要票据；前端先拦一次，省得建单后到副机才被拒。
          setNetErr('写动词需要票据：先用 scripts/maint-ticket.mjs 签发，把 ticket= 后面那串贴进来')
          return
        }
        setSending(true)
        try {
          const ok = await doDispatch(pick, g, model)
          if (ok) { setGoal(''); setAsk(false); setModel('') }
        } catch (e) {
          setNetErr('派工异常：' + String((e && e.message) || e))
        } finally {
          setSending(false)
        }
      }

      // v2.6.29（U-3）：maint 派工前的 dryRun 预览。只算差异，不建任务、不写盘。
      const previewDiff = async () => {
        if (diffBusy) return
        setDiffBusy(true)
        setDiffRes(null)
        try {
          const out = await getJson(API + '/config-diff', {
            method: 'POST',
            body: JSON.stringify({
              goal: String(goal || '').trim(),
              ticket: String(ticket || '').trim(),
              machine: pick || '',
            }),
          })
          setDiffRes(out || { ok: false, error: '无响应' })
        } catch (e) {
          setDiffRes({ ok: false, error: String((e && e.message) || e) })
        } finally {
          setDiffBusy(false)
        }
      }

      // v2.6.29（U-4）：worker 状态卡的数据源 + drain/resume。
      const loadWorkerStatus = async () => {
        const d = await getJson(API + '/worker-status')
        if (d) setWorkerStat(d)
      }
      React.useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const d = await getJson(API + '/worker-status')
            if (alive && d) setWorkerStat(d)
          } catch (e) {
            /* worker 卡自己挂了不该影响面板 */
          }
        }
        load()
        const timer = setInterval(load, 15000)
        return () => { alive = false; clearInterval(timer) }
      }, [tick])
      const workerControl = async (action) => {
        if (workerBusy) return
        setWorkerBusy(action)
        setWorkerErr('')
        try {
          const out = await getJson(API + '/worker-control', { method: 'POST', body: JSON.stringify({ action }) })
          if (!out || out.ok === false) {
            setWorkerErr(asText(out && (out.error || out.reason), '操作失败'))
            return
          }
          // 操作成功后 8 秒再刷一次状态（drain/resume 生效有延迟）。
          setTimeout(() => { loadWorkerStatus().catch(() => {}) }, 8000)
        } catch (e) {
          setWorkerErr(String((e && e.message) || e))
        } finally {
          setWorkerBusy('')
        }
      }

      // 待派任务的自动派工只走 Host 侧后台循环（apply 里的 bgDispatch）：
      // 面板里再写一份会在 resolveNodeId 未定义时抛错（复核 #11），且浏览器一关就停。

      const act = async (kind, task, extra) => {
        const ex = extra || {}
        setBusy(task.id + ':' + kind)
        setNetErr('')
        try {
          let out = null
          if (kind === 'claim') out = await getJson(API + '/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task_id: task.id }) })
          if (kind === 'done')
            out = await getJson(API + '/release', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ task_id: task.id, status: 'done', artifact: ex.artifact || '', note: ex.note || '', machine: task.machine || undefined, holder: task.holder || undefined }),
            })
          if (kind === 'retry')
            out = await getJson(API + '/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task_id: task.id }) })
          if (out && out.ok && kind === 'retry') setNotice('已重派：' + task.id + ' → ' + out.task_id + '（调度器下一轮按原机器/模型派发）')
          if (kind === 'blocked')
            out = await getJson(API + '/release', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              // 复核 #5：把 task.machine 带上 —— 多机在跑时板子只认这一条，
              // 不带的话 Host 会用本机身份 release，释放掉别人的占位。
              body: JSON.stringify({ task_id: task.id, status: 'blocked', note: ex.note || 'GUI 打回', machine: task.machine || undefined, holder: task.holder || undefined }),
            })
          // 板子回 409（例如已经被人认领过）时以前完全不提示，看起来像成功了。
          if (out && out.ok === false) setNetErr('操作失败：' + asText(out.error || out.message, '未知'))
        } catch (e) {
          setNetErr('操作异常：' + String((e && e.message) || e))
        } finally {
          setBusy('')
          setTick((t) => t + 1)
        }
      }

      // v2.3.0：失败原因归类。只做提示，不改变任务状态。
      const failureHint = function (note) {
        const n = String(note || '')
        if (/no api key|no key for provider|unauthorized|401/i.test(n)) return '模型未登录或凭据无效：到那台机器登录账号后重派'
        if (/exceeds the available context|context (size|length)|too many tokens/i.test(n)) return '上下文超限：换更小的任务或换成大上下文模型'
        if (/workspace (not reachable|outside)|allowed roots/i.test(n)) return '工作目录不可达或不在白名单：检查 Z: 映射与 allowedRoots'
        if (/timeout|timed out|超时/i.test(n)) return '执行超时：提高 timeoutMs，或把任务拆小'
        if (/transport failed|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(n)) return '网络/服务不可达：检查副机在线与 19387 连接'
        // v2.6.27（盘古审计 P1）：闸门类 reason 之前没有文案，用户只看到一串 reason 名。
        if (/agent-not-allowlisted/.test(n)) return '不在本机 agent 白名单：去那台机器的 worker.agentAllowlist 里加一条（goalPrefix 要匹配任务开头）'
        if (/agent-misconfigured|agent-cwd-unset/.test(n)) return 'agent 配置不全：agentEnabled / agentPreset / agentCwdRoot 三件都要在 worker: 块里'
        if (/agent-prompt-denied/.test(n)) return '被提示词闸门拦下：任务描述命中了本机配置的拦截规则'
        if (/agent-approval-required/.test(n)) return '需要本机人工批准：在那台机器执行 worker_control action=approve'
        if (/agent-budget-exceeded/.test(n)) return '当日 agent 额度用完：等明天或调 worker.agentBudgetMaxPerDay'
        if (/cwd-root-unset|execCwdRoot/.test(n)) return '没配执行根目录：worker.execCwdRoot 必填（或显式 allowUnscopedCwd=true 恢复旧行为）'
        if (/maint-ticket|票据/.test(n)) return '票据问题：重新签发（票据一次性、绑 payload 与机器）'
        if (/maint-write-disabled/.test(n)) return '写通道没开：在副机跑 scripts/enable-maint-write.ps1 -PublicKey <主控公钥> 并重启 DSH'
        return ''
      }
      const counts = (data && data.counts) || { queued: 0, running: 0, done: 0, bad: 0, stale: 0 }
      const machines = ((data && data.machines) || []).filter(function (m) { return m && String(m.id || '') !== '?' })
  // v2.7.5（S1）：在线副机（host 自己不算派工目标）
  const onlineSub = machines.filter(function (m) { return m && m.online && String(m.id || '').toLowerCase() !== 'host' })
      const tasks = (data && data.tasks) || []
      // 所有地方显示机器名都走它：nodeId → 板子别名，大小写一并抹平
      const mLabel = machineLabeler(data && data.nodeMap, data && data.machines)
      // 本机身份牌（/identity 的 machine 可能是 nodeId，跟任务列保持同一套别名）
      const meLabel = ident && ident.machine ? mLabel(ident.machine) : ''
      const machineRisk = (machines || []).some(function (m) { const st = (m.caps || {}).stability || {}; return st.level === 'risky' })
      const mCollapsed = machinesCollapsed && !machineRisk
      // v2.6.29（U-3）：只有 maint 且 goal 是合法 config-set JSON 才显示「预览改动」。
      const diffPayload = (function () {
        if (taskMode !== 'maint') return null
        const t = String(goal || '').trim()
        if (!t || t.charAt(0) !== '{') return null
        try {
          const obj = JSON.parse(t)
          if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
          return String(obj.verb || '').toLowerCase() === 'config-set' ? obj : null
        } catch (e) {
          return null
        }
      })()
      // v2.6.29（U-4）：worker 卡只在 status.enabled 时渲染。
      const workerSt = (workerStat && workerStat.status) || {}
      const workerOn = !!(workerStat && workerStat.ok !== false && workerStat.enabled)
      const fmtDiffValue = function (v) {
        if (v === null || v === undefined) return '（无）'
        return typeof v === 'string' ? v : JSON.stringify(v)
      }

      const isArchived = (t) => ARCHIVED.indexOf(t.status) >= 0
      // 「已完成」按完成时间倒序：后端只给了相对时间（3 分钟前），排序靠 updatedAt
      const doneList = tasks
        .filter((t) => t.status === 'done')
        .slice()
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      const activeList = tasks.filter((t) => t.status !== 'done' && !isArchived(t))
      const badList = tasks.filter((t) => t.status === 'blocked' || t.status === 'failed')

      // 宿主插件还没重载时 summary 仍按 60 条截断（板子实际 74 条 done）。有缺口就说出来，
      // 不要让用户以为"已完成"只有这么几条——重载宿主后这条提示自动消失。
      const doneTotal = Number((data && data.counts && data.counts.done) || 0)
      const doneGap = doneTotal > doneList.length ? doneTotal - doneList.length : 0

      // 三个老视图语义不变：未完成=除 done/归档外全部，全部=一条不漏，打回=blocked+failed
      const shown =
        filter === 'all'
          ? tasks
          : filter === 'done'
            ? doneList
            : filter === 'bad'
              ? badList
              : activeList

      const kw = q.trim().toLowerCase()
      const filtered = kw
        ? shown.filter((t) =>
            [t.id, t.title, t.note, t.machine, mLabel(t.machine), t.progress]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(kw),
          )
        : shown

      // 清理候选：只含历史态，running / claimed 永远进不来。
      // 弹窗打开后会重新拉一次 summary 覆盖 cleanSnap —— 30 秒前的快照可能已经过期。
      const cleanBase = cleanSnap || tasks
      const cleanList = cleanBase.filter((t) => CLEANABLE.indexOf(t.status) >= 0)
      // 已被认领的 queued 任务：归档前必须先退占位，否则副机还在跑就会被作废
      const cleanClaimed = cleanList.filter((t) => t.status === 'queued' && t.taker).length
      const archivedN = cleanBase.filter(isArchived).length

      // 拉一次全量任务（null = 拉不到，调用方退回现有快照）
      const fetchTasks = async () => {
        try {
          const d = await getJson(API + '/summary')
          return d && d.ok && Array.isArray(d.tasks) ? d.tasks : null
        } catch {
          return null
        }
      }

      const closeClean = () => {
        if (cleanBusy) return
        setCleanOpen(false)
        setCleanSnap(null)
      }

      // 点「清理」：先把最新状态拉到眼前，再让用户确认（条数、被认领数都以此为准）
      const openClean = async () => {
        setCleanRes(null)
        setCleanOpen(true)
        setCleanLoading(true)
        const fresh = await fetchTasks()
        setCleanSnap(fresh)
        setCleanLoading(false)
      }

      // 面板清理期间让 Host 调度器停手：清理是"读快照 → 逐条归档"，这几秒里
      // 若调度器把某条 queued 任务 take 走并派到副机，随后的 release 会把正在跑的
      // 任务作废。ms=0 表示立刻恢复；宿主侧有上限并会自然过期，不存在永久暂停。
      const pauseDispatch = async (ms) => {
        try {
          return await getJson(API + '/dispatch-pause', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ms }),
          })
        } catch (e) {
          return null
        }
      }

      // 板子 /api/untake 要求 task_id + machine 都必填，且比的是任务的 taker 字段
      const untakeOne = async (taskId, taker) => {
        let out = null
        try {
          out = await getJson(API + '/untake', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ task_id: taskId, machine: taker }),
          })
        } catch (e) {
          out = { ok: false, error: String((e && e.message) || e) }
        }
        return out || { ok: false, error: '没有返回' }
      }

      // 单条任务在动手前的判定：能归档 → {task}；该跳过 → {skip}；真失败 → {fail}
      const prepareClean = async (cur0) => {
        let cur = cur0
        // running / claimed 一律不碰（CLEANABLE 已排除，这里再挡一次）
        if (cur.status === 'running' || cur.status === 'claimed') {
          return { skip: '正在跑（' + (cur.taker ? mLabel(cur.taker) : '已认领') + '），不动' }
        }
        if (CLEANABLE.indexOf(cur.status) < 0) {
          return { skip: '状态已变：' + (STATUS_LABEL[cur.status] || cur.status) }
        }
        // queued 且已被认领 → 先退占位再归档
        if (cur.status !== 'queued' || !cur.taker) return { task: cur }
        const u = await untakeOne(cur.id, cur.taker)
        if (u && u.ok) return { task: Object.assign({}, cur, { taker: '' }) }
        const st = Number(u && u.status) || 0
        if (st !== 409) {
          const msg = (u && (u.error || u.message)) || '未知错误'
          // 宿主插件还没重载时这条路由不存在，报错会是一坨 HTML —— 翻成人话
          const why = /返回不是 JSON|HTTP 404|Cannot POST/.test(msg)
            ? '宿主没有 /api/board/ui/untake 接口（插件可能未重载）'
            : msg
          return { fail: '退占位失败：' + why }
        }
        // 409「不是你占的」：可能刚被另一台认领并跑起来了 —— 取一次最新状态再判
        const now = await fetchTasks()
        if (now) setCleanSnap(now)
        const nt = now ? now.find((x) => x.id === cur.id) : null
        const holder = (u && (u.taker || u.holder)) || cur.taker
        if (nt && nt.status !== 'queued') {
          return {
            skip: '已被 ' + mLabel(holder) + ' 认领并开始执行（' + (STATUS_LABEL[nt.status] || nt.status) + '），跳过',
          }
        }
        if (nt && !nt.taker) return { task: Object.assign({}, nt, { taker: '' }) }
        return { skip: '已被 ' + mLabel(holder) + ' 认领，跳过，稍后再清理' }
      }

      const runCleanup = async () => {
        if (cleanBusy) return
        setCleanBusy(true)
        setCleanRes(null)
        let paused = false
        // v1.3.10（复核 D3/D4）：整段放进 try/finally —— ① 任何一步抛错都不能把 cleanBusy
        // 卡在 true（否则按钮永久变灰、pauseDispatch(0) 也不执行）；② 暂停失败必须**中止**，
        // 不能因为 pauseRes.ok 不为真就跳过判断继续归档 —— 那会在调度器没停手时把在途任务
        // release 成 superseded（副机在跑、板上作废，syncRemote 的 watched 也不含它）。
        try {
          // ⓪ 先让 Host 调度器停手（2 分钟上限，正常几秒就结束）
          const pauseRes = await pauseDispatch(120000)
          paused = !!(pauseRes && pauseRes.ok && pauseRes.paused)
          if (!paused) {
            // v1.2.3（复核 S1）：宿主回 paused=false 说明还有在途写（最长 20 秒）。再等一次，
            // 仍不停手就**不要动**。
            const again = await pauseDispatch(120000)
            paused = !!(again && again.ok && again.paused)
          }
          if (!paused) {
            setNotice('调度器没有停手（或暂停接口不可用），这次没有归档任何任务，请确认 DSH 在跑后再试')
            return
          }
        // ① 点确认到真正开跑之间也可能被认领：开跑前再拉一次，以最新状态为准
        const fresh = await fetchTasks()
        if (fresh) setCleanSnap(fresh)
        const base = fresh || cleanSnap || tasks
        const list = base.filter((t) => CLEANABLE.indexOf(t.status) >= 0)
        setCleanProg({ i: 0, n: list.length })
        if (!list.length) {
          if (paused) await pauseDispatch(0)
          setCleanBusy(false)
          setCleanRes({ ok: 0, skipped: [], failed: [] })
          return
        }
        const failed = []
        const skipped = []
        let okN = 0
        for (let i = 0; i < list.length; i++) {
          const t = list[i]
          setCleanProg({ i: i + 1, n: list.length })
          const prep = await prepareClean(t)
          if (prep.skip) {
            skipped.push({ id: t.id, title: t.title || '', why: prep.skip })
            continue
          }
          if (prep.fail) {
            failed.push({ id: t.id, title: t.title || '', error: prep.fail })
            continue
          }
          const cur = prep.task
          let out = null
          try {
            out = await getJson(API + '/release', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              // machine 必须原样回传任务自身的值：可能是别名（MB14），也可能是 nodeId
              body: JSON.stringify({
                task_id: cur.id,
                status: 'superseded',
                machine: cur.machine || undefined,
                note: cleanNote.trim() || CLEAN_NOTE,
              }),
            })
          } catch (e) {
            out = { ok: false, error: String((e && e.message) || e) }
          }
          if (out && out.ok) okN += 1
          else failed.push({ id: cur.id, title: cur.title || '', error: (out && (out.error || out.message)) || '未知错误' })
        }
          setCleanRes({ ok: okN, skipped, failed })
          if (!failed.length && !skipped.length) {
            setCleanOpen(false)
            setCleanSnap(null)
            setNotice('已清理 ' + okN + ' 条未完成的历史任务（归档为「被取代」，记录仍可在「全部」里查到）')
          } else {
            setNotice(
              '清理完成 ' + okN + ' 条，跳过 ' + skipped.length + ' 条（被认领/正在跑），' + failed.length + ' 条失败（详情见弹窗）',
            )
          }
          setTick((t) => t + 1)
        } catch (e) {
          // v1.3.10（复核 D4）：网络抖动/接口异常时给出可读结论，未归档的任务保持原状。
          setNotice('清理中断：' + String((e && e.message) || e) + '（未完成的任务保持原状）')
          setCleanRes({ ok: 0, skipped: [], failed: [] })
        } finally {
          setCleanBusy(false)
          // 归档结束（或中途失败）都要把调度器放回去，别等 2 分钟自然过期。
          if (paused) {
            try { await pauseDispatch(0) } catch (e) { /* 网络抖动：暂停到期后自然恢复 */ }
          }
        }
      }

      const filtBtn = (key, label, n) =>
        h(
          'button',
          {
            className: 'dsb-btn' + (filter === key ? ' on' : ''),
            disabled: filter === key,
            'aria-pressed': filter === key,
            // 数字靠悬停补一句人话：视图切换不该只有一个后缀数字
            title:
              (filter === key ? '当前视图：' : '切到「') +
              label +
              '」' +
              (typeof n === 'number' ? '（' + n + ' 条）' : ''),
            onClick: () => setFilter(key),
          },
          label,
          typeof n === 'number' ? h('span', { className: 'dsb-n' }, n) : null,
        )

      const emptyText = error
        ? '板子连不上'
        : kw
          ? '没有匹配「' + q.trim() + '」的任务'
          : filter === 'done'
            ? '还没有已完成的任务'
            : filter === 'bad'
              ? '没有被打回的任务'
              : '没有任务'

      const doctorIssues = (doctor && Array.isArray(doctor.checks) ? doctor.checks : [])
        .filter(function (c) { return c && (c.level === 'error' || c.level === 'warn') })
      const doctorHasError = doctorIssues.some(function (c) { return c.level === 'error' })
      // v2.7.5（U1）：收缩条计数 —— 错误数单独上色，不靠颜色单独传达（WCAG 1.4.1）
      const doctorErrN = doctorIssues.filter(function (c) { return c.level === 'error' }).length
      const doctorWarnN = doctorIssues.length - doctorErrN

      const saveAlias = async () => {
        try {
          const r = await fetch(API + '/alias', {
            method: 'POST',
            credentials: 'same-origin',
            headers: Object.assign({}, UI_HEADERS, { 'content-type': 'application/json' }),
            body: JSON.stringify({ alias: aliasDraft }),
          })
          const j = await r.json().catch(() => ({}))
          if (!r.ok || !j.ok) {
            setNotice('改名失败：' + (j.error || ('HTTP ' + r.status)))
            return
          }
          setNotice(j.alias ? '本机显示名已改为「' + j.alias + '」' : '已恢复默认显示名（电脑名）')
          setRenaming(false)
          setTick((x) => x + 1)
        } catch (e) {
          setNotice('改名失败：' + ((e && e.message) || e))
        }
      }

      // v2.7.19：机器卡上的「安装更新 / 重启 DSH」——都走宿主路由，由宿主签票派 maint 任务。
      // v2.7.21：宿主现在会等任务终态 + 回查实例号/版本，回执直接说「真重启 / 未生效」；
      //          面板按机器分别显示（nodeMsg 从单条字符串改成 {machine: text}）。
    const nodeOp = async (kind, id) => {
      const m = String(id)
      // v2.7.19：setNodeBusy 是异步渲染，连点时第二次仍会进来 ⇒ 用同步 ref 锁挡住重复派工。
      if (nodeLock.current[m]) return
      nodeLock.current[m] = true
      setNodeBusy((s) => ({ ...s, [m]: kind }))
      setNodeMsg((s) => ({ ...s, [m]: '' }))
      try {
        const r = await fetch('/api/board/ui/' + kind, {
          method: 'POST',
          credentials: 'same-origin',
          headers: Object.assign({}, UI_HEADERS, { 'content-type': 'application/json' }),
          body: JSON.stringify({ machine: m }),
        })
        const d = await r.json().catch(() => ({}))
        let text = ''
        if (d && d.ok) {
          text = d.note || (kind === 'node-upgrade'
            ? `已派安装任务 ${d.taskId || ''}（v${d.version || '?'}）`
            : `已派重启任务 ${d.taskId || ''}`)
        } else {
          text = `失败：${(d && (d.message || d.error)) || ('HTTP ' + r.status)}`
        }
        setNodeMsg((s) => ({ ...s, [m]: text }))
      } catch (e) {
        setNodeMsg((s) => ({ ...s, [m]: '失败：' + String((e && e.message) || e) }))
      } finally {
        delete nodeLock.current[m]
        setNodeBusy((s) => { const n = { ...s }; delete n[m]; return n })
      }
    }
    const saveMachineAlias = async (id) => {
        setCardBusy((b) => Object.assign({}, b, { [String(id)]: true }))
        try {
          const r = await fetch(API + '/machine-alias', {
            method: 'POST',
            credentials: 'same-origin',
            headers: Object.assign({}, UI_HEADERS, { 'content-type': 'application/json' }),
            body: JSON.stringify({ machine: id, alias: cardRenameDraft }),
          })
          const j = await r.json().catch(() => ({}))
          if (!r.ok || !j.ok) {
            setNotice('改名失败：' + (j.error || ('HTTP ' + r.status)))
            return
          }
          setNotice(j.alias ? '「' + mLabel(id) + '」的显示名改为「' + j.alias + '」' : '已恢复「' + mLabel(id) + '」的默认显示名')
          setCardRenameId('')
          setTick((x) => x + 1)
        } catch (e) {
          setNotice('改名失败：' + ((e && e.message) || e))
        } finally {
          setCardBusy((b) => Object.assign({}, b, { [String(id)]: false }))
        }
      }

      const forgetMachine = async (id) => {
        if (!window.confirm('把「' + mLabel(id) + '」从看板移除？只移除机器卡片，任务记录保留；如果那台机器之后再次上报，它会重新出现。')) return
        setCardBusy((b) => Object.assign({}, b, { [String(id)]: true }))
        try {
          const r = await fetch(API + '/forget-machine', {
            method: 'POST',
            credentials: 'same-origin',
            headers: Object.assign({}, UI_HEADERS, { 'content-type': 'application/json' }),
            body: JSON.stringify({ machine: id }),
          })
          const j = await r.json().catch(() => ({}))
          if (!r.ok || !j.ok) {
            setNotice('移除失败：' + (j.error || ('HTTP ' + r.status)) + (j.hint ? '　' + j.hint : ''))
            return
          }
          setNotice('已从看板移除「' + mLabel(id) + '」')
          setCardRenameId('')
          setCardRenameDraft('')
          setTick((x) => x + 1)
        } catch (e) {
          setNotice('移除失败：' + ((e && e.message) || e))
        } finally {
          setCardBusy((b) => Object.assign({}, b, { [String(id)]: false }))
        }
      }

      const parseTags = (raw) => String(raw == null ? '' : raw).split(/[,，\s]+/).map((x) => x.trim().slice(0, 24)).filter(Boolean).slice(0, 12)
      const runCapsProbe = async (id) => {
        // 中⑤：重测会整份替换探测结果，未保存的标签编辑先确认，避免静默丢失。
        if (capsProbe) {
          let dirty = true
          try { dirty = JSON.stringify({ caps: capsProbe.caps, role: capsProbe.role, allow: !!capsProbe.allowHighRisk }) !== capsBase } catch (e) { dirty = true }
          if (dirty) {
            let go = true
            try { go = window.confirm('重新自检会丢弃尚未保存的标签与角色编辑，继续？') } catch (e) { go = true }
            if (!go) return
          }
        }
        setCapsBusy(String(id))
        setCapsProbe(null)
        setTagDraft({})
        try {
          const r = await fetch(API + '/caps-probe', {
            method: 'POST',
            credentials: 'same-origin',
            headers: Object.assign({}, UI_HEADERS, { 'content-type': 'application/json' }),
            body: JSON.stringify({ machine: id }),
          })
          const j = await r.json().catch(() => ({}))
          if (!r.ok || !j.ok) {
            setNotice('能力自检失败：' + (j.error || ('HTTP ' + r.status)))
            return
          }
          const role0 = (j.caps && Array.isArray(j.caps.roles) && j.caps.roles[0] && ['primary', 'secondary', 'secondary-if-idle', 'none'].includes(String(j.caps.roles[0].level))) ? String(j.caps.roles[0].level) : 'secondary'
          setCapsShowAll(false)
        setCapsProbe({ machine: id, caps: j.caps || {}, role: role0, allowHighRisk: false })
          setTagDraft({})
          try { setCapsBase(JSON.stringify({ caps: j.caps || {}, role: role0, allow: false })) } catch (e) {}
          setNotice('能力自检完成' + (j.cached ? '（60 秒内缓存）' : '') + '：确认角色后保存')
        } catch (e) {
          setNotice('能力自检失败：' + ((e && e.message) || e))
        } finally {
          setCapsBusy('')
        }
      }

      const openWorkloadProbe = async () => {
        // 保留上一轮结果：关闭再打开不该把刚跑完的实测值清空（关窗期间跑完的也在）。
        setWlOpen(true)
        setWlNote('')
        try {
          const r = await fetch(API + '/workload-catalog', { cache: 'no-store', credentials: 'same-origin' })
          const j = await r.json().catch(() => ({}))
          if (!r.ok || !j.ok) { setWlNote('读取工作大类失败：' + (j.error || ('HTTP ' + r.status))); return }
          const cat = Array.isArray(j.catalog) ? j.catalog : []
          setWlCatalog(cat)
          setWlSel(function (prev) {
            const next = Object.assign({}, prev)
            for (const w of cat) if (w.enabled && next[w.id] === undefined) next[w.id] = true
            return next
          })
        } catch (e) {
          setWlNote('读取工作大类失败：' + ((e && e.message) || e))
        }
      }
      const runWorkloadProbe = async () => {
        if (wlRun.busy) return
        const list = (wlCatalog || []).filter((w) => w.enabled && wlSel[w.id])
        if (!list.length) { setWlNote('先勾选至少一项要测的工作'); return }
        setWlRun({ busy: true, current: '', done: {} })
        setWlNote('')
        for (const w of list) {
          setWlRun((prev) => Object.assign({}, prev, { current: w.id }))
          try {
            const r = await fetch(API + '/workload-probe', {
              method: 'POST',
              credentials: 'same-origin',
              headers: Object.assign({}, UI_HEADERS, { 'content-type': 'application/json' }),
              body: JSON.stringify({ workload: w.id }),
            })
            const j = await r.json().catch(() => ({}))
            setWlRun((prev) => {
              const done = Object.assign({}, prev.done)
              done[w.id] = { ok: !!(r.ok && j.ok), value: j.workload ? j.workload.value : null, unit: j.workload ? j.workload.unit : w.unit, aggregate: j.workload ? j.workload.aggregate : null, maxStreams: j.workload ? j.workload.maxStreams : null, elapsedMs: j.elapsedMs || 0, error: j.error || '' }
              return Object.assign({}, prev, { done: done })
            })
          } catch (e) {
            setWlRun((prev) => {
              const done = Object.assign({}, prev.done)
              done[w.id] = { ok: false, error: String((e && e.message) || e) }
              return Object.assign({}, prev, { done: done })
            })
          }
        }
        setWlRun((prev) => Object.assign({}, prev, { busy: false, current: '' }))
        setTick((t) => t + 1)
        setNotice('能力探测结束；成功项已写入本机能力卡')
      }

      // v2.5.3：可选压测。三档时长固定，用户可以随时取消（服务端杀整棵进程树）。
      const runStressNow = async () => {
        if (stressBusy) return
        setStressBusy('run')
        setStressRes(null)
        setNotice('压测开始：' + ({ quick: '快速 3 分钟', standard: '标准 10 分钟', deep: '深度 60 分钟' })[stressMode])
        try {
          const r = await fetch(API + '/stress-test', {
            method: 'POST',
            credentials: 'same-origin',
            headers: Object.assign({}, UI_HEADERS, { 'content-type': 'application/json' }),
            body: JSON.stringify({ mode: stressMode }),
          })
          const j = await r.json().catch(() => ({}))
          if (r.status === 409) {
            setStressRes(j)
            setNotice('已有压测在跑' + (j.mode ? '（' + j.mode + '）' : ''))
            return
          }
          setStressRes(j)
          if (j.cancelled) {
            setNotice('已取消压测（未写入能力卡）')
            return
          }
          setNotice(j.ok ? ('压测完成：' + (j.result && j.result.ok ? '通过' : '未通过') + (j.saved ? '，结果已写入能力卡' : '')) : ('压测失败：' + (j.error || ('HTTP ' + r.status))))
          if (j.ok) setTick((t) => t + 1)
        } catch (e) {
          setNotice('压测失败：' + String((e && e.message) || e))
        } finally {
          setStressBusy('')
        }
      }

      const cancelStressNow = async () => {
        try {
          const r = await fetch(API + '/stress-cancel', { method: 'POST', credentials: 'same-origin', headers: Object.assign({}, UI_HEADERS, { 'content-type': 'application/json' }), body: '{}' })
          const j = await r.json().catch(() => ({}))
          if (r.status === 409) { setNotice('没有正在跑的压测'); setStressRes(null) }
          else if (r.ok && j.cancelled) { setNotice('已请求取消压测'); setStressRes(null) }
          else if (r.ok) { setNotice('压测已自然结束'); setStressRes(null) }
          else setNotice('取消失败：' + (j.error || ('HTTP ' + r.status)))
        } catch (e) {
          setNotice('取消失败：' + String((e && e.message) || e))
        }
      }

      const applyCaps = async () => {
        if (!capsProbe) return
        setCapsBusy('apply')
        try {
          const r = await fetch(API + '/caps-apply', {
            method: 'POST',
            credentials: 'same-origin',
            headers: Object.assign({}, UI_HEADERS, { 'content-type': 'application/json' }),
            body: JSON.stringify({
              caps: capsProbe.caps,
              role: capsProbe.role,
              models: (capsProbe.caps.models || []).map(function (mm, mi) {
                var raw = tagDraft[mi] !== undefined ? tagDraft[mi] : (mm.tags || []).join(', ')
                return Object.assign({}, mm, { tags: parseTags(raw) })
              }),
              allowUnverifiedHighRisk: !!capsProbe.allowHighRisk,
            }),
          })
          const j = await r.json().catch(() => ({}))
          if (!r.ok || !j.ok) {
            setNotice('保存能力卡失败：' + (j.error || ('HTTP ' + r.status)))
            return
          }
          setNotice(j.modelsDropped > 0 ? ('能力卡已保存；超出上限（最多 80 条 / 约 7.0KB）的 ' + j.modelsDropped + ' 个模型（含标签）被截掉') : '能力卡已保存到看板')
          setCapsProbe(null)
          setTagDraft({})
          setCapsBase('')
          setTick((x) => x + 1)
        } catch (e) {
          setNotice('保存能力卡失败：' + ((e && e.message) || e))
        } finally {
          setCapsBusy('')
        }
      }

      // v2.6.13：标题旁的版本 pill —— 常显，不依赖自检横幅是否渲染。
      //   · doctor 回来了就用它报的运行版本，没回来用 CLIENT_VERSION 兜底；
      //   · 磁盘版本与运行版本不同 ⇒ 追加黄色「→ 磁盘 vX」（说明要重启 DSH 才生效）；
      //   · 有更新 ⇒ 追加蓝色「↑ vX」；
      //   · 点一下 = 立刻重新拉一轮 doctor（不用等 30 秒轮询）。
      const verRunning = (doctor && doctor.version) || CLIENT_VERSION
      const verDisk = doctor && doctor.installedVersion ? String(doctor.installedVersion) : ''
      const verLatest = doctor && doctor.updateAvailable && doctor.latestVersion ? String(doctor.latestVersion) : ''
      const verSkew = Boolean(verDisk) && verDisk !== verRunning
      const verTitle = [
        '插件 v' + verRunning,
        verSkew ? '磁盘已安装 v' + verDisk + '（重启 DSH 后生效）' : '',
        verLatest ? '有新版本 v' + verLatest : '',
        doctor && doctor.role ? '角色 ' + doctor.role : '',
        '点击重新自检',
      ]
        .filter(Boolean)
        .join('　·　')
      const versionPill = h(
        'span',
        {
          className: 'dsb-pill dsb-v',
          role: 'status',
          title: verTitle,
          style: { cursor: 'pointer' },
          onClick: () => setTick((t) => t + 1),
        },
        '插件 v' + verRunning,
        verSkew ? h('span', { className: 'dsb-v-skew' }, '→ 磁盘 v' + verDisk) : null,
        verLatest ? h('span', { className: 'dsb-v-new' }, '↑ v' + verLatest) : null,
      )

      return h(
        'div',
        { className: 'dsb-root', 'data-theme': theme, style: { ['--dsb-fs']: fs + 'px' } },
        h(
          'div',
          { className: 'dsb-head' },
          h(
            'div',
            { className: 'dsb-brand' },
            h('div', { className: 'dsb-title' }, '多机调度台'),
            versionPill,
            h('span', { className: 'dsb-sub' }, (data ? 'dsh-job-board · ' + ((Array.isArray(data.machines) ? data.machines : []).filter(function (m) { return m && m.online && String(m.id || '').toLowerCase() !== 'host' }).length) + ' 台副机在线' : 'dsh-job-board')),
          ),
          h(
            'div',
            { className: 'dsb-meta' },
          h('span', { className: 'dsb-pill dsb-q' }, '待办 ', h('b', null, counts.queued)),
          h('span', { className: 'dsb-pill dsb-r' }, '进行 ', h('b', null, counts.running)),
          h('span', { className: 'dsb-pill dsb-d' }, '完成 ', h('b', null, counts.done)),
          h('span', { className: 'dsb-pill dsb-b' }, '打回 ', h('b', null, counts.bad)),
          ),
          h(
            'div',
            { className: 'dsb-acts' },
          h('div', { className: 'dsb-sp' }),
          h(
            'span',
            { className: 'dsb-pill', title: data && data.board ? data.board : '' },
            data && data.updatedAgeSec != null ? '更新 ' + ago(data.updatedAgeSec) : '未连接',
          ),
          h('button', { className: 'dsb-btn', title: '切换深色 / 浅色主题', onClick: toggleTheme }, theme === 'light' ? '☀' : '☾'),
          h('button', { className: 'dsb-btn', title: '字号：点一下换一档', onClick: bump }, 'A+'),
                      h('button', {
              className: 'dsb-btn',
              title: '\u7701\u4e00\u884c\uff1a\u628a\u4fa7\u680f\u7684\u300c\u8fdc\u7a0b\u540c\u4e8b\u300d\u6536\u8d77\u6765\uff08\u529f\u80fd\u5df2\u5e76\u5165\u672c\u9875\uff09',
              onClick: function () {
                const next = !mergeOnState
                setMergeOnState(next)
                try { if (window.__dsbMergeEntry) window.__dsbMergeEntry(next) } catch (e) { /* 忽略 */ }
              },
            }, mergeOnState ? '\u7701\u884c:\u5f00' : '\u7701\u884c:\u5173'),h('button', { className: 'dsb-btn', title: '\u663e\u793a/\u9690\u85cf\u684c\u5ba0', onClick: function () { window.dispatchEvent(new CustomEvent('dsh-board-pet-toggle')) } }, '\u{1F41F}'),
          h('button', { className: 'dsb-btn', title: '测本机的工作能力（首版视频三类，约 40 秒）', onClick: openWorkloadProbe }, '能力探测'),
          h('button', { className: 'dsb-btn', title: '可选：给本机做一次带负载的稳定性压测（默认不做，可能让老硬件吃不消）', onClick: () => setStressOpen(true) }, '压测'),
          h('button', {
            className: 'dsb-btn',
            title: '给本机起一个显示名（只改显示，不改机器身份）',
            onClick: () => {
              setAliasDraft((meLabel && meLabel !== ident.machine) ? meLabel : '')
              setRenaming(!renaming)
            },
          }, '改名'),
          h('button', { className: 'dsb-btn', title: '重新打开工作能力评估', onClick: () => setAssessHidden(false) }, '评估'),
          h('button', { className: 'dsb-btn', onClick: () => setTick((t) => t + 1) }, '刷新'),
          ),
        ),
        renaming
          ? h(
              'div',
              { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' } },
              h('span', { style: { opacity: 0.75 } }, '本机显示名（身份 ' + (ident && ident.machine ? ident.machine : '?') + ' 不变）'),
              h('input', {
                value: aliasDraft,
                maxLength: 32,
                placeholder: '留空 = 用电脑名',
                onChange: (e) => setAliasDraft(e.target.value),
                style: { padding: '4px 8px', minWidth: 180, background: 'var(--dsb-bg1)', color: 'var(--dsb-fg)', border: '1px solid var(--dsb-bd)', borderRadius: 6 },
              }),
              h('button', { className: 'dsb-btn', onClick: saveAlias }, '保存'),
              h('button', { className: 'dsb-btn', onClick: () => setRenaming(false) }, '取消'),
            )
          : null,
        wlOpen
          ? h(
              'div',
              { className: 'dsb-modal', onClick: () => setWlOpen(false) },
              h(
                'div',
                { className: 'dsb-card', onClick: (e) => e.stopPropagation() },
                h('h3', null, '能力探测（只测本机）'),
                h('p', null, '每类跑一个固定小样本，结果写进本机能力卡；派工时按这些实测值估算 ETA。补帧最慢（约 40–90 秒），其余几秒。'),
                (wlCatalog || []).filter((w) => w.enabled).map((w) =>
                  h(
                    'label',
                    { key: w.id, style: { display: 'flex', gap: 8, alignItems: 'center', padding: '3px 0' } },
                    h('input', {
                      type: 'checkbox',
                      checked: !!wlSel[w.id],
                      disabled: wlRun.busy,
                      onChange: (e) => setWlSel(Object.assign({}, wlSel, { [w.id]: e.target.checked })),
                    }),
                    h('span', null, w.name),
                    h('span', { className: 'muted', style: { marginLeft: 'auto' } }, '约 ' + w.estSec + 's'),
                    wlRun.done[w.id]
                      ? h('span', { style: { minWidth: 150, textAlign: 'right', color: wlRun.done[w.id].ok ? 'var(--dsb-ok)' : 'var(--dsb-bad)' } },
                          wlRun.done[w.id].ok
                            ? (wlRun.done[w.id].value + ' ' + wlRun.done[w.id].unit +
                              (wlRun.done[w.id].maxStreams && wlRun.done[w.id].aggregate ? ' · ' + wlRun.done[w.id].maxStreams + ' 路 ' + wlRun.done[w.id].aggregate + ' ' + wlRun.done[w.id].unit : ''))
                            : '失败')
                      : h('span', { style: { minWidth: 92 } }),
                  ),
                ),
                Object.keys(wlRun.done || {}).map((id) => {
                  const d = wlRun.done[id]
                  return d.ok ? null : h('p', { key: 'err-' + id, style: { color: 'var(--dsb-bad)', margin: 0 } }, id + '：' + (d.error || '失败'))
                }),
                wlNote ? h('p', { className: 'muted' }, wlNote) : null,
                wlRun.busy ? h('p', null, '正在测：' + (wlRun.current || '…') + '（关掉窗口不影响，探测会继续跑完）') : null,
                (function () {
                  var entries = Object.keys(wlRun.done || {}).map(function (k) { return wlRun.done[k] })
                  var doneN = entries.length
                  var okN = entries.filter(function (d) { return d && d.ok === true }).length
                  var failedN = doneN - okN
                  var list = (wlCatalog || []).filter(function (w) { return w.enabled && wlSel[w.id] })
                  var pendingN = list.filter(function (w) { return !wlRun.done[w.id] }).length
                  var covered = list.length > 0 && pendingN === 0
                  var finished = doneN > 0 && !wlRun.busy && covered
                  var tone = failedN === 0 ? 'var(--dsb-ok)' : (okN === 0 ? 'var(--dsb-bad)' : 'var(--dsb-warn)')
                  var text = failedN === 0
                    ? '已完成，结果已写入本机能力卡'
                    : (okN === 0 ? '探测全部失败，未写入本机能力卡' : '已完成：' + okN + ' 项已写入，' + failedN + ' 项失败未写入')
                  if (!finished && !wlRun.busy && doneN > 0) {
                    tone = 'var(--dsb-warn)'
                    text = pendingN > 0
                      ? '上次结果仍保留；本次勾选还有 ' + pendingN + ' 项未测'
                      : '上次结果仍保留；当前未勾选任何项'
                  }
                  return h(
                    'div',
                    { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', marginTop: 4 } },
                    (finished || (!wlRun.busy && doneN > 0)) ? h('span', { className: 'muted', style: { marginRight: 'auto', color: tone } }, text) : null,
                    h('button', { className: 'dsb-btn', onClick: () => setWlOpen(false) }, '关闭'),
                    (finished || wlRun.busy) ? h('button', { className: 'dsb-btn', disabled: wlRun.busy, onClick: runWorkloadProbe }, '重新探测') : null,
                    h(
                      'button',
                      { className: 'dsb-btn on', disabled: wlRun.busy, onClick: () => { if (finished) setWlOpen(false); else runWorkloadProbe() } },
                      wlRun.busy ? '探测中…' : (finished ? '完成' : '开始探测'),
                    ),
                  )
                })(),
              ),
            )
          : null,
        stressOpen
          ? h(
              'div',
              { className: 'dsb-modal', onClick: () => setStressOpen(false) },
              h(
                'div',
                { className: 'dsb-card', onClick: (e) => e.stopPropagation() },
                h('h3', null, '稳定性压测（可选，只测本机）'),
                h('p', null, '会跑 NVENC 编码 + 多路补帧，观察温度、降频、吞吐漂移与新增硬件错误。老硬件可能吃不消；默认不做，随时可取消。'),
                h(
                  'div',
                  { style: { display: 'flex', gap: 14, flexWrap: 'wrap', margin: '6px 0' } },
                  [['quick', '快速 3 分钟'], ['standard', '标准 10 分钟'], ['deep', '深度 60 分钟']].map(([id, label]) =>
                    h('label', { key: id, style: { display: 'flex', gap: 6, alignItems: 'center' } },
                      h('input', { type: 'radio', name: 'stressmode', checked: stressMode === id, disabled: stressActive, onChange: () => setStressMode(id) }),
                      h('span', null, label),
                    ),
                  ),
                ),
                stressRes
                  ? h('div', { style: { marginTop: 8, padding: 8, border: '1px solid var(--dsb-bd)', borderRadius: 8, background: 'var(--dsb-bg2)' } },
                      h('div', { style: { fontWeight: 600 } },
                        stressRes.cancelled ? '已取消' : (stressRes.result ? (stressRes.result.error ? String(stressRes.result.error) : (stressRes.ok && stressRes.result.ok ? '通过' : '未通过')) : String(stressRes.error || '没有拿到结果')),
                        stressRes.saved ? ' · 已写入能力卡' : '',
                      ),
                      stressRes.result
                        ? h('div', { className: 'muted', style: { marginTop: 4 } },
                            '最高温度 ' + (stressRes.result.maxTempC == null ? '—' : stressRes.result.maxTempC + '°C') +
                            ' · 吞吐漂移 ' + (stressRes.result.driftPct == null ? '—' : stressRes.result.driftPct + '%') +
                            (Array.isArray(stressRes.result.reasons) && stressRes.result.reasons.length ? ' · ' + stressRes.result.reasons.join('；') : ''),
                          )
                        : h('div', { className: 'muted', style: { marginTop: 4 } }, String(stressRes.error || '没有拿到结果')),
                    )
                  : null,
                stressActive
                  ? h('p', { className: 'muted' }, '压测进行中；可以关掉窗口，也可以点“取消压测”。')
                  : null,
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 } },
                  h('button', { className: 'dsb-btn', onClick: () => setStressOpen(false) }, '关闭'),
                  stressActive ? h('button', { className: 'dsb-btn', onClick: cancelStressNow }, '取消压测') : null,
                  h('button', { className: 'dsb-btn on', disabled: stressActive, onClick: runStressNow }, stressActive ? '压测中…' : '开始压测'),
                ),
              ),
            )
          : null,
        // v2.7.4（UI-1）：评估卡四态 —— loading / error 两个态有专属卡片，任何路径都不会永久转圈
        assessPhase === 'loading'
          ? h(
              'div',
              {
                style: {
                  border: '1px solid var(--dsb-warn)',
                  background: 'rgba(var(--dsb-warn-rgb),0.10)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  marginBottom: 10,
                },
              },
              h(
                'div',
                { style: { fontWeight: 600, marginBottom: 4 } },
                '正在评估本机工作能力…（最长 ' + Math.round(ASSESS_TIMEOUT_MS / 1000) + ' 秒，超时会自动停下并提示重试，不会一直转圈）',
              ),
              h(
                'div',
                { style: { display: 'flex', gap: 8, marginTop: 10 } },
                h('button', { className: 'dsb-btn dsb-assess-cancel', onClick: cancelAssess }, '取消'),
              ),
            )
          : assessPhase === 'error'
          ? h(
              'div',
              {
                style: {
                  border: '1px solid var(--dsb-bad)',
                  background: 'rgba(var(--dsb-bad-rgb),0.08)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  marginBottom: 10,
                },
              },
              h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '评估没有完成'),
              h(
                'div',
                { style: { opacity: 0.85, lineHeight: 1.7, fontSize: 'calc(var(--dsb-fs) - 1px)' } },
                assessErr,
              ),
              h(
                'div',
                { style: { display: 'flex', gap: 8, marginTop: 10 } },
                h('button', { className: 'dsb-btn dsb-assess-retry', onClick: runAssess }, '重试'),
                h(
                  'button',
                  {
                    className: 'dsb-btn',
                    onClick: () => {
                      setAssessPhase('idle')
                      setAssessErr('')
                    },
                  },
                  '关闭',
                ),
              ),
            )
          : needsAssessEff && assessPhase === 'idle'
          ? h(
              'div',
              {
                style: {
                  border: '1px solid var(--dsb-warn)',
                  background: 'rgba(var(--dsb-warn-rgb),0.10)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  marginBottom: 10,
                },
              },
              h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '这台机器（' + (meLabel || '?') + '）还没做过工作能力评估'),
              h(
                'div',
                { style: { opacity: 0.8, lineHeight: 1.7, fontSize: 'calc(var(--dsb-fs) - 1px)' } },
                '评估一次，主机就知道这台机器适合接什么活（CPU / 内存 / 磁盘 / PowerShell / ffmpeg / Python / GPU）。只测本机，不传文件。',
              ),
              h(
                'div',
                { style: { display: 'flex', gap: 8, marginTop: 10 } },
                h('button', { className: 'dsb-btn', disabled: assessPhase === 'loading', onClick: runAssess }, assessPhase === 'loading' ? '评估中…' : '开始评估'),
                h(
                  'button',
                  {
                    className: 'dsb-btn',
                    // v2.7.4（UI-2）：「稍后」按机器记一轮，否则 15s 轮询立刻翻回引导卡（原有缺陷顺带修）
                    onClick: () => {
                      setAssessLater(ident.machine)
                      setIdent(Object.assign({}, ident, { needsAssessment: false }))
                    },
                  },
                  '稍后',
                ),
              ),
            )
          : showAssessBar
            ? h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                    border: '1px solid var(--dsb-bd)',
                    borderRadius: 8,
                    padding: '7px 10px',
                    marginBottom: 10,
                    fontSize: 'calc(var(--dsb-fs) - 1px)',
                  },
                },
                h('span', { style: { opacity: 0.75 } }, (meLabel || '本机') + ' · 工作能力'),
                h(
                  'span',
                  { style: { opacity: 0.95 } },
                  capsForBar
                    ? [
                        String(capsForBar.os || '').replace('Windows ', 'Win'),
                        (capsForBar.cores || '?') + ' 核',
                        (capsForBar.memGB || '?') + 'G 内存',
                        '余 ' + (capsForBar.freeDiskGB || '?') + 'G',
                        capsForBar.features && capsForBar.features.pwsh ? 'pwsh ' + capsForBar.features.pwsh : '无 pwsh',
                        capsForBar.features && capsForBar.features.ffmpeg ? 'ffmpeg' : '无 ffmpeg',
                        capsForBar.features && capsForBar.features.python ? 'Python ' + capsForBar.features.python : '',
                        capsForBar.features && capsForBar.features.gpu ? String(capsForBar.features.gpu).slice(0, 28) : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : ident
                      ? '（清单为空，点右按钮重测）'
                      : '评估完成，能力清单待 /identity 刷新',
                ),
                h('span', { style: { opacity: 0.5, marginLeft: 'auto' } }, assessAtShown ? '评估于 ' + new Date(assessAtShown).toLocaleString() : ''),
                h('button', { className: 'dsb-btn', disabled: assessPhase === 'loading', onClick: runAssess }, assessPhase === 'loading' ? '评估中…' : '重新评估'),
              )
            : null,
        (doctorIssues.length || (doctor && doctor.ok === false))
          ? !doctorOpen && !(doctor && doctor.ok === false) && doctorIssues.length
            ? // v2.7.5（U1）：收缩态 —— 单行摘要，整条可点展开；键盘 Enter/Space 同效（WCAG 2.1.1）
              h(
                'div',
                {
                  className: 'dsb-doctor-collapsed',
                  role: 'button',
                  tabIndex: 0,
                  'aria-expanded': 'false',
                  title: '点击展开自检详情',
                  style: {
                    borderLeft: '3px solid ' + (doctorHasError ? 'var(--dsb-bad)' : 'var(--dsb-warn)'),
                    background: doctorHasError ? 'rgba(var(--dsb-bad-rgb),0.08)' : 'rgba(var(--dsb-warn-rgb),0.08)',
                    padding: '4px 12px',
                    marginBottom: 10,
                    lineHeight: 1.7,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    flexWrap: 'wrap',
                    fontSize: 'calc(var(--dsb-fs) - 1px)',
                  },
                  onClick: toggleDoctor,
                  onKeyDown: function (e) {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      toggleDoctor()
                    }
                  },
                },
                h('span', { style: { fontWeight: 600 } }, '▸ 自检：' + doctorIssues.length + ' 项待处理（'),
                h('span', { style: doctorErrN > 0 ? { fontWeight: 700, color: 'var(--dsb-bad)' } : null }, doctorErrN + ' 错误'),
                h('span', null, ' / ' + doctorWarnN + ' 警告）'),
                doctor && doctor.version ? h('span', { style: { opacity: 0.6 } }, '插件 v' + doctor.version) : null,
                h('span', { style: { marginLeft: 'auto', opacity: 0.6, fontSize: 'calc(var(--dsb-fs) - 2px)' } }, '点击展开'),
              )
            : h(
                'div',
                {
                  style: {
                    borderLeft: '3px solid ' + (doctorHasError ? 'var(--dsb-bad)' : 'var(--dsb-warn)'),
                    background: doctorHasError ? 'rgba(var(--dsb-bad-rgb),0.08)' : 'rgba(var(--dsb-warn-rgb),0.08)',
                    padding: '8px 12px',
                    marginBottom: 10,
                    lineHeight: 1.7,
                  },
                },
                h(
                  'div',
                  { style: { fontWeight: 700, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  h(
                    'span',
                    { style: { flex: '0 1 auto' } },
                    '自检：' + (doctorHasError ? '有错误' : '有警告'),
                    doctor && doctor.version ? '　插件 v' + doctor.version : '',
                    doctor && doctor.installedVersion && doctor.installedVersion !== doctor.version
                      ? '　（磁盘已装 v' + doctor.installedVersion + '，重启后生效）'
                      : '',
                    doctor && doctor.role ? '　角色 ' + doctor.role : '',
                  ),
                  // v2.7.5（U1）：ok===false（自检不可用）不允许收起，避免把「插件没加载」也收没了
                  doctor && doctor.ok !== false
                    ? h('button', { className: 'dsb-btn', style: { marginLeft: 'auto', padding: '1px 8px' }, onClick: toggleDoctor, 'aria-expanded': 'true', title: '收起自检详情' }, '收起 ▴')
                    : null,
                ),
                doctorIssues.map(function (c) {
                  return h(
                    'div',
                    { key: c.id, style: { fontSize: 'calc(var(--dsb-fs) - 2px)' } },
                    (c.level === 'error' ? '\u2715 ' : '! ') + c.message + (c.hint ? '\u3000\u2192 ' + c.hint : ''),
                  )
                }),
                doctor && doctor.ok === false && !doctorIssues.length
                  ? h('div', { style: { fontSize: 'calc(var(--dsb-fs) - 2px)' } }, '\u2715 自检不可用：' + (doctor.error || '后端返回异常') + '\u3000\u2192 检查插件是否已加载 / 重启 DSH')
                  : null,
              )
          : null,
        doctor && doctor.updateAvailable && doctor.latestVersion && doctor.version
          ? h(
              'div',
              { style: { borderLeft: '3px solid var(--dsb-accent)', background: 'rgba(var(--dsb-accent-rgb),0.08)', padding: '6px 10px', marginBottom: 10, fontSize: 'calc(var(--dsb-fs) - 2px)', lineHeight: 1.7 } },
              '插件有新版本 v' + doctor.latestVersion + '（当前 v' + doctor.version + '）：在插件市场（或 GitHub Releases）升级后重启 DSH。',
            )
          : null,
        notice
          ? h(
              'div',
              { style: { borderLeft: '3px solid var(--dsb-accent)', padding: '6px 10px', marginBottom: 10, opacity: 0.9, lineHeight: 1.6 } },
              notice,
              h('button', { className: 'dsb-btn', style: { marginLeft: 10, padding: '1px 8px' }, onClick: () => setNotice('') }, '知道了'),
            )
          : null,
        machines.length
          ? h('div', { style: { marginBottom: 12 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' } },
                h('span', { style: { fontSize: 'calc(var(--dsb-fs) - 3px)', opacity: 0.6 } }, '机器 · ' + machines.length + ' 台'),
                mCollapsed
                  ? h('span', { style: { fontSize: 'calc(var(--dsb-fs) - 3px)', opacity: 0.8 } },
                      machines.map(function (m) {
                        const st = (m.caps || {}).stability || {}
                        const busy = (tasks || []).filter(function (t) { return (t.status === 'running' || t.status === 'claimed') && mLabel(t.machine) === mLabel(m.id) }).length
                        const flag = st.level === 'risky' ? ' ⚠风险' : st.level === 'watch' ? ' !注意' : st.level === 'unknown' ? ' ?未知' : ''
                        return mLabel(m.id) + (m.online ? ' ✓' : ' ✗') + (busy ? (' 在跑' + busy) : '') + flag
                      }).join(' · '))
                  : null,
                machineRisk
                  ? h('span', { style: { fontSize: 'calc(var(--dsb-fs) - 4px)', color: 'var(--dsb-bad)' } }, '有机器稳定性风险，已展开')
                  : null,
                h('span', { style: { marginLeft: 'auto' } }),
                h('button', {
                  className: 'dsb-btn',
                  style: { padding: '1px 8px', fontSize: 'calc(var(--dsb-fs) - 4px)' },
                  onClick: function () {
                    const v = !machinesCollapsed
                    setMachinesCollapsed(v)
                    try { window.localStorage.setItem('dsh-board-machines-collapsed', v ? '1' : '0') } catch (e) {}
                  },
                }, mCollapsed ? '展开机器卡' : '收起机器卡'),
              ),
              mCollapsed ? null : h(
              'div',
              { className: 'dsb-mach-grid', style: { display: 'flex', flexWrap: 'wrap', gap: 10, maxHeight: 'min(46vh, 340px)', overflowY: 'auto' } },
              machines.map((m) => {
                const caps = m.caps
                const live = m.live
                const bar = (pct, color) =>
                  h(
                    'div',
                    { style: { height: 5, background: 'var(--dsb-bg2)', borderRadius: 3, overflow: 'hidden', marginTop: 3 } },
                    h('div', {
                      style: { width: Math.max(0, Math.min(100, pct || 0)) + '%', height: '100%', background: color },
                    }),
                  )
                const rows = []
                if (live) {
                  rows.push(
                    h(
                      'div',
                      { key: 'mem', style: { fontSize: 'calc(var(--dsb-fs) - 2px)', opacity: 0.9, marginTop: 2 } },
                      '内存 ' + live.memUsedGB + '/' + live.memTotalGB + 'G',
                      h('span', { style: { opacity: 0.6, marginLeft: 6 } }, live.memPct + '%'),
                    ),
                  )
                  rows.push(bar(live.memPct, live.memPct > 85 ? 'var(--dsb-bad)' : live.memPct > 65 ? 'var(--dsb-warn)' : 'var(--dsb-ok)'))
                  rows.push(
                    h(
                      'div',
                      { key: 'cpu', style: { fontSize: 'calc(var(--dsb-fs) - 2px)', opacity: 0.9, marginTop: 7 } },
                      'CPU',
                      h(
                        'span',
                        { style: { opacity: 0.6, marginLeft: 6 } },
                        live.cpuPct >= 0 ? live.cpuPct + '%' : '测量中…',
                      ),
                      live.cores ? h('span', { style: { opacity: 0.45, marginLeft: 6 } }, live.cores + ' 核') : null,
                    ),
                  )
                  rows.push(
                    bar(
                      live.cpuPct >= 0 ? live.cpuPct : 0,
                      live.cpuPct > 85 ? 'var(--dsb-bad)' : live.cpuPct > 60 ? 'var(--dsb-warn)' : 'var(--dsb-accent)',
                    ),
                  )
                  rows.push(
                    h(
                      'div',
                      { key: 'disk', style: { fontSize: 'calc(var(--dsb-fs) - 2px)', opacity: 0.9, marginTop: 7 } },
                      '磁盘余 ' + live.freeDiskGB + 'G',
                      live.diskPct ? h('span', { style: { opacity: 0.6, marginLeft: 6 } }, '已用 ' + live.diskPct + '%') : null,
                    ),
                  )
                  rows.push(bar(live.diskPct || 0, 'var(--dsb-fg2)'))
                  rows.push(
                    h(
                      'div',
                      { key: 'meta', style: { marginTop: 7, opacity: 0.5, fontSize: 'calc(var(--dsb-fs) - 3px)' } },
                      '开机 ' + live.uptimeH + 'h · ' +
                        (m.liveAt ? ago(Math.max(0, Math.round(Date.now() / 1000 - m.liveAt))) + '前更新' : ''),
                    ),
                  )
                } else {
                  rows.push(
                    h(
                      'div',
                      { key: 'none', style: { opacity: 0.6, fontSize: 'calc(var(--dsb-fs) - 2px)', marginTop: 6, lineHeight: 1.6 } },
                      caps ? '等待实时指标（该机重启 DSH 后开始上报）' : '还没做工作能力评估',
                    ),
                  )
                }
                if (caps && Number(caps.schema) >= 2) {
                  const idn = caps.identity || {}
                  const g0 = (caps.gpu || [])[0] || {}
                  const encArr = ((caps.tools || {}).ffmpeg || {}).encoders
                  const encN = Array.isArray(encArr) ? encArr.length : 0
                  const models = (Array.isArray(caps.models) ? caps.models : []).filter(function (x) { return x && typeof x === 'object' })
                  const role = caps.roles && caps.roles[0] ? caps.roles[0].id : ''
                  const roleText = ({ primary: '主职', secondary: '副职', 'secondary-if-idle': '仅空闲', none: '不接' })[role] || ''
                  rows.push(
                    h('div', {
                      key: 'capsv2',
                      style: { marginTop: 7, fontSize: 'calc(var(--dsb-fs) - 3px)', lineHeight: 1.7, opacity: 0.82, borderTop: '1px dashed var(--dsb-bd)', paddingTop: 6 },
                    },
                      (idn.cpu ? String(idn.cpu).replace(/\s*\((R|TM)\)/g, '').replace(/\s*CPU\b/g, '').slice(0, 34) : '—') +
                      (idn.ramGB ? ' · ' + idn.ramGB + 'G' : '') +
                      (g0.name ? ' · ' + String(g0.name).replace('NVIDIA GeForce ', '') : ''),
                    ),
                    h('div', {
                      key: 'capsv2b',
                      style: { marginTop: 3, fontSize: 'calc(var(--dsb-fs) - 3px)', lineHeight: 1.7, opacity: 0.72 },
                    },
                      (Array.isArray(encArr) ? (encN + ' 编码器') : '编码器未上报') + ' · ' + (Array.isArray(caps.models) ? models.length + ' 个模型' : '模型未上报') +
                      (roleText ? ' · ' + roleText : '') +
                      (caps.allowUnverifiedHighRisk ? ' · 允许未验证' : ''),
                    ),
                  )
                  if (caps.stability) {
                    const st = caps.stability
                    const ev = st.events || {}
                    const lb = st.evidence && st.evidence.lastBurnIn
                    const lv = ({ good: '稳定', watch: '注意', risky: '风险', unknown: '未知（读取失败）' })[st.level] || String(st.level || '')
                    const wd = Number(st.windowDays) > 0 ? Number(st.windowDays) : 30
                    const parts = ['稳定性 ' + lv, wd + '天 TDR ' + (ev.tdr || 0), '蓝屏 ' + (ev.bugcheck || 0)]
                    if ((Number(ev.disk) || 0) + (Number(ev.ntfs) || 0) > 0) parts.push('磁盘错误 ' + ((Number(ev.disk) || 0) + (Number(ev.ntfs) || 0)))
                    if (Number(ev.kernelPower) > 0) parts.push('异常关机 ' + Number(ev.kernelPower))
                    if (Number(ev.whea) > 0) parts.push('WHEA ' + Number(ev.whea))
                    parts.push(lb ? '上次压测 ' + (lb.ok ? '通过' : '未通过') : '未压测')
                    rows.push(h('div', {
                      key: 'capsst',
                      style: { marginTop: 3, fontSize: 'calc(var(--dsb-fs) - 3px)', lineHeight: 1.7, opacity: 0.72 },
                    }, parts.join(' · ')))
                  }
                }
                const mid = mLabel(m.id)
                const busyN = tasks.filter((t) => (t.status === 'running' || t.status === 'claimed') && String(t.machine || '').toLowerCase() === String(m.id || '').toLowerCase()).length
                const mPerf = f1PerfOf(m)
                const mFit = f1Fit({ mode: 'agent', model: '' }, m, (data && data.nodeModels) || null, busyN)
                const mEtaSec = f1LookupEtaSec(data, m, 'agent', '')
                const mReasonsText = (Array.isArray(mFit.reasons) ? mFit.reasons : []).map((r) => asText(r)).filter(Boolean).join('；')
                const mFitTitle = mReasonsText + (mEtaSec === null ? '（历史样本不足）' : '')
                rows.unshift(
                  h(
                    'div',
                    {
                      key: 'f1fit',
                      className: 'dsb-fit-row',
                      title: mFitTitle,
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        marginTop: 4,
                        marginBottom: 4,
                        padding: '3px 8px',
                        borderRadius: 6,
                        background: 'var(--dsb-bg2)',
                        fontSize: 'calc(var(--dsb-fs) - 2px)',
                      },
                    },
                    h('span', null, '适配 '),
                    h('b', { style: { color: mFit.score >= 70 ? 'var(--dsb-ok)' : mFit.score >= 40 ? 'var(--dsb-warn)' : 'var(--dsb-fg2)' } }, String(mFit.score)),
                    h('span', { style: { opacity: 0.85 } }, ' · ' + fmtEta(mEtaSec)),
                  ),
                  h(
                    'div',
                    {
                      key: 'f1perf',
                      className: 'dsb-perf-row',
                      style: { fontSize: 'calc(var(--dsb-fs) - 3px)', opacity: 0.78, lineHeight: 1.5, marginBottom: 4 },
                    },
                    'CPU ' + (mPerf.cores !== null ? (mPerf.cores + '核') : '未知') +
                      ' · 内存余 ' + (mPerf.memFreeGb !== null ? (mPerf.memFreeGb + 'G') : '未知') +
                      ' · 磁盘余 ' + (mPerf.diskFreeGb !== null ? (mPerf.diskFreeGb + 'G') : '未知') +
                      ' · GPU ' + (mPerf.gpu ? String(mPerf.gpu).replace(/^NVIDIA GeForce\s+/i, '') : '未知') +
                      ' · 模型 ' + (mPerf.models !== null ? String(mPerf.models) : '未知'),
                  ),
                )
                return h(
                  'div',
                  {
                    key: m.id,
                    className: 'dsb-mach',
                    style: {
                      minWidth: 208,
                      flex: '1 1 208px',
                      border: '1px solid ' + (m.online ? 'var(--dsb-bd)' : 'var(--dsb-bg2)'),
                      borderRadius: 10,
                      padding: '10px 12px 12px',
                      background: m.online ? 'rgba(255,255,255,0.025)' : 'transparent',
                      opacity: m.online ? 1 : 0.5,
                    },
                  },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 } },
                    h('span', { className: 'dsb-dot ' + (m.online ? 'on' : 'off') }, m.online ? '\u2713' : '\u2717'),
                    h('b', { style: { fontSize: 'calc(var(--dsb-fs) + 1px)' } }, mid),
                    caps && caps.os
                      ? h('span', { style: { opacity: 0.5, fontSize: 'calc(var(--dsb-fs) - 3px)' } }, String(caps.os).replace('Windows ', 'Win'))
                      : null,
                    busyN
                      ? h(
                          'span',
                          { style: { marginLeft: 'auto', color: 'var(--dsb-warn)', fontSize: 'calc(var(--dsb-fs) - 3px)' } },
                          '在跑 ' + busyN,
                        )
                      : null,
                  ),
                  rows,
                  h(
                    'div',
                    { style: { display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' } },
                    h('button', {
                      className: 'dsb-btn',
                      style: { fontSize: 'calc(var(--dsb-fs) - 3px)', padding: '1px 8px' },
                      onClick: () => {
                        if (String(m.id) === String((ident && ident.machine) || '')) {
                          setAliasDraft((mid && mid !== m.id) ? mid : '')
                          setRenaming(true)
                          setCardRenameId('')
                          return
                        }
                        if (cardRenameId === String(m.id)) { setCardRenameId(''); return }
                        setCardRenameId(String(m.id))
                        setCardRenameDraft((m.name && m.name !== m.id) ? String(m.name) : '')
                      },
                    }, '改名'),
                    h('button', {
                      className: 'dsb-btn',
                      style: { fontSize: 'calc(var(--dsb-fs) - 3px)', padding: '1px 8px' },
                      onClick: () => setMachineDetail(String(m.id)),
                    }, '详情'),
                    String(m.id).toLowerCase() === String((ident && ident.machine) || '').toLowerCase()
                      ? h('button', {
                          className: 'dsb-btn',
                          style: { fontSize: 'calc(var(--dsb-fs) - 3px)', padding: '1px 8px' },
                          disabled: !!capsBusy,
                          onClick: () => runCapsProbe(String(m.id)),
                        }, capsBusy === String(m.id) ? '自检中…' : '配置自检')
                      : null,
                    !m.online
                      ? h('button', {
                          className: 'dsb-btn danger',
                          style: { fontSize: 'calc(var(--dsb-fs) - 3px)', padding: '1px 8px' },
                          disabled: !!cardBusy[String(m.id)], onClick: () => forgetMachine(String(m.id)),
                        }, '移除')
                      : null,
                  ),
                  // v2.7.21：升级/重启从底部小按钮行里拿出来，单独一行、加大点击区域。
                  String(m.id).toLowerCase() !== String((ident && ident.machine) || '').toLowerCase() && m.online
                    ? h(
                        'div',
                        { style: { display: 'flex', gap: 8, marginTop: 10 } },
                        h('button', {
                          className: 'dsb-btn primary',
                          style: { flex: '1 1 auto', minHeight: 30, padding: '6px 12px', fontSize: 'calc(var(--dsb-fs) - 1px)', fontWeight: 600 },
                          disabled: !!nodeBusy[String(m.id)],
                          title: '把共享盘里最新的 wfcj-dsh-job-board-*.tgz 装到这台副机（停 DSH → 装 → 拉起；装完会告诉你要不要手动重启）',
                          onClick: () => nodeOp('node-upgrade', String(m.id)),
                        }, nodeBusy[String(m.id)] === 'node-upgrade' ? '派发中…（约 20 秒）' : '安装更新'),
                        h('button', {
                          className: 'dsb-btn warn',
                          style: { flex: '0 0 auto', minHeight: 30, padding: '6px 12px', fontSize: 'calc(var(--dsb-fs) - 1px)', fontWeight: 600 },
                          disabled: !!nodeBusy[String(m.id)],
                          title: '远程重启这台副机的 DSH；完成后会显示实例号变化，确认这次是真重启',
                          onClick: () => nodeOp('node-restart', String(m.id)),
                        }, nodeBusy[String(m.id)] === 'node-restart' ? '重启中…' : '重启 DSH'),
                      )
                    : null,
                  nodeMsg[String(m.id)]
                    ? h('div', {
                        className: 'dsb-note',
                        style: {
                          marginTop: 6, fontSize: 'calc(var(--dsb-fs) - 2px)', lineHeight: 1.45,
                          padding: '6px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.04)',
                          whiteSpace: 'normal', wordBreak: 'break-word',
                        },
                      }, nodeMsg[String(m.id)])
                    : null,
                  cardRenameId === String(m.id)
                    ? h(
                        'div',
                        { style: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' } },
                        h('input', {
                          className: 'dsb-input',
                          style: { flex: '1 1 120px', padding: '2px 6px' },
                          maxLength: 32,
                          placeholder: '显示名（留空=电脑名）',
                          value: cardRenameDraft,
                          onChange: (e) => setCardRenameDraft(e.target.value),
                          onKeyDown: (e) => {
                            if (e.key === 'Enter') { e.preventDefault(); saveMachineAlias(String(m.id)) }
                            else if (e.key === 'Escape') { setCardRenameId(''); setCardRenameDraft('') }
                          },
                        }),
                        h('button', { className: 'dsb-btn', disabled: !!cardBusy[String(m.id)], onClick: () => saveMachineAlias(String(m.id)) }, '保存'),
                      )
                    : null,
                )
              }),
            )
            )
          : null,
        // v2.6.29（U-4）：本机 worker 小卡。enabled=false（workerMode=off / 未初始化）时整卡不渲染。
        workerOn
          ? h(
              'div',
              {
                className: 'dsb-worker-card',
                style: { marginBottom: 12, border: '1px solid var(--dsb-bd)', borderRadius: 10, padding: '8px 12px', background: 'var(--dsb-bg1)' },
              },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('b', { style: { fontSize: 'calc(var(--dsb-fs) - 2px)' } }, 'worker'),
                h('span', { className: 'dsb-tag ' + (workerSt.running ? 'st-ok' : 'st-q') },
                  (workerSt.mode || workerStat.workerMode || '?') + (workerSt.running ? ' · 运行中' : ' · 未运行')),
                h('span', { style: { marginLeft: 'auto' } }),
                h('button', {
                  className: 'dsb-btn dsb-worker-drain',
                  disabled: !!workerBusy,
                  onClick: () => workerControl('drain'),
                }, workerBusy === 'drain' ? 'drain…' : 'drain'),
                h('button', {
                  className: 'dsb-btn dsb-worker-resume',
                  disabled: !!workerBusy,
                  onClick: () => workerControl('resume'),
                }, workerBusy === 'resume' ? 'resume…' : 'resume'),
              ),
              h('div', { style: { marginTop: 4, fontSize: 'calc(var(--dsb-fs) - 3px)', opacity: 0.85 } },
                '当前任务：' + (workerSt.currentTask
                  ? ((workerSt.currentTask.title || workerSt.currentTask.taskId) + '（' + workerSt.currentTask.taskId + '）')
                  : '空闲')),
              h('div', { style: { fontSize: 'calc(var(--dsb-fs) - 3px)', opacity: 0.7 } },
                '下轮轮询：' + (Number.isFinite(Number(workerSt.nextPollMs)) ? Math.max(0, Number(workerSt.nextPollMs)) + 'ms' : '—')),
              workerSt.lastError
                ? h('div', { style: { marginTop: 4, fontSize: 'calc(var(--dsb-fs) - 4px)', color: 'var(--dsb-warn)' } }, '最近错误：' + workerSt.lastError)
                : null,
              workerErr
                ? h('div', { style: { marginTop: 4, fontSize: 'calc(var(--dsb-fs) - 4px)', color: 'var(--dsb-bad)' } }, workerErr)
                : null,
            )
          : null,
        capsProbe
          ? h(
              'div',
              { style: { border: '1px solid var(--dsb-accent)', borderRadius: 10, marginBottom: 12, background: 'rgba(var(--dsb-accent-rgb),0.06)', maxHeight: 'min(80vh, 760px)', display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--dsb-bd)', flex: '0 0 auto', flexWrap: 'wrap' } },
                h('b', null, '能力自检结果 · ' + mLabel(capsProbe.machine)),
                h('span', { className: 'dsb-tag ' + ((capsProbe.caps.gaps || []).length ? 'st-q' : 'st-ok') },
                  (capsProbe.caps.gaps || []).length ? ((capsProbe.caps.gaps || []).length + ' 项待修') : '全部通过'),
                h('span', { style: { marginLeft: 'auto' } }),
                h('button', { className: 'dsb-btn', disabled: capsBusy === String(capsProbe.machine), onClick: () => runCapsProbe(String(capsProbe.machine)) }, capsBusy === String(capsProbe.machine) ? '检测中…' : '重新检测'),
              ),
              h('div', { style: { padding: '12px 16px', overflow: 'auto', flex: '1 1 auto' } },
                h('div', { style: { fontSize: 'calc(var(--dsb-fs) - 3px)', lineHeight: 1.8 } },
                  'CPU ' + ((capsProbe.caps.identity || {}).cpu || '—') + ' · ' + ((capsProbe.caps.identity || {}).ramGB || '—') + ' GB · ' +
                  'GPU ' + (((capsProbe.caps.gpu || [])[0] || {}).name || '未检测到'),
                ),
                h('div', { style: { fontSize: 'calc(var(--dsb-fs) - 3px)', lineHeight: 1.8, opacity: 0.78 } },
                  '编码器 ' + ((((capsProbe.caps.tools || {}).ffmpeg || {}).encoders || []).length) + ' 个 · ' +
                  '浏览器 ' + (((capsProbe.caps.tools || {}).browsers || []).length) + ' 个 · ' +
                  '本地模型 ' + ((capsProbe.caps.models || []).length) + ' 个',
                ),
                (capsProbe.caps.gaps || []).length
                  ? h('div', { style: { fontSize: 'calc(var(--dsb-fs) - 4px)', color: 'var(--dsb-warn)', marginTop: 4 } },
                      '待修：' + (capsProbe.caps.gaps || []).map((g) => g.tool || g.why).join('、'))
                  : null,
                (capsProbe.caps.models || []).length
                  ? h('div', { style: { marginTop: 12 } },
                      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                        h('div', { style: { fontSize: 'calc(var(--dsb-fs) - 3px)', opacity: 0.65 } }, '模型与用途 · ' + (capsProbe.caps.models || []).length + ' 个'),
                        h('span', { style: { marginLeft: 'auto' } }),
                        (capsProbe.caps.models || []).length > 3
                          ? h('button', { className: 'dsb-btn', style: { padding: '1px 8px', fontSize: 'calc(var(--dsb-fs) - 4px)' }, onClick: function () { setCapsShowAll(function (v) { return !v }) } },
                              capsShowAll ? '收起 ↑' : '展开全部 ↓')
                          : null,
                      ),
                      h('div', { style: { marginTop: 6, maxHeight: capsShowAll ? 264 : 120, overflow: capsShowAll ? 'auto' : 'hidden' } },
                        (capsProbe.caps.models || []).slice(0, capsShowAll ? 999 : 3).map(function (mm, mi) {
                          var src = mm.source === 'bench' ? '实测' : mm.source === 'declared' ? '已声明' : '按名称推测'
  return h('div', { key: 'cm' + mi, style: { display: 'grid', gridTemplateColumns: 'minmax(120px, 1.6fr) auto minmax(140px, 1fr) 72px', gap: 8, alignItems: 'center', minHeight: 32, padding: '2px 0', borderBottom: '1px dashed var(--dsb-bd)' } },
                            h('span', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: String(mm.id || '') + (mm.ctx ? ' · ctx ' + mm.ctx : '') }, String(mm.id || mm.model || '')),
                            h('span', { style: { fontSize: 'calc(var(--dsb-fs) - 5px)', opacity: mm.source === 'guessed' ? 0.6 : 0.8, whiteSpace: 'nowrap' } }, src),
                            h('input', {
                              className: 'dsb-input',
                              style: { minWidth: 0, width: '100%' },
                              placeholder: '标签，如 代码审查, 通用对话',
                              title: '逗号分隔；失焦后生效',
                              value: tagDraft[mi] !== undefined ? tagDraft[mi] : (mm.tags || []).join(', '),
                              onChange: function (e) {
                                var v = e.target.value
                                setTagDraft(function (d) { var n = Object.assign({}, d); n[mi] = v; return n })
                              },
                              onBlur: function (e) {
                                var tags = parseTags(e.target.value)
                                setTagDraft(function (d) { var n = Object.assign({}, d); n[mi] = tags.join(', '); return n })
                                setCapsProbe(function (prev) {
                                  if (!prev) return prev
                                  var caps = Object.assign({}, prev.caps)
                                  var arr = (caps.models || []).slice()
                                  arr[mi] = Object.assign({}, arr[mi], { tags: tags })
                                  caps.models = arr
                                  return Object.assign({}, prev, { caps: caps })
                                })
                              },
                            }),
                            h('select', {
                              className: 'dsb-input',
                              style: { minWidth: 0, width: '100%' },
                              value: String(mm.location || ''),
                              title: '位置：本机/局域网进免费分组，云端按量计费；只能往更贵方向改',
                              onChange: function (e) {
                                var loc = e.target.value
                                setCapsProbe(function (prev) {
                                  if (!prev) return prev
                                  var caps = Object.assign({}, prev.caps)
                                  var arr = (caps.models || []).slice()
                                  arr[mi] = Object.assign({}, arr[mi], { location: loc })
                                  caps.models = arr
                                  return Object.assign({}, prev, { caps: caps })
                                })
                              },
                            },
                              h('option', { value: '' }, '未定'),
                              h('option', { value: 'local' }, '本机'),
                              h('option', { value: 'lan' }, '局域网'),
                              h('option', { value: 'cloud' }, '云端')),
                          )
                        }),
                      ),
                    )
                  : h('div', { style: { marginTop: 12, padding: '16px 0', textAlign: 'center', fontSize: 'calc(var(--dsb-fs) - 3px)', opacity: 0.55 } }, '未发现本地模型（可跳过）'),
                h('div', { style: { display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' } },
                  h('span', { style: { fontSize: 'calc(var(--dsb-fs) - 3px)', opacity: 0.6 } }, '角色'),
                  ['primary', 'secondary', 'secondary-if-idle', 'none'].map((r) =>
                    h('button', {
                      key: r,
                      className: 'dsb-btn',
                      style: { padding: '1px 8px', fontSize: 'calc(var(--dsb-fs) - 3px)', borderColor: capsProbe.role === r ? 'var(--dsb-accent)' : '', color: capsProbe.role === r ? 'var(--dsb-accent)' : '' },
                      onClick: () => setCapsProbe((p) => Object.assign({}, p, { role: r })),
                    }, ({ primary: '主职', secondary: '副职', 'secondary-if-idle': '仅空闲', none: '不接' })[r]),
                  ),
                  h('label', { style: { display: 'flex', alignItems: 'center', gap: 5, marginLeft: 8, fontSize: 'calc(var(--dsb-fs) - 3px)' } },
                    h('input', {
                      type: 'checkbox',
                      checked: !!capsProbe.allowHighRisk,
                      onChange: (e) => setCapsProbe((p) => Object.assign({}, p, { allowHighRisk: e.target.checked })),
                    }),
                    '允许高风险任务使用未验证模型',
                  ),
                ),
                ((capsProbe.caps.models || []).length > 3 && !capsShowAll)
                  ? h('div', { style: { marginTop: 8, fontSize: 'calc(var(--dsb-fs) - 4px)', opacity: 0.72 } },
                      '另有 ' + String((capsProbe.caps.models || []).length - 3) + ' 个模型未展示' +
                      (function () {
                        var hidden = (capsProbe.caps.models || []).slice(3)
                        var risky = hidden.filter(function (mm) { return mm && (mm.source === 'guessed' || mm.location === 'cloud') })
                        return risky.length ? ('（含 ' + risky.length + ' 个按名称推测/云端）') : ''
                      })() +
                      '；展开后还能调它们的标签与位置')
                  : null,
              ),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderTop: '1px solid var(--dsb-bd)', flex: '0 0 auto', flexWrap: 'wrap' } },
                h('span', { className: 'muted', style: { fontSize: 'calc(var(--dsb-fs) - 4px)' } }, '确认角色与标签后保存；保存后仍可重测'),
                h('span', { style: { marginLeft: 'auto' } }),
                h('button', { className: 'dsb-btn', disabled: capsBusy === 'apply', onClick: () => setCapsProbe(null) }, '取消'),
                h('button', { className: 'dsb-btn on', disabled: capsBusy === 'apply', style: { minWidth: 108 }, onClick: applyCaps }, capsBusy === 'apply' ? '保存中…' : '保存能力卡'),
              ),
            )
          : null,

        // __R3_TEAM__ 远程同事节点行
        h(
          'div',
          { className: 'dsb-head' },
          h(
            'span',
            { className: 'dsb-pill' },
            '远程同事 ' + (net && net.counts ? net.counts.online + '/' + net.counts.nodes : '—'),
          ),
          ((net && net.nodes) || []).map((n) => {
            // 这里以前直接打 nodeId（desktop-2gh05s7），用户认不出是谁；nodeMap 折成别名。
            const nid = String((n && n.nodeId) || '')
            const alias = mLabel(nid) || nid
            return h(
              'span',
              {
                key: 'n-' + nid,
                className: 'dsb-pill' + (n.online ? '' : ' off'),
                // nodeId 只留在 title 里，方便排查时对号；可见文字永远只有别名
                title: alias + (alias !== nid ? '（节点 ' + nid + '）' : '') + (n.online ? ' · 在线' : ' · 离线'),
              },
              h('span', { className: 'dsb-dot ' + (n.online ? 'on' : 'off') }, n.online ? '✓' : '✗'),
              alias,
            )
          }),
          netErr ? h('span', { className: 'dsb-tag' }, netErr) : null,
        ),
        // __R3_TEAM__ 一句话派工
        h(
          'div',
          { className: 'dsb-filt' },
          h('input', {
            className: 'dsb-input',
            style: { flex: '1 1 320px' },
            placeholder: '一句话派工：写清目标，回车或点「派工」选机器',
            value: goal,
            onChange: (e) => setGoal(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter' && goal.trim() !== '') openDispatchModal() },
          }),
          h('button', { className: 'dsb-btn', disabled: goal.trim() === '', onClick: openDispatchModal }, '派工'),
        ),
        h(
          'div',
          { className: 'dsb-filt' },
          filtBtn('active', '未完成', activeList.length),
          filtBtn('done', '已完成', doneList.length),
          filtBtn('all', '全部', tasks.length),
          filtBtn('bad', '打回', badList.length),
          h('input', {
            className: 'dsb-input',
            placeholder: '搜标题 / 备注 / 机器',
            value: q,
            onChange: (e) => setQ(e.target.value),
          }),
          // 清理入口：只对历史态任务开口子，running 永远不会被算进 cleanList
          h(
            'button',
            {
              className: 'dsb-btn danger',
              disabled: cleanList.length === 0,
              title: cleanList.length
                ? '把 ' + cleanList.length + ' 条未完成的历史任务归档（' +
                  (cleanClaimed ? cleanClaimed + ' 条已被认领，会先退占位；' : '') +
                  'running 不会被处理）'
                : '没有需要清理的历史任务',
              onClick: openClean,
            },
            cleanList.length ? '清理 ' + cleanList.length : '清理',
          ),
        ),
        error ? h('div', { className: 'dsb-err' }, asText(error)) : null,
        filter === 'done' && doneGap
          ? h(
              'div',
              { className: 'dsb-trunc' },
              '板子共有 ' +
                doneTotal +
                ' 条已完成任务，面板这次只收到 ' +
                doneList.length +
                ' 条（宿主侧插件按 60 条截断，重载插件后显示全部）。',
            )
          : null,
        h(
          'div',
          { className: 'dsb-main' },
          filtered.length
            ? filtered.map((t) =>
                h(
                  'div',
                  { key: t.id, className: 'dsb-row' + (t.status === 'done' ? ' is-done' : '') },
                  h('div', { className: 'dsb-id dsb-col-id' }, t.id.replace(/^ui-/, '')),
                  h(
                    'div',
                    { className: 'dsb-body' },
                    h(
                      'div',
                      { className: 'dsb-line1' },
                      h(
                        'span',
                        { className: 'dsb-name', style: { cursor: 'pointer' }, onClick: () => { setArtText(''); setNoteText(''); setOpenId(openId === t.id ? '' : t.id) } },
                        (openId === t.id ? '▾ ' : '▸ ') + (t.title || '(无标题)'),
                      ),
                      h('span', { className: 'dsb-tag ' + (STATUS_TONE[t.status] || '') }, STATUS_LABEL[t.status] || t.status),
                      // 机器一律显示别名（MB14 / GT14），原始 nodeId 只在悬停时露出来
                      t.machine
                        ? h(
                            'span',
                            {
                              className: 'dsb-tag dsb-machine',
                              title: mLabel(t.machine) !== t.machine ? '节点 ' + t.machine : undefined,
                            },
                            mLabel(t.machine),
                          )
                        : null,
                      h(
                        'span',
                        {
                          className: 'dsb-tag time',
                          title: t.updatedAt ? new Date(t.updatedAt * 1000).toLocaleString() : undefined,
                        },
                        (t.status === 'done' ? '完成于 ' : '更新 ') + (t.updated || '—'),
                      ),
                    ),
                    t.note
                ? h(
                  'div',
                  { className: 'dsb-note', title: asText(t.note) },
                  failureHint(t.note) ? '诊断：' + failureHint(t.note) + '（悬停看原始 reason）' : asText(t.note),
                )
                : null,
                    openId === t.id
                      ? h(
                          'div',
                          { className: 'dsb-detail' },
                          h('div', { className: 'dsb-kv' }, `状态 ${STATUS_LABEL[t.status] || t.status} · 机器 ${t.machine ? mLabel(t.machine) : '未指派'}${t.model ? ' · 模型 ' + t.model : ''}${['failed','blocked','superseded'].indexOf(t.status) >= 0 ? ' · 可重派' : ''} · ${t.status === 'done' ? '完成' : '更新'} ${t.updated || '—'}`),
                          t.result && typeof t.result === 'object'
                            ? h('div', { className: 'dsb-kv', style: { color: t.result.ok === true ? 'var(--dsb-ok)' : 'var(--dsb-warn)' } },
                                '结果：' + (t.result.ok === true ? '通过' : '不符') +
                                (t.result.expected !== undefined ? (' · ' + String(t.result.actual === undefined ? '?' : t.result.actual) + '/' + String(t.result.expected)) : '') +
                                (Array.isArray(t.result.reasons) && t.result.reasons.length ? (' · ' + t.result.reasons.join('；')) : ''))
                            : null,
                          t.mode ? h('div', { className: 'dsb-kv' }, '模式：' + t.mode + (t.dispatch ? ' · ' + t.dispatch : '')) : null,
                          t.remote ? h('div', { className: 'dsb-kv' }, '远端任务：' + t.remote) : null,
                          (t.taker || t.holder) ? h('div', { className: 'dsb-kv' }, '占位：' + [t.taker, t.holder].filter(Boolean).join(' / ')) : null,
                          t.goal ? h('div', { className: 'dsb-kv', style: { whiteSpace: 'pre-wrap' } }, '目标：' + t.goal) : null,
                          t.progress ? h('div', { className: 'dsb-kv' }, '进度：' + t.progress) : null,
                          h('div', { className: 'dsb-kv' },
                            '产物：' + (t.artifact || '（无）'),
                            t.artifact ? h('button', { className: 'dsb-btn', style: { marginLeft: 8 }, onClick: function () {
                              try { navigator.clipboard.writeText(t.artifact).then(function () { setNotice('已复制产物路径') }, function (e) { setNotice('复制失败：' + ((e && e.message) || '浏览器拒绝')) }) } catch (e) { setNotice('复制失败：' + ((e && e.message) || '浏览器拒绝')) }
                            } }, '复制路径') : null,
                          ),
                          (t.status === 'failed' || t.status === 'blocked') && failureHint(t.note)
                            ? h('div', { className: 'dsb-kv', style: { color: 'var(--dsb-warn)' } }, '诊断：' + failureHint(t.note))
                            : null,
                          h('div', { className: 'dsb-line1' },
                            h('button', { className: 'dsb-btn', onClick: () => {
                              const txt = JSON.stringify(t, null, 2)
                              const fallback = function () {
                                const ta = document.createElement('textarea')
                                ta.value = txt
                                ta.style.position = 'fixed'
                                ta.style.opacity = '0'
                                document.body.appendChild(ta)
                                ta.select()
                                let ok = false
                                try { ok = document.execCommand('copy') } catch (e) { ok = false }
                                document.body.removeChild(ta)
                                return ok
                              }
                              const done = function () { setNotice('已复制任务 ' + t.id + ' 的详情（快照，字段可能截断）') }
                              const fail = function (msg) { setNotice('复制失败：' + msg + '（可选中详情文本手动复制）') }
                              try {
                                if (navigator.clipboard && navigator.clipboard.writeText) {
                                  navigator.clipboard.writeText(txt).then(done, function (e) { fail((e && e.message) || '浏览器拒绝') })
                                } else if (fallback()) { done() } else { fail('浏览器不允许访问剪贴板') }
                              } catch (e) { fail((e && e.message) || '浏览器拒绝') }
                            } }, '复制 JSON'),
                          ),
                          h('div', { className: 'dsb-line1' },
                            h('input', { className: 'dsb-input', placeholder: '产物路径（可空）', value: artText, onChange: (e) => setArtText(e.target.value) }),
                            h('input', { className: 'dsb-input', placeholder: '交付/打回备注（可空）', value: noteText, onChange: (e) => setNoteText(e.target.value) }),
                          ),
                          h('div', { className: 'dsb-acts' },
                            ['failed', 'blocked', 'superseded'].includes(t.status)
                              ? h('button', { className: 'dsb-btn', disabled: busy === t.id + ':retry', onClick: () => act('retry', t) }, '重派')
                              : null,
                            h('button', { className: 'dsb-btn', disabled: busy === t.id + ':done' || ['done', 'blocked', 'superseded', 'failed'].includes(t.status), title: t.status === 'failed' ? '失败任务请先重派' : (['done', 'blocked', 'superseded'].includes(t.status) ? '终态任务不能再交付' : ''), onClick: () => act('done', t, { artifact: artText, note: noteText }) }, '交付（带产物）'),
                            h('button', { className: 'dsb-btn', disabled: busy === t.id + ':blocked' || ['done', 'blocked', 'superseded', 'failed'].includes(t.status), title: t.status === 'failed' ? '失败任务请先重派' : (['done', 'blocked', 'superseded'].includes(t.status) ? '终态任务不能再打回' : ''), onClick: () => act('blocked', t, { note: noteText }) }, '打回并留原因'),
                          ),
                        )
                      : null,
                  ),
                  h(
                    'div',
                    { className: 'dsb-acts' },
                    t.claimable
                      ? h(
                          'button',
                          { className: 'dsb-btn', disabled: busy === t.id + ':claim', onClick: () => act('claim', t) },
                          '认领',
                        )
                      : null,
                    t.status !== 'done' && t.status !== 'superseded' && t.status !== 'failed' && t.status !== 'blocked'
                      ? h(
                          'button',
                          { className: 'dsb-btn', disabled: busy === t.id + ':done', onClick: () => act('done', t) },
                          '完成',
                        )
                      : null,
                    t.status !== 'done' && t.status !== 'blocked' && t.status !== 'superseded'
                      ? h(
                          'button',
                          { className: 'dsb-btn', disabled: busy === t.id + ':blocked', onClick: () => act('blocked', t) },
                          '打回',
                        )
                      : null,
                  ),
                ),
              )
            : h('div', { className: 'dsb-empty' }, emptyText),
        ),
        // 清理确认：先把将发生的事讲清楚（清几条、按状态分布、running 不碰），再动手
        cleanOpen
          ? (function () {
              const byStatus = {}
              for (const t of cleanList) byStatus[t.status] = (byStatus[t.status] || 0) + 1
              const breakdown = CLEANABLE.filter((s) => byStatus[s])
                .map((s) => (STATUS_LABEL[s] || s) + ' ' + byStatus[s])
                .join(' · ')
              const pct = cleanProg.n ? Math.round((cleanProg.i / cleanProg.n) * 100) : 0
              const preview = cleanList.slice(0, 40)
              return h(
                'div',
                {
                  className: 'dsb-modal',
                  onMouseDown: (e) => {
                    if (!cleanBusy && e.target === e.currentTarget) closeClean()
                  },
                },
                h(
                  'div',
                  { className: 'dsb-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': '清理未完成的历史任务' },
                  h('h3', {}, '清理未完成的历史任务'),
                  h(
                    'p',
                    {},
                    cleanLoading
                      ? '正在拉取最新任务状态…'
                      : cleanList.length
                        ? '将要清理 ' + cleanList.length + ' 条（' + breakdown + '）。' +
                          (cleanClaimed ? '其中 ' + cleanClaimed + ' 条已被认领，会先退占位再归档；' : '') +
                          'running 任务不会被处理。'
                        : '当前没有可清理的历史任务。',
                  ),
                  h(
                    'div',
                    { className: 'dsb-warn' },
                    '清理 = 归档为「被取代」，板子不支持物理删除：任务会离开「未完成」视图，记录仍可在「全部」里查到。' +
                      (archivedN ? '另有 ' + archivedN + ' 条已归档任务无需处理。' : ''),
                  ),
                  preview.length
                    ? h(
                        'div',
                        { className: 'dsb-list' },
                        preview.map((t) =>
                          h(
                            'div',
                            { key: t.id, className: 'dsb-lrow' },
                            h('span', { className: 'i' }, t.id.replace(/^ui-/, '')),
                            h('span', { className: 't', title: t.title || '' }, t.title || '(无标题)'),
                            h(
                              'span',
                              { className: 's' },
                              (STATUS_LABEL[t.status] || t.status) +
                                ' · ' +
                                (t.machine ? mLabel(t.machine) : '未指派') +
                                (t.status === 'queued' && t.taker ? ' · 被 ' + mLabel(t.taker) + ' 认领' : ''),
                            ),
                          ),
                        ),
                        cleanList.length > preview.length
                          ? h(
                              'div',
                              { className: 'dsb-lrow' },
                              h('span', { className: 'muted' }, '… 还有 ' + (cleanList.length - preview.length) + ' 条'),
                            )
                          : null,
                      )
                    : null,
                  h('input', {
                    className: 'dsb-input',
                    placeholder: '清理备注（默认：' + CLEAN_NOTE + '）',
                    value: cleanNote,
                    disabled: cleanBusy,
                    onChange: (e) => setCleanNote(e.target.value),
                  }),
                  cleanBusy
                    ? h(
                        'div',
                        {},
                        h('div', { className: 'dsb-bar' }, h('i', { style: { width: pct + '%' } })),
                        h(
                          'div',
                          { className: 'muted', style: { fontSize: 'calc(var(--dsb-fs) - 3px)', marginTop: 4 } },
                          '正在清理 ' + cleanProg.i + ' / ' + cleanProg.n,
                        ),
                      )
                    : null,
                  cleanRes
                    ? h(
                        'div',
                        {},
                        h(
                          'div',
                          { className: cleanRes.failed.length ? 'dsb-fail' : 'dsb-ok' },
                          '成功 ' + cleanRes.ok + ' 条' +
                            (cleanRes.skipped.length ? '，跳过 ' + cleanRes.skipped.length + ' 条（被认领/正在跑）' : '') +
                            (cleanRes.failed.length ? '，失败 ' + cleanRes.failed.length + ' 条' : ''),
                        ),
                        cleanRes.skipped.length
                          ? h(
                              'div',
                              { className: 'dsb-skip' },
                              '已跳过 ' + cleanRes.skipped.length + ' 条（被认领/正在跑），这些任务原样保留，稍后可再清理：',
                            )
                          : null,
                        cleanRes.skipped.length
                          ? h(
                              'div',
                              { className: 'dsb-list', style: { maxHeight: 120 } },
                              cleanRes.skipped.slice(0, 20).map((s) =>
                                h(
                                  'div',
                                  { key: 's-' + s.id, className: 'dsb-lrow' },
                                  h('span', { className: 'i' }, s.id.replace(/^ui-/, '')),
                                  h('span', { className: 't', title: asText(s.why) }, asText(s.why)),
                                ),
                              ),
                            )
                          : null,
                        cleanRes.failed.length
                          ? h('div', { className: 'dsb-fail' }, '失败 ' + cleanRes.failed.length + ' 条（可重试）：')
                          : null,
                        cleanRes.failed.length
                          ? h(
                              'div',
                              { className: 'dsb-list', style: { maxHeight: 120 } },
                              cleanRes.failed.slice(0, 20).map((f) =>
                                h(
                                  'div',
                                  { key: 'f-' + f.id, className: 'dsb-lrow' },
                                  h('span', { className: 'i' }, f.id.replace(/^ui-/, '')),
                                  h('span', { className: 't', title: asText(f.error) }, asText(f.error)),
                                ),
                              ),
                            )
                          : null,
                      )
                    : null,
                  h(
                    'div',
                    { className: 'dsb-acts end' },
                    h('button', { className: 'dsb-btn', disabled: cleanBusy, onClick: closeClean }, '取消'),
                    h(
                      'button',
                      {
                        className: 'dsb-btn danger',
                        disabled: cleanBusy || cleanLoading || cleanList.length === 0,
                        onClick: runCleanup,
                      },
                      cleanBusy ? '清理中…' : '确认清理 ' + cleanList.length + ' 条',
                    ),
                  ),
                ),
              )
            })()
          : null,
        machineDetail
          ? (function () {
              const mm = machines.find((x) => String(x.id) === String(machineDetail))
              if (!mm) return null
              const caps = mm.caps || {}
              const idn = caps.identity || {}
              const encsRaw = (((caps.tools || {}).ffmpeg || {}).encoders)
              const encs = Array.isArray(encsRaw) ? encsRaw : []
              const models = Array.isArray(caps.models) ? caps.models : []
              const st = caps.stability || {}
              const ev = st.events || {}
              const lb = st.evidence && st.evidence.lastBurnIn
              return h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 } },
                h('div', { style: { background: 'var(--dsb-bg)', border: '1px solid var(--dsb-bd)', borderRadius: 10, padding: 16, width: 'min(720px, 94vw)', maxHeight: '86vh', overflow: 'auto' } },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' } },
                    h('b', { style: { fontSize: 'calc(var(--dsb-fs) + 2px)' } }, mLabel(mm.id)),
                    h('span', { style: { opacity: 0.6, fontSize: 'calc(var(--dsb-fs) - 3px)' } }, String(idn.cpu || '')),
                    h('span', { style: { marginLeft: 'auto' } }),
                    h('button', { className: 'dsb-btn', onClick: () => setMachineDetail(null) }, '关闭')),
                  h('div', { style: { fontSize: 'calc(var(--dsb-fs) - 2px)', lineHeight: 1.8 } },
                    ([
                      idn.ramGB ? ('内存 ' + idn.ramGB + 'G') : '',
                      (((caps.gpu || [])[0] || {}).name) ? ('GPU ' + String(((caps.gpu || [])[0] || {}).name)) : '',
                      caps.os ? String(caps.os) : '',
                    ].filter(Boolean).join(' · ') || '未上报硬件')),
                  h('div', { style: { marginTop: 10 } },
                    h('div', { style: { fontSize: 'calc(var(--dsb-fs) - 3px)', opacity: 0.6 } }, '编码器 · ' + encs.length + ' 个'),
                    h('div', { style: { fontSize: 'calc(var(--dsb-fs) - 4px)', lineHeight: 1.7, wordBreak: 'break-all' } }, encs.length ? encs.join(' · ') : '未上报')),
                  h('div', { style: { marginTop: 10 } },
                    h('div', { style: { fontSize: 'calc(var(--dsb-fs) - 3px)', opacity: 0.6 } }, '模型 · ' + models.length + ' 个'),
                    models.length
                      ? h('div', null, models.map((x, i) => h('div', { key: 'dm' + i, style: { display: 'grid', gridTemplateColumns: 'minmax(140px, 1.4fr) auto minmax(80px, 1fr)', gap: 8, padding: '3px 0', borderBottom: '1px dashed var(--dsb-bd)', fontSize: 'calc(var(--dsb-fs) - 3px)' } },
                          h('span', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: String(x.id || '') }, String(x.id || x.model || '')),
                          h('span', { style: { opacity: 0.7 } }, (x.source === 'bench' ? '实测' : x.source === 'declared' ? '已声明' : '推测') + (x.location ? (' · ' + x.location) : '')),
                          h('span', { style: { opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: (Array.isArray(x.tags) ? x.tags : []).join(', ') }, (Array.isArray(x.tags) ? x.tags : []).join(', ') || '—'))))
                      : h('div', { style: { opacity: 0.6, fontSize: 'calc(var(--dsb-fs) - 3px)' } }, '未上报')),
                  st.level
                    ? h('div', { style: { marginTop: 10, fontSize: 'calc(var(--dsb-fs) - 3px)', lineHeight: 1.8 } },
                        '稳定性 ' + (({ good: '稳定', watch: '注意', risky: '风险', unknown: '未知' })[st.level] || st.level) +
                        ' · ' + (Number(st.windowDays) || 30) + ' 天 TDR ' + (ev.tdr || 0) + ' · 蓝屏 ' + (ev.bugcheck || 0) +
                        (ev.whea ? (' · WHEA ' + ev.whea) : '') +
                        ' · ' + (lb ? ('上次压测 ' + (lb.ok ? '通过' : '未通过') + (lb.maxTempC ? (' · ' + lb.maxTempC + '°C') : '')) : '未压测'))
                    : null,
                ))
            })()
          : null,
        ask
          ? h(
              'div',
              {
                style: {
                  position: 'fixed',
                  inset: 0,
                  background: 'rgba(0,0,0,0.55)',
                  zIndex: 9999,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                },
              },
              h(
                'div',
                {
                  style: {
                    background: 'var(--dsb-bg)',
                    border: '1px solid var(--dsb-bd)',
                    borderRadius: 10,
                    padding: 18,
                    minWidth: 360,
                    maxWidth: 560,
                  },
                },
                h('div', { style: { fontSize: 'calc(var(--dsb-fs) + 2px)', fontWeight: 600, marginBottom: 6, color: 'var(--dsb-fg)' } }, '派给谁？'),
                h('div', { style: { color: 'var(--dsb-fg2)', marginBottom: 4, lineHeight: 1.6 } }, goal.trim().slice(0, 160)),
                h(
                  'div',
                  { style: { color: 'var(--dsb-fg2)', marginBottom: 14, fontSize: 'calc(var(--dsb-fs) - 1px)' } },
                  '点一张卡片选定；不选就是让主机自动挑最闲的那台。',
                ),
                (function () {
                  const load = {}
                  for (const t of tasks) {
                    // 按别名计数：任务里的 machine 可能是 gt14 / GT14 / nodeId，同一台机器只算一次
                    if (t.status === 'running' && t.machine) {
                      const k = String(t.machine || '').toLowerCase()
                      load[k] = (load[k] || 0) + 1
                    }
                  }
                  // 复核 #3 的界面侧：hub 的节点号（desktop-2gh05s7）和板子的机器名
                  // （MB14）是同一台机器，以前会画成两张卡。这里按 summary 给的
                  // nodeMap 归一，同一台机器只出一张卡，标题用板子上的名字。
                  const nodeMap = (data && data.nodeMap) || {}
                  const low = (x) => String(x || '').toLowerCase()
                  const byKey = new Map()
                  const slot = (key, label) => {
                    if (!byKey.has(key)) byKey.set(key, { key, label, m: null, nodeIds: [] })
                    const e = byKey.get(key)
                    if (label && e.label === key) e.label = label
                    return e
                  }
                  for (const m of machines) {
                    const alias = String((m.caps && m.caps.machine) || m.id || '')
                    if (!alias || low(alias) === 'host') continue
                    const e = slot(low(alias), alias)
                    e.m = m
                  }
                  for (const n of (net && net.nodes) || []) {
                    const nid = String(n.nodeId || '')
                    if (!nid || low(nid) === 'host') continue
                    const alias = String(nodeMap[nid] || nid)
                    const e = slot(low(alias), alias)
                    e.nodeIds.push(nid)
                    if (n.online === false) e.hubOffline = true
                  }
                  const nmForFit = (data && data.nodeModels) || null
                  const cards = [...byKey.values()].map((e) => {
                    const m = e.m
                    const caps = (m && m.caps) || null
                    const f = (caps && caps.features) || {}
                    const on = m ? !!m.online : !e.hubOffline
                    // 卡片标题也统一走别名表（GT14 而不是 gt14），key 保持归一后的值用于在跑计数
                    // v2.1.0 复审（阻断）：卡片的值必须是身份 id。显示名只用于展示 ——
                    // 把别名当 id 传给 /create，调度器 pickNode 认不出，任务会永远 queued。
                    const id = (m && m.id) ? String(m.id) : String((e.nodeIds || [])[0] || e.label)
                    const label = mLabel(id) || id
                    const busyN = load[id.toLowerCase()] || 0
                    const fitRes = f1Fit({ mode: taskMode, model }, m || { id, online: on, busy: busyN }, nmForFit, busyN)
                    const etaSec = f1LookupEtaSec(data, m || { id }, taskMode, model)
                    return { id, label, key: id.toLowerCase(), on, caps, f, busyN, last: (m && m.lastSeen) || '', nodeIds: e.nodeIds, fit: fitRes, etaSec }
                  })
                  cards.sort((a, b) => (b.on ? 1 : 0) - (a.on ? 1 : 0) || b.fit.score - a.fit.score || a.busyN - b.busyN || String(a.id).toLowerCase().localeCompare(String(b.id).toLowerCase()))
                  const best = cards.find((c) => c.on && c.fit.score > 0) || cards.find((c) => c.on) || null
                  const CARD_BASE = {
                    borderRadius: 8,
                    padding: '10px 12px',
                    marginBottom: 8,
                    cursor: 'pointer',
                    color: 'var(--dsb-fg)',
                    background: 'var(--dsb-bg1)',
                    border: '1px solid var(--dsb-bd2)',
                  }
                  const pickStyle = (sel, off) => {
                    if (off) {
                      return Object.assign({}, CARD_BASE, {
                        background: 'var(--dsb-bg2)',
                        border: '1px dashed var(--dsb-bd2)',
                        color: 'var(--dsb-fg2)',
                      })
                    }
                    if (!sel) return CARD_BASE
                    return Object.assign({}, CARD_BASE, {
                      background: 'rgba(var(--dsb-accent-rgb),0.22)',
                      border: '1px solid var(--dsb-accent)',
                      boxShadow: 'inset 3px 0 0 var(--dsb-accent)',
                    })
                  }
                  const MUTED = { color: 'var(--dsb-fg2)', fontSize: 'calc(var(--dsb-fs) - 2px)' }
                  const BADGE = {
                    fontSize: 'calc(var(--dsb-fs) - 3px)',
                    padding: '2px 8px',
                    border: '1px solid var(--dsb-bd2)',
                    borderRadius: 999,
                    color: 'var(--dsb-fg2)',
                    background: 'var(--dsb-bg2)',
                  }
                  const rows = [
                    h(
                      'div',
                      {
                        key: 'auto',
                        className: 'dsb-pick' + (pick === '' ? ' on' : ''),
                        onClick: () => { setPick(''); setModel('') },
                        style: pickStyle(pick === '', false),
                      },
                      h('div', { style: { fontWeight: 600, color: 'var(--dsb-fg)' } }, '自动（最闲的在线副机）'),
                      h('div', { style: Object.assign({ marginTop: 2 }, MUTED) }, best ? '会派给 ' + best.id + '（推荐 ' + best.fit.score + ' · 在跑 ' + best.busyN + ' 条）' : '当前没有在线副机'),
                    ),
                  ]
                  for (const c of cards) {
                    const badges = []
                    if (c.caps) {
                      if (c.caps.os) badges.push(String(c.caps.os).replace('Windows ', 'Win'))
                      if (c.caps.cores) badges.push(c.caps.cores + 'C')
                      if (c.caps.memGB) badges.push(c.caps.memGB + 'G')
                      if (c.f.pwsh) badges.push('pwsh ' + c.f.pwsh)
                      badges.push(c.f.ffmpeg ? 'ffmpeg' : '无 ffmpeg')
                      if (c.f.gpu) badges.push('GPU')
                    } else {
                      badges.push('配置未上报')
                    }
                    rows.push(
                      h(
                        'div',
                        {
                          key: c.key,
                          className: 'dsb-pick' + (pick === c.id ? ' on' : ''),
                          title: (Array.isArray(c.fit && c.fit.reasons) ? c.fit.reasons : []).join('；'),
                          onClick: () => {
                            // v2.7.5（GLM 可用性 S2）：离线机器不能选，否则任务静默排队
                            if (!c.on) {
                              setNetErr((c.label || c.id) + ' 当前离线，不能派工')
                              return
                            }
                            // 换机器时清掉旧选择：上一台机器的模型在下一台可能不存在
                            if (c.id !== pick) setModel('')
                            setPick(c.id)
                            setPickOff(false)
                          },
                          style: pickStyle(pick === c.id, !c.on),
                        },
                        h(
                          'div',
                          { style: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 } },
                          h('span', { className: 'dsb-dot ' + (c.on ? 'on' : 'off'), style: { fontSize: 'calc(var(--dsb-fs) - 1px)', color: c.on ? 'var(--dsb-ok)' : 'var(--dsb-bad)' } }, c.on ? '✓' : '✗'),
                          h('span', { style: { color: c.on ? 'var(--dsb-fg)' : 'var(--dsb-fg2)' } }, (c.label || c.id) + (best && best.key === c.key ? ('（推荐 ' + c.fit.score + '）') : '')),
                          h('span', { style: { fontWeight: 400, fontSize: 'calc(var(--dsb-fs) - 2px)', color: 'var(--dsb-fg2)' } }, '适配 ' + c.fit.score + ' · ' + fmtEta(c.etaSec)),
                          c.on ? null : h('span', { style: { color: 'var(--dsb-fg2)', fontWeight: 400, fontSize: 'calc(var(--dsb-fs) - 2px)' } }, '离线 · ' + c.last),
                          c.busyN
                            ? h('span', { style: { marginLeft: 'auto', fontWeight: 600, fontSize: 'calc(var(--dsb-fs) - 2px)', color: 'var(--dsb-warn)', background: 'rgba(var(--dsb-warn-rgb),0.14)', border: '1px solid rgba(var(--dsb-warn-rgb),0.45)', borderRadius: 999, padding: '1px 8px' } }, '在跑 ' + c.busyN)
                            : null,
                        ),
                        h(
                          'div',
                          { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 } },
                          badges.map((b, i) => h('span', { key: 'b' + i, style: BADGE }, b)),
                        ),
                      ),
                    )
                  }
                  const recReasonText = best
                    ? ('推荐理由：' + (best.label || best.id) + ' — ' + ((Array.isArray(best.fit && best.fit.reasons) ? best.fit.reasons : []).join('；') || '综合适配分最高'))
                    : '推荐理由：当前没有可用的在线副机'
                  return h(
                    'div',
                    null,
                    h('div', { style: { maxHeight: 320, overflowY: 'auto', paddingRight: 4 } }, rows),
                    h('div', { className: 'dsb-rec-reason', style: { marginTop: 6, color: 'var(--dsb-fg2)', fontSize: 'calc(var(--dsb-fs) - 2px)', lineHeight: 1.5 } }, recReasonText),
                  )
                })(),
                // v2.1.0：模型选择（机器上报了清单才显示；否则跟随副机默认/团队默认）
                (function () {
                  const nm = (data && data.nodeModels) || {}
                  const pool = []
                  const seen = Object.create(null)
                  const meta = Object.create(null)
                  const absorb = (key) => {
                    const e = nm[String(key || '').toLowerCase()]
                    if (!e || !Array.isArray(e.models)) return []
                    const out = []
                    for (const m of e.models) {
                      const value = m.provider ? m.provider + '/' + m.model : m.model
                      if (!value) continue
                      if (!meta[value]) meta[value] = { label: String(m.name || value), location: String(m.location || ''), tags: Array.isArray(m.tags) ? m.tags : [] }
                      out.push(value)
                    }
                    return out
                  }
                  const pushModels = (key, label) => {
                    const e = nm[String(key || '').toLowerCase()]
                    if (!e || !Array.isArray(e.models)) return
                    for (const m of e.models) {
                      const value = m.provider ? m.provider + '/' + m.model : m.model
                      if (!value || Object.prototype.hasOwnProperty.call(seen, value)) continue
                      seen[value] = true
                      // 显示用 name；发给 worker 的必须是 provider/model（或裸 id）
                      const one = { value, label: (m.name || value), location: String(m.location || ''), tags: Array.isArray(m.tags) ? m.tags : [] }
                      meta[value] = one
                      pool.push(one)
                    }
                  }
                  if (pick !== '') {
                    pushModels(pick, false)
                  } else {
                    // 选“自动”时只列所有在线副机的交集：并集里可能混着某台装不了的模型，
                    // 自动选机后派过去会直接失败。交集为空就只剩“跟随副机默认”。
                    // 只对“板子上在线、且不是 host”的机器求交集，和调度器的候选集合保持一致。
                    const allowed = Object.create(null)
                    for (const bm of (data && Array.isArray(data.machines) ? data.machines : [])) {
                      const id = String((bm && bm.id) || '')
                      if (id && bm.online && id.toLowerCase() !== 'host') allowed[id.toLowerCase()] = true
                    }
                    const expected = Object.keys(allowed).length
                    const allowedKeys = Object.keys(nm).filter((k) => Object.prototype.hasOwnProperty.call(allowed, k))
                    for (const k of allowedKeys) absorb(k)
                    const lists = allowedKeys
                      .map((k) => (nm[k] && Array.isArray(nm[k].models) ? nm[k].models : []))
                      .filter((arr) => arr.length > 0)
                      .map((arr) => arr.map((m) => (m.provider ? m.provider + '/' + m.model : m.model)).filter(Boolean))
                    // 低13：有在线副机没上报模型清单时，不做跨机交集（否则可能挑到那台没有的模型）。
                    if (lists.length > 0 && lists.length === expected) {
                      const common = lists.reduce((acc, cur) => acc.filter((v) => cur.indexOf(v) >= 0))
                      for (const v of common) {
                        if (Object.prototype.hasOwnProperty.call(seen, v)) continue
                        seen[v] = true
                        // 中③：交集里也要带元数据，否则“自动”全落“其他”（location 为空）。
                        pool.push(Object.assign({ value: v, label: v, location: '', tags: [] }, meta[v] || {}))
                      }
                    }
                  }
                  const teamDefault = (data && data.defaultModel) || ''
                  // v2.7.1：自动档下把「各机专属模型」也列出来（交集之外的），按机器分组，
                  // 便于直接选某台机器的本地模型；交集本身仍单列，避免选到对方没有的模型。
                  const autoExtras = []
                  if (pick === '' && pool.length > 0) {
                    const seenVals = Object.create(null)
                    for (const o of pool) seenVals[o.value] = true
                    for (const k of Object.keys(nm)) {
                      const arr = nm[k] && Array.isArray(nm[k].models) ? nm[k].models : []
                      const items = []
                      for (const m of arr) {
                        const value = m.provider ? m.provider + '/' + m.model : m.model
                        if (!value || seenVals[value]) continue
                        seenVals[value] = true
                        const hit = meta[value] || {}
                        items.push({
                          value,
                          label: m.name || value,
                          location: String(m.location || hit.location || ''),
                          tags: Array.isArray(m.tags) ? m.tags : (Array.isArray(hit.tags) ? hit.tags : []),
                        })
                      }
                      if (items.length) autoExtras.push({ name: String(k), items })
                    }
                  }
                  return h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column' } },
                    h(
                      'div',
                      { style: { marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 } },
                      h('span', { style: { color: 'var(--dsb-fg2)', fontSize: 'calc(var(--dsb-fs) - 1px)' } }, '类型'),
                      h(
                        'select',
                        {
                          value: taskMode,
                          onChange: (e) => setTaskMode(e.target.value),
                          style: {
                            flex: 1,
                            background: 'var(--dsb-bg1)',
                            color: 'var(--dsb-fg)',
                            border: '1px solid var(--dsb-bd2)',
                            borderRadius: 6,
                            padding: '5px 8px',
                            fontSize: 'calc(var(--dsb-fs) - 1px)',
                          },
                        },
                        h('option', { value: 'agent' }, 'agent · 智能体会话（工具随 preset）'),
                        h('option', { value: 'exec' }, 'exec · 跑 allowlist 里的 .ps1'),
                        h('option', { value: 'maint' }, 'maint · 只读诊断 / 签名写动作'),
                      ),
                    ),
                    taskMode === 'maint'
                      ? h(
                        'div',
                        { style: { marginTop: 8 } },
                        h('div', { style: { color: 'var(--dsb-fg2)', fontSize: 'calc(var(--dsb-fs) - 2px)', marginBottom: 4 } },
                          '票据（写动词必填；只读动词可空。签发：pwsh -File scripts/maint-ticket.mjs sign …）'),
                        h('textarea', {
                          value: ticket,
                          rows: 2,
                          placeholder: 'ticket= 后面那串（16..900 位 base64url）',
                          onChange: (e) => setTicket(e.target.value),
                          style: {
                            width: '100%',
                            boxSizing: 'border-box',
                            background: 'var(--dsb-bg1)',
                            color: 'var(--dsb-fg)',
                            border: '1px solid var(--dsb-bd2)',
                            borderRadius: 6,
                            padding: '5px 8px',
                            fontSize: 'calc(var(--dsb-fs) - 2px)',
                            fontFamily: 'ui-monospace, Consolas, monospace',
                          },
                        }),
                        // v2.6.29（U-3）：可解析的 config-set goal 才显示预览入口。
                        diffPayload
                          ? h(
                            'div',
                            { style: { marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                            h('button', { className: 'dsb-btn', disabled: diffBusy || sending, onClick: previewDiff }, diffBusy ? '预览中…' : '预览改动'),
                            diffRes
                              ? h(
                                'div',
                                {
                                  className: 'dsb-diff',
                                  style: {
                                    flex: '1 1 100%',
                                    marginTop: 4,
                                    fontSize: 'calc(var(--dsb-fs) - 3px)',
                                    lineHeight: 1.7,
                                    color: diffRes.ok === false ? 'var(--dsb-bad)' : 'var(--dsb-fg)',
                                    fontFamily: 'ui-monospace, Consolas, monospace',
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-all',
                                  },
                                },
                                diffRes.ok === false
                                  ? asText(diffRes.error, '未知错误')
                                  : (diffRes.remote
                                    ? asText(diffRes.note, '预览只反映本机配置；实际写入目标副机。')
                                    : ((diffRes.changesList || []).length === 0
                                      ? '无变化'
                                      : (diffRes.changesList || []).map(function (c, ci) {
                                          return h('div', { key: 'df' + ci }, String(c.key) + ': ' + fmtDiffValue(c.from) + ' → ' + fmtDiffValue(c.to))
                                        }))),
                              )
                              : null,
                          )
                          : null,
                      )
                      : null,
                    h(
                      'div',
                      { style: { marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 } },
                      h('span', { style: { color: 'var(--dsb-fg2)', fontSize: 'calc(var(--dsb-fs) - 1px)' } }, '模型'),
                    h(
                      'select',
                      {
                        value: model,
                        onChange: (e) => setModel(e.target.value),
                        style: {
                          flex: 1,
                          background: 'var(--dsb-bg1)',
                          color: 'var(--dsb-fg)',
                          border: '1px solid var(--dsb-bd2)',
                          borderRadius: 6,
                          padding: '5px 8px',
                          fontSize: 'calc(var(--dsb-fs) - 1px)',
                        },
                      },
                      h('option', { value: '' }, teamDefault ? '跟随副机默认（团队默认 ' + teamDefault + '）' : '跟随副机默认'),
                      // v2.7.1：没有可选模型时不再静默隐藏整行，而是给一个置灰占位，缺数据一眼可见。
                      pool.length === 0
                        ? h('option', { value: '', disabled: true }, '该机器未上报模型清单（跟随默认）')
                        : null,
                      (function () {
                        const groups = { cloud: [], lan: [], local: [], other: [] }
                        for (const o of pool) {
                          const g = (o.location === 'cloud' || o.location === 'lan' || o.location === 'local') ? o.location : 'other'
                          groups[g].push(o)
                        }
                        const titles = { cloud: '云端 · 按量计费', lan: '局域网 · 免费', local: '本机 · 免费', other: '其他 / 共有' }
                        return ['cloud', 'lan', 'local', 'other'].map(function (g) {
                          if (!groups[g].length) return null
                          return h('optgroup', { key: g, label: titles[g] },
                            groups[g].map(function (o) {
                              const hint = (o.tags && o.tags.length) ? ' · ' + o.tags.slice(0, 2).join('/') : ''
                              return h('option', { key: o.value, value: o.value }, o.label + hint)
                            }))
                        })
                      })(),
                      // v2.7.1：自动档下，交集之外的各机专属模型按机器分组列出（选本地/云模型时直达）。
                      autoExtras.length
                        ? autoExtras.map(function (grp, gi) {
                          return h('optgroup', { key: 'mx' + gi, label: grp.name + ' · 专属' },
                            grp.items.map(function (o) {
                              const hint = (o.tags && o.tags.length) ? ' · ' + o.tags.slice(0, 2).join('/') : ''
                              return h('option', { key: 'mx' + gi + ':' + o.value, value: o.value }, o.label + hint)
                            }))
                        })
                        : null,
                    ),
                    ),
                  )
                })(),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 } },
                  h('button', { className: 'dsb-btn', onClick: () => setAsk(false) }, '取消'),
                  h('button', {
                    className: 'dsb-btn',
                    disabled: sending || pickOff || (!pick && onlineSub.length === 0),
                    title: (pickOff || (!pick && onlineSub.length === 0)) ? '当前没有在线副机：派出去只会排队；先修好机器再派' : '',
                    onClick: confirmDispatch,
                  }, sending ? '派发中…' : '确认派工'),
                ),
              ),
            )
          : null,
      )
    }

    // v2.7.1：渲染兜底 —— 面板自身渲染抛错时在 slot 'main' 内降级成占位，
    // 不再把异常抛给宿主 slot 错误边界（那是整槽白屏）。诊断摘要写 window.__dsbCrash。
    // 用函数包装器而不是 class 边界：本插件的组件全是普通函数，整棵树在 Panel() 同步
    // 调用链里建完；同时冒烟里的假 React 不支持 class 组件（用 class 会把门禁跑挂）。
    function PanelSafe() {
      try {
        return Panel()
      } catch (err) {
        try {
          window.__dsbCrash = {
            kind: 'panel-render',
            at: new Date().toISOString(),
            message: String((err && err.message) || err),
            stack: String((err && err.stack) || '').split('\n').slice(0, 12).join('\n'),
          }
        } catch (e2) { /* 诊断写入失败不该再抛 */ }
        try {
          if (typeof console !== 'undefined' && console.error) console.error('[dsb] panel render crashed', err)
        } catch (e3) { /* noop */ }
        return h(
          'div',
          { className: 'dsb-panel-err', style: { padding: 16 } },
          h('div', { style: { fontWeight: 700, marginBottom: 6 } }, '调度台渲染出错（已降级，未整槽白屏）'),
          h('div', { style: { opacity: 0.75, marginBottom: 10 } }, String((err && err.message) || err)),
          h('div', { style: { opacity: 0.6, fontSize: 'calc(var(--dsb-fs) - 2px)' } }, '诊断摘要：window.__dsbCrash'),
        )
      }
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        const disposers = []

        // 样式注入走两条路：优先用宿主 styles 服务；服务不在（或注入没生效）时
        // 自己往 document.head 塞一个 <style>。面板“全挤在一起”就是这条路断了。
        let styled = false
        try {
          const stylesSvc = ctx.get ? ctx.get('styles') : null
          if (stylesSvc && typeof stylesSvc.insert === 'function') {
            disposers.push(stylesSvc.insert(CSS))
            styled = true
          }
        } catch {
          styled = false
        }
        if (typeof document !== 'undefined') {
          const elId = 'dsh-board-style'
          let el = document.getElementById(elId)
          if (!el) {
            el = document.createElement('style')
            el.id = elId
            el.textContent = CSS
            document.head.appendChild(el)
          }
          disposers.push(function () {
            const n = document.getElementById(elId)
            if (n && n.parentNode) n.parentNode.removeChild(n)
          })
        }

        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_KEY, order: 26, label: function () { return '多机调度台' } },
            Icon,
          )
        })

        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: PANEL_KEY }, PanelSafe)
        })

        let pet = null
        try {
          pet = mountPet()
        } catch (err) {
          pet = null
          if (typeof console !== 'undefined') console.warn('[dsh-board] pet mount failed:', err)
        }
        if (pet) disposers.push(pet.dispose)


        // v1.1：派发与终态回写全部搬到 Host 侧（lib/index.js 的 dispatchOnce / syncRemote）。
        // 浏览器不再轮询 remote-agent，也不再持有派发权 —— 关掉页面不影响任何任务。

        // __R3_MERGE__ 省一行：把侧栏里的「远程同事」入口收起来，它的内容已并进作业板
        const MERGE_KEY = 'dsh-board-merge-entry'
        const REMOTE_LABEL = '\u8fdc\u7a0b\u540c\u4e8b'
        const mergeOn = function () { try { return localStorage.getItem(MERGE_KEY) !== '0' } catch (e) { return true } }
        let hidePending = false
        const hideRemoteEntry = function (force) {
          if (!force && hidePending) return
          hidePending = true
          const run = function () {
            hidePending = false
            if (!mergeOn()) return
            let nodes = []
            try { nodes = document.querySelectorAll('div,span,button,a,li,p') } catch (e) { return }
            for (let i = 0; i < nodes.length; i++) {
              const el = nodes[i]
              if (!el || !el.getAttribute) continue
              if (el.dataset && el.dataset.dsbMerged === '1') continue
              const cls = String(el.className || '')
              if (cls.indexOf('dsb') >= 0) continue
              if ((el.textContent || '').trim() !== REMOTE_LABEL) continue
              // 往上找到“整行”：父节点文本仍恰好是这四个字（图标不贡献文本）
              let row = el
              for (let up = 0; up < 5 && row.parentElement; up++) {
                const p = row.parentElement
                if ((p.textContent || '').trim() === REMOTE_LABEL) row = p
                else break
              }
              // 记下原来的内联 display：卸载时要还原，不能把宿主的行永久藏掉。
              if (row.dataset) {
                row.dataset.dsbPrevDisplay = row.style.display || ''
                row.dataset.dsbMerged = '1'
              }
              row.style.display = 'none'
            }
          }
          setTimeout(run, force ? 0 : 120)
        }
        const showRemoteEntry = function () {
          let els = []
          try { els = document.querySelectorAll('[data-dsb-merged=\"1\"]') } catch (e) { return }
          for (let i = 0; i < els.length; i++) {
            els[i].style.display = els[i].dataset.dsbPrevDisplay || ''
            els[i].dataset.dsbMerged = '0'
          }
        }
        window.__dsbMergeEntry = function (on) {
          try { localStorage.setItem(MERGE_KEY, on ? '1' : '0') } catch (e) { /* 忽略 */ }
          if (on) hideRemoteEntry(true); else showRemoteEntry()
        }
        let mo = null
        try { mo = new MutationObserver(function () { hideRemoteEntry() }); mo.observe(document.body, { childList: true, subtree: true }) } catch (e) { mo = null }
        const mergeTimer = setInterval(function () { hideRemoteEntry(true) }, 1500)
        hideRemoteEntry(true)
        disposers.push(function () {
          try { if (mo) mo.disconnect() } catch (e) { /* 忽略 */ }
          clearInterval(mergeTimer)
          try { showRemoteEntry() } catch (e) { /* 忽略 */ }
        })

        return function () {
          for (let i = 0; i < disposers.length; i++) {
            try {
              disposers[i]()
            } catch {
              /* 已释放 */
            }
          }
        }
      },
    }
  },
})


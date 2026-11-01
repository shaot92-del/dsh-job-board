/**
 * dsh-team —— Client 半边（浏览器静态 bundle，作业板 + 桌宠）。
 *
 * 只做 GUI：侧栏一个图标 + 主面板一张任务表。
 * 所有数据都走 Host 半边注册的 /api/board/ui/*，浏览器不直接跨网访问板子。
 *
 * 打包约定（与 dsh-remote-agent / imagegen 一致）：
 *   window.__ModuleLoader__.load({ id, factory(require) { ... return { inject, apply } } })
 * 只能 require('react')，不能 import 任何 @deepseek-ai/*。
 */
window.__ModuleLoader__.load({
  id: 'dsh-team',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/board/ui'
    const PANEL_KEY = 'dsh-board'

    const CSS = [
      '.dsb-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);--dsb-fs:16px;font-size:var(--dsb-fs)}',
      '.dsb-head{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;flex-wrap:wrap}',
      '.dsb-title{font-weight:600;font-size:calc(var(--dsb-fs) + 3px)}',
      '.dsb-sp{flex:1}',
      '.dsb-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;border:1px solid #4a5561;background:#1b1f25;font-size:calc(var(--dsb-fs) - 1px);font-weight:700;white-space:nowrap;color:#e9edf2}',
      '.dsb-pill b{font-weight:600}',
      '.dsb-q{background:#4a3a0f;border-color:#d8a53a;color:#ffd479}',
      '.dsb-r{background:#0d3550;border-color:#4aa3e0;color:#a8dbff}',
      '.dsb-d{background:#0f3a20;border-color:#3fbf6a;color:#a5f0bf}',
      '.dsb-b{background:#4a1410;border-color:#e0554a;color:#ffb8b0}',
      '.dsb-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:5px 13px;font-size:calc(var(--dsb-fs) - 1px);cursor:pointer;line-height:1.7}',
      '.dsb-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsb-btn[disabled]{opacity:.45;cursor:not-allowed}',
      '.dsb-main{flex:1;min-height:0;overflow:auto}',
    
  '.dsb-row{display:flex;gap:14px;align-items:flex-start;padding:13px 18px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
    
  '.dsb-row:hover{background:var(--dsw-alias-bg-layer-1)}',
      '.dsb-id{font-family:ui-monospace,Consolas,monospace;font-size:calc(var(--dsb-fs) - 4px);opacity:.65;flex:0 0 auto;padding-top:2px}',
      '.dsb-body{flex:1;min-width:0}',
      '.dsb-line1{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
      '.dsb-name{font-weight:600;font-size:var(--dsb-fs)}',
      '.dsb-tag{font-size:calc(var(--dsb-fs) - 3px);padding:2px 8px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);opacity:.85}',
      '.dsb-note{font-size:calc(var(--dsb-fs) - 2px);line-height:1.65;opacity:.72;margin-top:4px;word-break:break-word}',
      '.dsb-acts{display:flex;gap:6px;flex:0 0 auto;align-items:center}',
      '.dsb-dot{width:auto;height:auto;border-radius:0;display:inline-block;font-weight:800;font-size:calc(var(--dsb-fs) - 1px);line-height:1}',
      '.dsb-dot.on{color:#5ff08a}.dsb-dot.off{color:#b9bec6}',
      '.dsb-pill.off{opacity:.85}',
      '.dsb-empty{padding:44px 18px;text-align:center;opacity:.6;font-size:var(--dsb-fs)}',
      '.dsb-err{padding:12px 18px;font-size:calc(var(--dsb-fs) - 2px);color:#e58a8a;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dsb-filt{display:flex;gap:8px;padding:10px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;flex-wrap:wrap}',
      '.dsb-input{flex:1 1 auto;min-width:170px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:5px 10px;font-size:calc(var(--dsb-fs) - 2px);outline:none}',
      '.dsb-input:focus{border-color:var(--dsw-alias-border-l2);box-shadow:0 0 0 1px var(--dsw-alias-border-l2)}',
      '.dsb-detail{margin-top:10px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.dsb-kv{font-size:calc(var(--dsb-fs) - 2px);opacity:.82;word-break:break-all;line-height:1.6}',
      '.dsb-root,.dsb-root *{box-sizing:border-box}',
      '.dsb-root{color:var(--dsw-alias-label-primary,#e6e6e8);background:var(--dsw-alias-bg-base,#17171a)}',
    
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
    ].join('\n')

    const STATUS_LABEL = {
      queued: '待办',
      claimed: '已认领',
      running: '进行中',
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

    /* ───────────── 桌宠状态（把 D:\gp_video\pet 的判据搬到面板里） ─────────────
       桌宠是 C# 独立窗口（HWND 嵌不进网页），这里走方案 B：
       同一套判据 + 同一张立绘，在面板顶部重画一张状态卡。 */

    function petState(data, machines, counts) {
      if (!data || data.ok === false) {
        return {
          mood: 'down',
          head: '连不上作业板',
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

    async function getJson(path, init) {
      const res = await fetch(path, Object.assign({ cache: 'no-store' }, init || {}))
      const text = await res.text()
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = { ok: false, error: '返回不是 JSON：' + text.slice(0, 120) }
      }
      return data || { ok: false, error: 'HTTP ' + res.status }
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
      const [net, setNet] = React.useState(null)
      const [netErr, setNetErr] = React.useState('')
      const [ident, setIdent] = React.useState(null)
      const [assessing, setAssessing] = React.useState(false)
      const [notice, setNotice] = React.useState('')

      React.useEffect(() => {
        let alive = true
        const load = () =>
          fetch(API + '/identity', { cache: 'no-store', credentials: 'same-origin' })
            .then((r) => r.json())
            .then((d) => {
              if (alive && d && d.ok) setIdent(d)
            })
            .catch(() => {})
        load()
        const t = setInterval(load, 15000)
        return () => {
          alive = false
          clearInterval(t)
        }
      }, [])

      const runAssess = function () {
        if (assessing) return
        setAssessing(true)
        setNotice('正在测本机能力（CPU/内存/磁盘/PowerShell/ffmpeg/Python/GPU）…')
        fetch(API + '/assess', { method: 'POST', credentials: 'same-origin' })
          .then((r) => r.json())
          .then((d) => {
            setNotice((d && d.summary) || '评估完成')
            return fetch(API + '/identity', { cache: 'no-store', credentials: 'same-origin' }).then((r) => r.json())
          })
          .then((i) => {
            if (i && i.ok) setIdent(i)
            setTick((t) => t + 1)
          })
          .catch((e) => setNotice('评估失败：' + ((e && e.message) || '未知错误')))
          .then(() => setAssessing(false))
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
      const doDispatch = async (target, g) => {
        const bid = 'bd-' + Date.now().toString(36).slice(-6) + '-' + Math.random().toString(36).slice(2, 6)
        const cre = await getJson(API + '/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            task_id: bid,
            goal: g,
            title: g.slice(0, 40),
            machine: target || '',
            dispatch: 'auto',
            mode: window.__dsbTaskMode || 'agent',
            workspace: window.__dsbWorkspace || '',
          }),
        })
        if (!cre || !cre.ok) {
          setNetErr('建单失败：' + ((cre && (cre.error || cre.message)) || '未知'))
          return false
        }
        setNetErr('')
        setTick((t) => t + 1)
        return true
      }

      // __R3_TEAM__ 弹窗确认
      const confirmDispatch = async () => {
        const g = goal.trim()
        if (g === '') return
        setSending(true)
        try {
          const ok = await doDispatch(pick, g)
          if (ok) { setGoal(''); setAsk(false) }
        } catch (e) {
          setNetErr('派工异常：' + String((e && e.message) || e))
        } finally {
          setSending(false)
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
              body: JSON.stringify({ task_id: task.id, status: 'done', artifact: ex.artifact || '', note: ex.note || '', machine: task.machine || undefined }),
            })
          if (kind === 'blocked')
            out = await getJson(API + '/release', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              // 复核 #5：把 task.machine 带上 —— 多机在跑时板子只认这一条，
              // 不带的话 Host 会用本机身份 release，释放掉别人的占位。
              body: JSON.stringify({ task_id: task.id, status: 'blocked', note: ex.note || 'GUI 打回', machine: task.machine || undefined }),
            })
          // 板子回 409（例如已经被人认领过）时以前完全不提示，看起来像成功了。
          if (out && out.ok === false) setNetErr('操作失败：' + (out.error || out.message || '未知'))
        } catch (e) {
          setNetErr('操作异常：' + String((e && e.message) || e))
        } finally {
          setBusy('')
          setTick((t) => t + 1)
        }
      }

      const counts = (data && data.counts) || { queued: 0, running: 0, done: 0, bad: 0, stale: 0 }
      const machines = (data && data.machines) || []
      const tasks = (data && data.tasks) || []
      const shown =
        filter === 'all'
          ? tasks
          : filter === 'active'
            ? tasks.filter((t) => t.status !== 'done' && t.status !== 'superseded' && t.status !== 'cancelled')
            : tasks.filter((t) => (filter === 'bad' ? t.status === 'blocked' || t.status === 'failed' : true))

      const kw = q.trim().toLowerCase()
      const filtered = kw
        ? shown.filter((t) => [t.id, t.title, t.note, t.machine, t.progress].filter(Boolean).join(' ').toLowerCase().includes(kw))
        : shown

      const filtBtn = (key, label) =>
        h(
          'button',
          { className: 'dsb-btn', disabled: filter === key, onClick: () => setFilter(key) },
          label,
        )

      return h(
        'div',
        { className: 'dsb-root', style: { ['--dsb-fs']: fs + 'px' } },
        h(
          'div',
          { className: 'dsb-head' },
          h('div', { className: 'dsb-title' }, '团队 · 作业板'),
          h('span', { className: 'dsb-pill dsb-q' }, '待办 ', h('b', null, counts.queued)),
          h('span', { className: 'dsb-pill dsb-r' }, '进行 ', h('b', null, counts.running)),
          h('span', { className: 'dsb-pill dsb-d' }, '完成 ', h('b', null, counts.done)),
          h('span', { className: 'dsb-pill dsb-b' }, '打回 ', h('b', null, counts.bad)),
          h('div', { className: 'dsb-sp' }),
          h(
            'span',
            { className: 'dsb-pill', title: data && data.board ? data.board : '' },
            data && data.updatedAgeSec != null ? '更新 ' + ago(data.updatedAgeSec) : '未连接',
          ),
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
          h('button', { className: 'dsb-btn', onClick: () => setTick((t) => t + 1) }, '刷新'),
        ),
        ident && ident.needsAssessment
          ? h(
              'div',
              {
                style: {
                  border: '1px solid #d29922',
                  background: 'rgba(210,153,34,0.10)',
                  borderRadius: 8,
                  padding: '10px 12px',
                  marginBottom: 10,
                },
              },
              h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '这台机器（' + (ident.machine || '?') + '）还没做过工作能力评估'),
              h(
                'div',
                { style: { opacity: 0.8, lineHeight: 1.7, fontSize: 'calc(var(--dsb-fs) - 1px)' } },
                '评估一次，主机就知道这台机器适合接什么活（CPU / 内存 / 磁盘 / PowerShell / ffmpeg / Python / GPU）。只测本机，不传文件。',
              ),
              h(
                'div',
                { style: { display: 'flex', gap: 8, marginTop: 10 } },
                h('button', { className: 'dsb-btn', disabled: assessing, onClick: runAssess }, assessing ? '评估中…' : '开始评估'),
                h('button', { className: 'dsb-btn', onClick: () => setIdent(Object.assign({}, ident, { needsAssessment: false })) }, '稍后'),
              ),
            )
          : ident && ident.assessed
            ? h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                    border: '1px solid #30363d',
                    borderRadius: 8,
                    padding: '7px 10px',
                    marginBottom: 10,
                    fontSize: 'calc(var(--dsb-fs) - 1px)',
                  },
                },
                h('span', { style: { opacity: 0.75 } }, (ident.machine || '本机') + ' · 工作能力'),
                h(
                  'span',
                  { style: { opacity: 0.95 } },
                  ident.caps
                    ? [
                        String(ident.caps.os || '').replace('Windows ', 'Win'),
                        (ident.caps.cores || '?') + ' 核',
                        (ident.caps.memGB || '?') + 'G 内存',
                        '余 ' + (ident.caps.freeDiskGB || '?') + 'G',
                        ident.caps.features && ident.caps.features.pwsh ? 'pwsh ' + ident.caps.features.pwsh : '无 pwsh',
                        ident.caps.features && ident.caps.features.ffmpeg ? 'ffmpeg' : '无 ffmpeg',
                        ident.caps.features && ident.caps.features.python ? 'Python ' + ident.caps.features.python : '',
                        ident.caps.features && ident.caps.features.gpu ? String(ident.caps.features.gpu).slice(0, 28) : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : '（清单为空，点右按钮重测）',
                ),
                h('span', { style: { opacity: 0.5, marginLeft: 'auto' } }, ident.assessedAt ? '评估于 ' + new Date(ident.assessedAt).toLocaleString() : ''),
                h('button', { className: 'dsb-btn', disabled: assessing, onClick: runAssess }, assessing ? '评估中…' : '重新评估'),
              )
            : null,
        notice
          ? h(
              'div',
              { style: { borderLeft: '3px solid #58a6ff', padding: '6px 10px', marginBottom: 10, opacity: 0.9, lineHeight: 1.6 } },
              notice,
              h('button', { className: 'dsb-btn', style: { marginLeft: 10, padding: '1px 8px' }, onClick: () => setNotice('') }, '知道了'),
            )
          : null,
        machines.length
          ? h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 } },
              machines.map((m) => {
                const caps = m.caps
                const live = m.live
                const bar = (pct, color) =>
                  h(
                    'div',
                    { style: { height: 5, background: '#21262d', borderRadius: 3, overflow: 'hidden', marginTop: 3 } },
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
                  rows.push(bar(live.memPct, live.memPct > 85 ? '#f85149' : live.memPct > 65 ? '#d29922' : '#3fb950'))
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
                      live.cpuPct > 85 ? '#f85149' : live.cpuPct > 60 ? '#d29922' : '#58a6ff',
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
                  rows.push(bar(live.diskPct || 0, '#8b949e'))
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
                const busyN = tasks.filter(
                  (t) => t.status === 'running' && String(t.machine || '').toLowerCase() === String(m.id).toLowerCase(),
                ).length
                return h(
                  'div',
                  {
                    key: m.id,
                    style: {
                      minWidth: 208,
                      flex: '1 1 208px',
                      border: '1px solid ' + (m.online ? '#30363d' : '#21262d'),
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
                    h('b', { style: { fontSize: 'calc(var(--dsb-fs) + 1px)' } }, m.id),
                    caps && caps.os
                      ? h('span', { style: { opacity: 0.5, fontSize: 'calc(var(--dsb-fs) - 3px)' } }, String(caps.os).replace('Windows ', 'Win'))
                      : null,
                    busyN
                      ? h(
                          'span',
                          { style: { marginLeft: 'auto', color: '#e3b341', fontSize: 'calc(var(--dsb-fs) - 3px)' } },
                          '在跑 ' + busyN,
                        )
                      : null,
                  ),
                  rows,
                )
              }),
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
          ((net && net.nodes) || []).map((n) =>
            h(
              'span',
              {
                key: 'n-' + n.nodeId,
                className: 'dsb-pill' + (n.online ? '' : ' off'),
                title: n.nodeId + (n.online ? ' 在线' : ' 离线'),
              },
              h('span', { className: 'dsb-dot ' + (n.online ? 'on' : 'off') }, n.online ? '✓' : '✗'),
              n.nodeId,
            ),
          ),
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
            onKeyDown: (e) => { if (e.key === 'Enter' && goal.trim() !== '') setAsk(true) },
          }),
          h('button', { className: 'dsb-btn', disabled: goal.trim() === '', onClick: () => setAsk(true) }, '派工'),
        ),
        h(
          'div',
          { className: 'dsb-filt' },
          filtBtn('active', '未完成'),
          filtBtn('all', '全部'),
          filtBtn('bad', '打回'),
          h('input', {
            className: 'dsb-input',
            placeholder: '搜标题 / 备注 / 机器',
            value: q,
            onChange: (e) => setQ(e.target.value),
          }),
        ),
        error ? h('div', { className: 'dsb-err' }, error) : null,
        h(
          'div',
          { className: 'dsb-main' },
          filtered.length
            ? filtered.map((t) =>
                h(
                  'div',
                  { key: t.id, className: 'dsb-row' },
                  h('div', { className: 'dsb-id' }, t.id.replace(/^ui-/, '')),
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
                      h('span', { className: 'dsb-tag' }, STATUS_LABEL[t.status] || t.status),
                      t.machine ? h('span', { className: 'dsb-tag' }, t.machine) : null,
                      h('span', { className: 'dsb-tag' }, t.updated),
                    ),
                    t.note ? h('div', { className: 'dsb-note' }, t.note) : null,
                    openId === t.id
                      ? h(
                          'div',
                          { className: 'dsb-detail' },
                          h('div', { className: 'dsb-kv' }, `状态 ${STATUS_LABEL[t.status] || t.status} · 机器 ${t.machine || '未指派'} · 更新 ${t.updated || '—'}`),
                          t.progress ? h('div', { className: 'dsb-kv' }, '进度：' + t.progress) : null,
                          h('div', { className: 'dsb-kv' }, '产物：' + (t.artifact || '（无）')),
                          h('div', { className: 'dsb-line1' },
                            h('input', { className: 'dsb-input', placeholder: '产物路径（可空）', value: artText, onChange: (e) => setArtText(e.target.value) }),
                            h('input', { className: 'dsb-input', placeholder: '交付/打回备注（可空）', value: noteText, onChange: (e) => setNoteText(e.target.value) }),
                          ),
                          h('div', { className: 'dsb-acts' },
                            h('button', { className: 'dsb-btn', disabled: busy === t.id + ':done', onClick: () => act('done', t, { artifact: artText, note: noteText }) }, '交付（带产物）'),
                            h('button', { className: 'dsb-btn', disabled: busy === t.id + ':blocked', onClick: () => act('blocked', t, { note: noteText }) }, '打回并留原因'),
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
                    t.status !== 'done' && t.status !== 'superseded'
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
            : h('div', { className: 'dsb-empty' }, error ? '板子连不上' : '没有任务'),
        ),
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
                    background: '#161b22',
                    border: '1px solid #30363d',
                    borderRadius: 10,
                    padding: 18,
                    minWidth: 360,
                    maxWidth: 560,
                  },
                },
                h('div', { style: { fontSize: 'calc(var(--dsb-fs) + 2px)', fontWeight: 600, marginBottom: 6, color: '#e6edf3' } }, '派给谁？'),
                h('div', { style: { color: '#c9d1d9', marginBottom: 4, lineHeight: 1.6 } }, goal.trim().slice(0, 160)),
                h(
                  'div',
                  { style: { color: '#8b949e', marginBottom: 14, fontSize: 'calc(var(--dsb-fs) - 1px)' } },
                  '点一张卡片选定；不选就是让主机自动挑最闲的那台。',
                ),
                (function () {
                  const load = {}
                  for (const t of tasks) {
                    if (t.status === 'running' && t.machine) load[String(t.machine).toLowerCase()] = (load[String(t.machine).toLowerCase()] || 0) + 1
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
                  const cards = [...byKey.values()].map((e) => {
                    const m = e.m
                    const caps = (m && m.caps) || null
                    const f = (caps && caps.features) || {}
                    const on = m ? !!m.online : !e.hubOffline
                    return { id: e.label, key: e.key, on, caps, f, busyN: load[e.key] || 0, last: (m && m.lastSeen) || '', nodeIds: e.nodeIds }
                  })
                  const best = cards
                    .filter((c) => c.on)
                    .sort((a, b) => a.busyN - b.busyN || String(a.id).localeCompare(String(b.id)))[0]
                  const CARD_BASE = {
                    borderRadius: 8,
                    padding: '10px 12px',
                    marginBottom: 8,
                    cursor: 'pointer',
                    color: '#e6edf3',
                    background: '#1c2129',
                    border: '1px solid #3d444d',
                  }
                  const pickStyle = (sel, off) => {
                    if (off) {
                      return Object.assign({}, CARD_BASE, {
                        background: '#141a20',
                        border: '1px dashed #3d444d',
                        color: '#8b949e',
                      })
                    }
                    if (!sel) return CARD_BASE
                    return Object.assign({}, CARD_BASE, {
                      background: 'rgba(88,166,255,0.22)',
                      border: '1px solid #79c0ff',
                      boxShadow: 'inset 3px 0 0 #58a6ff',
                    })
                  }
                  const MUTED = { color: '#adbac7', fontSize: 'calc(var(--dsb-fs) - 2px)' }
                  const BADGE = {
                    fontSize: 'calc(var(--dsb-fs) - 3px)',
                    padding: '2px 8px',
                    border: '1px solid #3d444d',
                    borderRadius: 999,
                    color: '#c9d1d9',
                    background: '#21262d',
                  }
                  const rows = [
                    h(
                      'div',
                      {
                        key: 'auto',
                        className: 'dsb-pick' + (pick === '' ? ' on' : ''),
                        onClick: () => setPick(''),
                        style: pickStyle(pick === '', false),
                      },
                      h('div', { style: { fontWeight: 600, color: '#e6edf3' } }, '自动（最闲的在线副机）'),
                      h('div', { style: Object.assign({ marginTop: 2 }, MUTED) }, best ? '会派给 ' + best.id + '（在跑 ' + best.busyN + ' 条）' : '当前没有在线副机'),
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
                          onClick: () => setPick(c.id),
                          style: pickStyle(pick === c.id, !c.on),
                        },
                        h(
                          'div',
                          { style: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 } },
                          h('span', { className: 'dsb-dot ' + (c.on ? 'on' : 'off'), style: { fontSize: 'calc(var(--dsb-fs) - 1px)', color: c.on ? '#3fb950' : '#f85149' } }, c.on ? '✓' : '✗'),
                          h('span', { style: { color: c.on ? '#e6edf3' : '#adbac7' } }, c.id),
                          c.on ? null : h('span', { style: { color: '#8b949e', fontWeight: 400, fontSize: 'calc(var(--dsb-fs) - 2px)' } }, '离线 · ' + c.last),
                          c.busyN
                            ? h('span', { style: { marginLeft: 'auto', fontWeight: 600, fontSize: 'calc(var(--dsb-fs) - 2px)', color: '#e3b341', background: 'rgba(227,179,65,0.14)', border: '1px solid rgba(227,179,65,0.45)', borderRadius: 999, padding: '1px 8px' } }, '在跑 ' + c.busyN)
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
                  return h('div', { style: { maxHeight: 320, overflowY: 'auto', paddingRight: 4 } }, rows)
                })(),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 } },
                  h('button', { className: 'dsb-btn', onClick: () => setAsk(false) }, '取消'),
                  h('button', { className: 'dsb-btn', disabled: sending, onClick: confirmDispatch }, sending ? '派发中…' : '确认派工'),
                ),
              ),
            )
          : null,
      )
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
            { name: 'sidebar.panellist', id: PANEL_KEY, order: 26, label: function () { return '作业板' } },
            Icon,
          )
        })

        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: PANEL_KEY }, Panel)
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




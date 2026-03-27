'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { SessionProvider, useSession, signIn, signOut } from 'next-auth/react'
import { categorizeEmail } from '@/lib/categorize'

// ─── Default deals (user can add/edit/delete via UI) ───────────────────────
const DEFAULT_DEALS = [
  { id: 'deal-1', name: 'New Deal', color: '#4fc3f7', desc: 'Add a description', keywords: [] },
]

// ─── SVG helpers ───────────────────────────────────────────────────────────
const NS = 'http://www.w3.org/2000/svg'
function svgEl(tag, attrs) {
  const el = document.createElementNS(NS, tag)
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v))
  return el
}
function makeRect(x, y, w, h, rx, fill, stroke, sw) {
  return svgEl('rect', { x: x - w / 2, y: y - h / 2, width: w, height: h, rx, fill, stroke, 'stroke-width': sw })
}
function makeText(x, y, txt, font, size, weight, fill, anchor = 'middle') {
  const t = svgEl('text', { x, y, 'text-anchor': anchor, 'dominant-baseline': 'middle', 'font-family': font, 'font-size': size, 'font-weight': weight, fill })
  t.textContent = txt; return t
}
function makeCurve(x1, y1, x2, y2, stroke, sw, dash, opacity) {
  const my = (y1 + y2) / 2
  return svgEl('path', { d: `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`, fill: 'none', stroke, 'stroke-width': sw, 'stroke-dasharray': dash, opacity })
}

// ─── Main app (inner, requires session) ────────────────────────────────────
function DealFlowApp() {
  const { data: session, status } = useSession()

  const [emails, setEmails] = useState([])
  const [deals, setDeals] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_DEALS
    try { return JSON.parse(localStorage.getItem('df-deals')) || DEFAULT_DEALS }
    catch { return DEFAULT_DEALS }
  })
  const [tree, setTree] = useState({})           // { dealId: { name, color, branches: { branchName: [emailId] } } }
  const [activeDeal, setActiveDeal] = useState(null)
  const [selEmail, setSelEmail] = useState(null)
  const [unread, setUnread] = useState(0)
  const [folders, setFolders] = useState([])
  const [selectedFolder, setSelectedFolder] = useState('inbox')
  const [sinceDate, setSinceDate] = useState(() => {
    if (typeof window === 'undefined') return ''
    return localStorage.getItem('df-since') || ''
  })
  const [loading, setLoading] = useState(false)
  const [fetchErr, setFetchErr] = useState(null)
  const [showAddDeal, setShowAddDeal] = useState(false)
  const [editDeal, setEditDeal] = useState(null)
  const [hoverEmail, setHoverEmail] = useState(null)      // email shown in hover preview
  const [hoverY, setHoverY] = useState(0)
  const [suggesting, setSuggesting] = useState(false)    // loading state for Claude
  const [suggestions, setSuggestions] = useState(null)   // Claude's suggested deals
  const [selectedSuggs, setSelectedSuggs] = useState({}) // which suggestions are checked
  const hoverTimer = useRef(null)

  const svgRef = useRef(null)
  const worldRef = useRef(null)
  const nodePosRef = useRef({})
  const vp = useRef({ x: 0, y: 0, scale: 1 })
  const pan = useRef({ active: false, sx: 0, sy: 0, ox: 0, oy: 0 })
  const drag = useRef(null)

  // ── Persist deals to localStorage ──────────────────────────────────────
  useEffect(() => {
    localStorage.setItem('df-deals', JSON.stringify(deals))
    // Reset positions when deals change
    deals.forEach(d => { if (!nodePosRef.current[d.id]) nodePosRef.current[d.id] = {} })
  }, [deals])

  // ── Build tree from emails + deals ─────────────────────────────────────
  useEffect(() => {
    const newTree = {}
    deals.forEach(deal => {
      newTree[deal.id] = { name: deal.name, color: deal.color, desc: deal.desc, branches: {} }
    })
    emails.forEach(em => {
      const matches = categorizeEmail(em, deals)
      matches.forEach(({ dealId, branch }) => {
        if (!newTree[dealId]) return
        if (!newTree[dealId].branches[branch]) newTree[dealId].branches[branch] = []
        newTree[dealId].branches[branch].push(em.id)
      })
      em._matches = matches
    })
    setTree(newTree)
  }, [emails, deals])

  // ── Render SVG whenever tree / activeDeal / selEmail changes ───────────
  useEffect(() => {
    renderCanvas()
  }, [tree, activeDeal, selEmail]) // eslint-disable-line

  // ── Fetch folder list ───────────────────────────────────────────────────
  useEffect(() => {
    if (!session?.accessToken) return
    fetch('/api/folders')
      .then(r => r.json())
      .then(data => { if (data.folders) setFolders(data.folders) })
  }, [session])

  // ── Fetch emails from selected folder ──────────────────────────────────
  const fetchEmails = useCallback(async () => {
    if (!session?.accessToken) return
    setLoading(true); setFetchErr(null)
    try {
      const params = new URLSearchParams({ folderId: selectedFolder })
      if (sinceDate) params.set('since', sinceDate)
      const res = await fetch(`/api/emails?${params}`)
      const data = await res.json()
      if (data.error) { setFetchErr(data.error); return }
      setEmails(data.emails)
      setUnread(data.emails.filter(e => !e.isRead).length)
    } catch (e) {
      setFetchErr(e.message)
    } finally {
      setLoading(false)
    }
  }, [session, selectedFolder, sinceDate])

  useEffect(() => {
    if (!session?.accessToken) return
    fetchEmails()
    const t = setInterval(fetchEmails, 30000)
    return () => clearInterval(t)
  }, [fetchEmails])

  // ── Set first active deal once tree builds ──────────────────────────────
  useEffect(() => {
    if (!activeDeal) {
      const first = deals.find(d => Object.keys(tree[d.id]?.branches || {}).length > 0)
      if (first) setActiveDeal(first.id)
    }
  }, [tree]) // eslint-disable-line

  // ══════════════════════════════════════════════════════════════════
  // SVG CANVAS
  // ══════════════════════════════════════════════════════════════════
  function applyVP() {
    if (!worldRef.current) return
    const { x, y, scale } = vp.current
    worldRef.current.setAttribute('transform', `translate(${x},${y}) scale(${scale})`)
  }

  function renderCanvas() {
    const world = worldRef.current
    if (!world) return
    world.innerHTML = ''

    const d = tree[activeDeal]
    if (!d) { renderEmpty(world); return }
    const branches = Object.entries(d.branches)
    if (!branches.length) { renderEmpty(world); return }

    const color = d.color
    const cx = 440, cy = 90
    const np = nodePosRef.current[activeDeal] || {}
    if (!np.root) np.root = { x: cx, y: cy }
    nodePosRef.current[activeDeal] = np

    const fanW = Math.max(branches.length * 165, 420)
    const bY = cy + 175

    branches.forEach(([bn], bi) => {
      const bk = 'b:' + bn
      if (!np[bk]) {
        np[bk] = {
          x: branches.length === 1 ? cx : cx - fanW / 2 + fanW / (branches.length - 1) * bi,
          y: bY,
        }
      }
    })

    // Links
    const linksG = svgEl('g', {})
    branches.forEach(([bn]) => {
      const bp = np['b:' + bn]
      const rp = np.root
      const hlit = selEmail?._matches?.some(m => m.dealId === activeDeal && m.branch === bn)
      linksG.appendChild(makeCurve(rp.x, rp.y + 22, bp.x, bp.y - 18, color, hlit ? 2 : 1, hlit ? 'none' : '5 3', hlit ? 0.8 : 0.22))
    })
    world.appendChild(linksG)

    // Branch nodes
    branches.forEach(([bn, eids]) => {
      const bk = 'b:' + bn
      const bp = np[bk]
      const hlit = selEmail?._matches?.some(m => m.dealId === activeDeal && m.branch === bn)
      const BW = 132, BH = 38
      const g = svgEl('g', { style: 'cursor:grab' })
      const r = makeRect(bp.x, bp.y, BW, BH, 8, hlit ? color + '44' : color + '16', color, hlit ? 1.5 : 0.6)
      if (hlit) r.style.filter = `drop-shadow(0 0 8px ${color}66)`
      g.appendChild(r)
      g.appendChild(makeText(bp.x, bp.y - 7, bn.length > 16 ? bn.slice(0, 15) + '…' : bn, 'Syne,sans-serif', 10, 700, hlit ? '#fff' : color + 'ee'))
      g.appendChild(makeText(bp.x, bp.y + 8, `${eids.length} email${eids.length !== 1 ? 's' : ''}`, 'IBM Plex Mono,monospace', 7.5, 400, color + '88'))
      g.addEventListener('mousedown', e => { e.stopPropagation(); startDrag(e, bk) })
      g.addEventListener('mouseenter', ev => showBranchTip(ev, d, bn, eids))
      g.addEventListener('mouseleave', hideTip)
      world.appendChild(g)
    })

    // Root node (drawn last — on top)
    const rp = np.root
    const total = Object.values(d.branches).reduce((s, a) => s + a.length, 0)
    const dealHlit = selEmail?._matches?.some(m => m.dealId === activeDeal)
    const rg = svgEl('g', { style: 'cursor:grab' })
    const rr = makeRect(rp.x, rp.y, 160, 46, 12, dealHlit ? color + '33' : color + '22', color, dealHlit ? 2 : 1.8)
    if (dealHlit) rr.style.filter = `drop-shadow(0 0 16px ${color}55)`
    rg.appendChild(rr)
    rg.appendChild(makeText(rp.x, rp.y - 8, d.name, 'Syne,sans-serif', 13, 800, dealHlit ? '#fff' : color))
    rg.appendChild(makeText(rp.x, rp.y + 9, `${total} emails · ${branches.length} branches`, 'IBM Plex Mono,monospace', 7.5, 400, dealHlit ? 'rgba(255,255,255,.55)' : color + '88'))
    rg.addEventListener('mousedown', e => { e.stopPropagation(); startDrag(e, 'root') })
    rg.addEventListener('mouseenter', ev => showDealTip(ev, d, activeDeal))
    rg.addEventListener('mouseleave', hideTip)
    world.appendChild(rg)

    applyVP()
  }

  function renderEmpty(world) {
    const t = svgEl('text', { x: 420, y: 260, 'text-anchor': 'middle', fill: '#1c2535', 'font-family': 'Syne,sans-serif', 'font-size': 14 })
    t.textContent = activeDeal ? 'No emails matched this deal yet' : 'Select a deal →'
    world.appendChild(t)
    applyVP()
  }

  // ── Drag nodes ──────────────────────────────────────────────────────────
  function startDrag(e, nodeKey) {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const { x, y, scale } = vp.current
    const wx = (e.clientX - rect.left - x) / scale
    const wy = (e.clientY - rect.top - y) / scale
    const pos = nodePosRef.current[activeDeal]?.[nodeKey] || { x: 0, y: 0 }
    drag.current = { nodeKey, ox: wx - pos.x, oy: wy - pos.y }
    pan.current.active = false
  }

  // ── Canvas mouse events (pan + zoom) ────────────────────────────────────
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return

    const onDown = e => {
      if (drag.current) return
      pan.current = { active: true, sx: e.clientX, sy: e.clientY, ox: vp.current.x, oy: vp.current.y }
      svg.style.cursor = 'grabbing'
    }
    const onMove = e => {
      if (drag.current) {
        const rect = svg.getBoundingClientRect()
        const { x, y, scale } = vp.current
        const wx = (e.clientX - rect.left - x) / scale
        const wy = (e.clientY - rect.top - y) / scale
        if (!nodePosRef.current[activeDeal]) nodePosRef.current[activeDeal] = {}
        nodePosRef.current[activeDeal][drag.current.nodeKey] = {
          x: wx - drag.current.ox,
          y: wy - drag.current.oy,
        }
        renderCanvas(); return
      }
      if (!pan.current.active) return
      vp.current.x = pan.current.ox + (e.clientX - pan.current.sx)
      vp.current.y = pan.current.oy + (e.clientY - pan.current.sy)
      applyVP()
    }
    const onUp = () => {
      drag.current = null
      pan.current.active = false
      svg.style.cursor = 'default'
    }
    const onWheel = e => {
      e.preventDefault()
      const rect = svg.getBoundingClientRect()
      const mx = e.clientX - rect.left, my = e.clientY - rect.top
      const f = e.deltaY < 0 ? 1.1 : 0.91
      const ns = Math.min(3, Math.max(0.2, vp.current.scale * f))
      vp.current.x = mx - (mx - vp.current.x) * (ns / vp.current.scale)
      vp.current.y = my - (my - vp.current.y) * (ns / vp.current.scale)
      vp.current.scale = ns
      applyVP()
    }

    svg.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      svg.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      svg.removeEventListener('wheel', onWheel)
    }
  }, [activeDeal]) // eslint-disable-line

  function zoomBy(f) {
    const svg = svgRef.current; if (!svg) return
    const cx = svg.clientWidth / 2, cy = svg.clientHeight / 2
    const ns = Math.min(3, Math.max(0.2, vp.current.scale * f))
    vp.current.x = cx - (cx - vp.current.x) * (ns / vp.current.scale)
    vp.current.y = cy - (cy - vp.current.y) * (ns / vp.current.scale)
    vp.current.scale = ns; applyVP()
  }

  function fitView() {
    vp.current = { x: 0, y: 0, scale: 1 }; applyVP(); renderCanvas()
  }

  // ── Tooltip ─────────────────────────────────────────────────────────────
  const tipRef = useRef(null)
  function posTip(e) {
    const tt = tipRef.current; if (!tt) return
    let tx = e.clientX + 16, ty = e.clientY + 14
    if (tx + 250 > window.innerWidth) tx = e.clientX - 255
    if (ty + 220 > window.innerHeight) ty = e.clientY - 200
    tt.style.left = tx + 'px'; tt.style.top = ty + 'px'
  }
  function showDealTip(e, d, did) {
    const tt = tipRef.current; if (!tt) return
    const total = Object.values(d.branches).reduce((s, a) => s + a.length, 0)
    tt.innerHTML = `<div style="font-family:Syne,sans-serif;font-size:12px;color:${d.color};font-weight:800;margin-bottom:2px">${d.name}</div>
<div style="font-size:8px;color:#4a5468;margin-bottom:8px">${d.desc}</div>
${Object.entries(d.branches).map(([bn, ids]) => `<div style="display:flex;justify-content:space-between;font-size:8.5px;margin-bottom:2px"><span style="color:#4a5468">${bn}</span><span style="color:${d.color}">${ids.length}</span></div>`).join('')}
<div style="border-top:1px solid #242838;margin-top:5px;padding-top:5px;font-size:8.5px;display:flex;justify-content:space-between"><span style="color:#4a5468">Total</span><span style="color:#7a8494">${total} emails</span></div>`
    posTip(e); tt.style.opacity = 1
  }
  function showBranchTip(e, d, bn, eids) {
    const tt = tipRef.current; if (!tt) return
    const recent = eids.slice(-4).reverse().map(id => emails.find(em => em.id === id)).filter(Boolean)
    tt.innerHTML = `<div style="font-family:Syne,sans-serif;font-size:12px;color:${d.color};font-weight:800;margin-bottom:2px">${bn}</div>
<div style="font-size:8px;color:#4a5468;margin-bottom:8px">${d.name} · ${eids.length} email${eids.length !== 1 ? 's' : ''}</div>
${recent.map(em => `<div style="font-size:7.5px;color:#4a5468;padding:2px 0;border-bottom:1px solid #1c2030;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><span style="color:${d.color}88">${em.from?.emailAddress?.name || '?'}</span>  ${(em.subject || '').slice(0, 30)}${(em.subject || '').length > 30 ? '…' : ''}</div>`).join('')}`
    posTip(e); tt.style.opacity = 1
  }
  function hideTip() { if (tipRef.current) tipRef.current.style.opacity = 0 }

  // ── Deal management ──────────────────────────────────────────────────────
  function saveDeal(dealData) {
    if (editDeal) {
      setDeals(prev => prev.map(d => d.id === editDeal.id ? { ...d, ...dealData } : d))
    } else {
      const newDeal = { ...dealData, id: 'deal-' + Date.now() }
      setDeals(prev => [...prev, newDeal])
      setActiveDeal(newDeal.id)
    }
    setShowAddDeal(false); setEditDeal(null)
  }
  function deleteDeal(id) {
    setDeals(prev => prev.filter(d => d.id !== id))
    if (activeDeal === id) setActiveDeal(null)
  }

  // ── Persist sinceDate ────────────────────────────────────────────────────
  useEffect(() => {
    localStorage.setItem('df-since', sinceDate)
  }, [sinceDate])

  // ── Select email (highlights tree) ───────────────────────────────────────
  function selectEmail(em) {
    setSelEmail(em)
    if (em._matches?.length) setActiveDeal(em._matches[0].dealId)
  }

  // ── Hover preview handlers ────────────────────────────────────────────────
  function onEmailHover(e, em) {
    clearTimeout(hoverTimer.current)
    const rect = e.currentTarget.getBoundingClientRect()
    setHoverY(rect.top)
    setHoverEmail(em)
  }
  function onEmailLeave() {
    hoverTimer.current = setTimeout(() => setHoverEmail(null), 180)
  }

  // ── Claude: suggest deal categories ──────────────────────────────────────
  async function suggestDeals() {
    if (!emails.length) return
    setSuggesting(true); setSuggestions(null)
    try {
      const res = await fetch('/api/suggest-deals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails }),
      })
      const data = await res.json()
      if (data.suggestions) {
        setSuggestions({ items: data.suggestions, total: data.total })
        // Pre-select all suggestions
        const sel = {}
        data.suggestions.forEach((s, i) => { sel[i] = true })
        setSelectedSuggs(sel)
      }
    } finally {
      setSuggesting(false)
    }
  }

  function addSelectedSuggestions() {
    const toAdd = suggestions.items
      .filter((_, i) => selectedSuggs[i])
      .map(s => ({
        id: 'deal-' + Date.now() + '-' + Math.random().toString(36).slice(2),
        name: s.name,
        desc: s.description,
        color: s.color,
        keywords: s.keywords,
      }))
    setDeals(prev => [...prev.filter(d => d.id !== 'deal-1'), ...toAdd])
    setSuggestions(null)
    if (toAdd.length) setActiveDeal(toAdd[0].id)
  }

  // ══════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════

  if (status === 'loading') return <div style={S.loading}>Loading…</div>

  if (!session) return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:'100vh', background:'#0a0c10', fontFamily:"'IBM Plex Mono',monospace", gap:20 }}>
      <div style={{ fontFamily:'Syne,sans-serif', fontSize:28, fontWeight:800, color:'#4fc3f7' }}>Deal<span style={{color:'#dde1ea'}}>Flow</span></div>
      <div style={{ fontSize:11, color:'#4a5468', maxWidth:320, textAlign:'center', lineHeight:1.7 }}>
        Connect your Outlook inbox to automatically categorise emails by deal.
      </div>
      <button onClick={() => signIn('azure-ad')} style={{ marginTop:8, background:'#4fc3f7', color:'#0a0c10', border:'none', borderRadius:6, padding:'10px 24px', fontFamily:"'IBM Plex Mono',monospace", fontSize:11, fontWeight:600, cursor:'pointer' }}>
        Sign in with Microsoft
      </button>
    </div>
  )

  return (
    <div style={S.app}>
      {/* ── Header ── */}
      <header style={S.header}>
        <div style={S.logo}>Deal<span style={{ color: '#dde1ea' }}>Flow</span></div>
        <div style={S.hStats}>
          <span><span style={S.dot} />
            {session.user?.name || session.user?.email}
          </span>
          <span>Emails: <strong style={{ color: '#7a8494' }}>{emails.length}</strong></span>
          <span>Deals: <strong style={{ color: '#7a8494' }}>{deals.filter(d => Object.keys(tree[d.id]?.branches || {}).length > 0).length}</strong></span>
          {loading && <span style={{ color: '#4fc3f7' }}>Syncing…</span>}
          {fetchErr && <span style={{ color: '#ff6b6b' }}>Error: {fetchErr}</span>}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={S.btn} onClick={fitView}>⊡ Fit</button>
          <button style={S.btn} onClick={fetchEmails}>↺ Refresh</button>
          <button style={S.btn} onClick={() => signOut()}>Sign out</button>
        </div>
      </header>

      <div style={S.main}>
        {/* ── Left: Inbox ── */}
        <aside style={S.inbox}>
          <div style={S.panelHdr}>
            Outlook Inbox
            <span style={{ ...S.badge, background: unread > 0 ? '#4fc3f7' : '#1a1e28', color: unread > 0 ? '#0a0c10' : '#4a5468' }}>{unread}</span>
          </div>
          <div style={{ padding: '6px 12px', borderBottom: '1px solid #1c2030', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
            <select
              value={selectedFolder}
              onChange={e => setSelectedFolder(e.target.value)}
              style={{ width: '100%', background: '#141720', border: '1px solid #242838', color: '#7a8494', fontFamily: "'IBM Plex Mono',monospace", fontSize: 9.5, padding: '4px 8px', borderRadius: 4, cursor: 'pointer', outline: 'none' }}
            >
              <option value="inbox">Inbox</option>
              <option value="sentitems">Sent Items</option>
              {folders.map(f => (
                <option key={f.id} value={f.id}>{f.displayName} ({f.totalItemCount})</option>
              ))}
            </select>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 8, color: '#4a5468', whiteSpace: 'nowrap' }}>From date</span>
              <input
                type="date"
                value={sinceDate}
                onChange={e => setSinceDate(e.target.value)}
                style={{ flex: 1, background: '#141720', border: '1px solid #242838', color: '#7a8494', fontFamily: "'IBM Plex Mono',monospace", fontSize: 9.5, padding: '3px 7px', borderRadius: 4, outline: 'none', colorScheme: 'dark' }}
              />
              {sinceDate && (
                <button onClick={() => setSinceDate('')} style={{ ...S.btn, fontSize: 9, padding: '2px 7px', color: '#4a5468' }}>✕</button>
              )}
            </div>
          </div>
          <div style={S.emailList}>
            {emails.length === 0 && (
              <div style={{ padding: 16, fontSize: 9, color: '#4a5468' }}>
                No emails found. Try refreshing or selecting a different folder.
              </div>
            )}
            {emails.map(em => {
              const matches = em._matches || []
              const isSel = selEmail?.id === em.id
              return (
                <div
                  key={em.id}
                  onClick={() => selectEmail(em)}
                  onMouseEnter={e => onEmailHover(e, em)}
                  onMouseLeave={onEmailLeave}
                  style={{
                    ...S.emailItem,
                    background: isSel ? '#141720' : 'transparent',
                    borderLeft: isSel ? '2px solid #4fc3f7' : '2px solid transparent',
                  }}
                >
                  <div style={S.eSender}>
                    {!em.isRead && <span style={S.unreadDot} />}
                    {em.from?.emailAddress?.name || em.from?.emailAddress?.address || 'Unknown'}
                  </div>
                  <div style={S.eSubject}>{em.subject || '(no subject)'}</div>
                  <div style={S.ePreview}>{em.bodyPreview}</div>
                  <div style={S.eMeta}>
                    <span style={{ fontSize: 7.5, color: '#4a5468' }}>
                      {new Date(em.receivedDateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                      {matches.slice(0, 2).map(m => (
                        <span key={m.dealId} style={{ ...S.tag, background: m.dealColor + '22', color: m.dealColor, border: `1px solid ${m.dealColor}44` }}>
                          {m.dealName}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
          {/* Email detail pane */}
          {selEmail && (
            <div style={S.detailPane}>
              <div style={{ fontSize: 9.5, color: '#dde1ea', marginBottom: 2 }}>
                {selEmail.from?.emailAddress?.name}
              </div>
              <div style={{ fontSize: 10.5, fontFamily: 'Syne,sans-serif', color: '#4fc3f7', marginBottom: 6 }}>
                {selEmail.subject}
              </div>
              <div style={{ fontSize: 8.5, color: '#4a5468', lineHeight: 1.65 }}>
                {selEmail.bodyPreview}
              </div>
            </div>
          )}
        </aside>

        {/* ── Centre: SVG canvas ── */}
        <div style={S.canvasWrap}>
          <svg ref={svgRef} style={S.svg} xmlns="http://www.w3.org/2000/svg">
            <g ref={worldRef} id="world" />
          </svg>
          <div style={S.zoomCtrl}>
            <button style={S.zb} onClick={() => zoomBy(1.2)}>+</button>
            <button style={S.zb} onClick={() => zoomBy(0.83)}>−</button>
          </div>
          <div style={S.hint}>Drag to pan · Scroll to zoom · Drag nodes to rearrange</div>
        </div>

        {/* ── Right: Deal sidebar ── */}
        <aside style={S.sidebar}>
          <div style={S.panelHdr}>
            Deals
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                onClick={suggestDeals}
                disabled={suggesting || !emails.length}
                style={{ ...S.btn, fontSize: 8, padding: '2px 8px', color: suggesting ? '#4a5468' : '#9c6dff', borderColor: suggesting ? '#242838' : '#9c6dff44' }}
              >
                {suggesting ? '…' : '✦ Suggest'}
              </button>
              <button onClick={() => { setEditDeal(null); setShowAddDeal(true) }} style={{ ...S.btn, fontSize: 8, padding: '2px 8px' }}>+ Add</button>
            </div>
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {deals.map(deal => {
              const dt = tree[deal.id] || { branches: {} }
              const totalE = Object.values(dt.branches).reduce((s, a) => s + a.length, 0)
              const bNames = Object.keys(dt.branches)
              const isActive = activeDeal === deal.id
              return (
                <div
                  key={deal.id}
                  onClick={() => setActiveDeal(deal.id)}
                  style={{ ...S.dealCard, background: isActive ? '#141720' : 'transparent' }}
                >
                  <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: deal.color, borderRadius: '0 2px 2px 0' }} />
                  <div style={{ fontFamily: 'Syne,sans-serif', fontSize: 11, fontWeight: 700, color: deal.color, marginBottom: 2, paddingLeft: 8 }}>
                    {deal.name}
                  </div>
                  <div style={{ fontSize: 7.5, color: '#4a5468', marginBottom: 6, paddingLeft: 8, lineHeight: 1.4 }}>{deal.desc}</div>
                  <div style={{ display: 'flex', gap: 6, paddingLeft: 8, marginBottom: 6 }}>
                    <span style={S.dstat}>{totalE} emails</span>
                    <span style={S.dstat}>{bNames.length} branches</span>
                  </div>
                  {bNames.slice(0, 4).map(b => (
                    <div key={b} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 7.5, color: '#4a5468', padding: '2px 8px' }}>
                      <span>{b}</span><span style={{ color: '#7a8494' }}>{dt.branches[b].length}</span>
                    </div>
                  ))}
                  {bNames.length > 4 && <div style={{ fontSize: 7.5, color: '#2a3040', paddingLeft: 8 }}>+{bNames.length - 4} more</div>}
                  <div style={{ display: 'flex', gap: 5, padding: '6px 8px 0', borderTop: '1px solid #1c2030', marginTop: 5 }}>
                    <button onClick={e => { e.stopPropagation(); setEditDeal(deal); setShowAddDeal(true) }} style={{ ...S.btn, fontSize: 7.5, padding: '2px 7px' }}>Edit</button>
                    <button onClick={e => { e.stopPropagation(); deleteDeal(deal.id) }} style={{ ...S.btn, fontSize: 7.5, padding: '2px 7px', color: '#ff6b6b44' }}>Delete</button>
                  </div>
                </div>
              )
            })}
          </div>
        </aside>
      </div>

      {/* ── Tooltip ── */}
      <div ref={tipRef} style={S.tooltip} />

      {/* ── Hover email preview ── */}
      {hoverEmail && (
        <div
          onMouseEnter={() => clearTimeout(hoverTimer.current)}
          onMouseLeave={onEmailLeave}
          style={{
            position: 'fixed',
            left: 278,
            top: Math.min(hoverY, window.innerHeight - 320),
            width: 340,
            background: '#141720',
            border: '1px solid #242838',
            borderRadius: 8,
            padding: '13px 15px',
            zIndex: 200,
            boxShadow: '0 8px 32px rgba(0,0,0,.7)',
            pointerEvents: 'auto',
          }}
        >
          <div style={{ fontFamily: 'Syne,sans-serif', fontSize: 12, fontWeight: 700, color: '#dde1ea', marginBottom: 3, lineHeight: 1.35 }}>
            {hoverEmail.subject || '(no subject)'}
          </div>
          <div style={{ fontSize: 8.5, color: '#4a5468', marginBottom: 10 }}>
            <span style={{ color: '#7a8494' }}>{hoverEmail.from?.emailAddress?.name}</span>
            {' · '}
            <span>{new Date(hoverEmail.receivedDateTime).toLocaleDateString(undefined, { day:'numeric', month:'short', year:'numeric' })}</span>
          </div>
          <div style={{ fontSize: 9, color: '#7a8494', lineHeight: 1.7, marginBottom: 10 }}>
            {hoverEmail.bodyPreview}
          </div>
          {hoverEmail._matches?.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid #1c2030', paddingTop: 8 }}>
              {hoverEmail._matches.map(m => (
                <div key={m.dealId + m.branch} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: m.dealColor, flexShrink: 0, display: 'inline-block' }} />
                  <span style={{ fontSize: 8.5, fontFamily: 'Syne,sans-serif', fontWeight: 700, color: m.dealColor }}>{m.dealName}</span>
                  <span style={{ fontSize: 8.5, color: '#2a3040' }}>›</span>
                  <span style={{ fontSize: 8.5, color: '#4a5468' }}>{m.branch}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 8, color: '#2a3040', borderTop: '1px solid #1c2030', paddingTop: 8 }}>
              Not matched to any deal
            </div>
          )}
        </div>
      )}

      {/* ── Suggest deals modal ── */}
      {suggestions && (
        <div style={S.modalOverlay} onClick={e => e.target === e.currentTarget && setSuggestions(null)}>
          <div style={{ ...S.modal, width: 520, maxHeight: '85vh', display: 'flex', flexDirection: 'column', gap: 0 }}>
            <div style={{ fontFamily: 'Syne,sans-serif', fontSize: 15, fontWeight: 800, color: '#dde1ea', marginBottom: 4 }}>
              Suggested Deal Categories
            </div>
            <div style={{ fontSize: 8.5, color: '#4a5468', marginBottom: 16 }}>
              Based on {suggestions.total} emails · Claude identified {suggestions.items.length} distinct deals. Select which to add.
            </div>
            <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
              {suggestions.items.map((s, i) => (
                <div
                  key={i}
                  onClick={() => setSelectedSuggs(prev => ({ ...prev, [i]: !prev[i] }))}
                  style={{ padding: '10px 12px', borderRadius: 7, border: `1px solid ${selectedSuggs[i] ? s.color + '55' : '#242838'}`, background: selectedSuggs[i] ? s.color + '0e' : '#0e1116', cursor: 'pointer' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: s.color, flexShrink: 0, display: 'inline-block' }} />
                    <span style={{ fontFamily: 'Syne,sans-serif', fontSize: 12, fontWeight: 700, color: s.color, flex: 1 }}>{s.name}</span>
                    <span style={{ fontSize: 8.5, color: '#4a5468' }}>{s.count} emails · {Math.round(s.proportion * 100)}%</span>
                    <span style={{ fontSize: 11, color: selectedSuggs[i] ? s.color : '#2a3040' }}>{selectedSuggs[i] ? '✓' : '○'}</span>
                  </div>
                  {/* Proportion bar */}
                  <div style={{ height: 3, background: '#1a1e28', borderRadius: 2, marginBottom: 6, overflow: 'hidden' }}>
                    <div style={{ width: `${Math.round(s.proportion * 100)}%`, height: '100%', background: s.color, borderRadius: 2 }} />
                  </div>
                  <div style={{ fontSize: 8, color: '#4a5468', marginBottom: 5 }}>{s.description}</div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {s.keywords.map(kw => (
                      <span key={kw} style={{ fontSize: 7.5, padding: '1px 6px', background: s.color + '1a', color: s.color + 'cc', borderRadius: 3 }}>{kw}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid #1c2030', paddingTop: 12 }}>
              <button style={S.btn} onClick={() => setSuggestions(null)}>Cancel</button>
              <button
                onClick={addSelectedSuggestions}
                style={{ ...S.btn, background: '#9c6dff', color: '#0a0c10', borderColor: '#9c6dff' }}
              >
                Add {Object.values(selectedSuggs).filter(Boolean).length} Selected
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add/Edit Deal Modal ── */}
      {showAddDeal && (
        <DealModal
          initial={editDeal}
          onSave={saveDeal}
          onClose={() => { setShowAddDeal(false); setEditDeal(null) }}
        />
      )}

    </div>
  )
}

// ─── Add / Edit Deal Modal ──────────────────────────────────────────────────
function DealModal({ initial, onSave, onClose }) {
  const COLORS = ['#4fc3f7', '#9c6dff', '#00d98b', '#ff6b6b', '#ffa657', '#f78166', '#79c0ff', '#56d364']
  const [name, setName] = useState(initial?.name || '')
  const [desc, setDesc] = useState(initial?.desc || '')
  const [color, setColor] = useState(initial?.color || COLORS[0])
  const [kws, setKws] = useState((initial?.keywords || []).join(', '))

  function submit(e) {
    e.preventDefault()
    if (!name.trim()) return
    onSave({
      name: name.trim(),
      desc: desc.trim(),
      color,
      keywords: kws.split(',').map(k => k.trim()).filter(Boolean),
    })
  }

  return (
    <div style={S.modalOverlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <form onSubmit={submit} style={S.modal}>
        <div style={{ fontFamily: 'Syne,sans-serif', fontSize: 14, fontWeight: 800, color: '#dde1ea', marginBottom: 16 }}>
          {initial ? 'Edit Deal' : 'Add Deal'}
        </div>
        <label style={S.label}>Deal Name</label>
        <input style={S.input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Project Helix" required />
        <label style={S.label}>Description</label>
        <input style={S.input} value={desc} onChange={e => setDesc(e.target.value)} placeholder="e.g. Series B SaaS acquisition — $45M" />
        <label style={S.label}>Keywords (comma-separated)</label>
        <input style={S.input} value={kws} onChange={e => setKws(e.target.value)} placeholder="helix, project helix, SaaS deal" />
        <div style={{ fontSize: 8, color: '#4a5468', marginTop: -10, marginBottom: 12 }}>
          Emails containing these words will be categorised into this deal.
        </div>
        <label style={S.label}>Colour</label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {COLORS.map(c => (
            <div key={c} onClick={() => setColor(c)} style={{ width: 20, height: 20, borderRadius: '50%', background: c, cursor: 'pointer', outline: color === c ? `2px solid ${c}` : 'none', outlineOffset: 2 }} />
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" style={S.btn} onClick={onClose}>Cancel</button>
          <button type="submit" style={{ ...S.btn, background: color, color: '#0a0c10', borderColor: color }}>
            {initial ? 'Save' : 'Add Deal'}
          </button>
        </div>
      </form>
    </div>
  )
}

// ─── Styles (inline, no extra CSS files needed) ─────────────────────────────
const S = {
  app: { display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: '#0a0c10', color: '#dde1ea', fontFamily: "'IBM Plex Mono',monospace" },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px', borderBottom: '1px solid #1c2030', background: '#0e1116', flexShrink: 0 },
  logo: { fontFamily: 'Syne,sans-serif', fontWeight: 800, fontSize: 16, color: '#4fc3f7', letterSpacing: -0.5 },
  hStats: { display: 'flex', gap: 18, fontSize: 9.5, color: '#4a5468' },
  dot: { display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#00d98b', marginRight: 5, verticalAlign: 'middle' },
  btn: { background: '#141720', border: '1px solid #242838', color: '#7a8494', fontFamily: "'IBM Plex Mono',monospace", fontSize: 9.5, padding: '4px 11px', borderRadius: 4, cursor: 'pointer' },
  main: { display: 'flex', flex: 1, overflow: 'hidden' },
  inbox: { width: 272, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #1c2030', background: '#0e1116' },
  panelHdr: { padding: '10px 13px 8px', borderBottom: '1px solid #1c2030', fontSize: 8.5, fontWeight: 500, textTransform: 'uppercase', letterSpacing: 2, color: '#4a5468', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 },
  badge: { fontSize: 8, padding: '1px 6px', borderRadius: 8, fontWeight: 600 },
  emailList: { overflowY: 'auto', flex: 1 },
  emailItem: { padding: '9px 12px', borderBottom: '1px solid #1c2030', cursor: 'pointer', paddingLeft: 10 },
  eSender: { fontSize: 9.5, fontWeight: 500, color: '#dde1ea', marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  eSubject: { fontSize: 8.5, color: '#7a8494', marginBottom: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  ePreview: { fontSize: 7.5, color: '#4a5468', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  eMeta: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  unreadDot: { display: 'inline-block', width: 5, height: 5, borderRadius: '50%', background: '#4fc3f7', marginRight: 5, verticalAlign: 'middle' },
  tag: { fontSize: 7, padding: '1px 5px', borderRadius: 3, fontWeight: 500 },
  detailPane: { padding: 12, borderTop: '1px solid #1c2030', fontSize: 8.5, lineHeight: 1.65, maxHeight: 160, overflowY: 'auto', flexShrink: 0 },
  canvasWrap: { flex: 1, position: 'relative', overflow: 'hidden', background: '#0a0c10', backgroundImage: 'radial-gradient(circle, #1c2030 1px, transparent 1px)', backgroundSize: '28px 28px' },
  svg: { width: '100%', height: '100%', display: 'block' },
  zoomCtrl: { position: 'absolute', bottom: 14, left: 14, display: 'flex', flexDirection: 'column', gap: 5 },
  zb: { width: 28, height: 28, background: '#141720', border: '1px solid #242838', color: '#7a8494', borderRadius: 5, cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  hint: { position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)', fontSize: 8, color: '#4a5468', background: '#141720', border: '1px solid #1c2030', padding: '4px 10px', borderRadius: 10, pointerEvents: 'none' },
  sidebar: { width: 210, flexShrink: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid #1c2030', background: '#0e1116' },
  dealCard: { padding: '11px 12px', borderBottom: '1px solid #1c2030', cursor: 'pointer', position: 'relative' },
  dstat: { fontSize: 7.5, color: '#7a8494', background: '#1a1e28', padding: '2px 6px', borderRadius: 3 },
  tooltip: { position: 'fixed', pointerEvents: 'none', background: '#141720', border: '1px solid #242838', borderRadius: 8, padding: '10px 13px', fontSize: 9, color: '#4a5468', maxWidth: 240, zIndex: 999, opacity: 0, transition: 'opacity .12s', boxShadow: '0 8px 30px rgba(0,0,0,.6)' },
  loading: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0a0c10', color: '#4a5468', fontFamily: "'IBM Plex Mono',monospace", fontSize: 12 },
  modalOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: '#141720', border: '1px solid #242838', borderRadius: 10, padding: 24, width: 380, display: 'flex', flexDirection: 'column', gap: 8 },
  label: { fontSize: 8.5, color: '#4a5468', textTransform: 'uppercase', letterSpacing: 1.5 },
  input: { background: '#0e1116', border: '1px solid #242838', borderRadius: 5, color: '#dde1ea', fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, padding: '7px 10px', outline: 'none' },
  demoBanner: { position: 'fixed', bottom: 0, left: 0, right: 0, background: '#141720', borderTop: '1px solid #242838', padding: '8px 20px', fontSize: 9.5, color: '#4a5468', textAlign: 'center', zIndex: 50 },
}

// ─── Root export (wraps in SessionProvider) ─────────────────────────────────
export default function Page() {
  return (
    <SessionProvider>
      <DealFlowApp />
    </SessionProvider>
  )
}

/* folio — minimal personal epub reader (Tauri + foliate-js) */

// import view.js registers the <foliate-view> custom element
import { makeBook } from './vendor/foliate-js/view.js'
import { Overlayer } from './vendor/foliate-js/overlayer.js'
// pre-load every module the epub loader imports dynamically, so the
// dynamic `import()` calls resolve from the module cache and never
// hit a fetch during open (quirks in dev-protocol responses)
import './vendor/foliate-js/epub.js'
import './vendor/foliate-js/paginator.js'
import './vendor/foliate-js/fixed-layout.js'
import './vendor/foliate-js/search.js' // view.search imports it dynamically
import './vendor/foliate-js/vendor/zip.js'

// ---------------------------------------------------------------- tauri
const T = window.__TAURI__
const invoke = (T.core?.invoke || T.invoke).bind(null)
const $ = sel => document.querySelector(sel)

const els = {
  library: $('#library'), grid: $('#grid'), empty: $('#empty'),
  reader: $('#reader'), pages: $('#pages'),
  title: $('#rd-title-text'), author: $('#rd-author'), percent: $('#rd-percent'),
  fill: $('#progress-fill'),
  toc: $('#toc'), tocList: $('#toc-list'),
  search: $('#search'), searchInput: $('#search-input'), searchList: $('#search-list'),
  bm: $('#bm'), bmList: $('#bm-list'),
  settings: $('#settings'),
  drop: $('#drop-overlay'),
  toast: $('#toast'),
  rdBody: $('#rd-body'),
  selbar: $('#selbar'), hlbar: $('#hlbar'),
}

// ---------------------------------------------------------------- state
const FONT_SIZES = [16, 18, 20, 22, 24]

let state = { settings: { fontSize: 20, theme: 'sepia' }, books: [] }
let view = null            // <foliate-view>
let currentBookEntry = null
const bytesCache = new Map() // key -> Blob for this session
const coverCache = new Map() // path -> data URL

// ---------------------------------------------------------------- helpers
// saves are tiny and immediate — no debounce to cut short at quit time
let saveLocked = false // true while library.json (and its backup) is unreadable
function persist () {
  if (saveLocked) return
  invoke('save_library', { state: JSON.stringify(state) }).catch(console.error)
}

let toastTimer
function toast (msg, ms = 3200) {
  els.toast.textContent = msg
  els.toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { els.toast.hidden = true }, ms)
}

// FNV-ish hash of the path, as a stable book id (no crypto needed)
function fileKey (path) {
  let h1 = 5381, h2 = 52711
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i)
    h1 = (h1 * 33 ^ c) >>> 0
    h2 = (h2 * 31 ^ c) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

function sortedBooks () {
  return state.books.slice().sort((a, b) => (b.opened || 0) - (a.opened || 0))
}

// read a book's bytes from the data dir (all books are copied there at
// import time). foliate-js needs a File (it checks `file.name`), so wrap.
async function bytesFrom (path) {
  const data = await invoke('read_file', { path })
  return new File([data], path.split('/').pop() || 'book.epub', { type: 'application/epub+zip' })
}

async function coverImg (path, container, initial) {
  try {
    let url = coverCache.get(path)
    if (!url) {
      const data = await invoke('read_file', { path })
      const b = new Blob([data], { type: mimeOf(data) })
      url = await new Promise((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(fr.result)
        fr.onerror = reject
        fr.readAsDataURL(b)
      })
      coverCache.set(path, url)
    }
    const img = document.createElement('img')
    img.src = url
    container.replaceChildren(img)
  } catch {
    const span = document.createElement('span')
    span.className = 'initial'
    span.textContent = initial
    container.replaceChildren(span)
  }
}

function mimeOf (data) {
  const u = new Uint8Array(data)
  if (u[0] === 0xff && u[1] === 0xd8) return 'image/jpeg'
  if (u[0] === 0x89 && u[1] === 0x50) return 'image/png'
  return 'application/octet-stream'
}

// ---------------------------------------------------------------- theming
// colors are single-sourced in styles.css html[data-theme] blocks
function applyTheme (theme) {
  state.settings.theme = theme
  document.documentElement.dataset.theme = theme
  for (const dot of document.querySelectorAll('.dot')) {
    dot.classList.toggle('active', dot.dataset.theme === theme)
  }
  applyContentStyles()
}

function applyFontSize () {
  const idx = FONT_SIZES.indexOf(state.settings.fontSize)
  $('#font-down').disabled = idx === 0
  $('#font-up').disabled = idx === FONT_SIZES.length - 1
  applyContentStyles()
}

function contentCSS () {
  const cs = getComputedStyle(document.documentElement)
  const page = cs.getPropertyValue('--page').trim()
  const fg = cs.getPropertyValue('--page-fg').trim()
  const accent = cs.getPropertyValue('--accent').trim()
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
      font-size: ${state.settings.fontSize}px;
      background: ${page} !important;
    }
    body {
      background: ${page} !important;
      color: ${fg} !important;
    }
    p, li, blockquote, dd {
      line-height: 1.6;
      text-align: justify;
      -webkit-hyphens: auto; hyphens: auto;
      -webkit-hyphenate-limit-before: 3;
      -webkit-hyphenate-limit-after: 2;
      hanging-punctuation: allow-end last;
      widows: 2;
    }
    [align="left"] { text-align: left; }
    [align="right"] { text-align: right; }
    [align="center"] { text-align: center; }
    a, a:link { color: ${accent}; }
    pre { white-space: pre-wrap !important; }
    /* neutralize common book theming so reader theme wins */
    #page-container, .calibre, .chapter, .body, .content {
      background: transparent !important;
      color: inherit !important;
    }
    ::selection { background: rgb(140 110 80 / .35); }
    aside[epub|type~="footnote"], aside[epub|type~="endnote"],
    aside[epub|type~="note"], aside[epub|type~="rearnote"] { display: none; }
  `
}

function applyContentStyles () {
  const r = view?.renderer
  if (!r) return
  // the paginator paints its underlay from the doc background captured at
  // section load; the forwarded setter (see paginator.js) makes this write
  // reach it, and setStyles below triggers the repaint
  r.docBackground = getComputedStyle(document.documentElement)
    .getPropertyValue('--page').trim()
  r.setStyles?.(contentCSS())
}

// ---------------------------------------------------------------- library
function renderLibrary () {
  const books = sortedBooks()
  els.grid.replaceChildren(...books.map(b => bookCardEntry(b)))
  els.grid.style.display = books.length ? '' : 'none'
  els.empty.hidden = books.length > 0
}

function bookCardEntry (book) {
  const card = document.createElement('div')
  card.className = 'book'

  const cover = document.createElement('div')
  cover.className = 'cover'
  const title = book.title || book.path?.split('/').pop() || '?'
  const initial = title.trim().charAt(0).toUpperCase()
  const span = document.createElement('span')
  span.className = 'initial'
  span.textContent = initial
  cover.appendChild(span)
  if (book.cover) coverImg(book.cover, cover, initial) // replaces placeholder
  cover.addEventListener('click', () => openBook(book))

  card.appendChild(cover)

  const meta = document.createElement('div')
  meta.className = 'meta'
  const t = document.createElement('div')
  t.className = 'b-title'
  t.textContent = title
  const m = document.createElement('div')
  m.className = 'b-meta'
  m.textContent = [Math.round((book.fraction || 0) * 100) + '%', book.author]
    .filter(Boolean).join(' · ')
  meta.append(t, m)
  card.appendChild(meta)
  return card
}

// add and optionally open one book. `path` is already inside the data
// dir except for drops, whose bytes arrive as the `data` argument.
async function addBook (path, { openIt = true, data = null } = {}) {
  try {
    const key = fileKey(path)
    let blob = bytesCache.get(key)
    if (!blob) {
      if (data) {
        // dropped file: write via the raw IPC channel — serialized as a
        // JSON array of numbers, a 64 MB book stalls the whole app
        data = new Uint8Array(await data.arrayBuffer())
        const head = new TextEncoder().encode(key) // 16 hex chars — fileKey fixed length
        const body = new Uint8Array(head.length + data.length)
        body.set(head); body.set(data, head.length)
        path = await invoke('import_book', body)
        blob = new File([data], path.split('/').pop(), { type: 'application/epub+zip' })
      } else {
        blob = await bytesFrom(path)
      }
      if (bytesCache.size > 2) bytesCache.clear()
      bytesCache.set(key, blob)
    }
    const book = await makeBook(blob)
    const meta = book.metadata || {}

    const entry = state.books.find(b => b.key === key) || { key, path }
    entry.path = path
    entry.title = typeof meta.title === 'string' ? meta.title : ''
    const rawAuthor = typeof meta.author === 'string' ? meta.author : ''
    entry.author = rawAuthor && rawAuthor.toLowerCase() !== 'unknown' ? rawAuthor : ''
    entry.opened = entry.opened || Date.now()

    if (!entry.cover && book.getCover) {
      try {
        const cover = await book.getCover()
        if (cover) {
          const ext = (cover.type.split('/')[1] || 'img').replace('jpeg', 'jpg')
          entry.cover = await invoke('save_cover', {
            key, ext, data: Array.from(new Uint8Array(await cover.arrayBuffer())),
          })
        }
      } catch (e) { console.warn('cover failed', e) }
    }

    if (!state.books.some(b => b.key === key)) state.books.push(entry)
    persist()
    renderLibrary()
    if (openIt) openBook(entry)
  } catch (e) {
    const why = (e?.message ?? String(e))
    const at = String(e?.stack || '').split('\n').slice(1, 3).join(' | ')
    console.error('open failed', e)
    toast('Open failed: ' + why + (at ? ' @ ' + at : ''))
  }
}
function showView (name) {
  const show = name === 'library' ? els.library : els.reader
  const hide = name === 'library' ? els.reader : els.library
  show.hidden = false
  show.classList.add('hidden-out')
  requestAnimationFrame(() => requestAnimationFrame(() => show.classList.remove('hidden-out')))
  hide.classList.add('hidden-out')
  setTimeout(() => { hide.hidden = true }, 150)
}

function closeReaderSilent () {
  if (view) { try { view.close() } catch {} view.remove(); view = null }
}

function closeReader () {
  closeReaderSilent()
  currentBookEntry = null
  currentChapter = ''
  resetSearch() // invalidate any in-flight search for the dead book
  hideSelTool()
  els.toc.hidden = true
  els.settings.hidden = true
  els.search.hidden = true
  els.bm.hidden = true
  renderLibrary()
  showView('library')
  persist()
}

async function openBook (entry) {
  closeReaderSilent()
  currentBookEntry = entry
  entry.opened = Date.now()
  persist()

  els.title.textContent = entry.title || entry.path?.split('/').pop() || '?'
  els.author.textContent = entry.author ? '· ' + entry.author : ''
  els.percent.textContent = ''
  currentChapter = ''
  els.toc.hidden = els.settings.hidden = els.search.hidden = els.bm.hidden = true
  for (const li of els.tocList.children) li.classList.remove('active')
  showView('reader')

  try {
    let blob = bytesCache.get(entry.key)
    if (!blob) {
      blob = await bytesFrom(entry.path)
      if (bytesCache.size > 2) bytesCache.clear()
      bytesCache.set(entry.key, blob)
    }
    view = document.createElement('foliate-view')
    els.pages.replaceChildren(view)
    await view.open(blob)
    applyContentStyles()
    view.addEventListener('relocate', onRelocate)
    view.addEventListener('draw-annotation', ({ detail }) => {
      detail.draw(Overlayer.highlight, { color: detail.annotation.color })
    })
    view.addEventListener('show-annotation', onShowAnnotation)
    view.addEventListener('load', e => {
      const { doc, index } = e.detail
      // the sandbox keeps allow-scripts (WebKit bug 218086 breaks iframe
      // events without it), so scripts are removed from the section doc
      // instead: book JS must never reach `invoke` in the same origin
      doc.querySelectorAll('script').forEach(n => n.remove())
      for (const el of doc.querySelectorAll('*')) {
        for (const a of [...el.attributes]) {
          if (a.name.startsWith('on')) el.removeAttribute(a.name)
        }
      }
      doc.addEventListener('click', docClick)
      doc.addEventListener('pointerup', e => onSelection(e, doc, index))
      doc.addEventListener('wheel', turnWithWheel, { passive: false })
      // push the current theme into the underlay on every section load,
      // not only on explicit theme switches
      applyContentStyles()
      // redraw saved highlights for this section
      for (const h of (currentBookEntry?.highlights ?? [])) {
        view.addAnnotation({ value: h.cfi, color: h.color }).catch(() => {})
      }
    })
    buildToc(view.book.toc || [])
    await view.init({ lastLocation: entry.cfi ?? undefined, showTextStart: true })
  } catch (e) {
    console.error('read failed', e)
    toast('Could not open — re-import this book (Open or drag it in).')
    renderLibrary()
    state.books = state.books.filter(b => b !== entry)
    persist()
    closeReader()
  }
}

let currentChapter = ''
function onRelocate ({ detail }) {
  hideSelTool()
  const frac = detail.fraction
  if (typeof frac === 'number' && !Number.isNaN(frac)) {
    els.percent.textContent = Math.round(frac * 100) + '%'
    els.fill.style.width = (frac * 100).toFixed(1) + '%'
    if (currentBookEntry) {
      currentBookEntry.fraction = frac
      if (detail.cfi) currentBookEntry.cfi = detail.cfi
      persist()
    }
  }
  const label = detail.tocItem?.label
  if (label) {
    currentChapter = label
    for (const li of els.tocList.children) {
      li.classList.toggle('active', li.textContent === label)
    }
  }
}

// page-turn clicks inside the rendered document
function docClick (e) {
  if (!els.hlbar.hidden || e.detail > 1 || e.altKey) return
  // never page-turn on click that is part of text selection
  const sel = e.currentTarget?.defaultView?.getSelection?.()
  if (sel && !sel.isCollapsed) return
  const w = e.currentTarget?.documentElement?.clientWidth
      ?? e.view?.innerWidth ?? window.innerWidth
  if (!w) return
  const x = e.clientX / w
  if (x < 0.15) view?.prev()
  else if (x > 0.85) view?.next()
}

// ------------------------------------------------------- highlight tools
const HIGHLIGHTS = Object.fromEntries(
  [...document.querySelectorAll('#selbar .swatch')].map(b => [b.dataset.c, b.style.getPropertyValue('--c')]))

let pendingSel = null // { cfi, text } under the selection toolbar
let pendingHl = null  // { cfi } currently targeted by the remove bar
let selRangeRect = null

function onSelection (e, doc, index) {
  const sel = doc.defaultView.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) {
    if (!els.hlbar.hidden) return
    hideSelTool()
    return
  }
  const range = sel.getRangeAt(0)
  const rangeRect = range.getBoundingClientRect()
  const frameRect = doc.defaultView.frameElement.getBoundingClientRect()
  if (!frameRect || !rangeRect || !view) return
  try { var cfi = view.getCFI(index, range) } catch { hideSelTool(); return }
  if (!cfi) { hideSelTool(); return }
  pendingSel = { cfi, text: sel.toString().trim(), sel }
  // place the toolbar above the selection's top (flip below if near the top)
  const absX = frameRect.left + rangeRect.left + rangeRect.width / 2
  const absTop = frameRect.top + rangeRect.top
  selRangeRect = { absX, absTop }
  els.selbar.hidden = false
  els.hlbar.hidden = true
  const flip = absTop < 60
  els.selbar.style.left = Math.min(Math.max(absX, 150), window.innerWidth - 150) + 'px'
  els.selbar.style.top = flip ? (frameRect.top + rangeRect.bottom + 8) + 'px' : ''
  els.selbar.style.bottom = flip ? '' : (window.innerHeight - absTop + 8) + 'px'
  els.selbar.style.transform = 'translateX(-50%)'
}

function hideSelTool () {
  els.selbar.hidden = true
  els.hlbar.hidden = true
  pendingSel = null
  pendingHl = null
}

for (const dot of els.selbar.querySelectorAll('.swatch')) {
  dot.addEventListener('click', () => {
    if (!pendingSel || !currentBookEntry) return
    const color = HIGHLIGHTS[dot.dataset.c]
    try { view.addAnnotation({ value: pendingSel.cfi, color }) } catch (e) { console.warn(e) }
    currentBookEntry.highlights = currentBookEntry.highlights || []
    currentBookEntry.highlights.push({ cfi: pendingSel.cfi, color })
    persist()
    pendingSel.sel?.removeAllRanges?.()
    hideSelTool()
  })
}

$('#sel-copy').addEventListener('click', () => {
  if (!pendingSel) return
  navigator.clipboard?.writeText(pendingSel.text)
    .then(() => toast('Copied'))
    .catch(() => toast('Clipboard unavailable'))
  hideSelTool()
})

$('#sel-close').addEventListener('click', hideSelTool)
$('#hl-close').addEventListener('click', hideSelTool)

// tapping an existing highlight opens the remove bar
function onShowAnnotation ({ detail }) {
  if (!view || !currentBookEntry) return
  pendingHl = { cfi: detail.value }
  // locate the frame the highlight lives in — not just the first section
  const contents = view.renderer.getContents()
  const doc = contents.find(c => c.doc === detail.range?.startContainer?.ownerDocument)?.doc
    ?? contents[0]?.doc
  const frameRect = doc?.defaultView?.frameElement?.getBoundingClientRect()
  let r
  try { r = detail.range.getBoundingClientRect() } catch { r = null }
  if (frameRect && r) {
    els.hlbar.style.left = (frameRect.left + r.left + r.width / 2) + 'px'
    els.hlbar.style.transform = 'translateX(-50%)'
    const absTop = frameRect.top + r.top
    const flip = absTop < 60
    els.hlbar.style.top = flip ? (frameRect.top + r.bottom + 8) + 'px' : ''
    els.hlbar.style.bottom = flip ? '' : (window.innerHeight - absTop + 8) + 'px'
  }
  els.hlbar.hidden = false
  els.selbar.hidden = true
  pendingSel = null
}

$('#hl-del').addEventListener('click', () => {
  if (!pendingHl || !currentBookEntry) return
  try { view.deleteAnnotation({ value: pendingHl.cfi }) } catch {}
  currentBookEntry.highlights = (currentBookEntry.highlights || [])
    .filter(h => h.cfi !== pendingHl.cfi)
  persist()
  hideSelTool()
})

// page turns on wheel. events inside the book iframe never bubble out to
// the parent document, so the same handler must live in both frames —
// wheel over the page is otherwise dead (release builds included)
let wheelLock = false
const turnWithWheel = e => {
  if (!view) return
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
  e.preventDefault()
  if (Math.abs(e.deltaY) < 12) return // trackpad noise
  if (wheelLock) return
  wheelLock = true
  setTimeout(() => { wheelLock = false }, 240)
  if (e.deltaY > 0) view.next()
  else view.prev()
}
els.rdBody.addEventListener('wheel', turnWithWheel, { passive: false })

// ---------------------------------------------------------------- toc
function buildToc (toc) {
  const items = []
  const flatten = (list, depth = 0) => list.flatMap(it => {
    if (it.href) items.push({ label: it.label, href: it.href, depth })
    return flatten(it.subitems ?? [], depth + 1)
  })
  flatten(toc)
  els.tocList.replaceChildren(...items.map(item => {
    const a = document.createElement('button')
    a.className = 'toc-item'
    a.style.paddingLeft = 14 + item.depth * 14 + 'px'
    a.textContent = item.label || '—'
    a.addEventListener('click', () => {
      view?.goTo(item.href)
      els.toc.hidden = true
    })
    return a
  }))
}

// ---------------------------------------------------------------- wiring
$('#btn-open').addEventListener('click', async () => {
  try {
    const path = await T.dialog.open({
      multiple: false,
      filters: [{ name: 'EPUB', extensions: ['epub'] }],
    })
    if (path) {
      // copy the picked book into the data dir so it stays readable even
      // if the original file is later moved or deleted
      const local = await invoke('import_from_path', { key: fileKey(path), path })
      addBook(local)
    }
  } catch (e) {
    console.error(e)
    toast('Dialog failed: ' + (e?.message ?? String(e)))
  }
})

$('#btn-back').addEventListener('click', closeReader)

const PANELS = [
  ['settings', '#settings, #btn-settings'],
  ['toc', '#toc, #btn-toc'],
  ['search', '#search, #btn-search'],
  ['bm', '#bm, #btn-bm'],
]

function openPanel (name) {
  for (const [n] of PANELS) if (n !== name) els[n].hidden = true
  els[name].hidden = false
}

function closePanel (name) {
  els[name].hidden = true
  if (name === 'search') resetSearch()
}

$('#btn-toc').addEventListener('click', () => els.toc.hidden ? openPanel('toc') : closePanel('toc'))
$('#btn-settings').addEventListener('click', () => els.settings.hidden ? openPanel('settings') : closePanel('settings'))
$('#btn-search').addEventListener('click', () => {
  if (els.search.hidden) { openPanel('search'); els.searchInput.focus(); els.searchInput.select() }
  else closePanel('search')
})
$('#btn-bm').addEventListener('click', () => {
  if (els.bm.hidden) { renderBookmarks(); openPanel('bm') }
  else closePanel('bm')
})

document.addEventListener('click', e => {
  for (const [n, sel] of PANELS) {
    if (!els[n].hidden && !e.target.closest(sel)) closePanel(n)
  }
})

$('#font-up').addEventListener('click', () => {
  const i = FONT_SIZES.indexOf(state.settings.fontSize)
  state.settings.fontSize = FONT_SIZES[Math.min(i + 1, FONT_SIZES.length - 1)]
  applyFontSize(); persist()
})
$('#font-down').addEventListener('click', () => {
  const i = FONT_SIZES.indexOf(state.settings.fontSize)
  state.settings.fontSize = FONT_SIZES[Math.max(i - 1, 0)]
  applyFontSize(); persist()
})
for (const dot of document.querySelectorAll('.dot')) {
  dot.addEventListener('click', () => { applyTheme(dot.dataset.theme); persist() })
}

$('#zone-left').addEventListener('click', () => currentBookEntry && view?.prev())
$('#zone-right').addEventListener('click', () => currentBookEntry && view?.next())

document.addEventListener('keydown', e => {
  // never treat typing as a shortcut (space would flip pages mid-search)
  if (e.target.closest('input, textarea')) return
  if (!view) return
  switch (e.key) {
    case 'ArrowRight': case 'PageDown': case ' ': view?.next(); break
    case 'ArrowLeft': case 'PageUp': view?.prev(); break
    case 'Home': view?.goToFraction(0); break
    case '/':
      e.preventDefault()
      openPanel('search')
      els.searchInput.focus()
      els.searchInput.select()
      break
    case 'b': case 'B': addBookmark(); break
    case 'Escape':
      if (!els.search.hidden) closePanel('search')
      else if (!els.bm.hidden) closePanel('bm')
      else if (!els.toc.hidden) els.toc.hidden = true
      else if (!els.settings.hidden) els.settings.hidden = true
      else closeReader()
      break
    case 't': case 'T':
      els.toc.hidden ? openPanel('toc') : closePanel('toc')
      break
  }
})

// ---------------------------------------------------------------- search
const MAX_RESULTS = 200
let searchToken = 0
let debounceTimer // search-as-you-type

function resetSearch () {
  searchToken++
  els.searchInput.value = ''
  els.searchList.replaceChildren()
  try { view?.clearSearch() } catch {}
}

const emptyRow = text => {
  const div = document.createElement('div')
  div.className = 'bm-empty'
  div.textContent = text
  return div
}

function searchRow (cfi, excerpt) {
  const b = document.createElement('button')
  b.className = 'toc-item search-item'
  const line = document.createElement('small')
  const pre = excerpt?.pre ?? ''
  const match = excerpt?.match ?? ''
  const post = excerpt?.post ?? ''
  line.append(pre)
  if (match) {
    const m = document.createElement('b')
    m.textContent = match
    line.append(m, post)
  } else line.append(post)
  b.append(line)
  b.addEventListener('click', () => {
    view?.goTo(cfi).catch(() => toast('Could not jump to that match'))
    closePanel('search')
  })
  return b
}

async function runSearch (query) {
  const token = ++searchToken
  const book = view?.book
  els.searchList.replaceChildren()
  if (!view || !book || !query) {
    try { view?.clearSearch() } catch {}
    return
  }
  try {
    let shown = 0
    let truncated = false
    for await (const r of view.search({ query })) {
      if (token !== searchToken || view?.book !== book) return // stale run
      if (r === 'done') break
      if (r.subitems) {
        if (r.label) {
          const head = document.createElement('div')
          head.className = 'sr-head'
          head.textContent = r.label
          els.searchList.append(head)
        }
        for (const { cfi, excerpt } of r.subitems) {
          if (shown >= MAX_RESULTS) { truncated = true; break }
          els.searchList.append(searchRow(cfi, excerpt))
          shown++
        }
      } else if (r.cfi) {
        if (shown >= MAX_RESULTS) { truncated = true; break }
        els.searchList.append(searchRow(r.cfi, r.excerpt))
        shown++
      }
      if (truncated) break
    }
    if (token !== searchToken || view?.book !== book) return
    if (shown === 0) els.searchList.append(emptyRow('No matches'))
    else if (truncated) els.searchList.append(emptyRow(`Showing the first ${shown} matches`))
  } catch (e) { console.warn('search failed', e) }
}

els.searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => runSearch(els.searchInput.value.trim()), 200)
})
els.searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closePanel('search'); els.searchInput.blur(); return }
  if (e.key !== 'Enter') return
  e.preventDefault()
  clearTimeout(debounceTimer)
  runSearch(els.searchInput.value.trim())
})

// ---------------------------------------------------------------- bookmarks
function addBookmark () {
  const entry = currentBookEntry
  if (!view || !entry?.cfi) { toast('Nothing to bookmark yet'); return }
  entry.bookmarks = entry.bookmarks || []
  if (entry.bookmarks.some(x => x.cfi === entry.cfi)) {
    toast('Already bookmarked here')
    return
  }
  entry.bookmarks.push({
    cfi: entry.cfi,
    label: currentChapter || 'Page',
    at: Math.round((entry.fraction || 0) * 100) + '%',
  })
  persist()
  renderBookmarks()
  toast('Bookmark added')
}

function renderBookmarks () {
  const list = currentBookEntry?.bookmarks ?? []
  els.bmList.replaceChildren()
  if (!list.length) {
    els.bmList.append(emptyRow('No bookmarks yet — press B to add one'))
    return
  }
  for (const x of list) {
    const row = document.createElement('div')
    row.className = 'bm-row'
    const jump = document.createElement('button')
    jump.className = 'toc-item'
    jump.textContent = `${x.label || 'Page'} · ${x.at || ''}`
    jump.addEventListener('click', () => {
      view?.goTo(x.cfi).catch(() => toast('Bookmark location unavailable'))
      closePanel('bm')
    })
    const del = document.createElement('button')
    del.className = 'bm-del'
    del.textContent = '✕'
    del.title = 'Remove bookmark'
    del.addEventListener('click', () => {
      const entry = currentBookEntry
      if (!entry) return
      entry.bookmarks = entry.bookmarks.filter(y => y !== x)
      persist()
      renderBookmarks()
    })
    row.append(jump, del)
    els.bmList.append(row)
  }
}

// drag & drop: native HTML5 events (works under Wayland/X11)
function bindDrag () {
  const overlay = els.drop
  window.addEventListener('dragover', e => {
    e.preventDefault()
    overlay.hidden = false
  })
  window.addEventListener('dragleave', e => {
    if (!e.relatedTarget) overlay.hidden = true
  })
  window.addEventListener('drop', async e => {
    e.preventDefault()
    overlay.hidden = true
    const file = [...(e.dataTransfer?.files || [])].find(f => /\.epub$/i.test(f.name))
    if (file) {
      try {
        await addBook(file.name, { data: file })
      } catch (err) {
        console.error('drop failed', err)
        toast('Drop failed: ' + (err?.message ?? String(err)))
      }
    } else {
      toast('Drop an .epub file')
    }
  })
}

// ---------------------------------------------------------------- boot
function takeState (obj) {
  state = {
    settings: { fontSize: 20, theme: 'sepia', ...obj.settings },
    books: Array.isArray(obj.books) ? obj.books : [],
  }
  // normalize data saved by older versions or a damaged write
  for (const b of state.books) {
    if ((b.author || '').toLowerCase() === 'unknown') b.author = ''
    if (!Array.isArray(b.highlights)) b.highlights = []
    if (!Array.isArray(b.bookmarks)) b.bookmarks = []
  }
  return state
}

async function boot () {
  const info = JSON.parse(await invoke('load_library')) // { dir, state }
  let obj = null
  try { obj = JSON.parse(info.state || '{}') } catch { obj = null }
  if (!obj) {
    // main file unreadable: try the rotating backup kept before every save
    const raw = await invoke('read_file', { path: info.dir + '/library.json.bak' })
      .then(b => new TextDecoder().decode(b))
      .catch(() => null)
    obj = raw ? (() => { try { return JSON.parse(raw) } catch { return null } })() : null
    if (obj) {
      takeState(obj)
      persist() // heal the main file from the backup immediately
      toast('Library was damaged; restored from backup')
    } else {
      takeState({}) // degenerate in-memory state; refuse to overwrite the files
      saveLocked = true
      toast('Library file unreadable; changes will not be saved this session')
    }
  } else {
    takeState(obj)
  }
  applyTheme(state.settings.theme)
  applyFontSize()
  renderLibrary()
  bindDrag()
}

boot().catch(e => {
  console.error('boot failed', e)
  toast('Boot failed: ' + (e?.message ?? String(e)))
})

/* ereader — minimal personal epub reader (Tauri + foliate-js) */

// import view.js registers the <foliate-view> custom element
import { makeBook } from './vendor/foliate-js/view.js'
import { Overlayer } from './vendor/foliate-js/overlayer.js'
// pre-load every module the epub loader imports dynamically, so the
// dynamic `import()` calls resolve from the module cache and never
// hit a fetch during open (quirks in dev-protocol responses)
import './vendor/foliate-js/epub.js'
import './vendor/foliate-js/paginator.js'
import './vendor/foliate-js/fixed-layout.js'
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
let persistTimer
function persist (immediate = false) {
  clearTimeout(persistTimer)
  const write = () => invoke('save_library', { state: JSON.stringify(state) }).catch(console.error)
  if (immediate) write()
  else persistTimer = setTimeout(write, 400)
}
window.addEventListener('pagehide', () => persist(true))

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

// read a book's bytes. dialog picks give real paths (read from disk);
// imported drops were copied into the data dir at add time.
// foliate-js needs a File (it checks `file.name`), not a bare Blob.
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
const THEMES = {
  light: { 'ui-bg': '#f4f2ee', fg: '#1c1b1a', 'fg-dim': '#8a857c', line: '#e2ded6', accent: '#8c6d4f', card: '#ffffff', page: '#ffffff', 'page-fg': '#1c1b1a' },
  sepia: { 'ui-bg': '#ece3d2', fg: '#3b332a', 'fg-dim': '#9a8d7a', line: '#ddd0ba', accent: '#a1743f', card: '#f6efe3', page: '#f6efe3', 'page-fg': '#3b332a' },
  dark:  { 'ui-bg': '#0f1114', fg: '#d4d7dc', 'fg-dim': '#777c85', line: '#23262c', accent: '#b08d5f', card: '#171a1f', page: '#121519', 'page-fg': '#c9cdd4' },
}

function applyTheme (theme) {
  state.settings.theme = theme
  document.documentElement.dataset.theme = theme
  // inline vars beat every stylesheet — app chrome repaints for sure
  for (const [k, v] of Object.entries(THEMES[theme] || THEMES.sepia)) {
    document.documentElement.style.setProperty('--' + k, v)
  }
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
  // the paginator caches the doc background captured at section load;
  // refresh it, or the underlay keeps the old theme until relaunch
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

// add and optionally open one book given a real path on disk
async function addBook (path, { openIt = true, data = null } = {}) {
  try {
    const key = fileKey(path)
    let blob = bytesCache.get(key)
   	if (!blob) {
      if (data) {
        // dropped file: copy into the data dir so it stays readable
        data = new Uint8Array(await data.arrayBuffer())
        path = await invoke('import_book', { key, data: Array.from(data) })
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
  hideSelTool()
  els.toc.hidden = true
  els.settings.hidden = true
  renderLibrary()
  showView('library')
  persist(true)
}

async function openBook (entry) {
  closeReaderSilent()
  currentBookEntry = entry
  entry.opened = Date.now()
  persist()

  els.title.textContent = entry.title || entry.path?.split('/').pop() || '?'
  els.author.textContent = entry.author ? '· ' + entry.author : ''
  els.percent.textContent = ''
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
      docIndexMap.set(doc, index)
      doc.addEventListener('click', docClick)
      doc.addEventListener('pointerup', e => onSelection(e, doc, index))
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

function onRelocate ({ detail }) {
  hideSelTool()
  const frac = detail.fraction
  if (typeof frac === 'number' && !Number.isNaN(frac)) {
    els.percent.textContent = Math.round(frac * 100) + '%'
    els.fill.style.width = (frac * 100).toFixed(1) + '%'
    if (currentBookEntry) {
      currentBookEntry.fraction = frac
      if (detail.cfi) currentBookEntry.cfi = detail.cfi
      persist() // debounced
    }
  }
  const label = detail.tocItem?.label
  if (label) for (const li of els.tocList.children) {
    li.classList.toggle('active', li.textContent === label)
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

const docIndexMap = new WeakMap() // doc -> section index
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
  const doc = view.renderer.getContents()[0]?.doc
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

// hide toolbars when paging / leaving the book
const relocateAlsoHide = () => hideSelTool()

// mouse wheel turns pages — one tick, one page (with a short lockout)
let wheelLock = false
els.rdBody.addEventListener('wheel', e => {
  if (!view) return
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
  if (Math.abs(e.deltaY) < 12) { e.preventDefault(); return } // trackpad noise
  e.preventDefault()
  if (wheelLock) return
  wheelLock = true
  setTimeout(() => { wheelLock = false }, 240)
  if (e.deltaY > 0) view.next()
  else view.prev()
}, { passive: false })

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
    if (path) addBook(path)
  } catch (e) {
    console.error(e)
    toast('Dialog failed: ' + (e?.message ?? String(e)))
  }
})

$('#btn-back').addEventListener('click', closeReader)
$('#btn-toc').addEventListener('click', () => {
  els.settings.hidden = true
  els.toc.hidden = !els.toc.hidden
})
$('#btn-settings').addEventListener('click', () => {
  els.toc.hidden = true
  els.settings.hidden = !els.settings.hidden
})

document.addEventListener('click', e => {
  if (!els.settings.hidden && !e.target.closest('#settings, #btn-settings')) els.settings.hidden = true
  if (!els.toc.hidden && !e.target.closest('#toc, #btn-toc')) els.toc.hidden = true
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
  if (!view) return
  switch (e.key) {
    case 'ArrowRight': case 'PageDown': case ' ': view?.next(); break
    case 'ArrowLeft': case 'PageUp': view?.prev(); break
    case 'Home': view?.goToFraction(0); break
    case 'Escape':
      if (!els.toc.hidden) els.toc.hidden = true
      else if (!els.settings.hidden) els.settings.hidden = true
      else closeReader()
      break
    case 't': case 'T':
      if (e.target === document.body) { els.toc.hidden = !els.toc.hidden; els.settings.hidden = true }
      break
  }
})

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
    const file = [...(e.dataTransfer?.files || [])].find(f => /\.(epub|fb2|mobi|azw3)$/i.test(f.name))
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
async function boot () {
  const raw = await invoke('load_library')
  const parsed = JSON.parse(raw || '{}')
  state = {
    settings: { fontSize: 20, theme: 'sepia', ...parsed.settings },
    books: Array.isArray(parsed.books) ? parsed.books : [],
  }
  // clean author strings saved by older versions
  for (const b of state.books) {
    if ((b.author || '').toLowerCase() === 'unknown') b.author = ''
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

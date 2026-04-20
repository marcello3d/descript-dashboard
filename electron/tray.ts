import { app, BrowserWindow, shell, nativeImage, Menu, Tray } from 'electron'
import { join } from 'path'
import http from 'http'
import zlib from 'zlib'
import { DEV_PORT } from './constants'

let tray: Tray | null = null
let pollInterval: ReturnType<typeof setInterval> | null = null

let cachedItems: WorkItem[] = []
let cachedReviewItems: ReviewItem[] = []

// --- Types (mirrors src/types/index.ts) ---

interface WorkItem {
  id: string
  title: string
  linear?: { identifier: string; status: string; url: string; priority: number }
  prs: { title: string; url: string; draft: boolean; merged: boolean; closed: boolean; reviewDecision: string | null }[]
  agents: { id: string; status: string; url: string }[]
  tags: string[]
}

interface ReviewItem {
  id: string
  pr: { title: string; url: string; author: string; authorLogin: string; draft: boolean; merged: boolean; closed: boolean; reviewDecision: string | null }
  linear?: { identifier: string; status: string; url: string }
  requestType: 'individual' | 'team'
}

// --- Data fetching ---

function fetchDashboardData(): Promise<{ items: WorkItem[]; reviewItems: ReviewItem[] }> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${DEV_PORT}/api/work-items`, (res) => {
      let lastLine = ''
      let buffer = ''

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line.trim()) lastLine = line
        }
      })

      res.on('end', () => {
        if (buffer.trim()) lastLine = buffer
        try {
          const data = JSON.parse(lastLine)
          resolve({ items: data.items ?? [], reviewItems: data.reviewItems ?? [] })
        } catch {
          resolve({ items: [], reviewItems: [] })
        }
      })
    })

    req.on('error', () => resolve({ items: [], reviewItems: [] }))
    req.setTimeout(60_000, () => { req.destroy(); resolve({ items: [], reviewItems: [] }) })
  })
}

// --- Work item classification (mirrors page.tsx logic) ---

function isItemClosed(item: WorkItem): boolean {
  const hasActiveAgent = item.agents.some(a => a.status === 'running' || a.status === 'in_progress')
  if (hasActiveAgent) return false
  const cursorOnly = !item.linear && item.prs.length === 0 && item.agents.length > 0
  if (cursorOnly) return true
  const status = item.linear?.status.toLowerCase()
  if (status === 'canceled' || status === 'cancelled' || status === 'done' || status === 'completed') return true
  const isVerify = status === 'verify'
  const openPrs = item.prs.filter(pr => !pr.closed && !pr.merged)
  const hasMerged = item.prs.some(pr => pr.merged)
  if (hasMerged && openPrs.length === 0 && !isVerify) return true
  if (item.prs.length > 0 && item.prs.every(pr => pr.closed) && !item.linear) return true
  return false
}

type ActionGroup = 'ready' | 'verify' | 'review' | 'changes' | 'draft' | 'other'

function getActionGroup(item: WorkItem): ActionGroup {
  if (item.linear?.status.toLowerCase() === 'verify') return 'verify'
  const pr = item.prs[0]
  if (pr) {
    if (pr.merged) return 'other'
    if (pr.reviewDecision === 'APPROVED') return 'ready'
    if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes'
    if (pr.draft) return 'draft'
    return 'review'
  }
  return 'draft'
}

const GROUP_LABELS: Record<ActionGroup, string> = {
  verify: 'Verify',
  ready: 'Approved',
  changes: 'Changes Requested',
  review: 'Waiting for Review',
  draft: 'Draft / In Progress',
  other: 'Other',
}

const GROUP_ORDER: ActionGroup[] = ['verify', 'ready', 'changes', 'review', 'draft', 'other']

const GROUP_COLORS: Record<ActionGroup, string> = {
  verify: '#5E6AD2',
  ready: '#15803d',
  changes: '#dc2626',
  review: '#a16207',
  draft: '#6b7280',
  other: '#9ca3af',
}

const REVIEW_DOT_COLOR = '#2563eb'
const MAX_ITEMS_PER_GROUP = 3

// --- Dot icons ---

const dotCache = new Map<string, Electron.NativeImage>()

function dotIcon(hex: string): Electron.NativeImage {
  const cached = dotCache.get(hex)
  if (cached) return cached

  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const size = 32
  const radius = 10

  const pixels = Buffer.alloc(size * size * 4, 0)
  const cx = size / 2
  const cy = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx + 0.5
      const dy = y - cy + 0.5
      if (dx * dx + dy * dy <= radius * radius) {
        const offset = (y * size + x) * 4
        pixels[offset] = r
        pixels[offset + 1] = g
        pixels[offset + 2] = b
        pixels[offset + 3] = 255
      }
    }
  }

  const img = nativeImage.createFromBuffer(
    encodePNG(size, size, pixels),
    { width: size, height: size, scaleFactor: 2.0 },
  )
  dotCache.set(hex, img)
  return img
}

function encodePNG(w: number, h: number, rgba: Buffer): Buffer {
  const header = Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  ])

  function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const typeB = Buffer.from(type, 'ascii')
    const crcData = Buffer.concat([typeB, data])
    const crc = Buffer.alloc(4)
    crc.writeInt32BE(crc32(crcData))
    return Buffer.concat([len, typeB, data, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const rowBytes = w * 4 + 1
  const rawData = Buffer.alloc(rowBytes * h)
  for (let y = 0; y < h; y++) {
    rawData[y * rowBytes] = 0
    rgba.copy(rawData, y * rowBytes + 1, y * w * 4, (y + 1) * w * 4)
  }

  const compressed = zlib.deflateSync(rawData)
  const iend = Buffer.alloc(0)

  return Buffer.concat([
    header,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', iend),
  ])
}

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0)
    }
  }
  return (crc ^ 0xFFFFFFFF) | 0
}

// --- Helpers ---

function truncate(str: string, len: number): string {
  return str.length > len ? str.slice(0, len - 1) + '\u2026' : str
}

function showWindow(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) { win.show(); win.focus() }
}

// --- Tray menu ---

function buildTrayMenu(): Menu {
  const openItems = cachedItems.filter(item => !isItemClosed(item))
  const groups = new Map<ActionGroup, WorkItem[]>()
  for (const item of openItems) {
    const g = getActionGroup(item)
    const list = groups.get(g) ?? []
    list.push(item)
    groups.set(g, list)
  }

  const nonDraftReviews = cachedReviewItems.filter(r => !r.pr.draft)

  const template: Electron.MenuItemConstructorOptions[] = [
    { label: 'Descript Dashboard', enabled: false },
    { type: 'separator' },
  ]

  if (openItems.length > 0) {
    for (const group of GROUP_ORDER) {
      const items = groups.get(group)
      if (!items || items.length === 0) continue

      const dot = dotIcon(GROUP_COLORS[group])
      template.push({ type: 'separator' })
      template.push({ label: `${GROUP_LABELS[group]} (${items.length})`, icon: dot, enabled: false })

      for (const item of items.slice(0, MAX_ITEMS_PER_GROUP)) {
        const prefix = item.linear?.identifier ? `${item.linear.identifier} ` : ''
        template.push({
          label: `  ${prefix}${truncate(item.title, 45)}`,
          click: () => {
            const url = item.linear?.url ?? item.prs[0]?.url ?? item.agents[0]?.url
            if (url) shell.openExternal(url)
          },
        })
      }
      if (items.length > MAX_ITEMS_PER_GROUP) {
        template.push({ label: `  +${items.length - MAX_ITEMS_PER_GROUP} more\u2026`, click: showWindow })
      }
    }
  } else {
    template.push({ label: 'No active tasks', enabled: false })
  }

  template.push({ type: 'separator' })
  if (nonDraftReviews.length > 0) {
    const dot = dotIcon(REVIEW_DOT_COLOR)
    template.push({ label: `Reviews Requested (${nonDraftReviews.length})`, icon: dot, enabled: false })

    for (const item of nonDraftReviews.slice(0, MAX_ITEMS_PER_GROUP)) {
      const prefix = item.linear?.identifier ? `${item.linear.identifier} ` : ''
      const author = item.pr.author !== item.pr.authorLogin ? item.pr.author : `@${item.pr.authorLogin}`
      template.push({
        label: `  ${prefix}${truncate(item.pr.title, 35)} \u2014 ${author}`,
        click: () => shell.openExternal(item.pr.url),
      })
    }
    if (nonDraftReviews.length > MAX_ITEMS_PER_GROUP) {
      template.push({ label: `  +${nonDraftReviews.length - MAX_ITEMS_PER_GROUP} more\u2026`, click: showWindow })
    }
  }

  template.push({ type: 'separator' })
  template.push({ label: 'Show Window', click: showWindow })
  template.push({
    label: 'Refresh',
    click: () => {
      refreshTrayData()
      const win = BrowserWindow.getAllWindows()[0]
      if (win) win.webContents.reload()
    },
  })
  template.push({ type: 'separator' })
  template.push({ label: 'Quit', click: () => app.quit() })

  return Menu.buildFromTemplate(template)
}

function rebuildTrayMenu(): void {
  if (!tray) return
  tray.setContextMenu(buildTrayMenu())
  const openCount = cachedItems.filter(item => !isItemClosed(item)).length
  const reviewCount = cachedReviewItems.filter(r => !r.pr.draft).length
  tray.setToolTip(`Dashboard \u2014 ${openCount} tasks, ${reviewCount} reviews`)
}

// --- Exports ---

export async function refreshTrayData(): Promise<void> {
  try {
    const { items, reviewItems } = await fetchDashboardData()
    cachedItems = items
    cachedReviewItems = reviewItems
    rebuildTrayMenu()
  } catch {
    // keep cached data
  }
}

export function createTray(): void {
  const appRoot = app.getAppPath()
  const iconPath = join(appRoot, 'public/tray-iconTemplate.png')
  const icon = nativeImage.createFromPath(iconPath)
  icon.setTemplateImage(true)

  tray = new Tray(icon)
  tray.setToolTip('Descript Dashboard')
  tray.setContextMenu(buildTrayMenu())

  pollInterval = setInterval(refreshTrayData, 5 * 60 * 1000)
}

export function destroyTray(): void {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null }
  if (tray) { tray.destroy(); tray = null }
}

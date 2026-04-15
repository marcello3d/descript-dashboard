import { Notification, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'

const seenReviewIds = new Set<string>()
let initialized = false

function readConfig(): Record<string, any> {
  try {
    const configPath = path.join(process.cwd(), '.config.json')
    const raw = fs.readFileSync(configPath, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function isEnabled(type: 'reviewRequests' | 'syncErrors'): boolean {
  const config = readConfig()
  return config.notifications?.[type] !== false // default on
}

interface ReviewItem {
  id: string
  pr: { title: string; url: string; author: string; authorLogin: string }
  linear?: { identifier: string }
}

export function initSeenReviews(reviews: ReviewItem[]): void {
  for (const r of reviews) seenReviewIds.add(r.id)
  initialized = true
}

export function notifyNewReviews(reviews: ReviewItem[]): void {
  if (!initialized) {
    initSeenReviews(reviews)
    return
  }

  if (!isEnabled('reviewRequests')) {
    for (const r of reviews) seenReviewIds.add(r.id)
    return
  }

  // Only notify when window is not focused
  const win = BrowserWindow.getAllWindows()[0]
  if (win?.isFocused()) {
    // Still track IDs so we don't notify later
    for (const r of reviews) seenReviewIds.add(r.id)
    return
  }

  const newReviews = reviews.filter(r => !seenReviewIds.has(r.id))
  for (const r of newReviews) {
    seenReviewIds.add(r.id)
  }

  if (newReviews.length === 0) return

  if (newReviews.length === 1) {
    const r = newReviews[0]
    const prefix = r.linear?.identifier ? `${r.linear.identifier}: ` : ''
    const author = r.pr.author !== r.pr.authorLogin ? r.pr.author : `@${r.pr.authorLogin}`
    showNotification('New review request', `${prefix}${r.pr.title} — ${author}`)
  } else {
    showNotification(
      `${newReviews.length} new review requests`,
      newReviews.slice(0, 3).map(r => r.pr.title).join(', ') +
        (newReviews.length > 3 ? ` +${newReviews.length - 3} more` : ''),
    )
  }
}

function showNotification(title: string, body: string): void {
  const notif = new Notification({ title, body })
  notif.on('click', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) { win.show(); win.focus() }
  })
  notif.show()
}

import { Notification, BrowserWindow } from 'electron'

const seenReviewIds = new Set<string>()
let initialized = false

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

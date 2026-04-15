// Copy public/ and .next/static/ into .next/standalone/ as required by Next.js docs
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const standalone = path.join(root, '.next', 'standalone')

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

// public/ -> .next/standalone/public/
const publicSrc = path.join(root, 'public')
const publicDst = path.join(standalone, 'public')
if (fs.existsSync(publicSrc)) {
  copyDir(publicSrc, publicDst)
  console.log(`Copied public/ -> standalone/public/`)
}

// .next/static/ -> .next/standalone/.next/static/
const staticSrc = path.join(root, '.next', 'static')
const staticDst = path.join(standalone, '.next', 'static')
if (fs.existsSync(staticSrc)) {
  copyDir(staticSrc, staticDst)
  console.log(`Copied .next/static/ -> standalone/.next/static/`)
}

// Report size
function dirSize(dir) {
  let size = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) size += dirSize(p)
      else size += fs.statSync(p).size
    }
  } catch {}
  return size
}

const totalMB = (dirSize(standalone) / 1024 / 1024).toFixed(1)
console.log(`Standalone size: ${totalMB} MB`)

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const bundleDir = path.join(__dirname, '..', 'bundle')
fs.mkdirSync(bundleDir, { recursive: true })

const nodeSrc = process.execPath
const nodeDst = path.join(bundleDir, 'node')
fs.copyFileSync(nodeSrc, nodeDst)
fs.chmodSync(nodeDst, 0o755)

// Strip debug symbols to reduce size (~20% smaller)
try {
  execSync(`strip -x "${nodeDst}" 2>/dev/null`, { stdio: 'pipe' })
  // Re-sign after strip (macOS requires valid signature)
  execSync(`codesign --force --sign - "${nodeDst}" 2>/dev/null`, { stdio: 'pipe' })
} catch {
  // strip not available or failed — keep as-is
}

const size = (fs.statSync(nodeDst).size / 1024 / 1024).toFixed(1)
console.log(`Bundled Node.js ${process.version} (${size} MB): ${nodeSrc} -> ${nodeDst}`)

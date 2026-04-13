const fs = require('fs')
const path = require('path')

const bundleDir = path.join(__dirname, '..', 'bundle')
fs.mkdirSync(bundleDir, { recursive: true })

const nodeSrc = process.execPath
const nodeDst = path.join(bundleDir, 'node')
fs.copyFileSync(nodeSrc, nodeDst)
fs.chmodSync(nodeDst, 0o755)

const size = (fs.statSync(nodeDst).size / 1024 / 1024).toFixed(1)
console.log(`Bundled Node.js ${process.version} (${size} MB): ${nodeSrc} -> ${nodeDst}`)

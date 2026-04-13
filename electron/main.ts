import { app, BrowserWindow, shell, nativeImage, Menu } from 'electron'
import { join } from 'path'
import { spawn, type ChildProcess } from 'child_process'
import { buildAppMenu } from './app-menu'
import { createTray, destroyTray, refreshTrayData } from './tray'

const DEV_PORT = 4080
const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let nextProcess: ChildProcess | null = null

// --- Window ---

function createWindow(): BrowserWindow {
  const appRoot = app.getAppPath()
  const icon = nativeImage.createFromPath(join(appRoot, 'public/icon-512.png'))

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 12, y: 10 },
    icon,
    webPreferences: {
      sandbox: true,
    },
  })

  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(icon)
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  return mainWindow
}

// --- Next.js lifecycle (spawns as child process) ---

function startNext(): Promise<void> {
  return new Promise((resolve, reject) => {
    const projectRoot = isDev ? process.cwd() : app.getAppPath()

    let cmd: string
    let args: string[]

    if (isDev) {
      // Dev: use system npx
      cmd = 'npx'
      args = ['next', 'dev', '-p', String(DEV_PORT)]
    } else {
      // Packaged: use bundled Node binary + next CLI directly
      cmd = join(projectRoot, 'bundle', 'node')
      const nextBin = join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next')
      args = [nextBin, 'start', '-p', String(DEV_PORT)]
    }

    nextProcess = spawn(cmd, args, {
      cwd: projectRoot,
      stdio: 'pipe',
      shell: isDev,
      env: { ...process.env },
    })

    let resolved = false

    nextProcess.stdout?.on('data', (data: Buffer) => {
      const output = data.toString()
      process.stdout.write(`[next] ${output}`)
      if (!resolved && (output.includes(`localhost:${DEV_PORT}`) || output.includes('Ready'))) {
        resolved = true
        resolve()
      }
    })

    nextProcess.stderr?.on('data', (data: Buffer) => {
      process.stderr.write(`[next] ${data.toString()}`)
    })

    nextProcess.on('error', (err) => {
      if (!resolved) { resolved = true; reject(err) }
    })

    nextProcess.on('exit', (code) => {
      if (!resolved) { resolved = true; reject(new Error(`Next.js exited with code ${code}`)) }
      nextProcess = null
    })

    setTimeout(() => {
      if (!resolved) { resolved = true; resolve() }
    }, 30_000)
  })
}

function killNext(): void {
  if (nextProcess) {
    nextProcess.kill('SIGTERM')
    nextProcess = null
  }
}

// --- App lifecycle ---

app.setName('Descript Dashboard')

app.whenReady().then(async () => {
  Menu.setApplicationMenu(buildAppMenu(isDev))
  const win = createWindow()
  createTray()
  win.focus()

  try {
    await startNext()
  } catch (err) {
    console.error('Failed to start Next.js:', err)
  }

  win.loadURL(`http://localhost:${DEV_PORT}`)

  setTimeout(refreshTrayData, 5_000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const newWin = createWindow()
      newWin.loadURL(`http://localhost:${DEV_PORT}`)
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    killNext()
    destroyTray()
    app.quit()
  }
})

app.on('before-quit', () => {
  killNext()
  destroyTray()
})

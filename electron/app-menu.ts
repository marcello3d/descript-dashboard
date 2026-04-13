import { app, BrowserWindow, Menu } from 'electron'

function sendKey(key: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) return
  win.webContents.executeJavaScript(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`
  )
}

export function buildAppMenu(isDev: boolean): Menu {
  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu
    {
      label: 'Descript Dashboard',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings\u2026',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
            if (win) win.loadURL('http://localhost:4080/settings')
          },
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },

    // View — matches in-app hotkeys (bare letters: m, r, s, p, k, a)
    {
      label: 'View',
      submenu: [
        { label: 'My Tasks                          M', click: () => sendKey('m') },
        { label: 'Requested Reviews            R', click: () => sendKey('r') },
        { type: 'separator' },
        { label: 'Sort by Status                    S', click: () => sendKey('s') },
        { label: 'Sort by Priority                  P', click: () => sendKey('p') },
        { label: 'Sort by Stack                     K', click: () => sendKey('k') },
        { label: 'Show All                             A', click: () => sendKey('a') },
        { type: 'separator' },
        {
          label: 'Refresh',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
            if (win) win.webContents.reload()
          },
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },

    // Window
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]

  // Developer menu (dev only)
  if (isDev) {
    template.push({
      label: 'Developer',
      submenu: [
        { role: 'toggleDevTools' },
        {
          label: 'Force Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
            if (win) win.webContents.reloadIgnoringCache()
          },
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    })
  }

  return Menu.buildFromTemplate(template)
}

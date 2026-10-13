// Google sign-in probe with NO debugging port and NO Playwright: is Electron
// itself (with a Chrome UA) accepted by Google's sign-in page?
import { app, BrowserWindow, WebContentsView } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const log = (...a) => console.log('[native]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chromeUA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
app.userAgentFallback = chromeUA
if (process.env.WITH_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.WITH_PORT)
const MODE = process.env.MODE || 'plain'
import os from 'node:os'
import fs from 'node:fs'
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'pw-spike-' + MODE + '-')))
if (MODE === 'nohints') app.commandLine.appendSwitch('disable-features', 'UserAgentClientHint')
setTimeout(() => { log('WATCHDOG'); app.exit(2) }, 60_000)
app.whenReady().then(main).catch((e) => { log('FATAL', e); app.exit(3) })
async function main() {
  const win = new BrowserWindow({ width: 1100, height: 760 })
  await win.loadURL('about:blank')
  const view = new WebContentsView(MODE === 'chromeobj' ? { webPreferences: { preload: path.join(here, 'preload-chrome.cjs'), contextIsolation: false, sandbox: false } } : {})
  win.contentView.addChildView(view)
  if (MODE === 'brand') {
    const v = process.versions.chrome
    const major = v.split('.')[0]
    view.webContents.session.webRequest.onBeforeSendHeaders((details, cb) => {
      const h = details.requestHeaders
      for (const k of Object.keys(h)) {
        if (k.toLowerCase() === 'sec-ch-ua') h[k] = `"Google Chrome";v="${major}", "Chromium";v="${major}", "Not-A.Brand";v="24"`
        if (k.toLowerCase() === 'sec-ch-ua-full-version-list') h[k] = `"Google Chrome";v="${v}", "Chromium";v="${v}", "Not-A.Brand";v="24.0.0.0"`
      }
      cb({ requestHeaders: h })
    })
  }
  log('mode', MODE)
  view.setBounds({ x: 0, y: 60, width: 1100, height: 700 })
  const wc = view.webContents
  const SITE = process.env.SITE || 'google'
  await wc.loadURL(SITE === 'microsoft' ? 'https://login.microsoftonline.com/' : 'https://accounts.google.com/signin/v2/identifier?hl=en')
  await sleep(3000)
  log('landed', wc.getURL())
  const focused = await wc.executeJavaScript(`(()=>{const el=document.querySelector('input[name="loginfmt"],input[type="email"],#identifierId,input[name="identifier"]'); if(!el) return false; el.focus(); return true})()`)
  log('email field found:', focused)
  if (focused) {
    for (const ch of 'playwriter.spike.probe@gmail.com') {
      wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
      wc.sendInputEvent({ type: 'char', keyCode: ch })
      wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
    }
    await sleep(300)
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    wc.sendInputEvent({ type: 'char', keyCode: 'Return' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await sleep(5000)
  }
  const text = await wc.executeJavaScript(`document.body.innerText.slice(0, 900)`)
  log('text after email:\n' + text)
  const blocked = /may not be secure|Couldn.t sign you in|not supported|unsupported browser/i.test(text)
  log(blocked ? 'RESULT: BLOCKED' : 'RESULT: not blocked')
  const img = await wc.capturePage()
    fs.writeFileSync(path.join(here, `google-native-${MODE}.png`), img.toPNG())
  app.exit(blocked ? 1 : 0)
}

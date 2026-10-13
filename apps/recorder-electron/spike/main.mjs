// Spike: can the Playwriter engine attach to Electron's own Chromium over CDP
// and see real input as recorder actions?
import { app, BrowserWindow, WebContentsView } from 'electron'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@xmorse/playwright-core'

const here = path.dirname(fileURLToPath(import.meta.url))
const log = (...a) => console.log('[spike]', ...a)

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

const port = await freePort()
app.commandLine.appendSwitch('remote-debugging-port', String(port))
setTimeout(() => { log('WATCHDOG: giving up after 75s'); app.exit(2) }, 75_000)
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
// Chrome UA: drop the Electron and app tokens so sites see a normal Chrome
const chromeUA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
app.userAgentFallback = chromeUA

// Must not top-level-await whenReady: ready fires only after this module
// finishes evaluating.
app.whenReady().then(main).catch((e) => { log('FATAL', e); app.exit(3) })

async function main() {
log('electron', process.versions.electron, 'chrome', process.versions.chrome, 'node', process.versions.node, 'cdp port', port)

const win = new BrowserWindow({ width: 1100, height: 760, title: 'Playwriter Recorder spike' })
await win.loadURL('about:blank') // an unloaded window has no renderer and never answers CDP
const view = new WebContentsView()
win.contentView.addChildView(view)
view.setBounds({ x: 0, y: 60, width: 1100, height: 700 })
await view.webContents.loadFile(path.join(here, 'test.html'))
log('tab loaded', view.webContents.getURL())

const t0 = Date.now()
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
log('connectOverCDP ok in', Date.now() - t0, 'ms; contexts', browser.contexts().length)
const context = browser.contexts()[0]
log('pages', context.pages().map((p) => p.url()))

const actions = []
await context._enableRecorder(
  { language: 'javascript', mode: 'recording', recorderMode: 'api' },
  {
    actionAdded: (page, actionInContext, code) => {
      actions.push({ kind: 'added', code, name: actionInContext.action.name })
      log('ACTION added:', code)
    },
    actionUpdated: (page, actionInContext, code) => {
      actions.push({ kind: 'updated', code, name: actionInContext.action.name })
      log('ACTION updated:', code)
    },
    signalAdded: (page, s) => log('SIGNAL', s.signal.name, s.signal.url || ''),
  },
)
log('recorder enabled')

// Real input through Chromium's input pipeline (not Playwright): a click on
// the button and typing into the field.
const wc = view.webContents
const rect = await wc.executeJavaScript(`(()=>{const r=document.getElementById('buy').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
await new Promise((r) => setTimeout(r, 500))
wc.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y })
wc.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
wc.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
await new Promise((r) => setTimeout(r, 800))
const out = await wc.executeJavaScript(`document.getElementById('out').textContent`)
log('page saw click:', out)

const irect = await wc.executeJavaScript(`(()=>{const r=document.getElementById('name').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
wc.sendInputEvent({ type: 'mouseDown', x: irect.x, y: irect.y, button: 'left', clickCount: 1 })
wc.sendInputEvent({ type: 'mouseUp', x: irect.x, y: irect.y, button: 'left', clickCount: 1 })
await new Promise((r) => setTimeout(r, 300))
for (const ch of 'Jared') {
  wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
  wc.sendInputEvent({ type: 'char', keyCode: ch })
  wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
}
await new Promise((r) => setTimeout(r, 1500))

log('RESULT actions:', JSON.stringify(actions, null, 2))
const ok = actions.some((a) => a.code.includes("getByRole('button', { name: 'Buy now' })") && a.code.includes('.click()'))
log(ok ? 'SPIKE PASS: click produced an action with a role locator' : 'SPIKE FAIL: no click action with locator')

if (process.env.SPIKE_GOOGLE) {
  // Google sign-in probe: does Google show "This browser or app may not be secure"?
  const page = context.pages().find((p) => p.url().startsWith('file:')) || context.pages()[0]
  await context._disableRecorder().catch(() => {})
  await page.goto('https://accounts.google.com/signin/v2/identifier?hl=en', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  log('GOOGLE landed on', page.url())
  log('GOOGLE initial text:\n' + (await page.evaluate(() => document.body.innerText.slice(0, 800))))
  await page.screenshot({ path: path.join(here, 'google-probe-0.png') })
  const email = page.locator('input[type="email"], #identifierId, input[name="identifier"]').first()
  try {
    await email.fill('playwriter.spike.probe@gmail.com', { timeout: 8000 })
    await page.keyboard.press('Enter')
    await page.waitForTimeout(5000)
  } catch (e) {
    log('GOOGLE could not find the email field:', String(e).split('\n')[0])
  }
  const text = await page.evaluate(() => document.body.innerText.slice(0, 1500))
  log('GOOGLE page text after email:\n' + text)
  const blocked = /may not be secure|Couldn.t sign you in/i.test(text)
  log(blocked ? 'GOOGLE: BLOCKED (embedded browser refused)' : 'GOOGLE: not blocked (proceeded past email step)')
  await page.screenshot({ path: path.join(here, 'google-probe.png') })
}
await browser.close().catch(() => {})
app.exit(ok ? 0 : 1)
}

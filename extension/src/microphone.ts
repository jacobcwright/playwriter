// Visible microphone permission page. Triggers Chrome's prompt via
// getUserMedia, releases the stream immediately, and reports the result to
// the service worker (which closes this tab on success).

const allowButton = document.querySelector<HTMLButtonElement>('#allow')!
const statusEl = document.querySelector<HTMLDivElement>('#status')!

function setStatus({ text, kind }: { text: string; kind: 'ok' | 'bad' | 'neutral' }): void {
  statusEl.hidden = false
  statusEl.textContent = text
  statusEl.classList.remove('ok', 'bad')
  if (kind !== 'neutral') {
    statusEl.classList.add(kind)
  }
}

function report({ granted, error }: { granted: boolean; error?: string }): void {
  void chrome.runtime.sendMessage({ action: 'microphonePermissionResult', granted, error }).catch(() => {})
}

async function currentState(): Promise<PermissionState | null> {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    return status.state
  } catch {
    return null
  }
}

function explainDenied(): string {
  return [
    'Chrome blocked the microphone for Playwriter.',
    'To fix it: click the icon on the left of the address bar, set Microphone to Allow, then click the button again.',
    'If there is no microphone option there, open chrome://settings/content/microphone and remove Playwriter from the blocked list.',
  ].join(' ')
}

async function requestMicrophone(): Promise<void> {
  allowButton.disabled = true
  setStatus({ text: 'Waiting for Chrome’s permission prompt…', kind: 'neutral' })
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    const label = stream.getAudioTracks()[0]?.label
    stream.getTracks().forEach((track) => {
      track.stop()
    })
    setStatus({
      text: `Done. Playwriter can use your microphone${label ? ` (${label})` : ''}. You can close this tab.`,
      kind: 'ok',
    })
    report({ granted: true })
  } catch (error) {
    const name = error instanceof DOMException ? error.name : ''
    const message = error instanceof Error ? error.message : String(error)
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      setStatus({ text: explainDenied(), kind: 'bad' })
      report({ granted: false, error: 'Microphone permission denied' })
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      setStatus({
        text: 'No microphone was found. Plug one in or pick one in your computer’s sound settings, then click the button again.',
        kind: 'bad',
      })
      report({ granted: false, error: 'No microphone found' })
    } else if (name === 'NotReadableError') {
      setStatus({
        text: 'Your microphone is in use by another app. Close that app (or pick another microphone in your sound settings) and try again.',
        kind: 'bad',
      })
      report({ granted: false, error: 'Microphone is busy' })
    } else {
      setStatus({ text: `Could not use the microphone: ${message}`, kind: 'bad' })
      report({ granted: false, error: message })
    }
    allowButton.disabled = false
  }
}

allowButton.addEventListener('click', () => {
  void requestMicrophone()
})

void (async () => {
  const state = await currentState()
  if (state === 'granted') {
    // Already allowed: confirm the device works and let the service worker close us
    await requestMicrophone()
  } else if (state === 'denied') {
    setStatus({ text: explainDenied(), kind: 'bad' })
  }
})()

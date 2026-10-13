/**
 * Microphone narration for the skill recorder (service worker side).
 *
 * The relay asks us to capture the microphone while it records user actions.
 * Audio is captured in the offscreen document (MediaRecorder) and streamed to
 * the relay as base64 chunks; the relay writes the file next to the event
 * timeline. Nothing leaves the machine.
 *
 * Permission: an offscreen document cannot show Chrome's microphone prompt.
 * The first time, we open src/microphone.html in a visible tab; the user
 * clicks "Allow microphone" there and Chrome prompts. Because every extension
 * document shares one origin, the offscreen document can then open the mic
 * without prompting.
 */

import type {
  MicrophoneStateResult,
  StartNarrationParams,
  StartNarrationResult,
  StopNarrationParams,
  StopNarrationResult,
} from 'playwriter/src/protocol'
import type {
  OffscreenMicrophoneStateResult,
  OffscreenStartNarrationResult,
  OffscreenStopNarrationResult,
} from './offscreen-types'
import { ensureOffscreenDocument } from './recording'
import { logger } from './background'

export const MICROPHONE_PAGE_PATH = 'src/microphone.html'
/** chrome.storage.local key: the user's "narrate my recordings" preference */
export const RECORDER_MICROPHONE_PREF_KEY = 'playwriterRecorderMicrophone'
const DEFAULT_PERMISSION_WAIT_MS = 120_000
/** How long a start waits for a not-yet-answered permission prompt before
 *  giving up (the relay's own start timeout is 20s). */
const START_PERMISSION_WAIT_MS = 15_000

// recordingId -> narration info. Lets the toolbar show "Mic live" and lets the
// stop prompt mention the narration.
const activeNarrations = new Map<string, { startedAt: number }>()
let onActiveChanged: ((active: boolean) => void) | null = null

export function setNarrationActiveListener(listener: (active: boolean) => void): void {
  onActiveChanged = listener
}

export function isNarrationActive(): boolean {
  return activeNarrations.size > 0
}

export function hasNarrationForRecording(recordingId: string): boolean {
  return activeNarrations.has(recordingId)
}

export async function getRecorderMicrophonePreference(): Promise<boolean> {
  try {
    const stored = await chrome.storage.local.get(RECORDER_MICROPHONE_PREF_KEY)
    return stored[RECORDER_MICROPHONE_PREF_KEY] === true
  } catch {
    return false
  }
}

export async function setRecorderMicrophonePreference(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [RECORDER_MICROPHONE_PREF_KEY]: enabled })
}

export async function getMicrophoneState(): Promise<MicrophoneStateResult> {
  try {
    await ensureOffscreenDocument()
    const result: OffscreenMicrophoneStateResult = await chrome.runtime.sendMessage({ action: 'getMicrophoneState' })
    return result
  } catch (error) {
    return { state: 'unavailable', error: error instanceof Error ? error.message : String(error) }
  }
}

// ── Permission page ─────────────────────────────────────────────────────────

let pendingPermission: {
  waiters: Array<(result: MicrophoneStateResult) => void>
  tabId: number | null
  timer: ReturnType<typeof setTimeout>
} | null = null

async function openMicrophonePage(): Promise<number | null> {
  const url = chrome.runtime.getURL(MICROPHONE_PAGE_PATH)
  try {
    const tabs = await chrome.tabs.query({})
    const existing = tabs.find((tab) => {
      return tab.url?.startsWith(url)
    })
    if (existing?.id !== undefined) {
      await chrome.tabs.update(existing.id, { active: true })
      if (existing.windowId !== undefined) {
        await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {})
      }
      return existing.id
    }
    const created = await chrome.tabs.create({ url, active: true })
    if (created.windowId !== undefined) {
      await chrome.windows.update(created.windowId, { focused: true }).catch(() => {})
    }
    return created.id ?? null
  } catch (error) {
    logger.error('Could not open microphone permission page:', error)
    return null
  }
}

/**
 * Make sure the user has answered Chrome's microphone prompt. Opens the
 * visible permission page when the answer is still 'prompt' and resolves
 * with the final state. Never throws.
 */
export async function requestMicrophonePermission({
  timeoutMs = DEFAULT_PERMISSION_WAIT_MS,
}: {
  timeoutMs?: number
} = {}): Promise<MicrophoneStateResult> {
  const current = await getMicrophoneState()
  if (current.state !== 'prompt') {
    return current
  }
  if (pendingPermission) {
    return new Promise((resolve) => {
      pendingPermission!.waiters.push(resolve)
    })
  }
  return new Promise<MicrophoneStateResult>((resolve) => {
    const timer = setTimeout(() => {
      settlePermission({ state: 'prompt', error: 'Timed out waiting for the microphone permission' })
    }, timeoutMs)
    pendingPermission = { waiters: [resolve], tabId: null, timer }
    void openMicrophonePage().then((tabId) => {
      if (pendingPermission) {
        pendingPermission.tabId = tabId
      }
    })
  })
}

function settlePermission(result: MicrophoneStateResult): void {
  const pending = pendingPermission
  if (!pending) {
    return
  }
  pendingPermission = null
  clearTimeout(pending.timer)
  for (const waiter of pending.waiters) {
    waiter(result)
  }
}

/** Called when microphone.html reports the user's answer. */
export function handleMicrophonePermissionResult({
  granted,
  error,
  tabId,
}: {
  granted: boolean
  error?: string
  tabId?: number
}): void {
  void getMicrophoneState().then((state) => {
    const resolved: MicrophoneStateResult = granted
      ? { state: 'granted', hasMicrophone: state.hasMicrophone }
      : { state: state.state === 'granted' ? 'granted' : state.state, hasMicrophone: state.hasMicrophone, error }
    settlePermission(resolved)
  })
  if (granted && tabId !== undefined) {
    // Give the page a moment to show "Done" before closing it
    setTimeout(() => {
      chrome.tabs.remove(tabId).catch(() => {})
    }, 1500)
  }
}

// ── Narration lifecycle (relay commands) ────────────────────────────────────

export async function handleStartNarration(params: StartNarrationParams): Promise<StartNarrationResult> {
  if (!params?.recordingId) {
    return { success: false, reason: 'capture-failed', error: 'recordingId is required' }
  }
  try {
    await ensureOffscreenDocument()
    const state = await getMicrophoneState()
    if (state.state === 'prompt') {
      // Visible interaction: the permission page. Bounded so a user who walks
      // away still gets their action recording.
      const answered = await requestMicrophonePermission({ timeoutMs: START_PERMISSION_WAIT_MS })
      if (answered.state !== 'granted') {
        return {
          success: false,
          reason: answered.state === 'denied' ? 'permission-denied' : 'permission-pending',
          error:
            answered.error ||
            (answered.state === 'denied' ? 'Microphone permission denied' : 'Microphone permission not granted yet'),
        }
      }
    }
    const result: OffscreenStartNarrationResult = await chrome.runtime.sendMessage({
      action: 'startNarration',
      recordingId: params.recordingId,
      audioBitsPerSecond: params.audioBitsPerSecond,
    })
    if (!result.success) {
      return result
    }
    activeNarrations.set(params.recordingId, { startedAt: result.startedAt })
    onActiveChanged?.(true)
    logger.debug('Narration started for recording', params.recordingId, result.mimeType)
    return result
  } catch (error) {
    logger.error('Failed to start narration:', error)
    return { success: false, reason: 'capture-failed', error: error instanceof Error ? error.message : String(error) }
  }
}

export async function handleStopNarration(params: StopNarrationParams): Promise<StopNarrationResult> {
  try {
    const result: OffscreenStopNarrationResult = await chrome.runtime.sendMessage({
      action: 'stopNarration',
      recordingId: params.recordingId,
    })
    return result
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    markNarrationEnded(params.recordingId)
  }
}

export async function handleCancelNarration(params: StopNarrationParams): Promise<{ success: true }> {
  try {
    await chrome.runtime.sendMessage({ action: 'cancelNarration', recordingId: params.recordingId })
  } catch (error) {
    logger.debug('Cancel narration failed:', error)
  }
  markNarrationEnded(params.recordingId)
  return { success: true }
}

export function markNarrationEnded(recordingId: string): void {
  if (!activeNarrations.delete(recordingId)) {
    return
  }
  if (activeNarrations.size === 0) {
    onActiveChanged?.(false)
  }
}

/** Relay socket gone: release the microphone right away. */
export function cancelAllNarrations(): void {
  for (const recordingId of [...activeNarrations.keys()]) {
    void chrome.runtime.sendMessage({ action: 'cancelNarration', recordingId }).catch(() => {})
    markNarrationEnded(recordingId)
  }
}

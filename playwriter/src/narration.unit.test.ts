// Unit tests for the relay side of microphone narration: file lifecycle with
// a fake extension transport, transcript normalization + timeline merge, and
// the local-only transcribe runner with a custom command.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  NARRATION_TRANSCRIPT_FILE,
  NarrationCapture,
  mergeTranscriptIntoEvents,
  normalizeTranscript,
  readNarrationMetadata,
  readNarrationTranscript,
  transcribeNarration,
  writeNarrationMetadata,
  type NarrationTransport,
} from './narration.js'
import type { StartNarrationResult } from './protocol.js'

const silentLogger = { log: () => {}, error: () => {} }

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pw-narration-unit-'))
}

function fakeTransport(options: {
  startResult?: StartNarrationResult
  onStop?: () => void
  stopFails?: boolean
}): NarrationTransport & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    start: async () => {
      calls.push('start')
      return (
        options.startResult ?? {
          success: true,
          recordingId: '1',
          startedAt: Date.now(),
          mimeType: 'audio/webm;codecs=opus',
        }
      )
    },
    stop: async () => {
      calls.push('stop')
      if (options.stopFails) {
        return { success: false, error: 'extension exploded' }
      }
      options.onStop?.()
      return { success: true, recordingId: '1', durationMs: 1234 }
    },
    cancel: async () => {
      calls.push('cancel')
    },
  }
}

describe('NarrationCapture', () => {
  it('writes chunks to narration.webm, aligns the audio start to the timeline, and persists metadata on stop', async () => {
    const recordingsDir = tempDir()
    const recordingStartedAt = Date.now() - 5000
    let capture!: NarrationCapture
    const transport = fakeTransport({
      startResult: {
        success: true,
        recordingId: '7',
        startedAt: recordingStartedAt + 1500,
        mimeType: 'audio/webm;codecs=opus',
        deviceLabel: 'Fake Mic',
      },
      onStop: () => {
        // The extension flushes the last chunk, then reports the end
        capture.handleChunk(Buffer.from('tail').toString('base64'))
        capture.handleEnded({ reason: 'stopped', durationMs: 1234 })
      },
    })
    capture = new NarrationCapture({
      recordingId: '7',
      recordingsDir,
      recordingStartedAt,
      transport,
      logger: silentLogger,
    })
    const outcome = await capture.start()
    expect(outcome).toMatchObject({
      active: true,
      audioStartMs: 1500,
      mimeType: 'audio/webm;codecs=opus',
      deviceLabel: 'Fake Mic',
    })
    expect(capture.isActive).toBe(true)
    capture.handleChunk(Buffer.from('head-').toString('base64'))

    const metadata = await capture.stop()
    expect(metadata).toMatchObject({
      recordingId: '7',
      source: 'microphone',
      audioStartMs: 1500,
      durationMs: 1234,
      sizeBytes: 9,
      endReason: 'stopped',
      transcriptPath: null,
    })
    expect(metadata!.audioPath).toBe(path.join(recordingsDir, '7', 'narration.webm'))
    expect(fs.readFileSync(metadata!.audioPath, 'utf-8')).toBe('head-tail')
    // no temp file left behind, metadata sidecar written
    expect(fs.readdirSync(path.join(recordingsDir, '7')).sort()).toEqual(['narration.json', 'narration.webm'])
    expect(readNarrationMetadata({ recordingsDir, recordingId: '7' })).toEqual(metadata)
    expect(transport.calls).toEqual(['start', 'stop'])
    expect(capture.isActive).toBe(false)
    // stopping twice is idempotent
    expect(await capture.stop()).toEqual(metadata)
  })

  it('reports a denied permission as unavailable without touching the disk', async () => {
    const recordingsDir = tempDir()
    const transport = fakeTransport({
      startResult: { success: false, reason: 'permission-denied', error: 'Microphone permission denied' },
    })
    const capture = new NarrationCapture({
      recordingId: '2',
      recordingsDir,
      recordingStartedAt: Date.now(),
      transport,
      logger: silentLogger,
    })
    expect(await capture.start()).toEqual({
      active: false,
      reason: 'permission-denied',
      error: 'Microphone permission denied',
    })
    expect(capture.isActive).toBe(false)
    expect(await capture.stop()).toBeNull()
    expect(capture.failureInfo()).toEqual({ reason: 'permission-denied', error: 'Microphone permission denied' })
    expect(fs.existsSync(path.join(recordingsDir, '2'))).toBe(false)
    expect(transport.calls).toEqual(['start'])
  })

  it('keeps the partial audio when the device is lost mid-recording', async () => {
    const recordingsDir = tempDir()
    const transport = fakeTransport({})
    const capture = new NarrationCapture({
      recordingId: '3',
      recordingsDir,
      recordingStartedAt: Date.now(),
      transport,
      logger: silentLogger,
    })
    expect((await capture.start()).active).toBe(true)
    capture.handleChunk(Buffer.from('partial').toString('base64'))
    capture.handleEnded({ reason: 'device-lost', error: 'Microphone track ended', durationMs: 900 })
    expect(capture.isActive).toBe(false)
    const metadata = capture.metadata()
    expect(metadata).toMatchObject({
      endReason: 'device-lost',
      error: 'Microphone track ended',
      sizeBytes: 7,
      durationMs: 900,
    })
    expect(fs.readFileSync(metadata!.audioPath, 'utf-8')).toBe('partial')
    // later chunks are ignored, stop does not call the extension again
    capture.handleChunk(Buffer.from('late').toString('base64'))
    expect(await capture.stop()).toEqual(metadata)
    expect(transport.calls).toEqual(['start'])
  })

  it('finalizes with an error when the extension never sends the final chunk', async () => {
    const recordingsDir = tempDir()
    const transport = fakeTransport({})
    const capture = new NarrationCapture({
      recordingId: '4',
      recordingsDir,
      recordingStartedAt: Date.now(),
      transport,
      logger: silentLogger,
      stopTimeoutMs: 50,
    })
    expect((await capture.start()).active).toBe(true)
    capture.handleChunk(Buffer.from('x').toString('base64'))
    const metadata = await capture.stop()
    expect(metadata).toMatchObject({ endReason: 'error', sizeBytes: 1, durationMs: 1234 })
    expect(metadata!.error).toContain('Timed out')
  })

  it('drops an empty capture instead of leaving a zero-byte file', async () => {
    const recordingsDir = tempDir()
    const transport = fakeTransport({ stopFails: true })
    const capture = new NarrationCapture({
      recordingId: '5',
      recordingsDir,
      recordingStartedAt: Date.now(),
      transport,
      logger: silentLogger,
    })
    expect((await capture.start()).active).toBe(true)
    expect(await capture.stop()).toBeNull()
    expect(capture.failureInfo()).toEqual({ reason: 'capture-failed', error: 'extension exploded' })
    expect(fs.existsSync(path.join(recordingsDir, '5', 'narration.webm'))).toBe(false)
  })

  it('destroy() on extension disconnect keeps what arrived', async () => {
    const recordingsDir = tempDir()
    const capture = new NarrationCapture({
      recordingId: '6',
      recordingsDir,
      recordingStartedAt: Date.now(),
      transport: fakeTransport({}),
      logger: silentLogger,
    })
    await capture.start()
    capture.handleChunk(Buffer.from('abc').toString('base64'))
    capture.destroy('Extension disconnected')
    expect(capture.metadata()).toMatchObject({ endReason: 'error', error: 'Extension disconnected', sizeBytes: 3 })
  })
})

describe('transcripts', () => {
  it('normalizes canonical, whisper.cpp and openai-whisper shapes', () => {
    expect(
      normalizeTranscript({
        segments: [
          { start: 1.5, end: 3, text: ' click submit ' },
          { start: 0, end: 1, text: 'first' },
        ],
      }),
    ).toEqual([
      { start: 0, end: 1, text: 'first' },
      { start: 1.5, end: 3, text: 'click submit' },
    ])
    expect(
      normalizeTranscript({
        transcription: [
          { timestamps: { from: '00:00:00,000', to: '00:00:01,240' }, offsets: { from: 0, to: 1240 }, text: ' hello' },
          { timestamps: { from: '00:00:01,240', to: '00:00:02,000' }, text: 'world' },
        ],
      }),
    ).toEqual([
      { start: 0, end: 1.24, text: 'hello' },
      { start: 1.24, end: 2, text: 'world' },
    ])
    expect(normalizeTranscript({ text: 'just text' })).toEqual([{ start: 0, end: 0, text: 'just text' }])
    expect(normalizeTranscript([{ start: 2, text: 'no end' }, { start: 1, end: 2, text: '' }, null])).toEqual([
      { start: 2, end: 2, text: 'no end' },
    ])
    expect(normalizeTranscript('garbage')).toEqual([])
  })

  it('interleaves narration before the action it precedes and keeps recording-stopped last', () => {
    const events = [
      { id: 1, t: 0, ms: 0, type: 'recording-started' },
      { id: 2, t: 2.1, ms: 2100, type: 'action', code: 'click' },
      { id: 3, t: 6, ms: 6000, type: 'action', code: 'fill' },
      { id: 4, t: 7, ms: 7000, type: 'recording-stopped' },
    ]
    const merged = mergeTranscriptIntoEvents({
      events,
      audioStartMs: 500,
      segments: [
        { start: 0.5, end: 1.5, text: 'open the form' },
        { start: 4, end: 5, text: 'type the name' },
        { start: 9, end: 10, text: 'done' },
      ],
    })
    expect(merged.map((e) => `${e.id} ${e.type} ${e.ms}${'text' in e ? ` ${e.text}` : ''}`)).toMatchInlineSnapshot(`
      [
        "1 recording-started 0",
        "n1 narration 1000 open the form",
        "2 action 2100",
        "n2 narration 4500 type the name",
        "3 action 6000",
        "n3 narration 9500 done",
        "4 recording-stopped 7000",
      ]
    `)
    expect(mergeTranscriptIntoEvents({ events, audioStartMs: 0, segments: [] })).toBe(events)
  })

  it('transcribes with a custom local command and links the transcript into the metadata', async () => {
    const recordingsDir = tempDir()
    const audioPath = path.join(recordingsDir, '9', 'narration.webm')
    fs.mkdirSync(path.dirname(audioPath), { recursive: true })
    fs.writeFileSync(audioPath, 'fake audio')
    writeNarrationMetadata({
      recordingsDir,
      metadata: {
        recordingId: '9',
        source: 'microphone',
        audioPath,
        mimeType: 'audio/webm',
        audioStartMs: 250,
        durationMs: 3000,
        sizeBytes: 10,
        endReason: 'stopped',
        transcriptPath: null,
      },
    })
    // A stand-in speech-to-text tool: copies the input path into the output JSON
    const fakeTool = path.join(recordingsDir, 'fake-stt.cjs')
    fs.writeFileSync(
      fakeTool,
      `const fs = require('node:fs'); const [input, output] = process.argv.slice(2);
       fs.writeFileSync(output, JSON.stringify({ segments: [{ start: 0, end: 1, text: 'heard ' + fs.readFileSync(input, 'utf-8') }] }))`,
    )
    const result = await transcribeNarration({
      recordingsDir,
      recordingId: '9',
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(fakeTool)} {input} {output}`,
    })
    expect(result.tool).toBe('command')
    expect(result.segments).toEqual([{ start: 0, end: 1, text: 'heard fake audio' }])
    expect(result.transcriptPath).toBe(path.join(recordingsDir, '9', NARRATION_TRANSCRIPT_FILE))
    expect(readNarrationTranscript({ recordingsDir, recordingId: '9' })).toMatchObject({
      source: 'command',
      segments: result.segments,
    })
    expect(readNarrationMetadata({ recordingsDir, recordingId: '9' })!.transcriptPath).toBe(result.transcriptPath)
    // scratch dir cleaned up
    expect(fs.readdirSync(path.join(recordingsDir, '9')).sort()).toEqual([
      'narration.json',
      'narration.transcript.json',
      'narration.webm',
    ])
  })

  it('fails clearly when the command writes nothing or the recording has no narration', async () => {
    const recordingsDir = tempDir()
    await expect(transcribeNarration({ recordingsDir, recordingId: '1', command: 'true' })).rejects.toThrow(
      'has no narration',
    )
    fs.mkdirSync(path.join(recordingsDir, '1'))
    fs.writeFileSync(path.join(recordingsDir, '1', 'narration.webm'), 'x')
    writeNarrationMetadata({
      recordingsDir,
      metadata: {
        recordingId: '1',
        source: 'microphone',
        audioPath: path.join(recordingsDir, '1', 'narration.webm'),
        mimeType: 'audio/webm',
        audioStartMs: 0,
        durationMs: 1,
        sizeBytes: 1,
        endReason: 'stopped',
        transcriptPath: null,
      },
    })
    await expect(
      transcribeNarration({
        recordingsDir,
        recordingId: '1',
        command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      }),
    ).rejects.toThrow('produced no output')
  })
})

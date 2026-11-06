// Explicit real provider check. Shares the authorized cumulative $5 ledger; executes no game command.
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { loadZeroGProvider } from '../../backend/src/inference/zero-g.mjs'
import { speakVoice, transcribeVoice, playbackPcm, pcmWav } from '../../backend/src/inference/zero-g-speech.mjs'
if (process.argv[2] !== '--run') { console.log('Use --run for a small real 0G speech round trip under the existing shared allowance.'); process.exit(0) }
const root = fileURLToPath(new URL('../../', import.meta.url))
const config = JSON.parse(await readFile(join(root, '.local/comparison/providers.json'), 'utf8'))
const provider = await loadZeroGProvider(root, config.CityAgent2)
const budget = async () => { const s = JSON.parse(await readFile(provider.budget.file, 'utf8')); return { limitNanoUsd: s.limitNanoUsd, spentNanoUsd: s.spentNanoUsd, pendingIds: Object.keys(s.pending).sort() } }
const runId = randomUUID(), directory = join(root, 'evidence/runs/voice-provider', runId)
const report = { status: 'fail', inferenceOnly: true, gameActions: 0, before: await budget(), checks: [] }
try {
  const phrase = 'Follow me.', start = Date.now(), spoken = await speakVoice(provider, phrase, '0g')
  const pcm = await playbackPcm(spoken.audio)
  // Convert the validated 48 kHz mono playback stream to the capture format without saving audio.
  const input = await new Promise((resolve, reject) => {
    const process = spawn('ffmpeg', ['-hide_banner','-loglevel','error','-f','s16le','-ar','48000','-ac','1','-i','pipe:0','-ar','16000','-ac','1','-f','s16le','pipe:1'])
    const chunks = []; process.stdout.on('data', b => chunks.push(b)); process.stderr.resume(); process.stdin.on('error', reject)
    process.on('error', reject); process.on('close', code => code === 0 ? resolve(pcmWav(Buffer.concat(chunks))) : reject(Error('PROBE_CONVERSION_FAILED'))); process.stdin.end(pcm)
  })
  const transcript = await transcribeVoice(provider, input)
  assert.match(transcript.text, /follow\s+me/i)
  report.checks.push({ name: '0G MiniMax voice to Whisper transcription', status: 'pass', transcript: transcript.text, elapsedMs: Date.now() - start,
    playbackSamples: pcm.length / 2, audioSha256: createHash('sha256').update(spoken.audio).digest('hex') })
  const second = await speakVoice(provider, 'I will wait here.', 'agent')
  assert((await playbackPcm(second.audio)).length > 0)
  report.checks.push({ name: 'Distinct Agent voice produces valid Minecraft playback PCM', status: 'pass' })
  report.after = await budget(); assert(report.after.spentNanoUsd > report.before.spentNanoUsd)
  assert.deepEqual(report.after.pendingIds, report.before.pendingIds)
  assert.equal(report.after.limitNanoUsd, report.before.limitNanoUsd)
  report.status = 'pass'
} catch (error) { report.error = /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'VOICE_LIVE_CHECK_FAILED'; throw error }
finally { await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report)) }

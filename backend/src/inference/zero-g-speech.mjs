import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { zeroGRouter } from './zero-g.mjs'
import { zeroGSpeechModels, reserveZeroGAudio, recordZeroGAudio } from './zero-g-budget.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
export function pcmWav(pcm, sampleRate = 16000) {
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || ![16000, 48000].includes(sampleRate)) throw Error('VOICE_PCM_REQUIRED')
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40); return Buffer.concat([header, pcm])
}
export function voiceWavSeconds(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
    wav.readUInt32LE(16) !== 16 || wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1 || wav.readUInt32LE(24) !== 16000 ||
    wav.readUInt32LE(28) !== 32000 || wav.readUInt16LE(32) !== 2 || wav.readUInt16LE(34) !== 16 || wav.toString('ascii', 36, 40) !== 'data' ||
    wav.readUInt32LE(40) !== wav.length - 44 || wav.readUInt32LE(4) !== wav.length - 8 || (wav.length - 44) % 2) throw Error('VOICE_WAV_FORMAT_REQUIRED')
  const seconds = (wav.length - 44) / 32000
  if (seconds < 0.2 || seconds > 12) throw Error('VOICE_CLIP_MUST_BE_0_2_TO_12_SECONDS')
  return seconds
}
async function bounded(response, maximum) {
  const chunks = []; let length = 0
  for await (const chunk of response.body) { length += chunk.length; if (length > maximum) throw Error('VOICE_RESPONSE_TOO_LARGE'); chunks.push(chunk) }
  return Buffer.concat(chunks)
}
function validate(provider) {
  if (provider?.kind !== '0g' || provider.baseUrl !== zeroGRouter.baseUrl || provider.liveAccess !== true || !/^sk-[^\s]+$/.test(provider.apiKey || '')) throw Error('ZERO_G_VOICE_PROVIDER_REQUIRED')
}
export async function speechPricing(model, fetcher = fetch) {
  const response = await fetcher(zeroGRouter.baseUrl + '/models', { redirect: 'error', signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw Error('ZERO_G_VOICE_CATALOG_UNAVAILABLE')
  const row = JSON.parse((await bounded(response, 2097152)).toString()).data?.find(value => value.id === model), expected = zeroGSpeechModels[model]
  if (!expected || !row || Number(row.pricing_usd?.prompt) !== expected.unitNanoUsd / 1e9 ||
    row.type !== (expected.unit === 'second' ? 'speech-to-text' : 'text-to-speech') ||
    expected.unit === 'character' && (!row.speech_capabilities?.response_formats?.includes('wav') || row.speech_capabilities.max_input_bytes !== 2000)) throw Error('ZERO_G_VOICE_PRICE_OR_CAPABILITIES_CHANGED')
  return { ...expected, source: zeroGRouter.baseUrl + '/models', observedAt: new Date().toISOString() }
}
export async function transcribeVoice(provider, wav, { fetcher = fetch } = {}) {
  validate(provider); const seconds = voiceWavSeconds(wav), model = 'whisper-large-v3'
  const pricing = await speechPricing(model, fetcher)
  const reservation = await reserveZeroGAudio(provider, model, Math.max(1, Math.ceil(seconds)), sha(wav), pricing)
  const form = new FormData(); form.append('model', model); form.append('file', new Blob([wav], { type: 'audio/wav' }), 'command.wav')
  const response = await fetcher(zeroGRouter.baseUrl + '/audio/transcriptions', { method: 'POST', redirect: 'error',
    headers: { Authorization: 'Bearer ' + provider.apiKey }, body: form, signal: AbortSignal.timeout(45000) })
  if (!response.ok) throw Error('ZERO_G_TRANSCRIPTION_HTTP_' + response.status)
  const body = JSON.parse((await bounded(response, 65536)).toString())
  if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 800) throw Error('VOICE_TRANSCRIPT_INVALID')
  await recordZeroGAudio(provider, reservation, response.headers.get('x-request-id'))
  return { text: body.text.trim(), model, seconds }
}
export async function speakVoice(provider, input, worker, { fetcher = fetch } = {}) {
  validate(provider)
  if (typeof input !== 'string' || !input.trim() || input.length > 240 || Buffer.byteLength(input) > 2000 || !['0g', 'agent'].includes(worker)) throw Error('VOICE_REPLY_INVALID')
  const model = 'minimax-speech-2.8-turbo', voice = worker === '0g' ? 'English_Trustworth_Man' : 'English_CalmWoman'
  const request = { model, input, voice, response_format: 'wav', speed: 1 }
  const pricing = await speechPricing(model, fetcher)
  const reservation = await reserveZeroGAudio(provider, model, Buffer.byteLength(input), sha(JSON.stringify(request)), pricing)
  const response = await fetcher(zeroGRouter.baseUrl + '/audio/speech', { method: 'POST', redirect: 'error', headers: {
    Authorization: 'Bearer ' + provider.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(45000) })
  if (!response.ok) throw Error('ZERO_G_SPEECH_HTTP_' + response.status)
  const audio = await bounded(response, 4194304)
  if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw Error('VOICE_AUDIO_FORMAT_INVALID')
  await recordZeroGAudio(provider, reservation, response.headers.get('x-request-id'))
  return { audio, model, voice }
}
export async function playbackPcm(wav) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-ar', '48000', '-ac', '1', '-f', 's16le', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks = []; let bytes = 0, stopped = false
    const timer = setTimeout(() => { stopped = true; child.kill(); reject(Error('VOICE_AUDIO_CONVERSION_TIMEOUT')) }, 10000)
    child.stdout.on('data', b => { bytes += b.length; if (bytes > 2880000) { stopped = true; child.kill(); reject(Error('VOICE_PLAYBACK_TOO_LONG')) } else chunks.push(b) })
    child.stderr.resume(); child.stdin.on('error', () => {}); child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); if (!stopped) code === 0 && bytes > 0 && bytes % 2 === 0 ? resolve(Buffer.concat(chunks)) : reject(Error('VOICE_AUDIO_CONVERSION_FAILED')) })
    child.stdin.end(wav)
  })
}

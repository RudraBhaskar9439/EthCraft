import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import checkpoints from '../bot/checkpoint-store.cjs'
import { transcribeVoice, speakVoice, playbackPcm } from '../inference/zero-g-speech.mjs'

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const hash = value => createHash('sha256').update(value).digest('hex')
export function voiceCommand(text, selected) {
  if (typeof text !== 'string' || !text.trim() || text.length > 800 || !['0g', 'agent'].includes(selected)) throw Error('VOICE_COMMAND_INVALID')
  let command = text.trim().replace(/^(?:hey|hello|hi)[,\s]+/i, ''), worker = selected
  const match = command.match(/^(zero\s*g|0\s*g|जीरो\s*जी|ज़ीरो\s*जी|agent|एजेंट)[,\s:]+/i)
  if (match) { worker = /^(agent|एजेंट)$/i.test(match[1]) ? 'agent' : '0g'; command = command.slice(match[0].length).trim() }
  if (!command || command.startsWith('/')) throw Error('VOICE_AGENT_COMMAND_REQUIRED')
  return { worker, command }
}
const shortReply = text => String(text).replace(/\bclaude\b/gi, 'Agent').replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '').replace(/\s+/g, ' ').trim().slice(0, 230)

export class VoiceRuntime {
  constructor({ root, api, identity, serverId, provider, dispatch, transcribe = transcribeVoice, speak = speakVoice, convert = playbackPcm }) {
    Object.assign(this, { root, api, identity, serverId, provider, dispatch, transcribe, speak, convert })
    this.file = join(root, '.local/voice/turns.json'); this.state = { version: 1, turns: {} }; this.inFlight = new Map(); this.writes = Promise.resolve(); this.closed = false
  }
  async initialize() {
    try { this.state = JSON.parse(await readFile(this.file, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
    if (this.state.version !== 1 || !this.state.turns || Array.isArray(this.state.turns)) throw Error('VOICE_JOURNAL_INVALID')
    for (const turn of Object.values(this.state.turns)) if (!['complete', 'failed', 'interrupted'].includes(turn.status)) turn.status = 'interrupted'
    await this.save(); return this
  }
  save() {
    const snapshot = structuredClone(this.state), work = this.writes.then(() => checkpoints.writeCheckpoint(this.file, snapshot))
    this.writes = work.catch(() => {}); return work
  }
  async approved(meta) {
    if (!UUID.test(meta.playerId || '') || !UUID.test(meta.connectionId || '') || !UUID.test(meta.operationId || '') || !['0g', 'agent'].includes(meta.provider)) throw Error('VOICE_EVENT_INVALID')
    const current = await this.api('session?playerId=' + meta.playerId), owner = await this.identity.getMinecraftOwner(this.serverId, meta.playerId)
    if (this.closed || !current.online || current.pendingAuthentication !== false || current.connectionId !== meta.connectionId || owner?.ownerId !== current.principalId || owner.minecraftPlayerId !== meta.playerId || current.serverPosition?.world !== 'agentcity_mumbai') throw Error('VOICE_APPROVED_OWNER_REQUIRED')
    const status = await this.api('voice/status'), enrollment = status.enrolled?.find(e => e.playerId === meta.playerId && e.connectionId === meta.connectionId)
    if (!enrollment || enrollment.turnId !== meta.operationId || enrollment.provider !== meta.provider) throw Error('VOICE_TURN_SUPERSEDED')
    return current
  }
  async poll() {
    if (this.closed) return
    const { pending = [] } = await this.api('voice/status')
    for (const meta of pending) {
      if (this.inFlight.size >= 2 || this.inFlight.has(meta.operationId)) continue
      if (this.state.turns[meta.operationId]) { await this.api('voice/ack', { operationId: meta.operationId }); continue }
      const work = this.turn(meta).catch(() => {}).finally(() => this.inFlight.delete(meta.operationId))
      this.inFlight.set(meta.operationId, work)
    }
  }
  async turn(meta) {
    const turn = this.state.turns[meta.operationId] = { ...meta, status: 'received', createdAt: new Date().toISOString() }
    try {
      await this.approved(meta)
      const clip = await this.api('voice/clip?operationId=' + meta.operationId)
      if (clip.operationId !== meta.operationId || clip.playerId !== meta.playerId || clip.connectionId !== meta.connectionId || typeof clip.wavBase64 !== 'string' || clip.wavBase64.length > 512100) throw Error('VOICE_CLIP_BINDING_CHANGED')
      const wav = Buffer.from(clip.wavBase64, 'base64'); turn.audioSha256 = hash(wav); turn.status = 'transcribing'; await this.save()
      const transcript = await this.transcribe(this.provider, wav)
      turn.transcript = transcript.text; turn.status = 'transcribed'; await this.save()
      const current = await this.approved(meta), parsed = voiceCommand(transcript.text, meta.provider)
      turn.worker = parsed.worker; turn.status = 'dispatching'; await this.save()
      const message = await this.dispatch({ operationId: meta.operationId, playerId: meta.playerId, playerName: current.playerName,
        connectionId: meta.connectionId, action: 'agent', args: parsed.worker + ' ' + parsed.command, createdAtMs: meta.createdAtMs })
      turn.message = String(message); turn.status = 'accepted'; await this.save()
      await this.approved(meta)
      const spoken = / accepted: /.test(turn.message) ? parsed.worker + ': Task accepted. I will report the result.' : shortReply(turn.message)
      turn.status = 'speaking'; await this.save()
      const result = await this.speak(this.provider, spoken, parsed.worker), pcm = await this.convert(result.audio)
      await this.approved(meta)
      const reply = await this.api('voice/reply', { ...meta, text: shortReply(turn.message), pcmBase64: pcm.toString('base64') })
      if (reply.played) await new Promise(resolve => setTimeout(resolve, pcm.length / 96))
      turn.status = 'complete'; await this.save()
    } catch (error) {
      turn.status = 'failed'; turn.error = /^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'VOICE_REQUEST_UNAVAILABLE'
      await this.save()
      await this.api('voice/reply', { ...meta, text: 'Voice request stopped: ' + turn.error + '. Your existing task and funds are preserved.' }).catch(() => {})
    } finally { await this.api('voice/ack', { operationId: meta.operationId }).catch(() => {}) }
  }
  async notice({ playerId, worker, job }) {
    if (job) await this.inFlight.get(job.operationId)
    const turn = job && this.state.turns[job.operationId]
    if (this.closed || !turn || turn.worker !== worker || !['ready_for_review', 'blocked', 'paused'].includes(job.status)) return
    const key = 'notice:' + job.id + ':' + job.status
    if (this.state.turns[key]) return
    const status = await this.api('voice/status'), enrollment = status.enrolled?.find(e => e.playerId === playerId && e.connectionId === turn.connectionId && e.provider === turn.provider && e.turnId === job.operationId)
    if (!enrollment) return
    const meta = { operationId: enrollment.turnId, playerId, connectionId: enrollment.connectionId, provider: enrollment.provider }
    await this.approved(meta)
    this.state.turns[key] = { status: 'speaking', jobId: job.id }; await this.save()
    try {
      const text = worker + (job.status === 'ready_for_review' ? ': The work is ready for your review. Check the in-game result and 0G assessment.' : ': ' + shortReply(job.message).slice(0, 190))
      const result = await this.speak(this.provider, text, worker), pcm = await this.convert(result.audio)
      await this.approved(meta); await this.api('voice/reply', { ...meta, noticeId: hash(key), text, pcmBase64: pcm.toString('base64') })
      this.state.turns[key].status = 'complete'
    } catch { this.state.turns[key].status = 'failed' }
    await this.save()
  }
  async close() { this.closed = true; await Promise.allSettled(this.inFlight.values()); await this.writes }
}

export async function openVoiceRuntime(options) {
  let settings
  try { settings = JSON.parse(await readFile(join(options.root, '.local/voice/settings.json'), 'utf8')) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
  if (settings.version !== 1 || settings.enabled !== true) return null
  return new VoiceRuntime(options).initialize()
}

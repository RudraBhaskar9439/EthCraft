// Approved-session and durable-turn fixtures; no microphone, model or game effects.
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {VoiceRuntime,voiceCommand} from '../../backend/src/playable/voice.mjs'
import {pcmWav} from '../../backend/src/inference/zero-g-speech.mjs'
assert.deepEqual(voiceCommand('Hey Agent, follow me','0g'),{worker:'agent',command:'follow me'})
assert.deepEqual(voiceCommand('Zero G, come here','agent'),{worker:'0g',command:'come here'})
assert.throws(()=>voiceCommand('/op Micro','0g'),/AGENT_COMMAND_REQUIRED/)
const root=await mkdtemp(join(tmpdir(),'voice-turn-'))
try{
 const playerId=randomUUID(),connectionId=randomUUID(),principalId=randomUUID(),operationId=randomUUID()
 const meta={playerId,connectionId,operationId,provider:'0g',createdAtMs:Date.now()}
 let approved=true,latest=operationId,transcriptions=0,speeches=0,dispatches=0,supersede=false
 const messages=[]
 const options={root,serverId:'fixture',provider:{apiKey:'fixture-not-for-journals'},identity:{getMinecraftOwner:async()=>({ownerId:principalId,minecraftPlayerId:playerId})},
  api:async(path,input)=>{
   if(path.startsWith('session?'))return{online:true,pendingAuthentication:!approved,connectionId,principalId,playerName:'Fixture',serverPosition:{world:'agentcity_mumbai'}}
   if(path==='voice/status')return{pending:[meta],enrolled:[{playerId,connectionId,provider:'0g',turnId:latest}]}
   if(path.startsWith('voice/clip?'))return{...meta,wavBase64:pcmWav(Buffer.alloc(32000)).toString('base64')}
   assert(['voice/ack','voice/reply'].includes(path));messages.push({path,input});return{played:true}
  },dispatch:async event=>{dispatches++;assert.equal(event.operationId,operationId);assert.equal(event.playerId,playerId);assert.equal(event.args,'0g follow me');return'0G will follow you.'},
  transcribe:async()=>{transcriptions++;if(supersede)latest=randomUUID();return{text:'follow me'}},speak:async()=>{speeches++;return{audio:Buffer.from('fixture')}},convert:async()=>Buffer.alloc(9600)}
 let service=await new VoiceRuntime(options).initialize();await service.poll();await Promise.all(service.inFlight.values());await service.poll()
 assert.equal(dispatches,1);assert.equal(transcriptions,1);assert.equal(speeches,1);assert.equal(service.state.turns[operationId].status,'complete')
 assert(!JSON.stringify(JSON.parse(await readFile(service.file))).includes('fixture-not-for-journals'));assert(!JSON.stringify(service.state).includes('wavBase64'))
 await service.close();service=await new VoiceRuntime(options).initialize();await service.poll();assert.equal(dispatches,1);await service.close()
 console.log('PASS actual native actor/connection context reaches dispatch once; restart deduplicates the turn and journals exclude raw audio and credentials')
 meta.operationId=randomUUID();latest=meta.operationId;approved=false
 service=await new VoiceRuntime({...options,root:join(root,'unapproved')}).initialize();await service.poll();await Promise.all(service.inFlight.values());assert.equal(transcriptions,1);assert.equal(dispatches,1);await service.close()
 approved=true;supersede=true;meta.operationId=randomUUID();latest=meta.operationId
 service=await new VoiceRuntime({...options,root:join(root,'superseded')}).initialize();await service.poll();await Promise.all(service.inFlight.values());assert.equal(transcriptions,2);assert.equal(dispatches,1);assert.equal(speeches,1);await service.close()
 console.log('PASS unapproved sessions cannot invoke audio inference; a new push-to-talk turn fences old transcription before action or speech')
  supersede=false;meta.operationId=randomUUID();latest=meta.operationId
  service=await new VoiceRuntime({...options,root:join(root,'notice'),transcribe:async()=>({text:'Agent, craft four sticks'}),dispatch:async()=> 'Task accepted.'}).initialize()
  await service.poll()
  const job={id:randomUUID(),operationId:meta.operationId,status:'ready_for_review'}
  await service.notice({playerId,worker:'agent',job})
  assert.equal(service.state.turns[meta.operationId].status,'complete')
  assert.equal(service.state.turns['notice:'+job.id+':ready_for_review'].status,'complete')
  const replies=messages.filter(m=>m.path==='voice/reply'&&m.input.operationId===meta.operationId)
  assert.equal(replies.length,2);assert.equal(replies[0].input.noticeId,undefined);assert(replies[1].input.noticeId)
  await service.notice({playerId,worker:'agent',job});assert.equal(messages.filter(m=>m.path==='voice/reply'&&m.input.operationId===meta.operationId).length,2)
  await service.close()
  console.log('PASS completion follows the acceptance audio once, including an agent selected by spoken name')
}finally{await rm(root,{recursive:true,force:true})}

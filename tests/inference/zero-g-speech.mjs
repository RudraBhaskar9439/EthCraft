// Controlled HTTP fixtures; no provider requests or live credit usage.
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {initializeZeroGBudget,validateZeroGBudget,reserveZeroGRequest,zeroGModel} from '../../backend/src/inference/zero-g-budget.mjs'
import {pcmWav,voiceWavSeconds,transcribeVoice,speakVoice,playbackPcm} from '../../backend/src/inference/zero-g-speech.mjs'
const dir=await mkdtemp(join(tmpdir(),'voice-budget-'))
try{
 const budget={file:join(dir,'usage.json'),authorizationId:'same-approved-five-dollar-budget',limitUsd:'5'}
 await initializeZeroGBudget(budget)
 const provider={kind:'0g',baseUrl:'https://router-api.0g.ai/v1',apiKey:'sk-fixture-not-a-real-key',liveAccess:true,budget}
 const pricing={...zeroGModel,source:provider.baseUrl+'/models',observedAt:new Date().toISOString()}
 const old=await reserveZeroGRequest({...provider,model:zeroGModel.model},{model:zeroGModel.model,max_tokens:512},pricing)
 let calls=0,generations=0,timeout=false,changed=false
 const wav=pcmWav(Buffer.alloc(32000))
 const fetcher=async(url,options)=>{
  calls++
  if(url.endsWith('/models'))return new Response(JSON.stringify({data:[{id:'whisper-large-v3',type:'speech-to-text',pricing_usd:{prompt:'0.00013'}},{id:'minimax-speech-2.8-turbo',type:'text-to-speech',pricing_usd:{prompt:changed?'0.0002':'0.000108'},speech_capabilities:{max_input_bytes:2000,response_formats:['wav']}}]}))
  assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer '+provider.apiKey);generations++
  if(timeout)throw Error('fixture timeout after possible charge')
  if(url.endsWith('/transcriptions')){assert.equal(options.body.get('model'),'whisper-large-v3');return new Response(JSON.stringify({text:'Follow me.'}),{headers:{'x-request-id':'asr-fixture'}})}
  const request=JSON.parse(options.body);assert.equal(request.voice,'English_Trustworth_Man');return new Response(pcmWav(Buffer.alloc(96000),48000),{headers:{'content-type':'audio/wav','x-request-id':'tts-fixture'}})
 }
 assert.equal(voiceWavSeconds(wav),1)
 assert.equal((await transcribeVoice(provider,wav,{fetcher})).text,'Follow me.')
 const speech=await speakVoice(provider,'Hello','0g',{fetcher});assert.equal(speech.model,'minimax-speech-2.8-turbo')
 let state=JSON.parse(await readFile(budget.file));assert(state.pending[old]);assert.equal(Object.keys(state.pending).length,1);assert.equal(state.spentNanoUsd,670000)
 assert.equal((await playbackPcm(speech.audio)).length,96000)
 const before=calls;await assert.rejects(transcribeVoice(provider,Buffer.from('not audio'),{fetcher}),/WAV_FORMAT/);assert.equal(calls,before)
 await assert.rejects(transcribeVoice(provider,pcmWav(Buffer.alloc(13*32000)),{fetcher}),/0_2_TO_12/)
 await assert.rejects(speakVoice({...provider,baseUrl:'https://foreign.invalid'},'Hello','0g',{fetcher}),/PROVIDER_REQUIRED/)
 changed=true;const generationBefore=generations;await assert.rejects(speakVoice(provider,'Hello','0g',{fetcher}),/PRICE_OR_CAPABILITIES_CHANGED/);assert.equal(generations,generationBefore)
 changed=false;timeout=true;await assert.rejects(speakVoice(provider,'Hello','0g',{fetcher}),/fixture timeout/)
 state=JSON.parse(await readFile(budget.file));assert(state.pending[old]);assert.equal(Object.keys(state.pending).length,2);await validateZeroGBudget(budget)
 console.log('PASS shared audio/text cap retains old and uncertain reservations, meters bounded duration/UTF-8 conservatively, validates audio and prices before spending, and converts real WAV to playback PCM')
 const small={file:join(dir,'small.json'),authorizationId:'small-fixture',limitUsd:'0.001'};await initializeZeroGBudget(small);timeout=false
 const n=generations;await assert.rejects(speakVoice({...provider,budget:small},'A longer voice reply','0g',{fetcher}),/budget exhausted/);assert.equal(generations,n)
 console.log('PASS exhausted shared credit prevents audio generation; no paid calls')
}finally{await rm(dir,{recursive:true,force:true})}

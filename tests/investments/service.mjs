// Real isolated PostgreSQL; injected chain, session and signing fixtures. No public transactions or live wallet access.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID,createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {createInvestmentService} from '../../backend/src/investments/service.mjs'
const require=createRequire(new URL('../../backend/package.json',import.meta.url)),{Pool}=require('pg')
const {encodeEventTopics,encodeAbiParameters,parseAbiParameters,zeroAddress,keccak256,stringToHex}=require('viem')
const address=n=>'0x'+n.repeat(40),hash=v=>createHash('sha256').update(v).digest('hex')
const env=JSON.parse(await readFile(new URL('../../.local/backend/environment.json',import.meta.url),'utf8'))
const schema='test_invest_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:env.databaseUrl,max:1})
const pool=new Pool({connectionString:env.databaseUrl,options:'-c search_path='+schema,max:6})
const playerId=randomUUID(),principal=randomUUID(),connectionId=randomUUID(),wallet=address('7'),subject='did:privy:fixtureinvest'
const owner={ownerId:principal,ownerName:'Micro',minecraftPlayerId:playerId,privySubject:subject}
let time=2000000000000,approved=true,policy=false,loseSignature=false,reorganized=false,ready=true,changedPins=false,signatures=0,broadcasts=0
const intents=new Map(),bindings=new Map()
const manifest={chainId:1301,mode:'marketplace',rpcUrl:'https://sepolia.unichain.org',deploymentId:'0x'+'a'.repeat(64),maxGas:1000000,maxNativeCostWei:'500000000000000',city:address('1'),usdc:address('2'),positionManager:address('3'),permit2:address('4'),poolManager:address('5'),hook:address('6'),pools:{cityUsdc:{currency0:address('1'),currency1:address('2'),fee:8388608,tickSpacing:60,hooks:address('6')}}}
const sqrt=(1n<<96n)/1000000n,tick=-276325
const receipt={logs:[{address:manifest.positionManager,topics:encodeEventTopics({abi:require('viem').parseAbi(['event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']),eventName:'Transfer',args:{from:zeroAddress,to:wallet,tokenId:42n}}),data:'0x'}]}
const client={getBlock:async()=>({number:1n,timestamp:BigInt(time/1000),hash:'0x'+'b'.repeat(64)}),getBalance:async()=>10n**18n,
  readContract:async input=>{
    if(input.functionName==='extsload')return ['0x'+(sqrt|(BigInt.asUintN(24,BigInt(tick))<<160n)).toString(16).padStart(64,'0'),'0x0','0x0','0x2386f26fc10000']
    if(input.functionName==='marketReference')return [ready,tick,1n,300n]
    if(input.functionName==='balanceOf')return 10n**25n
    throw Error('fixture unexpected '+input.functionName)
  }}
const signer={
  prepare:async input=>{
    assert.equal(input.playerId,principal);assert.equal(input.subject,subject)
    assert.equal(input.limits.maxNativeCostWei,'30000000000000')
    if(bindings.has(input.operationId))assert.deepEqual(input,bindings.get(input.operationId))
    else {bindings.set(input.operationId,structuredClone(input));signatures++;intents.set(input.operationId,{status:'prepared',hash:keccak256(stringToHex(input.operationId))})}
    if(loseSignature){loseSignature=false;throw Error('FIXTURE_PROVIDER_REPLY_LOST')}
    return intents.get(input.operationId)
  },
  reconcile:async({operationId})=>({...intents.get(operationId),status:reorganized?'reorganized':intents.get(operationId).status,receipt}),
  broadcast:async({operationId})=>{broadcasts++;intents.get(operationId).status='confirmed'}
}
const options={pool,manifest,client,identity:{getMinecraftOwner:async()=>owner},serverId:'fixture',now:()=>time,
  gameSession:async()=>({online:true,pendingAuthentication:!approved,playerId,connectionId,principalId:principal,playerName:'Micro',authenticationKind:'discord_approved_local_profile'}),
  verifyDeployment:async()=>({deploymentId:manifest.deploymentId,positionManager:hash('manager'),permit2:hash('permit'),hook:hash(changedPins?'changed-hook':'hook'),router:hash('router')}),
  getSigner:async()=>{if(!policy)throw Error('INVEST_SEPARATE_PRIVY_POLICY_REQUIRED');return signer}}
const actor={playerId,connectionId},input={...actor,action:'deposit',amount0:'1000000000000000000',amount1:'1000000',tickLower:-276960,tickUpper:-275760}
try{
  await admin.query('CREATE SCHEMA '+schema)
  await pool.query(`CREATE TABLE ac_playable_testnet_wallets(wallet_id text,environment text,address text,provider_type text,provider_account_id text,external_id text,auth_subject_hash text);
    CREATE TABLE ac_discord_wallet_aliases(wallet_id text,principal_id uuid,address text,provider_account_id text);
    CREATE TABLE ac_playable_testnet_requests(operation_id uuid);`)
  await pool.query('INSERT INTO ac_playable_testnet_wallets VALUES($1,$2,$3,$4,$5,$6,$7)',['UNICHAIN_SEPOLIA_PLAYABLE:'+principal,'UNICHAIN_SEPOLIA_PLAYABLE',wallet,'privy','account','external',hash(subject)])
  await pool.query('INSERT INTO ac_discord_wallet_aliases VALUES($1,$2,$3,$4)',['UNICHAIN_SEPOLIA_PLAYABLE:'+principal,principal,wallet,'account'])
  let api=await createInvestmentService(options)
  const preview=await api.preview(input),op={...actor,operationId:preview.operationId}
  assert.equal(preview.status,'preview');assert.equal(preview.realTransaction,false);assert.equal(signatures,0)
  await api.status(op);assert.equal(signatures,0)
  await assert.rejects(api.confirm({...op,confirmationId:randomUUID(),consentNonce:'wrong'}),/FRESH_NATIVE/)
  await assert.rejects(api.confirm({...op,confirmationId:randomUUID(),consentNonce:preview.consentNonce}),/SEPARATE_PRIVY_POLICY/)
  assert.equal((await api.status(op)).confirmed,false);assert.equal(signatures,0)
  console.log('PASS preview/status/invalid consent/shop-only policy cannot authorize investments')
  const storedPins=(await pool.query('SELECT terms FROM ac_investment_operations WHERE operation_id=$1',[op.operationId])).rows[0].terms.pins
  assert.deepEqual(storedPins,await options.verifyDeployment())
  assert.notEqual(JSON.stringify(storedPins),JSON.stringify(await options.verifyDeployment()))
  policy=true;changedPins=true
  await assert.rejects(api.confirm({...op,confirmationId:randomUUID(),consentNonce:preview.consentNonce}),/INVEST_DEPLOYMENT_CHANGED/)
  assert.equal(signatures,0);assert.equal(broadcasts,0)
  console.log('PASS genuinely changed deployment pins block signing and broadcasting')
  changedPins=false;loseSignature=true
  await assert.rejects(api.confirm({...op,confirmationId:randomUUID(),consentNonce:preview.consentNonce}),/FIXTURE_PROVIDER_REPLY_LOST/)
  assert.equal(signatures,1)
  api=await createInvestmentService(options)
  let result=await api.status(op);assert.equal(signatures,1)
  for(let i=0;i<10&&result.status!=='complete';i++)result=await api.status(op)
  assert.equal(result.status,'complete');assert.equal(result.tokenId,'42');assert.equal(signatures,7)
  await api.status(op);assert.equal(signatures,7);assert.equal(broadcasts,7)
  console.log('PASS unchanged deployment pins survive PostgreSQL jsonb key ordering')
  console.log('PASS restart after lost signing reply resumes the same seven immutable stages without duplicate signatures or deposits')
  api=await createInvestmentService({...options,getSigner:async()=>{throw Error('FIXTURE_SIGNER_OFFLINE')},getRecoverySigner:async()=>signer})
  assert.equal((await api.status(op)).status,'complete');assert.equal(signatures,7)
  console.log('PASS retained signed receipts remain readable when fresh signing permission is unavailable')
  api=await createInvestmentService(options)
  reorganized=true;const changed=await api.status(op);assert.notEqual(changed.status,'complete');assert.equal(signatures,7);reorganized=false
  console.log('PASS canonicality is rechecked before reporting success; reorganization stops advancement')
  approved=false;await assert.rejects(api.status(op),/APPROVED_PLAYER/);approved=true
  await assert.rejects(api.status({...op,playerId:randomUUID()}),/APPROVED_PLAYER/)
  await assert.rejects(pool.query("UPDATE ac_investment_operations SET terms='{}' WHERE operation_id=$1",[op.operationId]),/INVEST_IMMUTABLE_TERMS/)
  console.log('PASS live owner/session checks and database immutability protect retained funds and terms')
  ready=false;await assert.rejects(api.preview(input),/REFERENCE_NOT_READY/);ready=true
  const expiring=await api.preview(input);time+=301000
  await assert.rejects(api.confirm({...actor,operationId:expiring.operationId,confirmationId:randomUUID(),consentNonce:expiring.consentNonce}),/FRESH_NATIVE/)
  assert.equal(signatures,7)
  console.log('PASS stale reference and expired consent fail without spending')
}finally{await pool.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end()}

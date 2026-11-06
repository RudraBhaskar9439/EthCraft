// Explicit operator maintenance only. The offline owner key never enters game or investment workers.
import assert from 'node:assert/strict'
import {readFile,lstat,writeFile,rename} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {generateKeyPairSync,createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {loadPrivySettings,privyPolicyFingerprint,createPrivyManagedProvider} from '../backend/src/playable/testnet-wallets.mjs'
import {buildInvestmentPolicy} from '../backend/src/investments/policy.mjs'
const require=createRequire(new URL('../backend/package.json',import.meta.url)),{Pool}=require('pg'),{PrivyClient}=require('@privy-io/node')
const root=fileURLToPath(new URL('../',import.meta.url)),apply=process.argv[2]==='--apply'
assert(process.argv.length===2||process.argv.length===3&&apply,'Use no arguments or --apply')
const json=async file=>JSON.parse(await readFile(file,'utf8'))
const privateFile=async file=>{const s=await lstat(file);assert(s.isFile()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&!(s.mode&0o077),'Private owner-only regular file required')}
const replace=async(file,value)=>{const tmp=file+'.investment-tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(tmp,file)}
async function main(){
  const {settings,credentials}=await loadPrivySettings(root,{requireProvider:false}),manifest=await json(join(root,'.local/marketplace/public-deployment.json'))
  assert.equal(manifest.chainId,1301);assert.equal(manifest.mode,'marketplace')
  const db=await json(join(root,'.local/backend/environment.json')),pool=new Pool({connectionString:db.databaseUrl,max:2}),tx=await pool.connect()
  try{
    await tx.query("SELECT pg_advisory_lock(hashtextextended('ethcraft-investment-policy-maintenance',0))")
    const rows=(await tx.query(`SELECT w.*,p.privy_subject,m.player_id,m.player_name FROM ac_playable_testnet_wallets w
      JOIN ac_discord_wallet_aliases a USING(wallet_id) JOIN ac_discord_principals p USING(principal_id)
      JOIN ac_discord_minecraft_aliases m USING(principal_id) WHERE m.server_id=$1 AND lower(m.player_name)='micro'
      AND w.provider_type='privy' AND w.environment='UNICHAIN_SEPOLIA_PLAYABLE'`,[manifest.serverIdText])).rows
    assert.equal(rows.length,1,'One existing Micro game wallet required');const wallet=rows[0]
    const principalId=wallet.wallet_id.slice('UNICHAIN_SEPOLIA_PLAYABLE:'.length)
    assert.equal(wallet.auth_subject_hash,createHash('sha256').update(wallet.privy_subject).digest('hex'))
    await tx.query('SELECT pg_advisory_lock(hashtextextended($1,0))',['playable-provider-wallet:'+wallet.wallet_id])
    const pending=(await tx.query(`SELECT count(*)::int AS n FROM ac_playable_testnet_requests r LEFT JOIN ac_playable_testnet_chain_intents i USING(operation_id)
      WHERE r.wallet_id=$1 AND r.unsigned_request IS NOT NULL AND (i.status IS NULL OR i.status NOT IN ('confirmed','reverted'))`,[wallet.wallet_id])).rows[0].n
    assert.equal(pending,0,'Existing signed requests must reconcile before adding a delegate')
    const sdk=new PrivyClient({appId:settings.appId,appSecret:credentials.appSecret,maxRetries:0,timeout:15000})
    const old=await sdk.policies().get(settings.policyId)
    assert.equal(old.owner_id,settings.ownerQuorumId);assert.equal(privyPolicyFingerprint(old),settings.policySha256)
    const actual=await sdk.wallets().get(wallet.provider_account_id)
    assert.equal(actual.address.toLowerCase(),wallet.address);assert.equal(actual.external_id,wallet.external_id);assert.equal(actual.owner_id,settings.ownerQuorumId)
    const report={chainId:1301,player:'Micro',walletAddress:wallet.address,existingWalletUnchanged:true,pendingRequests:pending,shopPolicyUnchanged:true,
      offlineOwnerAvailable:!!settings.adminCredentialsFile,investmentPolicyInstalled:!!settings.walletBindings?.[wallet.external_id],walletSignatures:0,chainTransactions:0}
    if(!apply){console.log(JSON.stringify({status:'ready',...report}));return}
    await privateFile(settings.adminCredentialsFile);const offline=await json(settings.adminCredentialsFile)
    assert.equal(offline.ownerPublicKey,credentials.ownerPublicKey);assert.equal(typeof offline.authorizationPrivateKey,'string')
    const progressFile=join(root,'.local/investments/setup-progress.json')
    let progress;try{progress=await json(progressFile)}catch(e){if(e.code!=='ENOENT')throw e}
    if(!progress){progress={chainId:1301,deploymentId:manifest.deploymentId,principalId,walletAddress:wallet.address,externalId:wallet.external_id,expiresAt:Math.floor(Date.now()/1000)+86400};await replace(progressFile,progress)}
    assert.equal(progress.deploymentId,manifest.deploymentId);assert.equal(progress.principalId,principalId);assert.equal(progress.walletAddress,wallet.address)
    if(!credentials.investmentDelegateAuthorizationPrivateKey){
      const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1',publicKeyEncoding:{type:'spki',format:'der'},privateKeyEncoding:{type:'pkcs8',format:'der'}})
      credentials.investmentDelegateAuthorizationPrivateKey=pair.privateKey.toString('base64');credentials.investmentDelegatePublicKey=pair.publicKey.toString('base64')
      await replace(settings.credentialsFile,credentials)
    }
    const publicKey=credentials.investmentDelegatePublicKey
    let quorum
    for await(const q of sdk.keyQuorums().list({limit:100}))if(q.authorization_keys?.some(k=>k.public_key===publicKey)){assert(!quorum,'Duplicate investment key quorum');quorum=q}
    quorum||=await sdk.keyQuorums().create({display_name:'EthCraft investment delegate 1301',public_keys:[publicKey],authorization_threshold:1})
    assert.equal(quorum.authorization_threshold,1);assert.equal(quorum.authorization_keys.length,1);assert.equal(quorum.authorization_keys[0].public_key,publicKey)
    const template=buildInvestmentPolicy(manifest,progress.expiresAt),fingerprint=privyPolicyFingerprint(template),name='EthCraft investments '+fingerprint.slice(0,12)
    let policy
    for await(const p of sdk.policies().list({limit:100}))if(p.name===name){assert(!policy,'Duplicate investment policy');policy=await sdk.policies().get(p.id)}
    policy||=await sdk.policies().create({...template,name,owner_id:settings.ownerQuorumId,idempotency_key:'ethcraft-invest-'+fingerprint.slice(0,48)})
    assert.equal(policy.owner_id,settings.ownerQuorumId);assert.equal(privyPolicyFingerprint(policy),fingerprint)
    const walletBinding={policyId:settings.policyId,additionalSigners:[{signer_id:settings.delegateQuorumId,override_policy_ids:[settings.policyId]},{signer_id:quorum.id,override_policy_ids:[policy.id]}]}
    progress={...progress,delegateQuorumId:quorum.id,delegatePublicKey:publicKey,policyId:policy.id,policySha256:fingerprint,walletBinding};await replace(progressFile,progress)
    assert.deepEqual(actual.policy_ids,[settings.policyId]);assert.equal(actual.exported_at??null,null)
    const original=[walletBinding.additionalSigners[0]],next=walletBinding.additionalSigners
    const projection=a=>a.map(s=>({signer_id:s.signer_id,override_policy_ids:s.override_policy_ids})).sort((a,b)=>a.signer_id.localeCompare(b.signer_id))
    const signers=projection(actual.additional_signers)
    if(JSON.stringify(signers)!==JSON.stringify(projection(next))){assert.deepEqual(signers,projection(original),'Unexpected wallet delegate changed; review required')
      await sdk.wallets().update(actual.id,{additional_signers:next,request_expiry:Date.now()+60000,authorization_context:{authorization_private_keys:[offline.authorizationPrivateKey]}})}
    const verified=await sdk.wallets().get(actual.id)
    assert.equal(verified.address.toLowerCase(),wallet.address);assert.deepEqual(verified.policy_ids,[settings.policyId]);assert.deepEqual(projection(verified.additional_signers),projection(next))
    const nextSettings={...settings,walletBindings:{...settings.walletBindings,[wallet.external_id]:walletBinding}}
    await replace(join(root,'.local/playable-testnet/wallet-settings.json'),nextSettings)
    await replace(join(root,'.local/investments/privy.json'),{...progress,enabled:true})
    const baseProvider=createPrivyManagedProvider({...nextSettings,...credentials,client:sdk})
    await baseProvider.validateConfiguration();const readback=await baseProvider.ensureWallet({externalId:wallet.external_id});assert.equal(readback.address,wallet.address)
    console.log(JSON.stringify({status:'pass',...report,investmentPolicyInstalled:true,expiresAt:progress.expiresAt,scope:'Separate 24-hour delegate installed. Original shop policy and wallet address unchanged. No investment consent or transactions created.'}))
  }finally{await tx.query('SELECT pg_advisory_unlock_all()');tx.release();await pool.end()}
}
main().catch(error=>{console.error(JSON.stringify({status:'blocked',code:/^INVEST_[A-Z0-9_]+$/.test(error.code||error.message||'')?error.code||error.message:'INVEST_POLICY_MAINTENANCE_FAILED',reason:error.code==='ERR_ASSERTION'||/^[0-9A-Z]{5}$/.test(error.code||'')?error.message.slice(0,180):undefined,errorType:error.name,httpStatus:Number.isInteger(error.status)?error.status:null}));process.exitCode=1})

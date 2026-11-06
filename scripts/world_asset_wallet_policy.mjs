// Operator-only, versioned Privy policy migration. Keys never enter the worker.
import assert from 'node:assert/strict'
import {readFile,stat} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {loadPrivySettings,privyPolicyFingerprint,buildPrivyMarketPolicies} from '../backend/src/playable/testnet-wallets.mjs'
import {buildPrivyWorldAssetPolicies} from '../backend/src/world-assets/managed-policy.mjs'
import {validateMarketManifest} from '../backend/src/playable/uniswap-market.mjs'
async function main(){
const require=createRequire(new URL('../backend/package.json',import.meta.url)),{Pool}=require('pg'),{PrivyClient}=require('@privy-io/node'),{writeCheckpoint,acquireLocalLease}=require('./src/bot/checkpoint-store.cjs')
const root=fileURLToPath(new URL('../',import.meta.url)),apply=process.argv.length===3&&process.argv[2]==='--apply'
if(process.argv.length>2&&!apply)throw Error('Use no arguments for preflight or --apply for a scoped policy migration')
const json=async p=>JSON.parse(await readFile(p,'utf8'))
const {settings,credentials}=await loadPrivySettings(root,{requireProvider:false})
const asset=await json(join(root,'.local/world-assets/asset-market.json')),payment=validateMarketManifest(await json(join(root,'.local/world-assets/payment-market.json'))),legacy=validateMarketManifest(await json(join(root,'.local/playable-testnet/market.json')))
const previous=buildPrivyMarketPolicies(legacy),nextPayment=buildPrivyMarketPolicies(payment),nextAsset=buildPrivyWorldAssetPolicies(asset)
const template={version:'1.0',chain_type:'ethereum',rules:[...previous.player.rules,...nextPayment.player.rules,...nextAsset.player.rules]}
const sha256=privyPolicyFingerprint(template),allowedTargets=[...new Set([...settings.allowedTargets,...nextPayment.allowedTargets,...nextAsset.allowedTargets])]
const sdk=new PrivyClient({appId:settings.appId,appSecret:credentials.appSecret,maxRetries:0,timeout:15000})
const oldPolicy=await sdk.policies().get(settings.policyId);assert.equal(oldPolicy.owner_id,settings.ownerQuorumId);assert.equal(privyPolicyFingerprint(oldPolicy),settings.policySha256)
if(!apply){console.log(JSON.stringify({status:sha256===settings.policySha256?'already_configured':'ready',scope:'Read-only exact Privy player policy extension for verified world asset contracts; no wallet update or signing',oldPolicyId:settings.policyId,oldSha256:settings.policySha256,newSha256:sha256,rules:template.rules.length,allowedTargets,publicTransactions:0}));process.exit(0)}
if(typeof process.getuid!=='function')throw Error('PRIVATE_UNIX_ADMIN_STORAGE_REQUIRED')
for(const file of [settings.adminCredentialsFile,dirname(settings.adminCredentialsFile)]){const info=await stat(file);assert.equal(info.uid,process.getuid());assert.equal(info.mode&0o077,0)}
const offline=await json(settings.adminCredentialsFile);assert.equal(typeof offline.authorizationPrivateKey,'string')
const release=await acquireLocalLease('agentcity-world-assets-player-policy'),db=await json(join(root,'.local/backend/environment.json')),pool=new Pool({connectionString:db.databaseUrl,max:1}),tx=await pool.connect()
try{
 await tx.query("SELECT pg_advisory_lock(hashtextextended('agentcity-world-assets-player-policy',0))")
 const wallets=(await tx.query("SELECT * FROM ac_playable_testnet_wallets WHERE environment='UNICHAIN_SEPOLIA_PLAYABLE' AND auth_subject_hash IS NOT NULL ORDER BY wallet_id")).rows
 for(const wallet of wallets){
  const pending=await tx.query("SELECT 1 FROM ac_playable_testnet_requests r LEFT JOIN ac_playable_testnet_chain_intents i USING(operation_id) WHERE wallet_id=$1 AND unsigned_request IS NOT NULL AND (i.status IS NULL OR i.status NOT IN ('confirmed','reverted')) LIMIT 1",[wallet.wallet_id])
  if(pending.rowCount)throw Error('PLAYER_POLICY_HAS_UNRESOLVED_SIGNED_INTENTS')
 }
 await tx.query(`CREATE TABLE IF NOT EXISTS ac_world_asset_policy_migrations(wallet_id text NOT NULL,new_sha256 text NOT NULL,old_policy_id text NOT NULL,new_policy_id text NOT NULL,provider_account_id text NOT NULL,address text NOT NULL,status text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(wallet_id,new_sha256))`)
 const idempotency='ac-world-assets-'+createHash('sha256').update(settings.appId+':'+sha256).digest('hex').slice(0,48)
 let policy
 for await(const candidate of sdk.policies().list({limit:100}))if(candidate.name==='AgentCity world assets '+sha256.slice(0,12)){
  const full=await sdk.policies().get(candidate.id);assert.equal(privyPolicyFingerprint(full),sha256);assert.equal(full.owner_id,settings.ownerQuorumId);if(policy)throw Error('DUPLICATE_WORLD_ASSET_POLICY');policy=full
 }
 policy||=await sdk.policies().create({...template,name:'AgentCity world assets '+sha256.slice(0,12),owner_id:settings.ownerQuorumId,idempotency_key:idempotency})
 assert.equal(privyPolicyFingerprint(policy),sha256);assert.equal(policy.owner_id,settings.ownerQuorumId)
 const validate=(actual,wallet)=>{
  assert.equal(actual.id,wallet.provider_account_id);assert.equal(actual.external_id,wallet.external_id);assert.equal(actual.address.toLowerCase(),wallet.address);assert.equal(actual.owner_id,settings.ownerQuorumId);assert.equal(actual.chain_type,'ethereum');assert.equal(actual.policy_ids.length,1);assert.equal(actual.additional_signers.length,1);assert.equal(actual.additional_signers[0].signer_id,settings.delegateQuorumId);assert.deepEqual(actual.additional_signers[0].override_policy_ids,actual.policy_ids);assert.equal(actual.exported_at??null,null)
 }
 for(const wallet of wallets){
  await tx.query("INSERT INTO ac_world_asset_policy_migrations(wallet_id,new_sha256,old_policy_id,new_policy_id,provider_account_id,address,status) VALUES($1,$2,$3,$4,$5,$6,'planned') ON CONFLICT DO NOTHING",[wallet.wallet_id,sha256,settings.policyId,policy.id,wallet.provider_account_id,wallet.address])
  const audit=(await tx.query('SELECT * FROM ac_world_asset_policy_migrations WHERE wallet_id=$1 AND new_sha256=$2',[wallet.wallet_id,sha256])).rows[0];assert.equal(audit.new_policy_id,policy.id);assert.equal(audit.provider_account_id,wallet.provider_account_id);assert.equal(audit.address,wallet.address)
  let actual=await sdk.wallets().get(wallet.provider_account_id);validate(actual,wallet)
  if(actual.policy_ids[0]!==policy.id){assert.equal(actual.policy_ids[0],audit.old_policy_id);await sdk.wallets().update(actual.id,{policy_ids:[policy.id],additional_signers:[{signer_id:settings.delegateQuorumId,override_policy_ids:[policy.id]}],request_expiry:Date.now()+60000,authorization_context:{authorization_private_keys:[offline.authorizationPrivateKey]}});actual=await sdk.wallets().get(actual.id);validate(actual,wallet);assert.equal(actual.policy_ids[0],policy.id)}
  await tx.query("UPDATE ac_world_asset_policy_migrations SET status='confirmed' WHERE wallet_id=$1 AND new_sha256=$2",[wallet.wallet_id,sha256])
 }
 await writeCheckpoint(join(root,'.local/world-assets/player-policy-migration.json'),{schema:'agentcity.world-asset-policy-migration.v1',oldPolicyId:settings.policyId,newPolicyId:policy.id,oldSha256:settings.policySha256,newSha256:sha256,migratedWallets:wallets.length,allowedTargets})
 await writeCheckpoint(join(root,'.local/playable-testnet/wallet-settings.json'),{...settings,policyId:policy.id,policySha256:sha256,allowedTargets})
 console.log(JSON.stringify({status:'pass',scope:'Versioned exact Privy player policy and existing wallet binding migration; same identities/addresses/owner/delegate, zero signatures or chain transactions',policyId:policy.id,policySha256:sha256,migratedWallets:wallets.length,publicTransactions:0}))
}finally{await tx.query("SELECT pg_advisory_unlock(hashtextextended('agentcity-world-assets-player-policy',0))");tx.release();await pool.end();await release()}
}
main().catch(error=>{console.error(JSON.stringify({status:'blocked',code:/^[A-Z0-9_]+$/.test(error.code||'')?error.code:/^[A-Z0-9_]+$/.test(error.message||'')?error.message:'WORLD_ASSET_POLICY_MIGRATION_FAILED',httpStatus:Number.isInteger(error.status)?error.status:null}));process.exitCode=1})

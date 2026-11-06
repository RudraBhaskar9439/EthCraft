import {readFile,lstat} from 'node:fs/promises'
import {join,delimiter} from 'node:path'
import {createHash} from 'node:crypto'
import {createPublicClient,http,parseAbi,encodeFunctionData,keccak256} from 'viem'
import {PostgresStore} from '../storage/postgres.mjs'
import {PublicTestnetEvm} from '../chain/public-testnet.mjs'
import {openDevelopmentKeystore} from '../chain/development-wallets.mjs'
const abi=parseAbi(['function publisher() view returns(address)','function sequence() view returns(uint64)','function validUntil() view returns(uint64)','function available() view returns(bool)','function publish(uint64 sequence,bool healthy,uint64 validUntil)'])
const uuid=value=>{const h=createHash('sha256').update(value).digest('hex');return[h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20,32)].join('-')}
export async function createWorldAssetHealthPublisher({rootDirectory,manifest,native}){
 process.env.PATH=join(rootDirectory,'.local/tools/foundry-linux')+delimiter+(process.env.PATH||'')
 const metadata=JSON.parse(await readFile(join(rootDirectory,'.local/world-assets/publisher-settings.json'),'utf8'))
 if(typeof process.getuid!=='function'||metadata.address?.toLowerCase()!==manifest.roles.publisher.toLowerCase()||[manifest.roles.administrator,manifest.roles.registrar].some(address=>address.toLowerCase()===metadata.address.toLowerCase()))throw Error('WORLD_HEALTH_DISTINCT_ROLE_REQUIRED')
 for(const path of[metadata.keystore,metadata.passwordFile]){if(!path?.includes('/role-world-publisher/'))throw Error('WORLD_HEALTH_PRIVATE_ROLE_REQUIRED');const info=await lstat(path);if(info.isSymbolicLink()||!info.isFile()||info.uid!==process.getuid()||(info.mode&0o077))throw Error('WORLD_HEALTH_PRIVATE_ROLE_REQUIRED')}
 const account=await openDevelopmentKeystore(metadata)
 const settings=JSON.parse(await readFile(join(rootDirectory,'.local/backend/environment.json'),'utf8')),admin=new PostgresStore(settings.databaseUrl),schema='world_assets_publisher_1301'
 await admin.query('CREATE SCHEMA IF NOT EXISTS '+schema);const database=new URL(settings.databaseUrl);database.searchParams.set('options','-c search_path='+schema)
 const store=new PostgresStore(database.toString());await store.migrate([new URL('../chain/schema.sql',import.meta.url)])
 await store.query('CREATE TABLE IF NOT EXISTS world_health_publications(operation_id uuid PRIMARY KEY,sequence bigint UNIQUE NOT NULL,valid_until bigint NOT NULL,healthy boolean NOT NULL,status text NOT NULL,transaction_hash text)')
 const payment=manifest.paymentManifest,client=createPublicClient({transport:http(manifest.rpcUrl,{timeout:15000,retryCount:0})})
 if(keccak256(await client.getCode({address:payment.stateRegistry}))!==payment.codeHashes.stateRegistry||(await client.readContract({address:payment.stateRegistry,abi,functionName:'publisher'})).toLowerCase()!==account.address.toLowerCase())throw Error('WORLD_HEALTH_PUBLISHER_BINDING_CHANGED')
 const evm=new PublicTestnetEvm({store,chainId:1301,rpcUrl:manifest.rpcUrl,genesisHash:manifest.genesisHash,environment:'PUBLIC_TESTNET_WORLD_ASSETS',allowedSigners:[account.address]});evm.nativeCap=50000000000000n
 let running=null,closed=false
 async function publish({projection}){
  if(closed)return{status:'closed'};if(running)return running
  running=(async()=>{
   const block=await client.getBlock(),pending=(await store.query("SELECT * FROM world_health_publications WHERE status NOT IN ('confirmed','reverted') ORDER BY sequence LIMIT 1")).rows[0]
   let row=pending
   if(!row){
    const escrow=await native('escrow/status',{}),property=await native('property/catalog'),healthy=projection?.status==='active'&&escrow.pendingCount===0&&Boolean(property.worldName||property.worldUUID)
    const until=await client.readContract({address:payment.stateRegistry,abi,functionName:'validUntil'}),available=await client.readContract({address:payment.stateRegistry,abi,functionName:'available'})
    if(healthy&&available&&BigInt(until)>block.timestamp+120n)return{status:'fresh',healthy:true,validUntil:String(until)}
    // A failed world check leaves the previous report to expire; it never
    // manufactures healthy state merely to make a swap simulation succeed.
    if(!healthy)return{status:'paused',healthy:false}
    const chainSequence=await client.readContract({address:payment.stateRegistry,abi,functionName:'sequence'}),last=(await store.query('SELECT COALESCE(max(sequence),0)::text value FROM world_health_publications')).rows[0]
    const sequence=BigInt(last.value)>chainSequence?BigInt(last.value)+1n:chainSequence+1n,operation=uuid(manifest.deploymentId+':health:'+sequence)
    row=(await store.query("INSERT INTO world_health_publications(operation_id,sequence,valid_until,healthy,status) VALUES($1,$2,$3,true,'prepared') ON CONFLICT(operation_id) DO UPDATE SET operation_id=EXCLUDED.operation_id RETURNING *",[operation,String(sequence),String(block.timestamp+240n)])).rows[0]
   }
   const data=encodeFunctionData({abi,functionName:'publish',args:[BigInt(row.sequence),row.healthy,BigInt(row.valid_until)]})
   await evm.prepare(row.operation_id,account,payment.stateRegistry,data,0n);await evm.broadcast(row.operation_id);const result=await evm.receipt(row.operation_id,2)
   await store.query('UPDATE world_health_publications SET status=$2,transaction_hash=$3 WHERE operation_id=$1',[row.operation_id,result.status,result.hash||null])
   return{status:result.status,healthy:row.healthy,validUntil:String(row.valid_until),transactionHash:result.hash}
  })().finally(()=>{running=null});return running
 }
 return{publish,async close(){closed=true;if(running)await running;await store.close();await admin.close()}}
}

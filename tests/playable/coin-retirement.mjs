import assert from 'node:assert/strict'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {randomUUID,createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {createCoinRetirement} from '../../backend/src/playable/coin-retirement.mjs'
import {createGameEconomy} from '../../backend/src/playable/economy.mjs'
import {createGameMarketplace} from '../../backend/src/playable/game-marketplace.mjs'
const require=createRequire(new URL('../../backend/package.json',import.meta.url)),{Pool}=require('pg')
const db=JSON.parse(await readFile('.local/backend/environment.json')),schema='test_retirement_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:db.databaseUrl}),pool=new Pool({connectionString:db.databaseUrl,options:'-c search_path='+schema})
const report={scope:'Isolated PostgreSQL retirement fixtures; no live accounts, inventory, chain or provider effects',checks:[],status:'fail'}
const pass=name=>{report.checks.push({name,status:'pass'});console.log('PASS '+name)}
let created=false
try{
 await admin.query('CREATE SCHEMA '+schema);created=true
 await pool.query(await readFile('backend/src/playable/economy.sql','utf8'));await pool.query(await readFile('backend/src/playable/game-marketplace.sql','utf8'))
 const seller=randomUUID(),buyer=randomUUID(),sa=randomUUID(),ba=randomUUID(),listing=randomUUID(),purchase=randomUUID(),stock=randomUUID(),delivery=randomUUID()
 await pool.query("INSERT INTO ac_game_players(player_id,player_name,name_key,available,held) VALUES($1,'Seller','seller',100,0),($2,'Buyer','buyer',93,7)",[sa,ba])
 await pool.query("INSERT INTO ac_game_market_listings(listing_id,seller_id,seller_account_id,item,count,price,source_id,source_kind,terms_digest,stock_operation_id,state,reserved_purchase_id,custody_id,fingerprint) VALUES($1,$2,$3,'stick',1,7,$3,'player_inventory','digest',$4,'reserved',$5,$6,'fingerprint')",[listing,seller,sa,stock,purchase,listing])
 await pool.query("INSERT INTO ac_game_market_purchases(purchase_id,listing_id,seller_id,seller_account_id,buyer_id,buyer_account_id,item,count,price,terms_digest,quote_digest,delivery_operation_id,custody_id,fingerprint,expires_at,state) VALUES($1,$2,$3,$4,$5,$6,'stick',1,7,'digest','quote',$7,$8,'fingerprint',now(),'reserved')",[purchase,listing,seller,sa,buyer,ba,delivery,listing])
 await pool.query("INSERT INTO ac_game_market_ledger VALUES($1,$2,$3,'reserve',-7,7,now())",['reserve:'+purchase,ba,purchase])
 const helper=createCoinRetirement({pool}),before=JSON.stringify((await pool.query('SELECT * FROM ac_game_players ORDER BY player_id')).rows)
 const economy=await createGameEconomy({pool}),market=await createGameMarketplace({pool,authorize:async()=>{throw Error('AUTH_MUST_NOT_RUN')},resolveAccount:async()=>{throw Error('RESOLVER_MUST_NOT_RUN')}})
 await assert.rejects(economy.handle({}),/GAME_COINS_RETIRED/)
 await assert.rejects(economy.prepareSale({}),/GAME_COINS_RETIRED/)
 assert.throws(()=>economy.completeSale({}),/GAME_COINS_RETIRED/)
 for(const method of ['prepareListing','confirmListing','confirmStock','quotePurchase','confirmPurchase'])await assert.rejects(market[method]({}),/GAME_COINS_RETIRED/)
 for(const action of ['player_join','pay','accept','prepareSale','prepareListing','confirmListing','confirmStock','quotePurchase','confirmPurchase','unknown'])await assert.rejects(helper.assertAllowed({action,principalId:buyer,purchaseId:purchase}),/GAME_COINS_RETIRED/)
 assert.equal((await helper.assertAllowed({action:'history'})).readOnly,true)
 pass('all new monetary actions and unknown routes refuse; historical reads remain available')
 assert.equal((await helper.assertAllowed({action:'confirmDelivery',purchaseId:purchase,principalId:buyer})).deliveryOperationId,delivery)
 await assert.rejects(helper.assertAllowed({action:'confirmDelivery',purchaseId:purchase,principalId:seller}),/PURCHASE_OWNER_REQUIRED/)
 await assert.rejects(helper.assertCutoverReady({nativeSnapshot:{verified:true,unresolvedIntents:0}}),/FUNDED_RECOVERY_PENDING/)
 await assert.rejects(helper.assertAllowed({action:'claim',principalId:buyer,nativeOwnerId:seller}),/MAILBOX_OWNER_REQUIRED/)
 pass('only original funded buyer recovery admitted; foreign mailbox ownership and premature cutover refused')
 assert.equal(JSON.stringify((await pool.query('SELECT * FROM ac_game_players ORDER BY player_id')).rows),before)
 await pool.query("UPDATE ac_game_market_listings SET state='open' WHERE listing_id=$1",[listing]);await pool.query("UPDATE ac_game_market_purchases SET state='settled' WHERE purchase_id=$1",[purchase]);await pool.query('UPDATE ac_game_players SET available=available+held,held=0 WHERE player_id=$1',[ba])
 assert.equal((await helper.assertAllowed({action:'cancelListing',listingId:listing,principalId:seller})).disposition,'OWNER_WITHDRAW_ONLY')
 await assert.rejects(helper.assertAllowed({action:'cancelListing',listingId:listing,principalId:buyer}),/LISTING_OWNER_REQUIRED/)
 await assert.rejects(helper.assertCutoverReady(),/NATIVE_RECONCILIATION_REQUIRED/)
 await assert.rejects(helper.assertCutoverReady({nativeSnapshot:{verified:true,unresolvedIntents:1}}),/NATIVE_RECONCILIATION_REQUIRED/)
 assert.equal((await helper.assertCutoverReady({nativeSnapshot:{verified:true,unresolvedIntents:0}})).cutoverReady,true)
 assert.equal((await helper.assertAllowed({action:'confirmDelivery',purchaseId:purchase,principalId:buyer})).replayOnly,true)
 pass('owner withdrawal and settled replay retained; cutover requires authoritative zero unresolved native intents; helper performs no economic writes')
 report.status='pass'
}catch(error){report.error=error.message;process.exitCode=1}
finally{await pool.end();if(created)await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();report.sources={};for(const file of ['backend/src/playable/coin-retirement.mjs','backend/src/playable/economy.mjs','backend/src/playable/game-marketplace.mjs'])report.sources[file]=createHash('sha256').update(await readFile(file)).digest('hex');const directory='evidence/runs/coin-retirement/'+randomUUID();await mkdir(directory,{recursive:true});await writeFile(directory+'/report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,checks:report.checks.length,evidence:directory+'/report.json',error:report.error}))}

// Isolated PG monetary accounting and disclosed native custody receipt fixtures.
import assert from 'node:assert/strict'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {randomUUID,createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createGameMarketplace} from '../../backend/src/playable/game-marketplace.mjs'
const require=createRequire(new URL('../../backend/package.json',import.meta.url)),{Pool}=require('pg')
const root=fileURLToPath(new URL('../../',import.meta.url)),db=JSON.parse(await readFile(join(root,'.local/backend/environment.json')))
const schema='test_game_market_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:db.databaseUrl,max:1}),pool=new Pool({connectionString:db.databaseUrl,options:'-c search_path='+schema,max:5})
const report={status:'fail',scope:'Focused isolated PostgreSQL Game Coin accounting with fixture native escrow/mailbox receipts; no live inventory or balances mutated, no blockchain',checks:[]}
const pass=name=>{report.checks.push({name,status:'pass'});console.log('PASS '+name)}
let created=false
try{
 await admin.query('CREATE SCHEMA '+schema);created=true
 await pool.query('CREATE TABLE ac_game_players(player_id uuid PRIMARY KEY,available bigint NOT NULL CHECK(available>=0),held bigint NOT NULL DEFAULT 0 CHECK(held>=0))')
 const seller=randomUUID(),buyer=randomUUID(),other=randomUUID(),sellerAccount=randomUUID(),buyerAccount=randomUUID(),otherAccount=randomUUID(),bot=randomUUID()
 const accounts=new Map([[seller,sellerAccount],[buyer,buyerAccount],[other,otherAccount]])
 await pool.query('INSERT INTO ac_game_players VALUES($1,100,0),($2,100,0),($3,1,0)',[sellerAccount,buyerAccount,otherAccount])
 let consent=true;const calls=[]
 const market=await createGameMarketplace({pool,allowLegacyGameCoinsFixture:true,resolveAccount:async({principalId})=>accounts.get(principalId),authorize:async terms=>{calls.push(terms);return consent}})
 const input={operationId:randomUUID(),sellerId:seller,sellerAccountId:sellerAccount,item:'oak_planks',count:3,price:'7',sourceId:bot,sourceKind:'agent_inventory'}
 const stockReceipt=listing=>({operationId:listing.stockOperationId,listingId:listing.listingId,sellerId:listing.sellerId,sellerAccountId:listing.sellerAccountId,sourceId:listing.sourceId,sourceKind:listing.sourceKind,item:listing.item,count:listing.count,termsDigest:listing.termsDigest,escrowed:true,custodyId:listing.listingId,fingerprint:'a'.repeat(64)})
 const open=async value=>{let listing=await market.prepareListing(value);await market.confirmListing({listingId:listing.listingId,sellerId:seller,termsDigest:listing.termsDigest});return market.confirmStock({listingId:listing.listingId,sellerId:seller,receipt:stockReceipt(listing)})}
 let listing=await market.prepareListing(input)
 assert.equal((await market.list()).length,0);assert.notEqual(seller,sellerAccount)
 consent=false;await assert.rejects(market.confirmListing({listingId:listing.listingId,sellerId:seller}),/EXPLICIT_OWNER_CONSENT_REQUIRED/);consent=true
 await assert.rejects(market.prepareListing({...input,operationId:randomUUID(),sellerAccountId:buyerAccount}),/EXISTING_ACCOUNT_OWNER_REQUIRED/)
 await assert.rejects(market.prepareListing({...input,operationId:randomUUID(),currency:'CITY'}),/GAME_COINS_ONLY/)
 await assert.rejects(market.confirmStock({listingId:listing.listingId,sellerId:seller,receipt:stockReceipt(listing)}),/STOCK_INTENT_REQUIRED/)
 await market.confirmListing({listingId:listing.listingId,sellerId:seller,termsDigest:listing.termsDigest})
 await assert.rejects(market.confirmStock({listingId:listing.listingId,sellerId:seller,receipt:{...stockReceipt(listing),sourceId:randomUUID()}}),/NATIVE_RECEIPT_BINDING_REQUIRED/)
 listing=await market.confirmStock({listingId:listing.listingId,sellerId:seller,receipt:stockReceipt(listing)})
 assert.equal(listing.state,'open');assert.equal((await market.list())[0].priceKind,'TOTAL_FULL_LOT')
 assert.equal((await pool.query('SELECT count(*) FROM ac_game_players')).rows[0].count,'3')
 pass('canonical owner maps only to existing Game Coin account; explicit listing authority and exact native stock receipt required; CITY and extra starter accounts excluded')

 const quote=await market.quotePurchase({operationId:randomUUID(),buyerId:buyer,buyerAccountId:buyerAccount,listingId:listing.listingId})
 const competing=await market.quotePurchase({operationId:randomUUID(),buyerId:other,buyerAccountId:otherAccount,listingId:listing.listingId})
 await assert.rejects(market.confirmPurchase({purchaseId:competing.purchaseId,buyerId:other,quoteDigest:competing.quoteDigest}),/INSUFFICIENT_GAME_COINS/)
 await assert.rejects(market.confirmPurchase({purchaseId:quote.purchaseId,buyerId:buyer,quoteDigest:'0'.repeat(64)}),/QUOTE_DIGEST_MISMATCH/)
 const reserved=await market.confirmPurchase({purchaseId:quote.purchaseId,buyerId:buyer,quoteDigest:quote.quoteDigest})
 assert.equal(reserved.state,'reserved')
 assert.deepEqual((await pool.query('SELECT available,held FROM ac_game_players WHERE player_id=$1',[buyerAccount])).rows[0],{available:'93',held:'7'})
 await assert.rejects(market.confirmPurchase({purchaseId:competing.purchaseId,buyerId:other,quoteDigest:competing.quoteDigest}),/LOT_NOT_AVAILABLE/)
 await assert.rejects(market.cancelListing({operationId:randomUUID(),listingId:listing.listingId,sellerId:seller}),/ONLY_OPEN_LOT_CAN_CANCEL/)
 const receipt={operationId:reserved.deliveryOperationId,listingId:listing.listingId,purchaseId:reserved.purchaseId,buyerId:buyer,ownerId:buyer,item:reserved.item,count:reserved.count,custodyId:reserved.custodyId,fingerprint:reserved.fingerprint,termsDigest:reserved.termsDigest,assigned:true}
 await assert.rejects(market.confirmDelivery({purchaseId:reserved.purchaseId,buyerId:buyer,receipt:{...receipt,ownerId:other}}),/NATIVE_RECEIPT_BINDING_REQUIRED/)
 const settled=await market.confirmDelivery({purchaseId:reserved.purchaseId,buyerId:buyer,receipt})
 assert.equal(settled.state,'settled')
 assert.deepEqual((await pool.query('SELECT available,held FROM ac_game_players WHERE player_id=$1',[sellerAccount])).rows[0],{available:'107',held:'0'})
 assert.deepEqual((await pool.query('SELECT available,held FROM ac_game_players WHERE player_id=$1',[buyerAccount])).rows[0],{available:'93',held:'0'})
 assert.equal((await pool.query('SELECT sum(available+held)::text AS total FROM ac_game_players')).rows[0].total,'201')
 assert.equal((await pool.query('SELECT sum(delta_available+delta_held)::text AS total FROM ac_game_market_ledger')).rows[0].total,'0')
 pass('full-lot purchase atomically holds buyer coins; insufficient or second buyer refused; only exact backed-mailbox receipt settles conserved funds')

 const balances=(await pool.query('SELECT * FROM ac_game_players ORDER BY player_id')).rows
 assert.deepEqual(await market.confirmDelivery({purchaseId:reserved.purchaseId,buyerId:buyer,receipt}),settled)
 await market.confirmPurchase({purchaseId:quote.purchaseId,buyerId:buyer,quoteDigest:quote.quoteDigest})
 await market.confirmStock({listingId:listing.listingId,sellerId:seller,receipt:stockReceipt(listing)})
 assert.deepEqual((await pool.query('SELECT * FROM ac_game_players ORDER BY player_id')).rows,balances)
 await assert.rejects(market.prepareListing({...input,price:'8'}),/LISTING_IMMUTABLE_TERMS/)
 await assert.rejects(market.confirmDelivery({purchaseId:reserved.purchaseId,buyerId:other,receipt}),/PURCHASE_OWNER_REQUIRED/)
 const returnedListing=await open({...input,operationId:randomUUID(),count:2,price:'5'})
 await assert.rejects(market.cancelListing({operationId:randomUUID(),listingId:returnedListing.listingId,sellerId:other}),/LISTING_OWNER_REQUIRED/)
 const cancelOperation=randomUUID(),returning=await market.cancelListing({operationId:cancelOperation,listingId:returnedListing.listingId,sellerId:seller})
 assert.equal(returning.state,'return_pending')
 const returnReceipt={operationId:returning.returnOperationId,listingId:returning.listingId,sellerId:seller,ownerId:seller,item:returning.item,count:returning.count,custodyId:returning.custodyId,fingerprint:returning.fingerprint,termsDigest:returning.termsDigest,returned:true,assigned:true}
 assert.equal((await market.confirmReturn({listingId:returning.listingId,sellerId:seller,receipt:returnReceipt})).state,'cancelled')
 await market.confirmReturn({listingId:returning.listingId,sellerId:seller,receipt:returnReceipt})
 await market.cancelListing({operationId:cancelOperation,listingId:returning.listingId,sellerId:seller})
 assert.deepEqual((await pool.query('SELECT * FROM ac_game_players ORDER BY player_id')).rows,balances)
 await assert.rejects(pool.query('UPDATE ac_game_market_listings SET price=99 WHERE listing_id=$1',[listing.listingId]),/LISTING_TERMS_IMMUTABLE/)
 pass('lost delivery reply replays original receipt without paying twice; owner cancellation returns exact escrow to seller mailbox without currency movement')
 report.status='pass'
}catch(error){report.error=error.message;process.exitCode=1}
finally{await pool.end();if(created)await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();report.sources={};for(const file of ['backend/src/playable/game-marketplace.mjs','backend/src/playable/game-marketplace.sql'])report.sources[file]=createHash('sha256').update(await readFile(join(root,file))).digest('hex');const directory=join(root,'evidence/runs/game-marketplace',randomUUID());await mkdir(directory,{recursive:true});await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,checks:report.checks.length,evidence:join(directory,'report.json'),error:report.error}))}

package org.agentcity.paper;

import com.google.gson.Gson;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.bukkit.*;
import org.bukkit.entity.Player;
import org.bukkit.event.*;
import org.bukkit.event.block.*;
import org.bukkit.event.entity.*;
import org.bukkit.event.inventory.*;
import org.bukkit.event.player.*;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.Damageable;
import io.papermc.paper.datacomponent.DataComponentTypes;
import org.bukkit.plugin.java.JavaPlugin;

/** Native item custody only. Game Coins and purchase consent remain in the backend. */
final class InventoryEscrow implements Listener {
    private static final Gson JSON=new Gson();
    private static final Set<String> CATALOG=Set.of("minecraft:oak_planks","minecraft:cobblestone","minecraft:stone","minecraft:dirt","minecraft:sand","minecraft:oak_log","minecraft:stick","minecraft:stone_bricks");
    private static final List<String> STOCK_FIELDS=List.of("operationId","listingId","sellerId","sellerAccountId","sourceId","sourceKind","item","count","termsDigest","authorityId");
    private final JavaPlugin plugin;
    private final PlayableExperience experience;
    private final Path journal;
    private final Map<String,Map<String,Object>> authorities=new HashMap<>(),operations=new LinkedHashMap<>(),vaults=new LinkedHashMap<>(),previews=new LinkedHashMap<>();
    private final Map<UUID,String> pending=new HashMap<>();
    private Map<String,Object> assetConfiguration;
    private boolean available=true;

    InventoryEscrow(JavaPlugin plugin,PlayableExperience experience)throws Exception {
        this.plugin=plugin;this.experience=experience;journal=plugin.getDataFolder().toPath().resolve("inventory-escrow.jsonl");
        if(Files.exists(journal))try(var lines=Files.lines(journal)){for(String line:(Iterable<String>)lines::iterator){if(line.isBlank())throw new IllegalStateException("escrow_journal_blank_record");apply(StrictJson.object(line));}}
        for(var row:operations.values())if("intent".equals(row.get("phase"))){UUID actor=UUID.fromString((String)row.get("actorId"));if(pending.put(actor,(String)row.get("operationId"))!=null)throw new IllegalStateException("escrow_multiple_pending_actor");}
        Bukkit.getPluginManager().registerEvents(this,plugin);
        for(Player player:Bukkit.getOnlinePlayers())recover(player);
    }
    void close(){HandlerList.unregisterAll(this);}
    boolean frozen(UUID actor){main();return pending.containsKey(actor);}
    private static void main(){if(!Bukkit.isPrimaryThread())throw new IllegalStateException("escrow_main_thread_required");}
    private void ready(){main();if(!available)throw new IllegalStateException("ESCROW_JOURNAL_UNAVAILABLE");}
    private static String text(Map<String,Object> input,String key){if(!(input.get(key) instanceof String s)||s.isBlank())throw new IllegalArgumentException("escrow_"+key);return s;}
    private static String uuid(Map<String,Object> input,String key){return UUID.fromString(text(input,key)).toString();}
    private static long integer(Map<String,Object> input,String key){if(!(input.get(key) instanceof Long n))throw new IllegalArgumentException("escrow_integer_"+key);return n;}
    private static String sha(byte[] bytes){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}catch(Exception e){throw new IllegalStateException(e);}}
    private static Map<String,Object> copy(Map<String,Object> row){return new LinkedHashMap<>(row);}
    @SuppressWarnings("unchecked") private void apply(Map<String,Object> row){
        if(!"agentcity.inventory-escrow.v1".equals(row.get("schema")))throw new IllegalStateException("escrow_journal_schema");
        if("asset-config".equals(row.get("kind")))assetConfiguration=row;
        else if("preview".equals(row.get("kind")))previews.put((String)row.get("previewId"),row);
        else if("authority".equals(row.get("kind")))authorities.put((String)row.get("authorityId"),row);
        else {operations.put((String)row.get("operationId"),row);if("complete".equals(row.get("phase"))&&row.get("vault") instanceof Map<?,?> v)vaults.put((String)v.get("listingId"),(Map<String,Object>)v);}
    }
    private void append(Map<String,Object> row)throws Exception {
        if(!available)throw new IllegalStateException("ESCROW_JOURNAL_UNAVAILABLE");
        row.put("schema","agentcity.inventory-escrow.v1");byte[] bytes=(JSON.toJson(row)+"\n").getBytes(StandardCharsets.UTF_8);
        if(bytes.length>65536)throw new IllegalArgumentException("escrow_record_size");
        try{
            try(FileChannel file=FileChannel.open(journal,StandardOpenOption.CREATE,StandardOpenOption.APPEND,StandardOpenOption.WRITE)){ByteBuffer buffer=ByteBuffer.wrap(bytes);while(buffer.hasRemaining())file.write(buffer);file.force(true);}
            try(FileChannel directory=FileChannel.open(journal.getParent(),StandardOpenOption.READ)){directory.force(true);}
            apply(row);
        }catch(Exception error){available=false;throw error;}
    }
    private static void same(Map<String,Object> old,Map<String,Object> requested,List<String> fields){for(String field:fields)if(!Objects.equals(old.get(field),requested.get(field)))throw new IllegalArgumentException("escrow_operation_binding_changed");}
    private Map<String,Object> stock(Map<String,Object> input){
        Map<String,Object> terms=new LinkedHashMap<>();for(String field:List.of("operationId","listingId","sellerId","sellerAccountId","sourceId","authorityId"))terms.put(field,uuid(input,field));
        String item=text(input,"item"),kind=text(input,"sourceKind"),digest=text(input,"termsDigest");long count=integer(input,"count");
        Material material=Material.matchMaterial(item);boolean gear=equipment(material),exact="world_asset".equals(input.get("custodyMode"));
        if((!CATALOG.contains(item)&&!gear)||count<1||count>64||gear&&count!=1||gear&&!exact||!Set.of("player_inventory","agent_inventory").contains(kind)||!digest.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("escrow_catalog_or_terms");
        terms.put("item",item);terms.put("sourceKind",kind);terms.put("termsDigest",digest);terms.put("count",count);
        if(exact){if(!"world_asset".equals(input.get("custodyMode")))throw new IllegalArgumentException("escrow_equipment_world_asset_custody_required");terms.put("custodyMode","world_asset");terms.put("previewId",uuid(input,"previewId"));String fingerprint=text(input,"expectedFingerprint");if(!fingerprint.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("escrow_exact_fingerprint_required");terms.put("expectedFingerprint",fingerprint);}
        else if(input.containsKey("previewId")||input.containsKey("expectedFingerprint")||input.containsKey("custodyMode")&&!"game_coins".equals(input.get("custodyMode")))throw new IllegalArgumentException("escrow_exact_equipment_only");return terms;
    }
    private static boolean equipment(Material material){return material!=null&&material.isItem()&&material.getMaxDurability()>0&&material.getMaxStackSize()==1;}
    private static boolean supportedEquipment(ItemStack item){return item!=null&&equipment(item.getType())&&item.getAmount()==1&&item.getMaxStackSize()==1&&!item.hasData(DataComponentTypes.CONTAINER)&&!item.hasData(DataComponentTypes.BUNDLE_CONTENTS)&&!item.hasData(DataComponentTypes.CHARGED_PROJECTILES);}
    private static List<String> stockFields(Map<String,Object> input){List<String> fields=new ArrayList<>(STOCK_FIELDS);if(input.containsKey("previewId")){fields.add("custodyMode");fields.add("previewId");fields.add("expectedFingerprint");}return fields;}
    private void approved(String principal,String playerId,String connectionId){
        Map<String,Object> session=experience.discordAccess().pendingSession(UUID.fromString(playerId));
        if(!Boolean.TRUE.equals(session.get("online"))||!"APPROVED".equals(session.get("reason"))||!principal.equals(session.get("principalId"))||!connectionId.equals(session.get("connectionId")))throw new IllegalArgumentException("escrow_approved_connection_required");
    }
    @SuppressWarnings("unchecked") private String registeredOwner(String principal,String ownerPlayerId)throws Exception {
        Map<String,Object> state=DiscordGameAccess.stateObject(Files.readString(plugin.getDataFolder().toPath().resolve("discord-game-access.json")));
        Map<String,Object> registration=null;for(Object value:((Map<String,Object>)state.get("reservations")).values()){Map<String,Object> r=(Map<String,Object>)value;if(principal.equals(r.get("principalId"))){registration=r;break;}}
        if(registration==null||((Number)registration.get("expiresAtMs")).longValue()<=System.currentTimeMillis())throw new IllegalArgumentException("escrow_registered_principal_required");
        boolean known=false;for(Object value:((Map<String,Object>)state.get("receipts")).values()){Map<String,Object> r=(Map<String,Object>)value;if(principal.equals(r.get("principalId"))&&ownerPlayerId.equals(r.get("playerId"))&&Boolean.TRUE.equals(r.get("approved")))known=true;}
        if(!known)throw new IllegalArgumentException("escrow_verified_minecraft_alias_required");return (String)registration.get("playerName");
    }
    @SuppressWarnings("unchecked") private void sourceAuthority(Map<String,Object> grant)throws Exception {
        String principal=(String)grant.get("sellerId"),owner=(String)grant.get("ownerPlayerId"),actorId=(String)grant.get("sourceId");
        if(!owner.equals(grant.get("sellerAccountId")))throw new IllegalArgumentException("escrow_inventory_owner_alias");
        Player actor=Bukkit.getPlayer(UUID.fromString(actorId));if(actor==null||!actor.isOnline())throw new IllegalArgumentException("escrow_source_offline");
        if("player_inventory".equals(grant.get("sourceKind"))){if(!owner.equals(actorId))throw new IllegalArgumentException("escrow_source_owner");registeredOwner(principal,owner);approved(principal,owner,(String)grant.get("connectionId"));return;}
        String ownerName=registeredOwner(principal,owner);
        if(!PlayableExperience.AGENTS.contains(actor.getName()))throw new IllegalArgumentException("escrow_owned_agent_required");
        Path runtime=plugin.getDataFolder().toPath().toAbsolutePath().normalize().getParent().getParent();Map<String,Object> registry=StrictJson.object(Files.readString(runtime.resolve("personal-agents.json")));
        boolean owned=false;for(Object value:(List<Object>)registry.get("agents")){Map<String,Object> entry=(Map<String,Object>)value;
            if(!actor.getName().equals(entry.get("name")))continue;
            String ownerKey=(String)entry.get("ownerId");boolean sameOwner=principal.equals(ownerKey)||owner.equals(ownerKey);
            boolean alias=entry.get("minecraftPlayerId")==null||owner.equals(entry.get("minecraftPlayerId"));
            if(sameOwner&&alias&&ownerName.equals(entry.get("ownerName")))owned=true;
        }
        if(!owned)throw new IllegalArgumentException("escrow_owned_agent_binding_changed");
        Path lockFile=plugin.getDataFolder().toPath().resolve("task-region-locks.json");Map<String,Object> locks=Files.exists(lockFile)?StrictJson.object(Files.readString(lockFile)):Map.of();
        if(locks.containsKey(actor.getName()))throw new IllegalArgumentException("escrow_agent_has_active_physical_task");
    }
    Map<String,Object> authorize(Map<String,Object> input)throws Exception {
        ready();Map<String,Object> grant=stock(input);if(!"world_asset".equals(grant.get("custodyMode")))EconomyMode.requireLegacy(plugin);grant.put("ownerPlayerId",uuid(input,"ownerPlayerId"));grant.put("consentId",uuid(input,"consentId"));
        long expiry=integer(input,"expiresAtMs");grant.put("expiresAtMs",expiry);
        if(!Boolean.TRUE.equals(input.get("confirmed"))||expiry<=System.currentTimeMillis()||expiry>System.currentTimeMillis()+300000L)throw new IllegalArgumentException("escrow_explicit_listing_confirmation_required");
        if("player_inventory".equals(grant.get("sourceKind")))grant.put("connectionId",uuid(input,"connectionId"));
        Map<String,Object> old=authorities.get((String)grant.get("authorityId"));
        if(old!=null){same(old,grant,new ArrayList<>(grant.keySet()));return Map.of("authorized",true,"authorityId",grant.get("authorityId"),"expiresAtMs",old.get("expiresAtMs"));}
        sourceAuthority(grant);if(grant.containsKey("previewId"))exactPreview(grant);grant.put("kind","authority");append(grant);return Map.of("authorized",true,"authorityId",grant.get("authorityId"),"expiresAtMs",expiry);
    }
    private Map<String,Object> descriptor(ItemStack item){
        var meta=item.getItemMeta();Map<String,Object> result=new LinkedHashMap<>();result.put("material",item.getType().getKey().toString());result.put("amount",item.getAmount());result.put("maxStackSize",item.getMaxStackSize());result.put("name",meta.hasDisplayName()?meta.getDisplayName():item.getType().name());result.put("damage",meta instanceof Damageable damage?damage.getDamage():0);result.put("maxDurability",(long)item.getType().getMaxDurability());
        Map<String,Object> enchants=new TreeMap<>();item.getEnchantments().forEach((key,level)->enchants.put(key.getKey().toString(),level.longValue()));result.put("enchantments",enchants);result.put("lore",meta.hasLore()?List.copyOf(meta.getLore()):List.of());return result;
    }
    Map<String,Object> shopStock(Map<String,Object> input)throws Exception {
        ready();Map<String,Object> owner=new LinkedHashMap<>();
        for(String field:List.of("sellerId","sellerAccountId","ownerPlayerId","sourceId","connectionId"))owner.put(field,uuid(input,field));
        owner.put("sourceKind","player_inventory");sourceAuthority(owner);
        Player actor=Bukkit.getPlayer(UUID.fromString((String)owner.get("sourceId")));clearActor(actor);
        if(!"BankSeller".equals(actor.getName()))throw new IllegalArgumentException("inventory_shop_operator_merchant_required");
        var marker=new org.bukkit.NamespacedKey(plugin,"unirock_demo_stock");
        if(Boolean.TRUE.equals(input.get("bootstrap"))&&!actor.getPersistentDataContainer().has(marker,org.bukkit.persistence.PersistentDataType.STRING)){
            String operation=uuid(input,"operationId");int empty=0;
            for(int slot=0;slot<36;slot++){ItemStack stack=actor.getInventory().getItem(slot);if(stack==null||stack.getType().isAir())empty++;}
            if(empty<CATALOG.size())throw new IllegalArgumentException("inventory_shop_demo_stock_capacity");
            ItemStack[] before=inventory(actor);
            try{
                for(String name:new TreeSet<>(CATALOG))if(!actor.getInventory().addItem(new ItemStack(Objects.requireNonNull(Material.matchMaterial(name)),64)).isEmpty())throw new IllegalStateException("inventory_shop_demo_stock_overflow");
                actor.getPersistentDataContainer().set(marker,org.bukkit.persistence.PersistentDataType.STRING,operation);actor.saveData();
            }catch(RuntimeException error){actor.getInventory().setContents(before);actor.getPersistentDataContainer().remove(marker);throw error;}
            plugin.getLogger().info("UniRock finite operator demo merchant grant: 64 each of eight declared resources, once. Not generated-city stock.");
        }
        Map<String,Integer> items=new TreeMap<>(),selections=new TreeMap<>();
        for(int slot=0;slot<36;slot++){
            ItemStack stack=actor.getInventory().getItem(slot);if(stack==null||!CATALOG.contains(stack.getType().getKey().toString())||!plain(stack,stack.getType()))continue;
            String name=stack.getType().getKey().getKey();if(stack.getAmount()>items.getOrDefault(name,0)){items.put(name,stack.getAmount());selections.put(name,slot);}
        }
        return Map.of("sourceId",owner.get("sourceId"),"items",items,"selections",selections,
            "fingerprint",sha(encode(inventory(actor)).getBytes(StandardCharsets.UTF_8)),"observedAtMs",System.currentTimeMillis(),
            "provenance","operator_supplied_demo","demoStockGranted",actor.getPersistentDataContainer().has(marker,org.bukkit.persistence.PersistentDataType.STRING));
    }
    Map<String,Object> preview(Map<String,Object> input)throws Exception {
        ready();Map<String,Object> request=new LinkedHashMap<>();String id=uuid(input,"operationId");request.put("previewId",id);for(String key:List.of("sellerId","sellerAccountId","ownerPlayerId","sourceId"))request.put(key,uuid(input,key));String kind=text(input,"sourceKind");if(!Set.of("player_inventory","agent_inventory").contains(kind))throw new IllegalArgumentException("escrow_source_kind");request.put("sourceKind",kind);
        if("player_inventory".equals(kind))request.put("connectionId",uuid(input,"connectionId"));
        long count=input.containsKey("count")?integer(input,"count"):1L;if(count<1||count>64)throw new IllegalArgumentException("escrow_supported_lot_count");request.put("count",count);
        if(input.containsKey("slot")){long slot=integer(input,"slot");if(slot<0||slot>35||input.containsKey("selection"))throw new IllegalArgumentException("escrow_selection_slot");request.put("requestedSlot",slot);}
        else{if(!"main_hand".equals(text(input,"selection")))throw new IllegalArgumentException("escrow_main_hand_or_slot_required");request.put("selection","main_hand");}
        Map<String,Object> old=previews.get(id);if(old!=null){same(old,request,new ArrayList<>(request.keySet()));return view(old);}
        sourceAuthority(request);Player actor=Bukkit.getPlayer(UUID.fromString((String)request.get("sourceId")));clearActor(actor);int slot=request.containsKey("requestedSlot")?((Number)request.get("requestedSlot")).intValue():actor.getInventory().getHeldItemSlot();ItemStack selected=actor.getInventory().getItem(slot);
        boolean resource=selected!=null&&CATALOG.contains(selected.getType().getKey().toString())&&plain(selected,selected.getType());
        if(!resource&&!supportedEquipment(selected)||selected==null||count>selected.getAmount()||count>selected.getMaxStackSize()||!resource&&count!=1)throw new IllegalArgumentException("escrow_supported_noncontainer_item_lot_required");
        ItemStack portion=selected.clone();portion.setAmount((int)count);String blob=encode(new ItemStack[]{portion});request.put("kind","preview");request.put("phase","complete");request.put("selectionSlot",(long)slot);request.put("item",selected.getType().getKey().toString());request.put("fingerprintAlgorithm",CanonicalItemFingerprint.VERSION);request.put("fingerprint",CanonicalItemFingerprint.hash(blob));request.put("sourceStackFingerprint",CanonicalItemFingerprint.hash(encode(new ItemStack[]{selected.clone()})));request.put("stackBytes",blob);request.put("descriptor",descriptor(portion));request.put("worldName",actor.getWorld().getName());request.put("worldUUID",actor.getWorld().getUID().toString());request.put("expiresAtMs",System.currentTimeMillis()+300000L);append(request);return view(request);
    }
    private Map<String,Object> exactPreview(Map<String,Object> terms){Map<String,Object> preview=previews.get((String)terms.get("previewId"));if(preview==null||((Number)preview.get("expiresAtMs")).longValue()<=System.currentTimeMillis())throw new IllegalArgumentException("escrow_equipment_preview_expired");same(preview,terms,List.of("sellerId","sellerAccountId","sourceId","sourceKind","item","count"));if(!preview.get("fingerprint").equals(terms.get("expectedFingerprint")))throw new IllegalArgumentException("escrow_equipment_preview_fingerprint_changed");return preview;}
    private ItemStack[] inventory(Player actor){return Arrays.stream(actor.getInventory().getContents()).map(item->item==null?null:item.clone()).toArray(ItemStack[]::new);}
    private static String encode(ItemStack[] items){return Base64.getEncoder().encodeToString(ItemStack.serializeItemsAsBytes(items));}
    private static ItemStack[] decode(String bytes){return ItemStack.deserializeItemsFromBytes(Base64.getDecoder().decode(bytes));}
    private static boolean matches(ItemStack[] a,ItemStack[] b){if(a.length!=b.length)return false;for(int i=0;i<a.length;i++){boolean emptyA=a[i]==null||a[i].getType().isAir(),emptyB=b[i]==null||b[i].getType().isAir();if(emptyA&&emptyB)continue;if(!Objects.equals(a[i],b[i]))return false;}return true;}
    private static boolean plain(ItemStack stack,Material material){return stack!=null&&stack.getType()==material&&stack.getMaxStackSize()==64&&!stack.hasItemMeta();}
    private void clearActor(Player actor){if(pending.containsKey(actor.getUniqueId()))throw new IllegalStateException("ESCROW_ACTOR_RECONCILIATION_REQUIRED");if(actor.getGameMode()!=GameMode.SURVIVAL||!actor.getItemOnCursor().getType().isAir()||actor.getOpenInventory().getTopInventory().getType()!=InventoryType.CRAFTING)throw new IllegalArgumentException("escrow_close_container_survival_required");}
    private Map<String,Object> view(Map<String,Object> row){Map<String,Object> result=copy(row);for(String key:List.of("schema","kind","phase","vault","before","after","actorId","stackBytes","sourceStackFingerprint"))result.remove(key);return result;}
    private Map<String,Object> vaultView(Map<String,Object> vault){Map<String,Object> result=copy(vault);result.remove("stackBytes");result.put("mailboxId",vault.get("listingId"));return result;}
    @SuppressWarnings("unchecked") private Map<String,Object> finish(Map<String,Object> intent,Player actor)throws Exception {
        ItemStack[] before=decode((String)intent.get("before")),after=decode((String)intent.get("after")),actual=inventory(actor);
        if(matches(actual,before)){actor.getInventory().setContents(after);actor.saveData();}
        else if(!matches(actual,after))throw new IllegalStateException("ESCROW_INVENTORY_RECONCILIATION_REQUIRED");
        Map<String,Object> receipt=copy(intent);receipt.put("phase","complete");receipt.remove("before");receipt.remove("after");receipt.put("completedAtMs",System.currentTimeMillis());
        if("reserve".equals(intent.get("kind")))receipt.put("escrowed",true);else receipt.put("claimed",true);
        append(receipt);pending.remove(actor.getUniqueId());return view(receipt);
    }
    private Map<String,Object> inventoryEffect(Map<String,Object> record,Player actor,ItemStack[] before,ItemStack[] after,Map<String,Object> vault)throws Exception {
        record.put("phase","intent");record.put("actorId",actor.getUniqueId().toString());record.put("before",encode(before));record.put("after",encode(after));record.put("vault",vault);
        append(record);pending.put(actor.getUniqueId(),(String)record.get("operationId"));return finish(record,actor);
    }
    private Map<String,Object> known(Map<String,Object> requested,List<String> fields)throws Exception {
        Map<String,Object> old=operations.get((String)requested.get("operationId"));if(old==null)return null;same(old,requested,fields);
        if(!"complete".equals(old.get("phase"))){Player actor=Bukkit.getPlayer(UUID.fromString((String)old.get("actorId")));if(actor==null)throw new IllegalStateException("ESCROW_ACTOR_RECONCILIATION_REQUIRED");return finish(old,actor);}
        return view(old);
    }
    Map<String,Object> reserve(Map<String,Object> input)throws Exception {
        ready();Map<String,Object> terms=stock(input);Map<String,Object> previous=operations.get((String)terms.get("operationId"));if(previous!=null){same(previous,terms,stockFields(terms));if("complete".equals(previous.get("phase")))return view(previous);}if(!"world_asset".equals(terms.get("custodyMode")))EconomyMode.requireLegacy(plugin);Map<String,Object> prior=known(terms,stockFields(terms));if(prior!=null)return prior;
        String listing=(String)terms.get("listingId");if(vaults.containsKey(listing)||operations.values().stream().anyMatch(row->listing.equals(row.get("listingId"))&&"reserve".equals(row.get("kind"))))throw new IllegalArgumentException("escrow_listing_already_reserved");
        Map<String,Object> grant=authorities.get((String)terms.get("authorityId"));if(grant==null)throw new IllegalArgumentException("escrow_financial_authority_required");same(grant,terms,stockFields(terms));
        if(((Number)grant.get("expiresAtMs")).longValue()<=System.currentTimeMillis())throw new IllegalArgumentException("escrow_financial_authority_expired");sourceAuthority(grant);
        Player actor=Bukkit.getPlayer(UUID.fromString((String)terms.get("sourceId")));clearActor(actor);Material material=Material.matchMaterial((String)terms.get("item"));
        ItemStack[] before=inventory(actor),after=inventory(actor);int remaining=((Number)terms.get("count")).intValue();ItemStack captured=null;
        String exactBlob=null;boolean canonical=false;
        if(terms.containsKey("previewId")){
            Map<String,Object> preview=exactPreview(terms);int slot=((Number)preview.get("selectionSlot")).intValue();ItemStack selected=after[slot];
            String sourceFingerprint=(String)preview.getOrDefault("sourceStackFingerprint",preview.get("fingerprint"));
            if(preview.containsKey("fingerprintAlgorithm")&&!CanonicalItemFingerprint.VERSION.equals(preview.get("fingerprintAlgorithm")))throw new IllegalArgumentException("escrow_fingerprint_algorithm");
            canonical=CanonicalItemFingerprint.VERSION.equals(preview.get("fingerprintAlgorithm"));
            String selectedBlob=selected==null?null:encode(new ItemStack[]{selected});
            boolean sameSource=selected!=null&&sourceFingerprint.equals(canonical?CanonicalItemFingerprint.hash(selectedBlob):sha(Base64.getDecoder().decode(selectedBlob)));
            // Legacy single equipment previews retain their original bytes/hash when only NBT key order changed on reload.
            if(!sameSource&&!canonical&&selected!=null&&selected.getAmount()==1&&remaining==1&&supportedEquipment(selected))sameSource=CanonicalItemFingerprint.same(selectedBlob,(String)preview.get("stackBytes"));
            if(!actor.getWorld().getUID().toString().equals(preview.get("worldUUID"))||!sameSource)throw new IllegalArgumentException("escrow_selected_item_changed");captured=selected.clone();captured.setAmount(remaining);exactBlob=(String)preview.get("stackBytes");if(!CanonicalItemFingerprint.same(encode(new ItemStack[]{captured}),exactBlob))throw new IllegalArgumentException("escrow_selected_item_changed");if(selected.getAmount()==remaining)after[slot]=null;else after[slot].setAmount(selected.getAmount()-remaining);remaining=0;terms.put("selectionSlot",(long)slot);terms.put("descriptor",preview.get("descriptor"));terms.put("worldName",preview.get("worldName"));terms.put("worldUUID",preview.get("worldUUID"));if(canonical)terms.put("fingerprintAlgorithm",CanonicalItemFingerprint.VERSION);
        }
        for(int slot=0;slot<actor.getInventory().getStorageContents().length&&remaining>0;slot++){
            ItemStack item=after[slot];if(!plain(item,material))continue;if(captured==null)captured=item.clone();int take=Math.min(remaining,item.getAmount());remaining-=take;if(take==item.getAmount())after[slot]=null;else item.setAmount(item.getAmount()-take);
        }
        if(remaining!=0)throw new IllegalArgumentException("escrow_insufficient_plain_items");captured.setAmount(((Number)terms.get("count")).intValue());
        String blob=exactBlob==null?encode(new ItemStack[]{captured}):exactBlob,fingerprint=canonical?CanonicalItemFingerprint.hash(blob):sha(Base64.getDecoder().decode(blob));Map<String,Object> vault=copy(terms);
        for(String key:List.of("operationId","authorityId"))vault.remove(key);vault.put("custodyId",listing);vault.put("fingerprint",fingerprint);vault.put("stackBytes",blob);vault.put("state","held");vault.put("ownerId",terms.get("sellerId"));
        if(terms.containsKey("descriptor"))vault.put("descriptor",terms.get("descriptor"));terms.put("kind","reserve");terms.put("custodyId",listing);terms.put("fingerprint",fingerprint);return inventoryEffect(terms,actor,before,after,vault);
    }
    private Map<String,Object> listing(String id){Map<String,Object> vault=vaults.get(id);if(vault==null)throw new IllegalArgumentException("escrow_listing_missing");return vault;}
    Map<String,Object> assign(Map<String,Object> input)throws Exception {
        ready();Map<String,Object> request=new LinkedHashMap<>();for(String key:List.of("operationId","listingId","purchaseId","buyerId"))request.put(key,uuid(input,key));request.put("termsDigest",text(input,"termsDigest"));
        Map<String,Object> prior=known(request,new ArrayList<>(request.keySet()));if(prior!=null)return prior;Map<String,Object> vault=copy(listing((String)request.get("listingId")));
        if("world_asset".equals(vault.get("custodyMode")))throw new IllegalArgumentException("escrow_world_asset_canonical_release_required");
        EconomyMode.requireLegacy(plugin);
        if(!"held".equals(vault.get("state"))||!request.get("termsDigest").equals(vault.get("termsDigest"))||request.get("buyerId").equals(vault.get("sellerId")))throw new IllegalArgumentException("escrow_assignment_terms_or_state");
        vault.put("state","assigned");vault.put("ownerId",request.get("buyerId"));vault.put("buyerId",request.get("buyerId"));vault.put("purchaseId",request.get("purchaseId"));vault.put("returned",false);
        return custodyReceipt(request,vault,"assign");
    }
    Map<String,Object> returnItems(Map<String,Object> input)throws Exception {
        ready();Map<String,Object> request=new LinkedHashMap<>();for(String key:List.of("operationId","listingId","sellerId"))request.put(key,uuid(input,key));request.put("termsDigest",text(input,"termsDigest"));
        Map<String,Object> prior=known(request,new ArrayList<>(request.keySet()));if(prior!=null)return prior;Map<String,Object> vault=copy(listing((String)request.get("listingId")));
        if("world_asset".equals(vault.get("custodyMode")))throw new IllegalArgumentException("escrow_world_asset_canonical_release_required");
        if(!"held".equals(vault.get("state"))||!request.get("sellerId").equals(vault.get("sellerId"))||!request.get("termsDigest").equals(vault.get("termsDigest")))throw new IllegalArgumentException("escrow_return_terms_or_state");
        vault.put("state","assigned");vault.put("ownerId",vault.get("sellerId"));vault.put("returned",true);return custodyReceipt(request,vault,"return");
    }
    private Map<String,Object> custodyReceipt(Map<String,Object> request,Map<String,Object> vault,String kind)throws Exception {
        request.put("kind",kind);request.put("phase","complete");for(String field:List.of("ownerId","item","count","custodyId","fingerprint"))request.put(field,vault.get(field));request.put("assigned",true);request.put("returned",vault.get("returned"));request.put("vault",vault);append(request);return view(request);
    }
    private Map<String,Object> assetPins(Map<String,Object> input){Map<String,Object> pins=new LinkedHashMap<>();long chain=integer(input,"chainId");String registry=text(input,"registry").toLowerCase(Locale.ROOT),code=text(input,"codeHash").toLowerCase(Locale.ROOT),deployment=text(input,"deploymentId");if(!Set.of(1301L,31337L).contains(chain)||!registry.matches("0x[a-f0-9]{40}")||!code.matches("0x[a-f0-9]{64}")||!deployment.matches("[A-Za-z0-9_.:-]{1,128}"))throw new IllegalArgumentException("escrow_asset_source_pins");pins.put("chainId",chain);pins.put("registry",registry);pins.put("codeHash",code);pins.put("deploymentId",deployment);return pins;}
    Map<String,Object> assetConfigure(Map<String,Object> input)throws Exception {
        ready();Map<String,Object> pins=assetPins(input);if(assetConfiguration!=null){same(assetConfiguration,pins,new ArrayList<>(pins.keySet()));return Map.of("configured",true,"source",view(assetConfiguration));}pins.put("operationId",uuid(input,"operationId"));pins.put("kind","asset-config");append(pins);return Map.of("configured",true,"source",view(pins));
    }
    private Map<String,Object> assetProof(Map<String,Object> input){
        if(assetConfiguration==null)throw new IllegalArgumentException("escrow_asset_source_not_configured");Map<String,Object> proof=assetPins(input);same(assetConfiguration,proof,new ArrayList<>(proof.keySet()));for(String key:List.of("operationId","listingId"))proof.put(key,uuid(input,key));
        String token=text(input,"tokenId"),fingerprint=text(input,"fingerprint"),digest=text(input,"termsDigest");if(!token.matches("[1-9][0-9]{0,77}")||!fingerprint.matches("[a-f0-9]{64}")||!digest.matches("[a-f0-9]{64}"))throw new IllegalArgumentException("escrow_asset_proof_terms");proof.put("tokenId",token);proof.put("fingerprint",fingerprint);proof.put("termsDigest",digest);
        for(String key:List.of("blockHash","transactionHash")){String value=text(input,key).toLowerCase(Locale.ROOT);if(!value.matches("0x[a-f0-9]{64}"))throw new IllegalArgumentException("escrow_asset_proof_hash");proof.put(key,value);}
        long block=integer(input,"blockNumber"),confirmations=integer(input,"confirmations");if(block<0||confirmations<2||!Boolean.TRUE.equals(input.get("confirmed")))throw new IllegalArgumentException("escrow_canonical_confirmed_proof_required");proof.put("blockNumber",block);proof.put("confirmations",confirmations);proof.put("confirmed",true);return proof;
    }
    Map<String,Object> assetBind(Map<String,Object> input)throws Exception {
        ready();Map<String,Object> proof=assetProof(input);Map<String,Object> prior=known(proof,new ArrayList<>(proof.keySet()));if(prior!=null)return prior;Map<String,Object> vault=copy(listing((String)proof.get("listingId")));
        if(!"world_asset".equals(vault.get("custodyMode"))||!"held".equals(vault.get("state"))||vault.containsKey("assetTokenId"))throw new IllegalArgumentException("escrow_asset_binding_state");same(vault,proof,List.of("fingerprint","termsDigest"));
        vault.put("assetTokenId",proof.get("tokenId"));vault.put("assetMintBlock",proof.get("blockNumber"));vault.put("assetMintHash",proof.get("blockHash"));vault.put("assetMintTransaction",proof.get("transactionHash"));proof.put("kind","asset-bind");proof.put("phase","complete");proof.put("bound",true);proof.put("custodyId",vault.get("custodyId"));proof.put("vault",vault);append(proof);return view(proof);
    }
    Map<String,Object> assetRelease(Map<String,Object> input)throws Exception {
        ready();Map<String,Object> proof=assetProof(input);proof.put("ownerId",uuid(input,"ownerId"));String claim=text(input,"claimId").toLowerCase(Locale.ROOT);if(!claim.matches("0x[a-f0-9]{64}"))throw new IllegalArgumentException("escrow_asset_claim_id");proof.put("claimId",claim);
        Map<String,Object> prior=known(proof,new ArrayList<>(proof.keySet()));if(prior!=null)return prior;Map<String,Object> vault=copy(listing((String)proof.get("listingId")));
        if(!"world_asset".equals(vault.get("custodyMode"))||!"held".equals(vault.get("state"))||!proof.get("tokenId").equals(vault.get("assetTokenId"))||((Number)proof.get("blockNumber")).longValue()<((Number)vault.get("assetMintBlock")).longValue())throw new IllegalArgumentException("escrow_asset_redemption_state");same(vault,proof,List.of("fingerprint","termsDigest"));
        if(operations.values().stream().anyMatch(row->"asset-release".equals(row.get("kind"))&&claim.equals(row.get("claimId"))))throw new IllegalArgumentException("escrow_asset_claim_already_used");
        vault.put("state","assigned");vault.put("ownerId",proof.get("ownerId"));vault.put("assetClaimId",claim);vault.put("returned",false);proof.put("kind","asset-release");proof.put("phase","complete");proof.put("assigned",true);proof.put("released",true);for(String key:List.of("item","count","custodyId","descriptor"))if(vault.containsKey(key))proof.put(key,vault.get(key));proof.put("vault",vault);append(proof);return view(proof);
    }
    Map<String,Object> mailbox(Map<String,Object> input){ready();String owner=uuid(input,"ownerId");return Map.of("ownerId",owner,"entries",vaults.values().stream().filter(v->owner.equals(v.get("ownerId"))&&"assigned".equals(v.get("state"))).map(this::vaultView).toList());}
    Map<String,Object> claim(Map<String,Object> input)throws Exception {
        ready();Map<String,Object> request=new LinkedHashMap<>();for(String key:List.of("operationId","mailboxId","ownerId","playerId","connectionId"))request.put(key,uuid(input,key));
        Map<String,Object> prior=known(request,List.of("operationId","mailboxId","ownerId","playerId"));if(prior!=null)return prior;
        String owner=(String)request.get("ownerId"),playerId=(String)request.get("playerId");registeredOwner(owner,playerId);approved(owner,playerId,(String)request.get("connectionId"));
        Map<String,Object> vault=copy(listing((String)request.get("mailboxId")));if(!"assigned".equals(vault.get("state"))||!owner.equals(vault.get("ownerId")))throw new IllegalArgumentException("escrow_mailbox_owner_or_state");
        Player actor=Bukkit.getPlayer(UUID.fromString(playerId));clearActor(actor);ItemStack[] before=inventory(actor),after=inventory(actor);ItemStack stack=decode((String)vault.get("stackBytes"))[0];int remaining=stack.getAmount();
        for(int i=0;i<actor.getInventory().getStorageContents().length&&remaining>0;i++)if(after[i]!=null&&after[i].isSimilar(stack)){int take=Math.min(remaining,after[i].getMaxStackSize()-after[i].getAmount());after[i].setAmount(after[i].getAmount()+take);remaining-=take;}
        for(int i=0;i<actor.getInventory().getStorageContents().length&&remaining>0;i++)if(after[i]==null||after[i].getType().isAir()){int take=Math.min(remaining,stack.getMaxStackSize());after[i]=stack.clone();after[i].setAmount(take);remaining-=take;}
        if(remaining!=0)throw new IllegalArgumentException("escrow_mailbox_inventory_full");vault.put("state","claimed");request.put("kind","claim");for(String key:List.of("listingId","custodyId","fingerprint","item","count"))request.put(key,vault.get(key));return inventoryEffect(request,actor,before,after,vault);
    }
    Map<String,Object> status(Map<String,Object> input){ready();if(input.containsKey("operationId")){Map<String,Object> row=operations.get(uuid(input,"operationId"));return row==null?Map.of("known",false):Map.of("known",true,"pending","intent".equals(row.get("phase")),"receipt",view(row));}if(input.containsKey("listingId")){Map<String,Object> row=vaults.get(uuid(input,"listingId"));return row==null?Map.of("known",false):Map.of("known",true,"custody",vaultView(row));}return Map.of("pendingCount",pending.size(),"custodyCount",vaults.size(),"catalog",CATALOG.stream().sorted().toList());}
    private boolean held(Player player){return pending.containsKey(player.getUniqueId());}
    private void recover(Player actor){if(!held(actor))return;try{finish(operations.get(pending.get(actor.getUniqueId())),actor);}catch(Exception error){plugin.getLogger().severe("Native item escrow remains frozen: "+(error instanceof IllegalStateException?error.getMessage():"escrow_recovery_failed"));}}
    @EventHandler(priority=EventPriority.LOWEST) public void joined(PlayerJoinEvent event){recover(event.getPlayer());}
    @EventHandler(priority=EventPriority.HIGHEST) public void inventoryClick(InventoryClickEvent event){if(event.getWhoClicked() instanceof Player p&&held(p))event.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void inventoryDrag(InventoryDragEvent event){if(event.getWhoClicked() instanceof Player p&&held(p))event.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void inventoryOpen(InventoryOpenEvent event){if(event.getPlayer() instanceof Player p&&held(p))event.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void pickup(EntityPickupItemEvent event){if(event.getEntity() instanceof Player p&&held(p))event.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void drop(PlayerDropItemEvent event){if(held(event.getPlayer()))event.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void place(BlockPlaceEvent event){if(held(event.getPlayer()))event.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void dig(BlockBreakEvent event){if(held(event.getPlayer()))event.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void interact(PlayerInteractEvent event){if(held(event.getPlayer()))event.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void entity(PlayerInteractEntityEvent event){if(held(event.getPlayer()))event.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void entityAt(PlayerInteractAtEntityEvent event){entity(event);}
    @EventHandler(priority=EventPriority.HIGHEST) public void damage(EntityDamageEvent event){if(event.getEntity() instanceof Player p&&held(p))event.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void attack(EntityDamageByEntityEvent event){if(event.getDamager() instanceof Player p&&held(p))event.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void consume(PlayerItemConsumeEvent event){if(held(event.getPlayer()))event.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void durability(PlayerItemDamageEvent event){if(held(event.getPlayer()))event.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void swap(PlayerSwapHandItemsEvent event){if(held(event.getPlayer()))event.setCancelled(true);}
    @EventHandler(priority=EventPriority.LOWEST) public void command(PlayerCommandPreprocessEvent event){if(held(event.getPlayer())){event.setCancelled(true);event.getPlayer().sendMessage("Your item transfer needs reconciliation. Inventory actions are temporarily held.");}}
}

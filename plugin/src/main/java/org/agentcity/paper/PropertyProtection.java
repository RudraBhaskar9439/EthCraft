package org.agentcity.paper;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.sk89q.worldedit.bukkit.BukkitAdapter;
import com.sk89q.worldedit.math.BlockVector3;
import com.sk89q.worldguard.WorldGuard;
import com.sk89q.worldguard.domains.DefaultDomain;
import com.sk89q.worldguard.protection.flags.*;
import com.sk89q.worldguard.protection.managers.RegionManager;
import com.sk89q.worldguard.protection.regions.ProtectedCuboidRegion;
import com.sk89q.worldguard.protection.regions.ProtectedRegion;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.bukkit.*;
import org.bukkit.entity.*;
import org.bukkit.event.*;
import org.bukkit.event.block.*;
import org.bukkit.event.entity.*;
import org.bukkit.event.hanging.HangingPlaceEvent;
import org.bukkit.event.inventory.*;
import org.bukkit.event.player.*;
import org.bukkit.event.vehicle.*;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;

/** Fixed estate geometry, projected only from the private canonical-chain adapter. */
final class PropertyProtection implements Listener {
    private static final Gson JSON=new GsonBuilder().serializeNulls().create();
    static final String WORLD="agentcity_estates";
    private final JavaPlugin plugin;
    private final PlayableExperience experience;
    private final World world;
    private final RegionManager regions;
    private final Path journal,runtime;
    private final String namespace;
    private final Map<Integer,Map<String,Object>> catalog=new LinkedHashMap<>(),owners=new LinkedHashMap<>();
    private final Map<Integer,Map<String,Object>> listingLocks=new HashMap<>();
    private final Map<String,Map<String,Object>> operations=new LinkedHashMap<>();
    private Map<String,Object> pins,snapshot;
    private long revision,blockNumber=-1,expiry;
    private String blockHash="";
    private String registeredWorldUUID,registeredWorldFolder;
    private boolean frozen=true;
    private final Set<UUID> internalTeleport=new HashSet<>();
    private BukkitTask timer;
    private String lastMembership="";
    private long refusedMoves,refusedTeleports;

    PropertyProtection(JavaPlugin plugin,PlayableExperience experience)throws Exception {
        this.plugin=plugin;this.experience=experience;Path directory=plugin.getDataFolder().toPath().toAbsolutePath().normalize();runtime=directory.getParent().getParent();journal=directory.resolve("property-projection.jsonl");
        namespace=(String)StrictJson.object(Files.readString(directory.resolve("deployment.json"))).get("serverId");
        boolean existing=Files.exists(journal);if(existing)try(var lines=Files.lines(journal)){for(String line:(Iterable<String>)lines::iterator)load(StrictJson.object(line));}
        if(existing&&(registeredWorldUUID==null||registeredWorldFolder==null||!Files.isDirectory(Path.of(registeredWorldFolder))))throw new IllegalStateException("estate_registered_world_data_missing");
        world=Bukkit.createWorld(new WorldCreator(WORLD).environment(World.Environment.NORMAL).type(WorldType.NORMAL));if(world==null)throw new IllegalStateException("estate_world_unavailable");
        if(existing&&!world.getUID().toString().equals(registeredWorldUUID))throw new IllegalStateException("estate_registered_world_identity_changed");
        if(!existing){Map<String,Object> initialization=new LinkedHashMap<>();initialization.put("kind","initialize");initialization.put("operationId",UUID.randomUUID().toString());initialization.put("worldUUID",world.getUID().toString());initialization.put("worldFolder",world.getWorldFolder().toPath().toAbsolutePath().normalize().toString());append(initialization);}
        regions=WorldGuard.getInstance().getPlatform().getRegionContainer().get(BukkitAdapter.adapt(world));if(regions==null)throw new IllegalStateException("estate_worldguard_unavailable");
        for(int id=1;id<=4;id++){
            int col=(id-1)%2,row=(id-1)/2,x=col*32,z=row*32;Map<String,Object> value=new LinkedHashMap<>();value.put("parcelId",(long)id);value.put("world",WORLD);value.put("worldUUID",world.getUID().toString());value.put("serverNamespace",namespace);value.put("cellX",(long)col*2);value.put("cellZ",(long)row*2);value.put("bounds",Map.of("min",Map.of("x",(long)x,"y",(long)world.getMinHeight(),"z",(long)z),"max",Map.of("x",(long)x+15,"y",(long)world.getMaxHeight()-1,"z",(long)z+15)));
            String digest=hash((namespace+"|"+WORLD+"|"+id+"|"+x+"|"+z+"|16|"+world.getMinHeight()+"|"+(world.getMaxHeight()-1)).getBytes(StandardCharsets.UTF_8));value.put("catalogDigest",digest);value.put("termsDigest",digest);catalog.put(id,value);
        }
        syncRegions();Bukkit.getPluginManager().registerEvents(this,plugin);
        timer=Bukkit.getScheduler().runTaskTimer(plugin,()->{try{syncRegions();for(Player player:Bukkit.getOnlinePlayers())evict(player);}catch(Exception error){frozen=true;plugin.getLogger().severe("Estate projection paused: native protection reconciliation failed.");}},1,20);
    }
    void close(){if(timer!=null)timer.cancel();HandlerList.unregisterAll(this);}
    private static void main(){if(!Bukkit.isPrimaryThread())throw new IllegalStateException("estate_main_thread_required");}
    private static String text(Map<String,Object> value,String key){if(!(value.get(key) instanceof String s)||s.isBlank())throw new IllegalArgumentException("estate_"+key);return s;}
    private static String uuid(Map<String,Object> value,String key){return UUID.fromString(text(value,key)).toString();}
    private static long number(Map<String,Object> value,String key){if(!(value.get(key) instanceof Long n))throw new IllegalArgumentException("estate_integer_"+key);return n;}
    private static String hash(byte[] bytes){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}catch(Exception e){throw new IllegalStateException(e);}}
    @SuppressWarnings("unchecked") private void load(Map<String,Object> row){
        if(!"agentcity.property-projection.v1".equals(row.get("schema")))throw new IllegalStateException("estate_journal_schema");operations.put((String)row.get("operationId"),row);
        switch((String)row.get("kind")){
            case "initialize"->{registeredWorldUUID=(String)row.get("worldUUID");registeredWorldFolder=(String)row.get("worldFolder");}
            case "configure"->pins=(Map<String,Object>)row.get("pins");
            case "apply"->{snapshot=(Map<String,Object>)row.get("snapshot");revision=((Number)snapshot.get("revision")).longValue();blockNumber=((Number)snapshot.get("blockNumber")).longValue();blockHash=(String)snapshot.get("blockHash");expiry=((Number)snapshot.get("expiresAtMs")).longValue();owners.clear();for(Object value:(List<Object>)snapshot.get("parcels")){Map<String,Object> owner=(Map<String,Object>)value;int parcel=((Number)owner.get("parcelId")).intValue();owners.put(parcel,owner);Map<String,Object> lock=listingLocks.get(parcel);if(lock!=null&&lock.get("operationId").equals(owner.get("resolvedOperationId"))&&Set.of("confirmed_cancel","confirmed_purchase","confirmed_expiry","confirmed_owner_change").contains(owner.get("marketResolution"))&&owner.get("resolutionTransactionHash") instanceof String tx&&tx.matches("0x[a-fA-F0-9]{64}"))listingLocks.remove(parcel);}frozen=false;}
            case "invalidate"->frozen=true;
            case "freeze"->listingLocks.put(((Number)row.get("parcelId")).intValue(),row);
            default->throw new IllegalStateException("estate_journal_kind");
        }
    }
    private void append(Map<String,Object> row)throws Exception {
        row.put("schema","agentcity.property-projection.v1");byte[] bytes=(JSON.toJson(row)+"\n").getBytes(StandardCharsets.UTF_8);if(bytes.length>65536)throw new IllegalArgumentException("estate_record_size");
        try{try(FileChannel file=FileChannel.open(journal,StandardOpenOption.CREATE,StandardOpenOption.APPEND,StandardOpenOption.WRITE)){ByteBuffer buffer=ByteBuffer.wrap(bytes);while(buffer.hasRemaining())file.write(buffer);file.force(true);}try(FileChannel directory=FileChannel.open(journal.getParent(),StandardOpenOption.READ)){directory.force(true);}load(row);}catch(Exception error){frozen=true;throw error;}
    }
    private Map<String,Object> source(Map<String,Object> input){Map<String,Object> value=new LinkedHashMap<>();long chain=number(input,"chainId");String registry=text(input,"registry").toLowerCase(Locale.ROOT),code=text(input,"codeHash").toLowerCase(Locale.ROOT),deployment=text(input,"deploymentId");if(!Set.of(1301L,31337L).contains(chain)||!registry.matches("0x[a-f0-9]{40}")||!code.matches("0x[a-f0-9]{64}")||!deployment.matches("[A-Za-z0-9_.:-]{1,128}"))throw new IllegalArgumentException("estate_source_pins");value.put("chainId",chain);value.put("registry",registry);value.put("codeHash",code);value.put("deploymentId",deployment);return value;}
    Map<String,Object> configure(Map<String,Object> input)throws Exception {main();Map<String,Object> requested=source(input);if(pins!=null){if(!pins.equals(requested))throw new IllegalArgumentException("estate_source_binding_changed");return Map.of("configured",true,"source",pins);}Map<String,Object> row=new LinkedHashMap<>();row.put("operationId",uuid(input,"operationId"));row.put("kind","configure");row.put("pins",requested);append(row);return Map.of("configured",true,"source",pins);}
    Map<String,Object> invalidate(Map<String,Object> input)throws Exception {main();String id=uuid(input,"operationId"),reason=text(input,"reason");if(!Set.of("canonical_reorg","source_unavailable","canonical_mismatch").contains(reason))throw new IllegalArgumentException("estate_invalidation_reason");Map<String,Object> prior=operations.get(id);if(prior!=null){if(!"invalidate".equals(prior.get("kind"))||!reason.equals(prior.get("reason")))throw new IllegalArgumentException("estate_operation_changed");return Map.of("paused",true,"revision",revision);}Map<String,Object> row=new LinkedHashMap<>();row.put("operationId",id);row.put("kind","invalidate");row.put("reason",reason);append(row);syncRegions();for(Player player:Bukkit.getOnlinePlayers())evict(player);return Map.of("paused",true,"revision",revision);}
    @SuppressWarnings("unchecked") Map<String,Object> apply(Map<String,Object> input)throws Exception {
        main();if(pins==null||!pins.equals(source(input)))throw new IllegalArgumentException("estate_source_binding_required");String id=uuid(input,"operationId");
        Map<String,Object> requested=new LinkedHashMap<>(input);requested.remove("operationId");Map<String,Object> prior=operations.get(id);if(prior!=null){if(!"apply".equals(prior.get("kind"))||!requested.equals(prior.get("snapshot")))throw new IllegalArgumentException("estate_operation_changed");return Map.of("applied",true,"revision",((Map<String,Object>)prior.get("snapshot")).get("revision"));}
        long next=number(input,"revision"),height=number(input,"blockNumber"),expires=number(input,"expiresAtMs"),observed=number(input,"observedAtMs"),confirmations=number(input,"confirmations");String hash=text(input,"blockHash").toLowerCase(Locale.ROOT);
        if(!hash.matches("0x[a-f0-9]{64}")||!Boolean.TRUE.equals(input.get("confirmed"))||confirmations<2||expires<=System.currentTimeMillis()||expires>System.currentTimeMillis()+60000||observed>System.currentTimeMillis()+5000||observed<System.currentTimeMillis()-60000)throw new IllegalArgumentException("estate_fresh_confirmed_snapshot_required");
        if(next<=revision||height<blockNumber||height==blockNumber&&!blockHash.isEmpty()&&!blockHash.equals(hash)){invalidate(Map.of("operationId",UUID.randomUUID().toString(),"reason","canonical_mismatch"));throw new IllegalArgumentException("estate_revision_or_canonical_block_regressed");}
        if(!(input.get("parcels") instanceof List<?> parcels)||parcels.size()!=4)throw new IllegalArgumentException("estate_full_four_parcel_snapshot_required");Set<Integer> seen=new HashSet<>();
        for(Object value:parcels){if(!(value instanceof Map<?,?>))throw new IllegalArgumentException("estate_parcel_record");Map<String,Object> owner=(Map<String,Object>)value;int parcel=Math.toIntExact(number(owner,"parcelId"));if(!catalog.containsKey(parcel)||!seen.add(parcel))throw new IllegalArgumentException("estate_registered_parcel_required");String digest=owner.containsKey("catalogDigest")?text(owner,"catalogDigest"):text(owner,"termsDigest");if(!catalog.get(parcel).get("catalogDigest").equals(digest)||owner.containsKey("bounds")||owner.containsKey("agentIds"))throw new IllegalArgumentException("estate_fixed_catalog_binding_required");
            if(owner.get("ownerPrincipalId")!=null){uuid(owner,"ownerPrincipalId");uuid(owner,"ownerPlayerId");text(owner,"assetId");}
        }
        Map<String,Object> row=new LinkedHashMap<>();row.put("operationId",id);row.put("kind","apply");row.put("snapshot",requested);append(row);try{syncRegions();for(Player player:Bukkit.getOnlinePlayers())evict(player);}catch(Exception error){frozen=true;throw error;}return Map.of("applied",true,"revision",revision);
    }
    private boolean active(){return !frozen&&pins!=null&&snapshot!=null&&System.currentTimeMillis()<expiry;}
    private boolean locked(int parcel){return parcel!=0&&(listingLocks.containsKey(parcel)||Boolean.TRUE.equals(owners.getOrDefault(parcel,Map.of()).get("marketLocked")));}
    private boolean mutationDenied(Player player,Location location){int parcel=parcel(location);return !permitted(player,parcel)||locked(parcel);}
    Map<String,Object> freeze(Map<String,Object> input)throws Exception {main();String operation=uuid(input,"operationId"),owner=uuid(input,"ownerPrincipalId"),asset=text(input,"assetId"),fingerprint=text(input,"expectedFingerprint");int parcel=Math.toIntExact(number(input,"parcelId"));Map<String,Object> prior=operations.get(operation);if(prior!=null){if(!"freeze".equals(prior.get("kind"))||!owner.equals(prior.get("ownerPrincipalId"))||!asset.equals(prior.get("assetId"))||!fingerprint.equals(prior.get("expectedFingerprint"))||parcel!=((Number)prior.get("parcelId")).intValue())throw new IllegalArgumentException("estate_operation_changed");return Map.of("frozen",true,"operationId",operation,"parcelId",(long)parcel);}Map<String,Object> projected=owners.get(parcel);if(!active()||projected==null||!owner.equals(projected.get("ownerPrincipalId"))||!asset.equals(projected.get("assetId"))||locked(parcel))throw new IllegalArgumentException("estate_current_owner_unlocked_parcel_required");if(!fingerprint.equals(preview(Map.of("parcelId",(long)parcel)).get("houseSnapshotFingerprint")))throw new IllegalArgumentException("estate_house_snapshot_changed");Map<String,Object> record=new LinkedHashMap<>();record.put("operationId",operation);record.put("kind","freeze");record.put("parcelId",(long)parcel);record.put("ownerPrincipalId",owner);record.put("assetId",asset);record.put("expectedFingerprint",fingerprint);append(record);for(Player player:Bukkit.getOnlinePlayers())if(parcel(player.getLocation())==parcel)player.closeInventory();syncRegions();return Map.of("frozen",true,"operationId",operation,"parcelId",(long)parcel);}
    private int parcel(Location location){if(location==null||!location.getWorld().equals(world))return 0;int x=location.getBlockX(),z=location.getBlockZ();for(int id=1;id<=4;id++){int minX=((id-1)%2)*32,minZ=((id-1)/2)*32;if(x>=minX&&x<minX+16&&z>=minZ&&z<minZ+16)return id;}return 0;}
    @SuppressWarnings("unchecked") private boolean ownedAgent(Player player,Map<String,Object> owner){
        if(!PlayableExperience.AGENTS.contains(player.getName()))return false;try{Path file=runtime.resolve("personal-agents.json");if(!Files.exists(file))return false;Map<String,Object> state=StrictJson.object(Files.readString(file));for(Object value:(List<Object>)state.get("agents")){Map<String,Object> agent=(Map<String,Object>)value;if(!player.getName().equals(agent.get("name")))continue;return Objects.equals(owner.get("ownerPrincipalId"),agent.get("ownerId"))||Objects.equals(owner.get("ownerPlayerId"),agent.get("ownerId"));}}catch(Exception error){return false;}return false;
    }
    private boolean permitted(Player player,int parcel){if(parcel==0)return true;if(!active())return false;Map<String,Object> owner=owners.get(parcel);if(owner==null||owner.get("ownerPrincipalId")==null)return false;if(ownedAgent(player,owner))return true;if(!player.getUniqueId().toString().equals(owner.get("ownerPlayerId")))return false;Map<String,Object> session=experience.discordAccess().pendingSession(player.getUniqueId());return "APPROVED".equals(session.get("reason"))&&owner.get("ownerPrincipalId").equals(session.get("principalId"));}
    private boolean denied(Player player,Location location){return !permitted(player,parcel(location));}
    private Location publicSpawn(){int y=world.getHighestBlockYAt(-8,-8,HeightMap.MOTION_BLOCKING_NO_LEAVES)+1;return new Location(world,-7.5,y,-7.5);}
    private void evict(Player player){if(!denied(player,player.getLocation()))return;internalTeleport.add(player.getUniqueId());try{player.closeInventory();player.teleport(publicSpawn());}finally{internalTeleport.remove(player.getUniqueId());}}
    private void syncRegions()throws Exception {
        StringBuilder signature=new StringBuilder(active()?"active":"paused");Map<Integer,DefaultDomain> domains=new HashMap<>();
        for(int id=1;id<=4;id++){DefaultDomain domain=new DefaultDomain();if(active()){Map<String,Object> owner=owners.get(id);if(owner!=null&&owner.get("ownerPrincipalId")!=null){domain.addPlayer(UUID.fromString((String)owner.get("ownerPlayerId")));for(Player player:Bukkit.getOnlinePlayers())if(ownedAgent(player,owner))domain.addPlayer(player.getUniqueId());}}domains.put(id,domain);signature.append('|').append(id).append(':').append(new TreeSet<>(domain.getUniqueIds())).append(locked(id));}
        if(signature.toString().equals(lastMembership))return;
        for(int id=1;id<=4;id++){int x=((id-1)%2)*32,z=((id-1)/2)*32;String key="ac_estate_"+id;ProtectedRegion region=regions.getRegion(key);BlockVector3 min=BlockVector3.at(x,world.getMinHeight(),z),max=BlockVector3.at(x+15,world.getMaxHeight()-1,z+15);if(region==null){region=new ProtectedCuboidRegion(key,min,max);regions.addRegion(region);}else if(!region.getMinimumPoint().equals(min)||!region.getMaximumPoint().equals(max))throw new IllegalStateException("estate_existing_region_geometry_changed");
            region.setPriority(100);region.setOwners(new DefaultDomain());region.setMembers(domains.get(id));
            for(StateFlag flag:List.of(Flags.ENTRY,Flags.USE,Flags.INTERACT,Flags.BLOCK_BREAK,Flags.BLOCK_PLACE,Flags.CHEST_ACCESS,Flags.ITEM_PICKUP,Flags.DAMAGE_ANIMALS,Flags.ENTITY_PAINTING_DESTROY,Flags.ENTITY_ITEM_FRAME_DESTROY)){region.setFlag(flag,StateFlag.State.DENY);if(flag.getRegionGroupFlag()!=null)region.setFlag(flag.getRegionGroupFlag(),locked(id)&&flag!=Flags.ENTRY?RegionGroup.ALL:RegionGroup.NON_MEMBERS);}
            for(StateFlag flag:List.of(Flags.TNT,Flags.CREEPER_EXPLOSION,Flags.GHAST_FIREBALL,Flags.OTHER_EXPLOSION,Flags.WITHER_DAMAGE,Flags.ENDERDRAGON_BLOCK_DAMAGE,Flags.PISTONS,Flags.WATER_FLOW,Flags.LAVA_FLOW,Flags.FIRE_SPREAD,Flags.LAVA_FIRE)){region.setFlag(flag,StateFlag.State.DENY);if(flag.getRegionGroupFlag()!=null)region.setFlag(flag.getRegionGroupFlag(),RegionGroup.ALL);}
        }
        regions.save();lastMembership=signature.toString();
    }
    Map<String,Object> status(){main();Map<String,Object> result=new LinkedHashMap<>();result.put("enabled",true);result.put("world",WORLD);result.put("worldUUID",world.getUID().toString());result.put("serverNamespace",namespace);result.put("catalog",List.copyOf(catalog.values()));result.put("revision",revision);result.put("blockNumber",blockNumber);result.put("blockHash",blockHash);result.put("expiresAtMs",expiry);result.put("active",active());result.put("refusals",Map.of("movement",refusedMoves,"teleport",refusedTeleports));result.put("listingLocks",List.copyOf(listingLocks.values()));result.put("source",pins==null?Map.of():pins);result.put("projection",snapshot==null?Map.of():snapshot);Location spawn=publicSpawn();result.put("safeReturn",Map.of("x",spawn.getX(),"y",spawn.getY(),"z",spawn.getZ()));return result;}
    Map<String,Object> catalog(){main();return Map.of("world",WORLD,"worldName",WORLD,"worldUUID",world.getUID().toString(),"serverNamespace",namespace,"catalog",List.copyOf(catalog.values()),"parcels",List.copyOf(catalog.values()));}
    Map<String,Object> preview(Map<String,Object> input){main();int id=Math.toIntExact(number(input,"parcelId"));if(!catalog.containsKey(id))throw new IllegalArgumentException("estate_registered_parcel_required");Map<String,Object> result=new LinkedHashMap<>(catalog.get(id));try{MessageDigest digest=MessageDigest.getInstance("SHA-256");long nonAir=0;int minX=((id-1)%2)*32,minZ=((id-1)/2)*32;for(int x=minX;x<minX+16;x++)for(int z=minZ;z<minZ+16;z++)for(int y=world.getMinHeight();y<world.getMaxHeight();y++){var block=world.getBlockAt(x,y,z);if(block.getType().isAir())continue;nonAir++;digest.update((x+","+y+","+z+":"+block.getBlockData().getAsString()+"\n").getBytes(StandardCharsets.UTF_8));}result.put("houseSnapshotFingerprint",HexFormat.of().formatHex(digest.digest()));result.put("observedNonAirBlocks",nonAir);result.put("observedAtMs",System.currentTimeMillis());result.put("snapshotScope","Actual blocks in the complete parcel bounds; no house completion or construction claim.");return result;}catch(Exception error){throw new IllegalStateException("estate_native_snapshot_failed",error);}}
    Map<String,Object> visit(Map<String,Object> input){main();Player player=Bukkit.getPlayer(UUID.fromString(uuid(input,"playerId")));if(player==null)throw new IllegalArgumentException("estate_player_offline");int id=Math.toIntExact(number(input,"parcelId"));if(!catalog.containsKey(id)||!permitted(player,id))throw new IllegalArgumentException("estate_current_owner_access_required");int x=((id-1)%2)*32+8,z=((id-1)/2)*32+8,y=world.getHighestBlockYAt(x,z,HeightMap.MOTION_BLOCKING_NO_LEAVES)+1;boolean moved=player.teleport(new Location(world,x+0.5,y,z+0.5));return Map.of("visited",moved,"parcelId",(long)id,"world",WORLD);}
    void visitRoad(Player player){main();player.teleport(publicSpawn());}
    @EventHandler(priority=EventPriority.HIGHEST) public void move(PlayerMoveEvent e){if(e.getTo()!=null&&denied(e.getPlayer(),e.getTo())){refusedMoves++;e.setCancelled(true);}}
    @EventHandler(priority=EventPriority.HIGHEST) public void teleport(PlayerTeleportEvent e){if(!internalTeleport.contains(e.getPlayer().getUniqueId())&&e.getTo()!=null&&denied(e.getPlayer(),e.getTo())){refusedTeleports++;e.setCancelled(true);}}
    @EventHandler(priority=EventPriority.HIGHEST) public void join(PlayerJoinEvent e){Bukkit.getScheduler().runTask(plugin,()->evict(e.getPlayer()));}
    @EventHandler(priority=EventPriority.HIGHEST) public void respawn(PlayerRespawnEvent e){if(denied(e.getPlayer(),e.getRespawnLocation()))e.setRespawnLocation(publicSpawn());}
    @EventHandler(priority=EventPriority.HIGHEST) public void place(BlockPlaceEvent e){if(mutationDenied(e.getPlayer(),e.getBlock().getLocation()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void dig(BlockBreakEvent e){if(mutationDenied(e.getPlayer(),e.getBlock().getLocation()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void use(PlayerInteractEvent e){if(e.getClickedBlock()!=null&&mutationDenied(e.getPlayer(),e.getClickedBlock().getLocation()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void interact(PlayerInteractEntityEvent e){if(mutationDenied(e.getPlayer(),e.getRightClicked().getLocation()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void interactAt(PlayerInteractAtEntityEvent e){interact(e);}
    @EventHandler(priority=EventPriority.HIGHEST) public void open(InventoryOpenEvent e){if(e.getPlayer() instanceof Player p&&mutationDenied(p,e.getInventory().getLocation()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void transfer(InventoryMoveItemEvent e){int source=parcel(e.getSource().getLocation()),destination=parcel(e.getDestination().getLocation());if(locked(source)||locked(destination)||source!=destination&&(source!=0||destination!=0))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void inventoryClick(InventoryClickEvent e){if(e.getWhoClicked() instanceof Player p&&mutationDenied(p,e.getView().getTopInventory().getLocation()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void inventoryDrag(InventoryDragEvent e){if(e.getWhoClicked() instanceof Player p&&mutationDenied(p,e.getView().getTopInventory().getLocation()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void burn(FurnaceBurnEvent e){if(locked(parcel(e.getBlock().getLocation())))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void cook(BlockCookEvent e){if(locked(parcel(e.getBlock().getLocation())))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void brew(BrewEvent e){if(locked(parcel(e.getBlock().getLocation())))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void pickup(EntityPickupItemEvent e){if(e.getEntity() instanceof Player p&&denied(p,e.getItem().getLocation()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void hanging(HangingPlaceEvent e){if(e.getPlayer()!=null&&mutationDenied(e.getPlayer(),e.getEntity().getLocation()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void damage(EntityDamageByEntityEvent e){Entity actor=e.getDamager();if(actor instanceof Projectile projectile&&projectile.getShooter() instanceof Entity entity)actor=entity;if(actor instanceof Player player&&mutationDenied(player,e.getEntity().getLocation()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void projectile(ProjectileHitEvent e){Location target=e.getHitBlock()!=null?e.getHitBlock().getLocation():e.getHitEntity()!=null?e.getHitEntity().getLocation():null;if(e.getEntity().getShooter() instanceof Player p&&mutationDenied(p,target)){e.setCancelled(true);e.getEntity().remove();}}
    @EventHandler(priority=EventPriority.HIGHEST) public void vehicle(VehicleEnterEvent e){if(e.getEntered() instanceof Player p&&denied(p,e.getVehicle().getLocation()))e.setCancelled(true);}
    @EventHandler public void vehicleMove(VehicleMoveEvent e){for(Entity passenger:e.getVehicle().getPassengers())if(passenger instanceof Player p&&denied(p,e.getTo())){e.getVehicle().removePassenger(p);evict(p);}}
}

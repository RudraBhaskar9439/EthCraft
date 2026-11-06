package org.agentcity.paper;

import com.google.gson.Gson;
import com.google.gson.Strictness;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import java.io.StringReader;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.*;
import org.bukkit.*;
import org.bukkit.entity.Player;
import org.bukkit.event.*;
import org.bukkit.event.block.*;
import org.bukkit.event.entity.*;
import org.bukkit.event.inventory.*;
import org.bukkit.event.player.*;
import org.bukkit.plugin.java.JavaPlugin;

/** Discord approves one exact local game connection, never Microsoft identity by name. */
public final class DiscordGameAccess implements Listener {
    private static final Set<String> BYPASS;
    static {
        Set<String> names=new HashSet<>(PlayableExperience.AGENTS);
        names.addAll(Set.of("WorldBuilder","WorldRequester","WorldInspector"));
        BYPASS=Set.copyOf(names);
    }
    private final JavaPlugin plugin;
    private final Supplier<Location> lobby;
    private final Function<UUID,String> connection;
    private final Consumer<Player> approved;
    private final Path stateFile;
    private final Map<String,Map<String,Object>> reservations=new LinkedHashMap<>(),holds=new LinkedHashMap<>(),receipts=new LinkedHashMap<>();
    private final Set<UUID> pending=ConcurrentHashMap.newKeySet();
    private final Map<UUID,Location> pendingLocations=new HashMap<>();
    private final Set<UUID> internalTeleport=new HashSet<>();
    private boolean available=true;

    public DiscordGameAccess(JavaPlugin plugin,Supplier<Location> lobby,Function<UUID,String> connection,Consumer<Player> approved){
        this.plugin=plugin;this.lobby=lobby;this.connection=connection;this.approved=approved;
        stateFile=plugin.getDataFolder().toPath().resolve("discord-game-access.json");
    }
    private static void main(){if(!Bukkit.isPrimaryThread())throw new IllegalStateException("discord_access_main_thread");}
    private static String text(Map<String,Object> input,String name){if(!(input.get(name) instanceof String value)||value.isBlank())throw new IllegalArgumentException("discord_access_"+name);return value;}
    private static String uuid(Map<String,Object> input,String name){return UUID.fromString(text(input,name)).toString();}
    private static long expiry(Map<String,Object> input){Object value=input.get("expiresAtMs");if(!(value instanceof Number n)||n.doubleValue()!=n.longValue())throw new IllegalArgumentException("discord_access_expiry");return n.longValue();}
    @SuppressWarnings("unchecked") public void start() throws Exception{
        main();if(Files.exists(stateFile)){
            Map<String,Object> state=stateObject(Files.readString(stateFile));
            if(!"agentcity.discord-game-access.v1".equals(state.get("schema")))throw new IllegalStateException("discord_access_schema");
            for(var pair:Map.of("reservations",reservations,"holds",holds,"receipts",receipts).entrySet()){
                if(!(state.get(pair.getKey()) instanceof Map<?,?> entries))throw new IllegalStateException("discord_access_state");
                for(var entry:entries.entrySet())pair.getValue().put((String)entry.getKey(),(Map<String,Object>)entry.getValue());
            }
        }
        Bukkit.getPluginManager().registerEvents(this,plugin);
    }
    /** Persisted Bukkit locations contain decimals; command JSON stays integer-only. */
    static Map<String,Object> stateObject(String text){
        if(text==null||text.length()>65536)throw new IllegalArgumentException("state_size");
        try(JsonReader reader=new JsonReader(new StringReader(text))){
            reader.setStrictness(Strictness.STRICT);Object value=stateValue(reader,0);
            if(!(value instanceof Map<?,?>)||reader.peek()!=JsonToken.END_DOCUMENT)throw new IllegalArgumentException("state_object_required");
            @SuppressWarnings("unchecked") Map<String,Object> result=(Map<String,Object>)value;return result;
        }catch(java.io.IOException error){throw new IllegalArgumentException("state_malformed_json",error);}
    }
    private static Object stateValue(JsonReader reader,int depth)throws java.io.IOException{
        if(depth>12)throw new IllegalArgumentException("state_depth");
        return switch(reader.peek()){
            case BEGIN_OBJECT->{reader.beginObject();Map<String,Object> values=new LinkedHashMap<>();while(reader.hasNext()){
                if(values.size()>=256)throw new IllegalArgumentException("state_object_size");String name=reader.nextName();if(values.containsKey(name))throw new IllegalArgumentException("state_duplicate_key");values.put(name,stateValue(reader,depth+1));
            }reader.endObject();yield values;}
            case BEGIN_ARRAY->{reader.beginArray();List<Object> values=new ArrayList<>();while(reader.hasNext()){if(values.size()>=4096)throw new IllegalArgumentException("state_array_size");values.add(stateValue(reader,depth+1));}reader.endArray();yield values;}
            case STRING->reader.nextString();
            case BOOLEAN->reader.nextBoolean();
            case NULL->{reader.nextNull();yield null;}
            case NUMBER->{String number=reader.nextString();try{
                if(number.matches("-?(0|[1-9][0-9]*)"))yield Long.parseLong(number);
                if(!number.matches("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?"))throw new IllegalArgumentException("state_number_required");
                double value=Double.parseDouble(number);if(!Double.isFinite(value))throw new IllegalArgumentException("state_number_finite_required");yield value;
            }catch(NumberFormatException error){throw new IllegalArgumentException("state_number_range",error);}}
            default->throw new IllegalArgumentException("state_malformed_json");
        };
    }
    public void close(){main();HandlerList.unregisterAll(this);pending.clear();pendingLocations.clear();}
    private void persist() throws Exception{
        Files.createDirectories(stateFile.getParent());Path temporary=stateFile.resolveSibling("discord-game-access."+UUID.randomUUID()+".tmp");
        try{try(FileChannel file=FileChannel.open(temporary,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE)){
            ByteBuffer bytes=StandardCharsets.UTF_8.encode(new Gson().toJson(Map.of("schema","agentcity.discord-game-access.v1","reservations",reservations,"holds",holds,"receipts",receipts))+"\n");while(bytes.hasRemaining())file.write(bytes);file.force(true);
        }Files.move(temporary,stateFile,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
        try(FileChannel directory=FileChannel.open(stateFile.getParent(),StandardOpenOption.READ)){directory.force(true);}
        }finally{Files.deleteIfExists(temporary);}
    }
    public Map<String,Object> reserve(Map<String,Object> input) throws Exception{
        main();if(!available)throw new IllegalStateException("discord_access_unavailable");
        String name=text(input,"playerName"),principal=uuid(input,"principalId"),discord=text(input,"discordId"),kind=text(input,"accountKind");long expires=expiry(input);
        if(!name.matches("[A-Za-z0-9_]{3,16}")||BYPASS.stream().anyMatch(name::equalsIgnoreCase)||!discord.matches("[0-9]{16,22}")||!Set.of("local","tlauncher","microsoft").contains(kind))throw new IllegalArgumentException("discord_access_registration");
        String key=name.toLowerCase(Locale.ROOT);
        Map<String,Object> terms=Map.of("playerName",name,"principalId",principal,"discordId",discord,"accountKind",kind,"expiresAtMs",expires),previous=reservations.get(key);
        if(previous!=null){
            for(String field:List.of("playerName","principalId","discordId","accountKind"))if(!Objects.equals(previous.get(field),terms.get(field)))throw new IllegalArgumentException("discord_access_registration_conflict");
            long oldExpiry=expiry(previous);if(expires<oldExpiry)throw new IllegalArgumentException("discord_access_registration_expiry_regression");
            if(expires==oldExpiry)return reservationView(previous);
            if(expires<=System.currentTimeMillis()||expires>System.currentTimeMillis()+30L*24*60*60*1000)throw new IllegalArgumentException("discord_access_registration_expired");
            reservations.put(key,terms);try{persist();}catch(Exception error){reservations.put(key,previous);throw error;}
            return reservationView(terms);
        }
        if(expires<=System.currentTimeMillis()||expires>System.currentTimeMillis()+30L*24*60*60*1000)throw new IllegalArgumentException("discord_access_registration_expired");
        for(var existing:reservations.values())if(principal.equals(existing.get("principalId"))||discord.equals(existing.get("discordId")))throw new IllegalArgumentException("discord_access_principal_already_registered");
        reservations.put(key,terms);try{persist();}catch(Exception error){reservations.remove(key);throw error;}
        for(Player player:Bukkit.getOnlinePlayers())if(player.getName().equalsIgnoreCase(name))begin(player);
        return reservationView(terms);
    }
    private Map<String,Object> reservationView(Map<String,Object> value){Map<String,Object> result=new LinkedHashMap<>(value);result.put("reserved",true);result.put("microsoftVerificationAvailable",Bukkit.getOnlineMode());return result;}
    private boolean gated(Player player){return !BYPASS.contains(player.getName())&&(Boolean.getBoolean("agentcity.discordRequired")||reservations.containsKey(player.getName().toLowerCase(Locale.ROOT)));}
    private Map<String,Object> registered(Player player){return reservations.get(player.getName().toLowerCase(Locale.ROOT));}
    private boolean sessionApproved(Player player,String id){Map<String,Object> receipt=receipts.get(id);return receipt!=null&&player.getUniqueId().toString().equals(receipt.get("playerId"));}
    public boolean isPending(Player player){main();return pending.contains(player.getUniqueId());}
    private Map<String,Object> location(Player player){Location p=player.getLocation();return Map.of("world",p.getWorld().getName(),"x",p.getX(),"y",p.getY(),"z",p.getZ(),"yaw",p.getYaw(),"pitch",p.getPitch(),"gameMode",player.getGameMode().name());}
    /** Called before ordinary onboarding; the original inventory is never touched. */
    public boolean begin(Player player){
        main();if(!gated(player))return false;
        String id=connection.apply(player.getUniqueId());if(id==null)throw new IllegalStateException("discord_access_connection_required");
        if(sessionApproved(player,id)&&!holds.containsKey(player.getUniqueId().toString())){pending.remove(player.getUniqueId());pendingLocations.remove(player.getUniqueId());return false;}
        pending.add(player.getUniqueId());player.closeInventory();player.setOp(false);
        String playerId=player.getUniqueId().toString();
        if(!holds.containsKey(playerId)){holds.put(playerId,location(player));try{persist();}catch(Exception error){available=false;plugin.getLogger().severe("Discord access state could not be persisted; player remains restricted.");return true;}}
        player.setGameMode(GameMode.ADVENTURE);internalTeleport.add(player.getUniqueId());try{player.teleport(lobby.get());}finally{internalTeleport.remove(player.getUniqueId());}
        pendingLocations.put(player.getUniqueId(),player.getLocation().clone());
        player.sendMessage("Approve this connection in Discord to play.");return true;
    }
    public Map<String,Object> approve(Map<String,Object> input) throws Exception{
        main();if(!available)throw new IllegalStateException("discord_access_unavailable");
        String playerId=uuid(input,"playerId"),id=uuid(input,"connectionId"),principal=uuid(input,"principalId");Player player=Bukkit.getPlayer(UUID.fromString(playerId));
        if(player==null||!player.isOnline()||!id.equals(connection.apply(player.getUniqueId())))throw new IllegalArgumentException("discord_access_connection_changed");
        Map<String,Object> registration=registered(player);if(registration==null||!principal.equals(registration.get("principalId")))throw new IllegalArgumentException("discord_access_principal_required");
        String kind=(String)registration.get("accountKind");
        if(kind.equals("microsoft")&&!Bukkit.getOnlineMode())throw new IllegalArgumentException("microsoft_authentication_unavailable_offline_server");
        Map<String,Object> receipt=receipts.get(id);
        if(receipt!=null){if(!principal.equals(receipt.get("principalId"))||!playerId.equals(receipt.get("playerId")))throw new IllegalArgumentException("discord_access_approval_conflict");}
        else{
            if(expiry(registration)<=System.currentTimeMillis())throw new IllegalArgumentException("discord_access_registration_expired");
            if(!pending.contains(player.getUniqueId()))throw new IllegalArgumentException("discord_access_pending_connection_required");
            receipt=Map.of("approved",true,"playerId",playerId,"connectionId",id,"principalId",principal,"authenticationKind",kind.equals("microsoft")?"minecraft_online_mode":"discord_approved_local_profile");
            receipts.put(id,receipt);try{persist();}catch(Exception error){receipts.remove(id);throw error;}
        }
        Map<String,Object> held=holds.get(playerId);
        if(held!=null){World world=Bukkit.getWorld((String)held.get("world"));if(world==null)throw new IllegalStateException("discord_access_restore_world_unavailable");
            Location original=new Location(world,((Number)held.get("x")).doubleValue(),((Number)held.get("y")).doubleValue(),((Number)held.get("z")).doubleValue(),((Number)held.get("yaw")).floatValue(),((Number)held.get("pitch")).floatValue());
            internalTeleport.add(player.getUniqueId());try{if(!player.teleport(original))throw new IllegalStateException("discord_access_restore_pending");}finally{internalTeleport.remove(player.getUniqueId());}
            player.setGameMode(GameMode.valueOf((String)held.get("gameMode")));holds.remove(playerId);try{persist();}catch(Exception error){holds.put(playerId,held);throw error;}
        }
        pending.remove(player.getUniqueId());pendingLocations.remove(player.getUniqueId());approved.accept(player);return receipt;
    }
    public Map<String,Object> enrich(Player player,String id){
        main();Map<String,Object> result=new LinkedHashMap<>();Map<String,Object> registration=registered(player),receipt=receipts.get(id);
        result.put("playerName",player.getName());result.put("pendingAuthentication",pending.contains(player.getUniqueId()));
        result.put("principalId",registration==null?"":registration.get("principalId"));
        result.put("authenticationKind",receipt==null?"unverified_local_connection":receipt.get("authenticationKind"));
        Location actual=player.getLocation();result.put("serverPosition",Map.of("world",actual.getWorld().getName(),"x",actual.getX(),"y",actual.getY(),"z",actual.getZ()));result.put("serverGameMode",player.getGameMode().name());result.put("observedAtMs",System.currentTimeMillis());
        Location frozen=pendingLocations.get(player.getUniqueId());if(frozen!=null)result.put("pendingPosition",Map.of("world",frozen.getWorld().getName(),"x",frozen.getX(),"y",frozen.getY(),"z",frozen.getZ()));
        return result;
    }
    public Map<String,Object> pendingSession(UUID playerId){
        main();Player player=Bukkit.getPlayer(playerId);String id=connection.apply(playerId);
        if(player==null||!player.isOnline()||id==null)return Map.of("online",false,"playerId",playerId.toString());
        Map<String,Object> result=new LinkedHashMap<>(enrich(player,id));result.put("online",true);result.put("playerId",playerId.toString());result.put("connectionId",id);
        Map<String,Object> registration=registered(player);
        result.put("reason",!pending.contains(playerId)?sessionApproved(player,id)?"APPROVED":"LEGACY_PROFILE_NOT_DISCORD_VERIFIED":registration==null?"DISCORD_REGISTRATION_REQUIRED":expiry(registration)<=System.currentTimeMillis()?"REGISTRATION_EXPIRED":"microsoft".equals(registration.get("accountKind"))&&!Bukkit.getOnlineMode()?"MICROSOFT_AUTHENTICATION_UNAVAILABLE":"DISCORD_APPROVAL_REQUIRED");
        return result;
    }
    public List<Map<String,Object>> pendingJoins(){main();List<Map<String,Object>> result=new ArrayList<>();for(UUID player:pending){Map<String,Object> value=pendingSession(player);if(Boolean.TRUE.equals(value.get("online")))result.add(value);}return List.copyOf(result);}
    @EventHandler(priority=EventPriority.HIGHEST) public void login(PlayerLoginEvent event){
        // A private registration admits only the restricted pending session.
        // Never turn a ban, full server or another admission refusal into ALLOWED.
        if(!available||event.getResult()!=PlayerLoginEvent.Result.KICK_WHITELIST)return;
        Player player=event.getPlayer();Map<String,Object> registration=registered(player);
        if(registration==null||!player.getName().equals(registration.get("playerName"))||expiry(registration)<=System.currentTimeMillis())return;
        if(player.isBanned()||Bukkit.getIPBans().contains(event.getAddress().getHostAddress()))return;
        event.allow();
    }
    @EventHandler(priority=EventPriority.HIGHEST) public void move(PlayerMoveEvent e){
        if(pending.contains(e.getPlayer().getUniqueId())&&!internalTeleport.contains(e.getPlayer().getUniqueId())&&e.getTo()!=null&&(e.getFrom().getX()!=e.getTo().getX()||e.getFrom().getY()!=e.getTo().getY()||e.getFrom().getZ()!=e.getTo().getZ())){
            // Use Paper's native cancellation rollback. Replacing the destination
            // can dispatch a plugin teleport, which the pending teleport gate
            // correctly denies and can thereby prevent that correction.
            e.setCancelled(true);
        }
    }
    @EventHandler(priority=EventPriority.HIGHEST) public void teleport(PlayerTeleportEvent e){if(pending.contains(e.getPlayer().getUniqueId())&&!internalTeleport.contains(e.getPlayer().getUniqueId()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void blockBreak(BlockBreakEvent e){if(pending.contains(e.getPlayer().getUniqueId()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void blockPlace(BlockPlaceEvent e){if(pending.contains(e.getPlayer().getUniqueId()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void interact(PlayerInteractEvent e){if(pending.contains(e.getPlayer().getUniqueId()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void entity(PlayerInteractEntityEvent e){if(pending.contains(e.getPlayer().getUniqueId()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void entityAt(PlayerInteractAtEntityEvent e){if(pending.contains(e.getPlayer().getUniqueId()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void open(InventoryOpenEvent e){if(e.getPlayer() instanceof Player p&&pending.contains(p.getUniqueId()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void click(InventoryClickEvent e){if(e.getWhoClicked() instanceof Player p&&pending.contains(p.getUniqueId()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void drag(InventoryDragEvent e){if(e.getWhoClicked() instanceof Player p&&pending.contains(p.getUniqueId()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void pickup(EntityPickupItemEvent e){if(e.getEntity() instanceof Player p&&pending.contains(p.getUniqueId()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void drop(PlayerDropItemEvent e){if(pending.contains(e.getPlayer().getUniqueId()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void hurt(EntityDamageEvent e){if(e.getEntity() instanceof Player p&&pending.contains(p.getUniqueId()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void attack(EntityDamageByEntityEvent e){if(e.getDamager() instanceof Player p&&pending.contains(p.getUniqueId()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.LOWEST) public void chat(AsyncPlayerChatEvent e){if(pending.contains(e.getPlayer().getUniqueId()))e.setCancelled(true);}
    @EventHandler(priority=EventPriority.LOWEST) public void command(PlayerCommandPreprocessEvent e){if(pending.contains(e.getPlayer().getUniqueId())){e.setCancelled(true);e.getPlayer().sendMessage("Approve this connection in Discord to play.");}}
    @EventHandler public void quit(PlayerQuitEvent e){pending.remove(e.getPlayer().getUniqueId());pendingLocations.remove(e.getPlayer().getUniqueId());}
}

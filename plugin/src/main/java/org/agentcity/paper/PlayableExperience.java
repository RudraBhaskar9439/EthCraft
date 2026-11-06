package org.agentcity.paper;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.util.*;
import org.bukkit.*;
import org.bukkit.block.Chest;
import org.bukkit.entity.*;
import org.bukkit.event.*;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryDragEvent;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.event.player.PlayerInteractAtEntityEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.AsyncPlayerChatEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerRespawnEvent;
import org.bukkit.inventory.*;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.plugin.java.JavaPlugin;

/** Player UI only. Ownership, tasks and on-chain confirmations are backend authority. */
public final class PlayableExperience implements Listener {
    private static final Gson JSON = new Gson();
    private static final Set<String> FIXTURES = Set.of("WorldBuilder", "WorldRequester", "WorldInspector");
    static final Set<String> AGENTS = Set.of("CityAgent1", "CityAgent2", "CityAgent3", "CityAgent4", "CityAgent5");
    private static final Set<String> MUMBAI_AGENTS = Set.of("CityAgent4", "CityAgent5");
    private static final Map<String,String> NPC_NAMES = Map.of("guide", "Guide", "agents", "Agent Desk", "jobs", "Job Board", "economy", "Wallet & Market", "play", "Play");
    private final Map<UUID,String> connections = new java.util.concurrent.ConcurrentHashMap<>();
    private final JavaPlugin plugin;
    private final World world;
    private World lobbyWorld, playWorld;
    private MumbaiWorld mumbai;
    private InventoryMarketplace inventoryMarket;
    private boolean mumbaiPadsInitialized;
    private final Set<UUID> cityArrivals = new HashSet<>();
    private DiscordGameAccess discordAccess;
    private PropertyProtection properties;
    void bindProperties(PropertyProtection properties){this.properties=properties;}
    private String lobbyWorldId, playWorldId;
    private int playX, playY, playZ;
    private boolean playSpawnKnown, lobbyInitialized, taskPadsInitialized;
    private int initializedTaskPads;
    private final int[] plotMin, plotMax;
    private final Path stateFile;
    private final NamespacedKey npcKey;
    private final Set<String> onboarded = new HashSet<>();
    private final Set<String> lobbyMigrated = new HashSet<>();
    private final LinkedHashMap<String,Map<String,Object>> events = new LinkedHashMap<>();
    private final Map<UUID,Long> recentRequests = new HashMap<>();
    private final Map<UUID,Long> recentNpcClicks = new HashMap<>();
    private boolean hubInitialized, safetyExitInitialized, available = true;

    public PlayableExperience(JavaPlugin plugin, World world, int[] plotMin, int[] plotMax) {
        this.plugin = Objects.requireNonNull(plugin);
        this.world = Objects.requireNonNull(world);
        this.plotMin = plotMin.clone(); this.plotMax = plotMax.clone();
        stateFile = plugin.getDataFolder().toPath().resolve("playable-state.json");
        npcKey = new NamespacedKey(plugin, "playable_npc");
    }

    public void start() {
        if (!Bukkit.isPrimaryThread()) throw new IllegalStateException("playable_start_requires_main_thread");
        try {
            load();
            createWorlds();
            mumbai = MumbaiWorld.load(plugin);
            for (int x = 1; x <= 2; x++) for (int z = -1; z <= 0; z++) lobbyWorld.getChunkAt(x,z).setForceLoaded(true);
            if (!lobbyInitialized) {
                for (int x = 24; x <= 45; x++) for (int z = -10; z <= 14; z++) {
                    lobbyWorld.getBlockAt(x,80,z).setType(Material.STONE_BRICKS, false);
                    for (int y = 81; y <= 85; y++) lobbyWorld.getBlockAt(x,y,z).setType(Material.AIR, false);
                }
                for (int[] p : new int[][]{{25,-9},{44,-9},{25,13},{44,13}}) lobbyWorld.getBlockAt(p[0],80,p[1]).setType(Material.SEA_LANTERN, false);
                for (int x = 24; x <= 45; x++) for (int z : new int[]{-10,14}) lobbyWorld.getBlockAt(x,81,z).setType(Material.OAK_FENCE,false);
                for (int z = -9; z <= 13; z++) {
                    lobbyWorld.getBlockAt(24,81,z).setType(Material.OAK_FENCE,false);
                    lobbyWorld.getBlockAt(45,81,z).setType(Material.OAK_FENCE,false);
                }
                lobbyWorld.setSpawnLocation(32,81,4);
                lobbyWorld.setTime(6000); lobbyWorld.setStorm(false); lobbyWorld.save();
                lobbyInitialized = true;
                persist();
            }
            if (initializedTaskPads < 3) prepareTaskPads();
            if (mumbai != null) prepareMumbaiPads();
            inventoryMarket = new InventoryMarketplace(plugin, player -> discordAccess != null && !discordAccess.isPending(player)
                && !AGENTS.contains(player.getName()), player -> connections.get(player.getUniqueId()),
                (player,action,fields) -> enqueue(player,"inventory_shop",List.of(action,JSON.toJson(fields))));
            inventoryMarket.start();
            if (mumbai != null) mumbai.controls(inventory -> inventory.getHolder() instanceof Menu || InventoryMarketplace.owns(inventory),
                this::isProtectedNpc, player -> MUMBAI_AGENTS.contains(player.getName()),
                player -> discordAccess!=null&&!discordAccess.isPending(player)&&!AGENTS.contains(player.getName()),
                this::ownsMumbaiContainer,this::ownsMumbaiBuild);
            ensureNpcs();
            discordAccess=new DiscordGameAccess(plugin,this::lobbyLocation,connections::get,this::onboard);
            discordAccess.start();
            Bukkit.getPluginManager().registerEvents(this, plugin);
            for (Player player : Bukkit.getOnlinePlayers()) onboard(player);
        } catch (Exception error) {
            available = false;
            Throwable cause=error;while(cause.getCause()!=null)cause=cause.getCause();
            String detail=cause.getMessage();
            plugin.getLogger().severe("Playable initialization cause: "+cause.getClass().getSimpleName()+":"+(detail!=null&&detail.matches("[A-Za-z0-9_ .:-]{1,160}")?detail:"private_detail_withheld"));
            throw new IllegalStateException("playable_start_failed", error);
        }
    }

    private void createWorlds() throws IOException {
        lobbyWorld = Bukkit.createWorld(new WorldCreator("agentcity_lobby").type(WorldType.FLAT).generateStructures(false));
        playWorld = Bukkit.createWorld(new WorldCreator("agentcity_play").type(WorldType.NORMAL).seed(614273L).generateStructures(true));
        if (lobbyWorld == null || playWorld == null || lobbyWorld.equals(world) || playWorld.equals(world)) throw new IllegalStateException("separate_playable_worlds_required");
        if (lobbyWorldId != null && !lobbyWorldId.equals(lobbyWorld.getUID().toString()) || playWorldId != null && !playWorldId.equals(playWorld.getUID().toString())) throw new IllegalStateException("playable_world_identity_changed");
        lobbyWorldId = lobbyWorld.getUID().toString(); playWorldId = playWorld.getUID().toString();
        if (!playSpawnKnown) {
            Set<Material> land = Set.of(Material.GRASS_BLOCK,Material.DIRT,Material.STONE,Material.SAND,Material.GRAVEL,Material.SNOW_BLOCK);
            search: for (int radius = 0; radius <= 64; radius += 8) for (int x = -radius; x <= radius; x += 8) for (int z = -radius; z <= radius; z += 8) {
                int y = playWorld.getHighestBlockYAt(x,z,HeightMap.MOTION_BLOCKING_NO_LEAVES);
                if (!land.contains(playWorld.getBlockAt(x,y,z).getType()) || y+4 >= playWorld.getMaxHeight()) continue;
                playX=x; playY=y+1; playZ=z; playSpawnKnown=true; break search;
            }
            if (!playSpawnKnown) throw new IllegalStateException("natural_play_spawn_not_found");
            for (int x=playX-2;x<=playX+2;x++) for(int z=playZ-2;z<=playZ+2;z++) {
                playWorld.getBlockAt(x,playY-1,z).setType(Material.STONE,false);
                for(int y=playY;y<=playY+3;y++) playWorld.getBlockAt(x,y,z).setType(Material.AIR,false);
            }
            playWorld.setSpawnLocation(playX,playY,playZ); playWorld.save();
        }
        persist();
    }

    private List<Map<String,Object>> taskRegions() {
        List<Map<String,Object>> regions = new ArrayList<>();
        for (Map<String,Object> old : taskRegions(playX,playY,playZ)) {
            Map<String,Object> region = new LinkedHashMap<>(old); region.put("worldName", playWorld.getName()); regions.add(Map.copyOf(region));
        }
        if (mumbai != null) for (int i=0;i<2;i++) {
            int x=1730+i*16;
            regions.add(Map.of("slotName","CityAgent"+(4+i),"worldName",MumbaiWorld.NAME,
                "min",Map.of("x",x,"y",69,"z",2810),"max",Map.of("x",x+11,"y",76,"z",2821),
                "origin",List.of(x+2,69,2812),"sourceChest",List.of(x,69,2810),"destinationChest",List.of(x,69,2812)));
        }
        return List.copyOf(regions);
    }
    @SuppressWarnings("unchecked") private void prepareMumbaiPads() throws IOException {
        NamespacedKey marker = new NamespacedKey(plugin,"playable_task_stock");
        for (Map<String,Object> region : taskRegions()) {
            String slot=(String)region.get("slotName"); if (!MUMBAI_AGENTS.contains(slot)) continue;
            Map<String,Integer> min=(Map<String,Integer>)region.get("min"); int x=min.get("x"),y=min.get("y"),z=min.get("z");
            org.bukkit.block.Block source=mumbai.world().getBlockAt(x,y,z);
            boolean granted=source.getState() instanceof Chest chest && slot.equals(chest.getPersistentDataContainer().get(marker,PersistentDataType.STRING));
            if (!granted) {
                if (mumbaiPadsInitialized || !source.getType().isAir()) throw new IOException("mumbai_agent_stock_occupied");
                source.setBlockData(Bukkit.createBlockData("minecraft:chest[facing=north,type=single,waterlogged=false]"),false);
                Chest chest=(Chest)source.getState(); chest.getPersistentDataContainer().set(marker,PersistentDataType.STRING,slot); chest.update(true,false);
                Chest actual=(Chest)source.getState();
                if (!actual.getBlockInventory().addItem(new ItemStack(Material.OAK_PLANKS,64),new ItemStack(Material.OAK_PLANKS,64),new ItemStack(Material.COBBLESTONE,64)).isEmpty()) throw new IOException("mumbai_stock_capacity");
                plugin.getLogger().info("One-time disclosed Mumbai demo stock for "+slot+": 128 oak planks, 64 cobblestone; not token backing.");
            }
            org.bukkit.block.Block destination=mumbai.world().getBlockAt(x,y,z+2);
            if (destination.getType()!=Material.CHEST) {
                if (!destination.getType().isAir()) throw new IOException("mumbai_destination_occupied");
                destination.setBlockData(Bukkit.createBlockData("minecraft:chest[facing=north,type=single,waterlogged=false]"),false);
            }
        }
        mumbai.world().save(); mumbaiPadsInitialized=true; persist();
        for(String name:MUMBAI_AGENTS)Bukkit.getOfflinePlayer(name).setWhitelisted(true);
    }

    static List<Map<String,Object>> taskRegions(int playX,int playY,int playZ) {
        List<Map<String,Object>> regions = new ArrayList<>();
        for (int slot=0;slot<3;slot++) {
            // The third offset was checked against the saved host terrain; the legacy plots stay fixed.
            int x=playX+(slot==2?23:slot==1?-31:20), z=playZ+(slot==2?18:-6);
            regions.add(Map.of("slotName","CityAgent"+(slot+1),"min",Map.of("x",x,"y",playY,"z",z),
                "max",Map.of("x",x+11,"y",playY+7,"z",z+11),"origin",List.of(x+2,playY,z+2),
                "sourceChest",List.of(x,playY,z),"destinationChest",List.of(x,playY,z+2)));
        }
        return List.copyOf(regions);
    }

    @SuppressWarnings("unchecked") static List<Double> taskHome(Map<String,Object> region) {
        Map<String,Integer> min=(Map<String,Integer>)region.get("min");
        return List.of(min.get("x")+1.5,min.get("y").doubleValue(),min.get("z")+1.5);
    }

    private void prepareTaskPads() throws IOException {
        NamespacedKey grantKey = new NamespacedKey(plugin,"playable_task_stock");
        for (Map<String,Object> region : taskRegions(playX,playY,playZ)) {
            @SuppressWarnings("unchecked") Map<String,Integer> min=(Map<String,Integer>)region.get("min");
            int x=min.get("x"), y=min.get("y"), z=min.get("z");
            String slot=(String)region.get("slotName");
            if (Integer.parseInt(slot.substring("CityAgent".length())) <= initializedTaskPads) continue;
            org.bukkit.block.Block source=playWorld.getBlockAt(x,y,z);
            boolean granted=source.getState() instanceof Chest chest && slot.equals(chest.getPersistentDataContainer().get(grantKey,PersistentDataType.STRING));
            if (!granted) {
                // An upgrade must never clear a player's existing build to add capacity.
                if (initializedTaskPads > 0) for(int px=x;px<x+12;px++) for(int pz=z;pz<z+12;pz++) {
                    if (playWorld.getBlockAt(px,y-1,pz).getState() instanceof org.bukkit.block.TileState) throw new IllegalStateException("new_agent_pad_foundation_occupied");
                    for(int py=y;py<=y+7;py++) if(!playWorld.getBlockAt(px,py,pz).getType().isAir()) throw new IllegalStateException("new_agent_pad_occupied");
                }
                for(int px=x;px<x+12;px++) for(int pz=z;pz<z+12;pz++) {
                    playWorld.getBlockAt(px,y-1,pz).setType(Material.STONE,false);
                    for(int py=y;py<=y+7;py++) playWorld.getBlockAt(px,py,pz).setType(Material.AIR,false);
                }
                source.setBlockData(Bukkit.createBlockData("minecraft:chest[facing=north,type=single,waterlogged=false]"),false);
                Chest chest=(Chest)source.getState();
                chest.getPersistentDataContainer().set(grantKey,PersistentDataType.STRING,slot);
                chest.update(true,false);
                Chest actual=(Chest)source.getState();
                if (!actual.getBlockInventory().addItem(new ItemStack(Material.OAK_PLANKS,64),new ItemStack(Material.OAK_PLANKS,64),new ItemStack(Material.COBBLESTONE,64)).isEmpty()) throw new IllegalStateException("task_stock_capacity");
                plugin.getLogger().info("One-time local task stock grant for "+slot+": 128 oak planks and 64 cobblestone. Not token backing.");
            }
            org.bukkit.block.Block destination=playWorld.getBlockAt(x,y,z+2);
            if (destination.getType()!=Material.CHEST) {
                if (!destination.getType().isAir()) throw new IllegalStateException("task_destination_changed");
                destination.setBlockData(Bukkit.createBlockData("minecraft:chest[facing=north,type=single,waterlogged=false]"),false);
            }
        }
        if (initializedTaskPads == 0) for(int x=playX-20;x<=playX+20;x++) for(int z=playZ-1;z<=playZ+1;z++) {
            playWorld.getBlockAt(x,playY-1,z).setType(Material.STONE,false);
            for(int y=playY;y<=playY+2;y++) playWorld.getBlockAt(x,y,z).setType(Material.AIR,false);
        }
        playWorld.save(); taskPadsInitialized=true; initializedTaskPads=3; persist();
    }

    public synchronized void close() {
        if(inventoryMarket!=null)inventoryMarket.close();
        if(discordAccess!=null)discordAccess.close();
        HandlerList.unregisterAll(this);
        try { persist(); } catch (IOException error) { plugin.getLogger().severe("Playable state could not be saved: " + error.getClass().getSimpleName()); }
    }

    private synchronized void load() throws IOException {
        if (!Files.exists(stateFile)) return;
        Map<String,Object> saved = JSON.fromJson(Files.readString(stateFile), new TypeToken<Map<String,Object>>(){}.getType());
        if (saved == null || !"agentcity.playable.v1".equals(saved.get("schema"))) throw new IOException("playable_state_schema");
        if (!world.getUID().toString().equals(saved.get("worldId"))) throw new IOException("playable_state_world_changed");
        hubInitialized = Boolean.TRUE.equals(saved.get("hubInitialized"));
        safetyExitInitialized = Boolean.TRUE.equals(saved.get("safetyExitInitialized"));
        lobbyInitialized = Boolean.TRUE.equals(saved.get("lobbyInitialized"));
        mumbaiPadsInitialized = Boolean.TRUE.equals(saved.get("mumbaiPadsInitialized"));
        taskPadsInitialized = Boolean.TRUE.equals(saved.get("taskPadsInitialized"));
        initializedTaskPads = initializedTaskPads(saved);
        lobbyWorldId = saved.get("lobbyWorldId") instanceof String id ? id : null;
        playWorldId = saved.get("playWorldId") instanceof String id ? id : null;
        if (saved.get("playSpawn") instanceof Map<?,?> spawn) {
            playX=((Number)spawn.get("x")).intValue(); playY=((Number)spawn.get("y")).intValue(); playZ=((Number)spawn.get("z")).intValue(); playSpawnKnown=true;
        }
        if(saved.get("lobbyMigrated") instanceof List<?> migrated) for(Object id:migrated) { UUID.fromString((String)id); lobbyMigrated.add((String)id); }
        if (!(saved.get("onboarded") instanceof List<?> people) || !(saved.get("events") instanceof List<?> pending)) throw new IOException("playable_state_fields");
        for (Object id : people) { UUID.fromString((String)id); onboarded.add((String)id); }
        if (pending.size() > 256) throw new IOException("playable_queue_limit");
        for (Object value : pending) {
            if (!(value instanceof Map<?,?> raw)) throw new IOException("playable_event_fields");
            String id = (String)raw.get("operationId"); UUID.fromString(id);
            String player = (String)raw.get("playerId"); UUID.fromString(player);
            String action = (String)raw.get("action"), name = (String)raw.get("playerName");
            if (!(raw.get("args") instanceof List<?> args) || action == null || name == null || !(raw.get("createdAtMs") instanceof Number created)) throw new IOException("playable_event_fields");
            List<String> arguments = args.stream().map(item -> (String)item).toList();
            Map<String,Object> event = new LinkedHashMap<>(event(id, player, name, action, arguments, created.longValue()));
            if(raw.get("connectionId") instanceof String connection){UUID.fromString(connection);event.put("connectionId",connection);}
            if (events.put(id,Collections.unmodifiableMap(event)) != null) throw new IOException("playable_duplicate_operation");
        }
    }

    static int initializedTaskPads(Map<String,Object> saved) throws IOException {
        Object raw=saved.get("initializedTaskPads");
        int count=raw==null ? Boolean.TRUE.equals(saved.get("taskPadsInitialized")) ? 2 : 0
            : raw instanceof Number value && value.doubleValue()==value.intValue() ? value.intValue() : -1;
        if(count<0||count>3)throw new IOException("playable_task_pad_count");
        return count;
    }

    private synchronized void persist() throws IOException {
        Files.createDirectories(stateFile.getParent());
        Map<String,Object> state = new LinkedHashMap<>();
        state.put("schema", "agentcity.playable.v1"); state.put("worldId",world.getUID().toString());
        state.put("hubInitialized",hubInitialized); state.put("safetyExitInitialized",safetyExitInitialized); state.put("onboarded",new TreeSet<>(onboarded));
        state.put("lobbyInitialized",lobbyInitialized); state.put("taskPadsInitialized",taskPadsInitialized);
        state.put("initializedTaskPads",initializedTaskPads);
        state.put("mumbaiPadsInitialized",mumbaiPadsInitialized);
        state.put("lobbyWorldId",lobbyWorldId); state.put("playWorldId",playWorldId);
        state.put("lobbyMigrated",new TreeSet<>(lobbyMigrated));
        if(playSpawnKnown) state.put("playSpawn",Map.of("x",playX,"y",playY,"z",playZ));
        state.put("events",new ArrayList<>(events.values()));
        Path temporary = stateFile.resolveSibling("playable-state." + UUID.randomUUID() + ".tmp");
        try {
            try (FileChannel file = FileChannel.open(temporary,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE)) {
                ByteBuffer bytes = java.nio.charset.StandardCharsets.UTF_8.encode(JSON.toJson(state) + "\n");
                while (bytes.hasRemaining()) file.write(bytes);
                file.force(true);
            }
            Files.move(temporary,stateFile,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
            try (FileChannel directory = FileChannel.open(stateFile.getParent(),StandardOpenOption.READ)) { directory.force(true); }
        } finally { Files.deleteIfExists(temporary); }
    }

    @SuppressWarnings("unchecked") private void onboard(Player player) {
        if (FIXTURES.contains(player.getName())) return;
        player.setOp(false);
        if(AGENTS.contains(player.getName())) {
            player.setGameMode(GameMode.SURVIVAL);
            if (MUMBAI_AGENTS.contains(player.getName()) && mumbai != null) {
                player.teleport(mumbai.agentDisplayLocations().get(player.getName())); return;
            }
            Map<String,Object> region=taskRegions().stream().filter(r->player.getName().equals(r.get("slotName"))).findFirst().orElseThrow();
            Map<String,Integer> min=(Map<String,Integer>)region.get("min"), max=(Map<String,Integer>)region.get("max");
            Location at=player.getLocation();
            boolean inside=at.getWorld().equals(playWorld)&&at.getBlockX()>=min.get("x")&&at.getBlockX()<=max.get("x")&&at.getBlockY()>=min.get("y")&&at.getBlockY()<=max.get("y")&&at.getBlockZ()>=min.get("z")&&at.getBlockZ()<=max.get("z");
            if(!inside){
                List<Double> home=taskHome(region);
                Location target=new Location(playWorld,home.get(0),home.get(1),home.get(2));
                boolean clear=target.getBlock().getType().isAir()&&target.clone().add(0,1,0).getBlock().getType().isAir()&&target.clone().subtract(0,1,0).getBlock().getType().isSolid();
                if(clear)player.teleport(target);
                else if(!at.getWorld().equals(playWorld))player.kickPlayer("Assigned agent spawn is blocked; operator review required.");
            }
            return;
        }
        String id = player.getUniqueId().toString();
        connections.putIfAbsent(player.getUniqueId(),UUID.randomUUID().toString());
        if(discordAccess!=null&&discordAccess.begin(player))return;
        synchronized (this) {
            if (mumbai != null ? cityArrivals.contains(player.getUniqueId()) : lobbyMigrated.contains(id)) return;
            player.setGameMode(GameMode.SURVIVAL);
            Location arrival=mumbai!=null&&player.getName().equals("BankSeller")?mumbai.npcLocation("economy").add(2,0,1):lobbyLocation();
            if (!player.teleport(arrival)) return;
            onboarded.add(id); lobbyMigrated.add(id);
            cityArrivals.add(player.getUniqueId());
            if(mumbai!=null)player.setGameMode(GameMode.SURVIVAL);
            if(inventoryMarket!=null&&!player.getName().equals("BankSeller"))inventoryMarket.giveButton(player);
            try { persist(); }
            catch (IOException error) { available = false; plugin.getLogger().severe("Playable onboarding save failed."); return; }
        }
        if (!AGENTS.contains(player.getName())) {
            player.sendMessage(ChatColor.GOLD + (mumbai!=null?"Welcome to UniRock in Mumbai. The service desks are inside the bank.":"Welcome to the AgentCity lobby."));
            player.sendMessage(ChatColor.YELLOW + "Use /agent 0g <request> or /agent agent <request>. Your Marketplace compass opens the CITY shop.");
            player.sendMessage(ChatColor.GRAY + "CITY purchases use testnet tokens and need your wallet confirmation. This local profile is not Microsoft identity verification.");
        }
    }

    private void ensureNpcs() {
        Map<String,Villager> found = new HashMap<>();
        for (World loaded : Bukkit.getWorlds()) for (Entity entity : loaded.getEntities()) {
            String key = entity.getPersistentDataContainer().get(npcKey,PersistentDataType.STRING);
            if (key == null || !NPC_NAMES.containsKey(key)) continue;
            if (!(entity instanceof Villager villager)) throw new IllegalStateException("playable_npc_type_changed");
            if (found.putIfAbsent(key,villager) != null) villager.remove();
        }
        String[] keys = {"guide","agents","jobs","economy","play"};
        for (int i = 0; i < keys.length; i++) {
            String key = keys[i]; Location location = mumbai!=null?mumbai.npcLocation(key):i==4?new Location(lobbyWorld,32.5,81,10.5,180,0):new Location(lobbyWorld,27.5 + i * 5,81,-4.5,0,0);
            Villager npc = found.get(key);
            if (npc == null) npc = location.getWorld().spawn(location,Villager.class);
            npc.leaveVehicle();
            npc.teleport(location); npc.setAI(false); npc.setInvulnerable(true); npc.setSilent(true);
            npc.setCollidable(false); npc.setRemoveWhenFarAway(false); npc.setPersistent(true);
            npc.setCustomName(ChatColor.GOLD + NPC_NAMES.get(key)); npc.setCustomNameVisible(true);
            npc.getPersistentDataContainer().set(npcKey,PersistentDataType.STRING,key);
            npc.setProfession(switch(key){case "agents"->Villager.Profession.TOOLSMITH;case "jobs"->Villager.Profession.CARTOGRAPHER;case "economy"->Villager.Profession.CLERIC;case "play"->Villager.Profession.ARMORER;default->Villager.Profession.LIBRARIAN;});
            npc.setVillagerType(Villager.Type.PLAINS); npc.setVillagerLevel(5);
            if(mumbai!=null){
                ArmorStand seat=null;
                for(Entity entity:location.getWorld().getEntities())if(entity instanceof ArmorStand stand
                    &&("seat:"+key).equals(entity.getPersistentDataContainer().get(npcKey,PersistentDataType.STRING))){
                    if(seat==null)seat=stand;else stand.remove();
                }
                if(seat==null)seat=location.getWorld().spawn(location.clone().subtract(0,0.6,0),ArmorStand.class);
                seat.teleport(location.clone().subtract(0,0.6,0));seat.setVisible(false);seat.setMarker(true);seat.setGravity(false);
                seat.setInvulnerable(true);seat.setPersistent(true);seat.getPersistentDataContainer().set(npcKey,PersistentDataType.STRING,"seat:"+key);
                seat.addPassenger(npc);
            }
        }
    }

    public boolean isProtectedNpc(Entity entity) {
        return entity.getPersistentDataContainer().has(npcKey,PersistentDataType.STRING);
    }

    private boolean inHub(Location location) {
        return location.getWorld().equals(lobbyWorld);
    }

    private Location lobbyLocation() { return mumbai!=null?mumbai.hubSpawn():new Location(lobbyWorld,44.5,81,4.5,90,0); }
    private Location playLocation() { return new Location(playWorld,playX+0.5,playY,playZ+0.5); }
    @SuppressWarnings("unchecked") private boolean ownsMumbai(Player player,Map<String,Object> region){
        if(discordAccess==null||discordAccess.isPending(player)||AGENTS.contains(player.getName()))return false;
        String principal=(String)discordAccess.enrich(player,connections.get(player.getUniqueId())).get("principalId");
        if(principal==null||principal.isBlank())return false;
        String slot=(String)region.get("slotName"),directory=slot.equals("CityAgent4")?"mumbai-0g":"mumbai-claude";
        Path registry=stateFile.toAbsolutePath().getParent().getParent().getParent().resolve(directory).resolve("personal-agents.json");
        try{
            if(!Files.isRegularFile(registry)||Files.size(registry)>262144)return false;
            Map<String,Object> saved=JSON.fromJson(Files.readString(registry),new TypeToken<Map<String,Object>>(){}.getType());
            if(!(saved.get("agents") instanceof List<?> agents))return false;
            for(Object raw:agents)if(raw instanceof Map<?,?> entry&&slot.equals(entry.get("name"))&&principal.equals(entry.get("ownerId"))
                &&player.getUniqueId().toString().equals(entry.get("minecraftPlayerId")))return true;
        }catch(IOException|RuntimeException error){return false;}
        return false;
    }
    boolean survivalOwner(Player player,String slot,String principal){return player!=null&&mumbai!=null&&MUMBAI_AGENTS.contains(slot)&&discordAccess!=null&&!discordAccess.isPending(player)&&Objects.equals(principal,discordAccess.enrich(player,connections.get(player.getUniqueId())).get("principalId"))&&ownsMumbai(player,Map.of("slotName",slot));}
    @SuppressWarnings("unchecked") private boolean ownsMumbaiContainer(Player player,Location location){
        if(mumbai==null||!mumbai.contains(location.getWorld()))return false;
        for(Map<String,Object> region:taskRegions())if(MUMBAI_AGENTS.contains(region.get("slotName"))){
            Map<String,Integer> min=(Map<String,Integer>)region.get("min");
            if(location.getBlockX()==min.get("x")&&location.getBlockY()==min.get("y")
                &&(location.getBlockZ()==min.get("z")||location.getBlockZ()==min.get("z")+2))return ownsMumbai(player,region);
        }
        return false;
    }
    @SuppressWarnings("unchecked") private boolean ownsMumbaiBuild(Player player,Location location){
        if(mumbai==null||!mumbai.contains(location.getWorld()))return false;
        for(Map<String,Object> region:taskRegions())if(MUMBAI_AGENTS.contains(region.get("slotName"))){
            Map<String,Integer> min=(Map<String,Integer>)region.get("min"),max=(Map<String,Integer>)region.get("max");
            if(location.getBlockX()>=min.get("x")+2&&location.getBlockX()<=max.get("x")&&location.getBlockY()>=min.get("y")&&location.getBlockY()<=max.get("y")
                &&location.getBlockZ()>=min.get("z")+2&&location.getBlockZ()<=max.get("z"))return ownsMumbai(player,region);
        }
        return false;
    }
    void positionTaskAgent(String name, boolean working) {
        if(mumbai==null||!MUMBAI_AGENTS.contains(name))return;
        Player agent=Bukkit.getPlayerExact(name);if(agent==null)return;
        Map<String,Object> region=taskRegions().stream().filter(value->name.equals(value.get("slotName"))).findFirst().orElseThrow();
        List<Double> home=taskHome(region);
        Location target=working?new Location(mumbai.world(),home.get(0),home.get(1),home.get(2)):mumbai.agentDisplayLocations().get(name);
        if(!target.getBlock().isPassable()||!target.clone().add(0,1,0).getBlock().isPassable()
            ||!target.clone().subtract(0,1,0).getBlock().getType().isSolid())throw new IllegalStateException("mumbai_agent_arrival_blocked");
        if(!agent.teleport(target))throw new IllegalStateException("mumbai_agent_travel_failed");
        agent.setGameMode(GameMode.SURVIVAL);
    }
    private void travel(Player player,String target) {
        if(mumbai!=null&&Set.of("play","lobby").contains(target)){mumbai.visit(player);return;}
        if (target.equals("mumbai")) {
            if (mumbai == null) player.sendMessage("The Mumbai map is not installed on this host.");
            else mumbai.visit(player);
            return;
        }
        Location location=switch(target) { case "play"->playLocation(); case "lobby"->lobbyLocation(); case "museum"->new Location(world,12.5,81,5.5); default->throw new IllegalArgumentException("unknown_destination"); };
        player.setOp(false); player.setGameMode(GameMode.SURVIVAL); player.closeInventory();
        if(player.teleport(location)) player.sendMessage(ChatColor.GREEN + (target.equals("play")?"Entered agentcity_play. Explore, collect materials and use your agent's assigned task area. /lobby returns to the NPCs.":target.equals("lobby")?"Returned to agentcity_lobby. Click Guide or Play.":"Entered the preserved calculator museum. Its plot remains protected. /lobby returns."));
        else player.sendMessage("Travel did not complete. Your inventory was not changed.");
    }

    @EventHandler(priority=EventPriority.LOWEST) public void join(PlayerJoinEvent event) {
        Player player=event.getPlayer();
        cityArrivals.remove(player.getUniqueId());
        if(!FIXTURES.contains(player.getName())&&!AGENTS.contains(player.getName())){
            connections.put(player.getUniqueId(),UUID.randomUUID().toString());
            if(discordAccess!=null&&discordAccess.begin(player))return;
        }
        Bukkit.getScheduler().runTask(plugin,() -> onboard(player));
    }
    @EventHandler public void respawn(PlayerRespawnEvent event) {
        if(mumbai!=null&&!AGENTS.contains(event.getPlayer().getName())&&!FIXTURES.contains(event.getPlayer().getName()))event.setRespawnLocation(lobbyLocation());
    }
    @EventHandler(priority=EventPriority.HIGHEST,ignoreCancelled=true) public void damage(EntityDamageEvent event) { if (isProtectedNpc(event.getEntity())) event.setCancelled(true); }
    @EventHandler(priority=EventPriority.HIGHEST,ignoreCancelled=true) public void breakHub(BlockBreakEvent event) { if (inHub(event.getBlock().getLocation())) { event.setCancelled(true); event.getPlayer().sendMessage("The public hub is protected. Build outside its platform."); } }
    @EventHandler(priority=EventPriority.HIGHEST,ignoreCancelled=true) public void placeHub(BlockPlaceEvent event) { if (inHub(event.getBlock().getLocation())) event.setCancelled(true); }
    @EventHandler(priority=EventPriority.HIGHEST) public void interact(PlayerInteractEntityEvent event) {
        if(discordAccess!=null&&discordAccess.isPending(event.getPlayer())){event.setCancelled(true);return;}
        if (!isProtectedNpc(event.getRightClicked())) return;
        event.setCancelled(true);
        if (event.getHand() != EquipmentSlot.HAND) return;
        long now = System.currentTimeMillis();
        if (now-recentNpcClicks.getOrDefault(event.getPlayer().getUniqueId(),0L) < 150) return;
        recentNpcClicks.put(event.getPlayer().getUniqueId(),now);
        String page = event.getRightClicked().getPersistentDataContainer().get(npcKey,PersistentDataType.STRING);
        // Vanilla sends interact-at and interact in one click. Open once on the
        // next tick so a cancelled vanilla trade cannot replace the custom menu.
        Bukkit.getScheduler().runTask(plugin,() -> openMenu(event.getPlayer(),page));
    }
    @EventHandler(priority=EventPriority.HIGHEST) public void interactAt(PlayerInteractAtEntityEvent event) { interact(event); }

    private static final class Menu implements InventoryHolder {
        final UUID owner; final String page; Inventory inventory;
        Menu(UUID owner,String page) { this.owner=owner; this.page=page; }
        @Override public Inventory getInventory() { return inventory; }
    }

    private ItemStack item(Material material,String title,String... lore) {
        ItemStack item = new ItemStack(material); ItemMeta meta = item.getItemMeta();
        meta.setDisplayName(ChatColor.GOLD + title); meta.setLore(Arrays.stream(lore).map(line -> ChatColor.GRAY + line).toList());
        item.setItemMeta(meta); return item;
    }

    private void openMenu(Player player,String page) {
        if (!NPC_NAMES.containsKey(page)) return;
        Menu menu = new Menu(player.getUniqueId(),page);
        menu.inventory = Bukkit.createInventory(menu,27,"AgentCity: " + NPC_NAMES.get(page));
        if (page.equals("guide")) {
            menu.inventory.setItem(10,item(Material.GRASS_BLOCK,"Enter the play world","Click to start Survival in agentcity_play.","Use /lobby to return to these NPCs."));
            menu.inventory.setItem(12,item(Material.COMPASS,"Talk to your agent","/agent <your request> or @agent <request>","Ask questions, give several steps, or say stop."));
            menu.inventory.setItem(14,item(Material.EMERALD,"CITY inventory marketplace","Use your Marketplace compass or /market.","Choose stocked material and quantity.","Review the total and confirm in your own wallet."));
            menu.inventory.setItem(16,item(Material.OAK_SIGN,"Supported tasks and materials","/jobs lists the supported task catalog.","/agent status reports current progress.","Paid job contracts are not enabled."));
            menu.inventory.setItem(22,item(Material.REDSTONE_LAMP,"Optional calculator museum","The old calculator world is preserved.","Click to visit; /lobby returns here."));
            if (mumbai != null) menu.inventory.setItem(24,item(Material.FILLED_MAP,"Visit South Mumbai","Real geographic data, read-only sightseeing.","Arnis · © OpenStreetMap contributors (ODbL)","Click to visit; /lobby returns here."));
        } else if (page.equals("agents")) {
            if(mumbai!=null){
                menu.inventory.setItem(10,item(Material.ENDER_EYE,"Create / reconnect 0G agent","Uses the configured 0G provider and its retained budget."));
                menu.inventory.setItem(11,item(Material.NETHER_STAR,"Create / reconnect Agent","Adaptive compute uses the existing allowances."));
                menu.inventory.setItem(12,item(Material.PAPER,"0G status","Read live task status."));
                menu.inventory.setItem(13,item(Material.PAPER,"Agent status","Read live task status."));
                menu.inventory.setItem(14,item(Material.BARRIER,"Pause 0G","Stop your own agent."));
                menu.inventory.setItem(15,item(Material.BARRIER,"Pause Agent","Stop your own agent."));
                menu.inventory.setItem(16,item(Material.CHEST,"0G supplies","Inspect real inventory and stock."));
                menu.inventory.setItem(17,item(Material.CHEST,"Agent supplies","Inspect real inventory and stock."));
                menu.inventory.setItem(20,item(Material.BOOK,"0G assessment of Agent work","Review your latest Agent objective.","Uses the existing 0G compute allowance.","Owner approval remains separate."));
                menu.inventory.setItem(24,item(Material.BOOK,"0G assessment of 0G work","Review your latest 0G objective.","This is a model assessment, not payment approval."));
                menu.inventory.setItem(22,item(Material.WRITABLE_BOOK,"Give a task","/agent 0g <request>","/agent agent <request>"));
                player.openInventory(menu.inventory); return;
            }
            menu.inventory.setItem(10,item(Material.PLAYER_HEAD,"Create my agent","Same request as /agent create"));
            menu.inventory.setItem(11,item(Material.LEAD,"Follow me","Same request as /agent follow"));
            menu.inventory.setItem(12,item(Material.COMPASS,"Come here","Same request as /agent come"));
            menu.inventory.setItem(13,item(Material.BARRIER,"Wait","Same request as /agent wait"));
            menu.inventory.setItem(14,item(Material.PAPER,"Agent status","Same request as /agent status"));
            menu.inventory.setItem(15,item(Material.REDSTONE,"Release my agent","Only when the agent carries no items.","Same request as /agent release"));
            menu.inventory.setItem(16,item(Material.CHEST,"Inspect supplies","Read actual agent inventory and registered chests.","Same request as /agent inspect"));
            menu.inventory.setItem(17,item(Material.BOOK,"Agent capabilities","Show the supported tools and task boundaries.","Same request as /agent capabilities"));
            menu.inventory.setItem(22,item(Material.WRITABLE_BOOK,"Talk to my agent","Type /agent <your request> or @agent <request>.","The agent can ask questions before acting."));
        } else if (page.equals("jobs")) {
            menu.inventory.setItem(11,item(Material.WRITABLE_BOOK,"Supported task catalog","Same request as /jobs","Paid job contracts are not enabled."));
            menu.inventory.setItem(15,item(Material.PAPER,"Current agent task status","Same request as /agent status"));
        } else if(page.equals("economy")) {
            menu.inventory.setItem(10,item(Material.CHEST,"Open CITY marketplace","Stocked materials, quantity and total price.","Self-custody confirmation; Unichain Sepolia only."));
            menu.inventory.setItem(12,item(Material.GOLD_INGOT,"USDC / CITY pool","CITY purchases use the guarded testnet market.","Wallet approval is separate from game login."));
            menu.inventory.setItem(14,item(Material.BOOK,"Protected native stock","The shop never extracts the city scenery.","A payment proposal is not delivered stock."));
            menu.inventory.setItem(16,item(Material.ENDER_CHEST,"Your wallet","Continue through the shop checkout page.","No operator wallet is assigned to you."));
        } else {
            menu.inventory.setItem(11,item(Material.GRASS_BLOCK,"Enter Survival","A separate natural world with resources.","Your agent works in its assigned task area."));
            menu.inventory.setItem(15,item(Material.REDSTONE_LAMP,"Optional museum","Visit the preserved calculator example."));
        }
        player.openInventory(menu.inventory);
    }

    @EventHandler(priority=EventPriority.HIGHEST) public void click(InventoryClickEvent event) {
        if (!(event.getView().getTopInventory().getHolder() instanceof Menu menu)) return;
        event.setCancelled(true);
        if (!(event.getWhoClicked() instanceof Player player) || !menu.owner.equals(player.getUniqueId()) || event.getRawSlot() < 0 || event.getRawSlot() >= 27) return;
        int slot = event.getRawSlot();
        if (menu.page.equals("agents")) {
            if(mumbai!=null){
                String target=switch(slot){case 10,12,14,16,24->"0g";case 11,13,15,17,20->"agent";default->null;};
                String action=switch(slot){case 10,11->"create";case 12,13->"status";case 14,15->"wait";case 16,17->"inspect";case 20,24->"review";default->null;};
                if(target!=null){enqueue(player,"agent",List.of(target+" "+action));player.closeInventory();}
                else if(slot==22){player.closeInventory();player.sendMessage("Use /agent 0g <request> or /agent agent <request>.");}
                return;
            }
            String action = switch(slot) {case 10 -> "agent_create"; case 11 -> "agent_follow"; case 12 -> "agent_come"; case 13 -> "agent_wait"; case 14 -> "agent_status"; case 15 -> "agent_release"; case 16 -> "agent_inspect"; case 17 -> "agent_capabilities"; default -> null;};
            if (action != null) { enqueue(player,action,List.of()); player.closeInventory(); }
            else if (slot == 22) { player.closeInventory(); player.sendMessage("Type /agent <your request> or @agent <request>."); }
        } else if (menu.page.equals("jobs")) {
            if (slot == 11) { enqueue(player,"agent",List.of("agent capabilities")); player.closeInventory(); }
            else if (slot == 15) { enqueue(player,"agent",List.of("agent status")); player.closeInventory(); }
        } else if (menu.page.equals("economy")) {
            if(slot==10||slot==12||slot==16){player.closeInventory();if(inventoryMarket!=null)inventoryMarket.open(player);}
            else if(slot==14){player.closeInventory();player.sendMessage("Only real merchant stock can be bought. Review and confirm the exact CITY amount in your own wallet.");}
        } else if (menu.page.equals("guide")) {
            if(slot==10) travel(player,"play"); else if(slot==22) travel(player,"museum"); else if(slot==24&&mumbai!=null) travel(player,"mumbai"); else { player.closeInventory(); help(player); }
        } else if(menu.page.equals("play")) {
            if(slot==11) travel(player,"play"); else if(slot==15) travel(player,"museum");
        }
    }
    @EventHandler(priority=EventPriority.HIGHEST) public void drag(InventoryDragEvent event) { if (event.getView().getTopInventory().getHolder() instanceof Menu) event.setCancelled(true); }

    private void help(Player player) {
        if(mumbai!=null){
            player.sendMessage(ChatColor.GOLD+"UniRock Mumbai: /mumbai, /lobby and /play return to the bank. /museum visits the calculator.");
            player.sendMessage("/agent 0g create | /agent agent create. Then choose status, inspect, capabilities, follow, come, wait, or a task.");
            player.sendMessage("Open your Marketplace compass or /market to choose materials, quantity and CITY total. Your own wallet confirms payment.");
            player.sendMessage("Your agents work in the two plots east of UniRock. The bank and generated city are protected.");
            return;
        }
        player.sendMessage(ChatColor.GOLD + "AgentCity: /play enters Survival, /lobby returns to the NPCs, /museum visits the old calculator.");
        if (mumbai != null) player.sendMessage("/mumbai visits the read-only South Mumbai map. Your inventory is retained.");
        player.sendMessage("/agent create | follow | come | wait | status | inspect | capabilities | release | task <request>");
        player.sendMessage("/agent build platform <width> <depth> [material] | /agent collect <item> <count> | /agent deliver <item> <count>");
        player.sendMessage("/jobs (supported catalog) | /wallet | /balance (CITY/GEM) | /market | /swap");
        player.sendMessage("Open Assets in Discord for item lots, equipment and CITY trades. /bazaar claim or cancel <listingId> recovers earlier escrow only.");
        player.sendMessage(ChatColor.GRAY + "The backend validates each request. A chat response is not proof a job or payment completed.");
    }

    public boolean handlesCommand(Player player,String raw) {
        if(discordAccess!=null&&discordAccess.isPending(player)){player.sendMessage("Approve this connection in Discord to play.");return true;}
        String[] parts = raw.trim().replaceFirst("^/", "").split("\\s+");
        String command = parts[0].toLowerCase(Locale.ROOT);
        if (!Set.of("agent","jobs","wallet","balance","pay","accept","play","lobby","museum","mumbai","sell","market","swap","bazaar","estate","assets").contains(command)) return false;
        if ((!player.getWorld().equals(world) && !player.getWorld().equals(lobbyWorld) && !player.getWorld().equals(playWorld)&&!player.getWorld().getName().equals(PropertyProtection.WORLD)&&(mumbai==null||!mumbai.contains(player.getWorld()))) || AGENTS.contains(player.getName()) || FIXTURES.contains(player.getName())) { player.sendMessage("Player actions are available to local human players in AgentCity worlds."); return true; }
        if (raw.length() > 1000) { player.sendMessage("That request is too long."); return true; }
        switch(command) {
            case "estate" -> {
                if(properties==null){player.sendMessage("The estate world is not enabled on this host.");break;}
                if(parts.length==1||parts.length==2&&parts[1].equalsIgnoreCase("ownership"))enqueue(player,"estate",List.of("ownership"));
                else if(parts.length==2&&parts[1].equalsIgnoreCase("visit"))properties.visitRoad(player);
                else if(parts.length==3&&parts[1].equalsIgnoreCase("visit")&&parts[2].matches("[1-4]")){try{properties.visit(Map.of("playerId",player.getUniqueId().toString(),"parcelId",Long.parseLong(parts[2])));}catch(Exception error){player.sendMessage("This parcel needs current verified ownership before you can enter. /estate visit reaches the public road.");}}
                else player.sendMessage("Use /estate ownership, /estate visit for the public road, or /estate visit <1..4> for your verified parcel.");
            }
            case "play","lobby","museum","mumbai" -> { if(parts.length==1) travel(player,command); else player.sendMessage("Use /"+command+"."); }
            case "agent" -> {
                if (parts.length == 1) { openMenu(player,"agents"); break; }
                String action = parts[1].toLowerCase(Locale.ROOT);
                if(mumbai!=null&&Set.of("0g","agent","claude").contains(action)){enqueue(player,"agent",List.of(String.join(" ",Arrays.copyOfRange(parts,1,parts.length))));break;}
                if (Set.of("create","follow","come","wait","status","inspect","capabilities","release").contains(action) && parts.length == 2) enqueue(player,"agent_"+action,List.of());
                else if (action.equals("task") && parts.length >= 3) enqueue(player,"agent_task",List.of(String.join(" ",Arrays.copyOfRange(parts,2,parts.length))));
                else if (action.equals("build") && parts.length>=4 && (parts[2].matches("[0-9]+") || parts.length>=5 && Set.of("platform","shelter").contains(parts[2]) && parts[3].matches("[0-9]+"))) enqueue(player,"agent_build",Arrays.asList(Arrays.copyOfRange(parts,2,parts.length)));
                else if(action.equals("sell")) player.sendMessage("Open Assets in Discord to review and confirm an on-chain listing from your agent inventory.");
                else if (Set.of("collect","deliver").contains(action) && parts.length==4 && parts[3].matches("[0-9]+")) enqueue(player,"agent_"+action,Arrays.asList(Arrays.copyOfRange(parts,2,parts.length)));
                else enqueue(player,"agent_task",List.of(String.join(" ",Arrays.copyOfRange(parts,1,parts.length))));
            }
            case "jobs" -> { if (parts.length == 1) {if(mumbai!=null)enqueue(player,"agent",List.of("agent capabilities"));else enqueue(player,"jobs",List.of());} else player.sendMessage("Use /jobs."); }
            case "wallet" -> { if(mumbai!=null)player.sendMessage("Open /market and review a purchase to connect your own wallet. Game login never grants spending permission.");else if(parts.length==1) enqueue(player,"crypto_wallet",List.of()); }
            case "balance" -> { if(mumbai!=null)player.sendMessage("Review your actual CITY balance in your connected wallet on Unichain Sepolia. /market opens the inventory shop.");else if(parts.length==1) enqueue(player,"crypto_wallet",List.of()); }
            case "bazaar" -> {
                String action=parts.length>1?parts[1].toLowerCase(Locale.ROOT):"";
                if(action.equals("cancel")&&parts.length==3&&parts[2].matches("[a-fA-F0-9-]{36}"))enqueue(player,"bazaar",List.of("cancel",parts[2]));
                else if(action.equals("claim")&&(parts.length==2||parts.length==3&&parts[2].matches("[a-fA-F0-9-]{36}")))enqueue(player,"bazaar",Arrays.asList(Arrays.copyOfRange(parts,1,parts.length)));
                else player.sendMessage("Open Assets in Discord for on-chain item trading with CITY. /bazaar claim and /bazaar cancel <listingId> are recovery-only commands for earlier escrow.");
            }
            case "market" -> {
                if(parts.length==1&&inventoryMarket!=null)inventoryMarket.open(player);
                else player.sendMessage("Use /market for wallet and Uniswap; open Assets in Discord to mint or trade resource lots and equipment with CITY.");
            }
            case "swap" -> {
                if(mumbai!=null){player.sendMessage("The CITY/GEM swap command is retired. Inventory shop payments use CITY on Unichain Sepolia. No swap was submitted.");break;}
                if(parts.length==4 && parts[1].matches("[0-9]+(?:\\.[0-9]{1,18})?") && parts[2].matches("(?i)CITY|GEM") && parts[3].matches("(?i)CITY|GEM"))enqueue(player,"crypto_swap",List.of(parts[1],parts[2].toUpperCase(Locale.ROOT),parts[3].toUpperCase(Locale.ROOT)));
                else if ((parts.length == 5 || parts.length == 6) && parts[1].equalsIgnoreCase("receive")
                        && parts[2].matches("[0-9]+(?:\\.[0-9]{1,18})?") && parts[3].matches("(?i)CITY|GEM")
                        && parts[4].matches("(?i)CITY|GEM") && (parts.length == 5 || parts[5].matches("[0-9]+(?:\\.[0-9]{1,18})?"))) {
                    List<String> request = new ArrayList<>(List.of("receive", parts[2], parts[3].toUpperCase(Locale.ROOT), parts[4].toUpperCase(Locale.ROOT)));
                    if (parts.length == 6) request.add(parts[5]);
                    enqueue(player, "crypto_swap", request);
                }
                else if(parts.length==3 && Set.of("confirm","retry").contains(parts[1].toLowerCase(Locale.ROOT)) && parts[2].matches("[a-fA-F0-9-]{36}"))enqueue(player,"crypto_swap",List.of(parts[1].toLowerCase(Locale.ROOT),parts[2]));
                else player.sendMessage("Use /swap <input amount> CITY GEM, /swap receive <output amount> GEM CITY [maximum input], /swap confirm <id>, or /swap retry <id>.");
            }
            case "pay","accept","sell","assets" -> player.sendMessage("Open Assets or Wallet in Discord to review and confirm on-chain CITY transactions. No transaction was submitted.");
            default -> throw new IllegalStateException("unhandled_playable_command");
        }
        return true;
    }

    @EventHandler(priority=EventPriority.HIGHEST,ignoreCancelled=true)
    public void agentChat(AsyncPlayerChatEvent event) {
        if(event.isCancelled())return;
        String message=event.getMessage();
        if(!message.matches("(?is)^@agent(?:\\s|:).*"))return;
        event.setCancelled(true);
        String request=message.replaceFirst("(?i)^@agent[\\s:]+","").trim();
        Bukkit.getScheduler().runTask(plugin,()->{if(!request.isEmpty()&&event.getPlayer().isOnline())handlesCommand(event.getPlayer(),"/agent task "+request);});
    }

    private static Map<String,Object> event(String id,String player,String name,String action,List<String> args,long created) {
        Map<String,Object> value = new LinkedHashMap<>();
        value.put("operationId",id); value.put("playerId",player); value.put("playerName",name);
        value.put("action",action); value.put("args",List.copyOf(args)); value.put("createdAtMs",created);
        return Collections.unmodifiableMap(value);
    }

    private synchronized String enqueue(Player player,String action,List<String> args) {
        if (!available) { player.sendMessage("The playable request queue is unavailable. Your request was not sent."); return null; }
        long now = System.currentTimeMillis();
        if (now-recentRequests.getOrDefault(player.getUniqueId(),0L) < 500) { player.sendMessage("Please wait a moment before another request."); return null; }
        long queued = events.values().stream().filter(value -> value.get("playerId").equals(player.getUniqueId().toString())).count();
        if (events.size() >= 256 || queued >= 16) { player.sendMessage("Your request queue is full. Wait for the current actions to finish."); return null; }
        String id = UUID.randomUUID().toString();
        Map<String,Object> attributedEvent=new LinkedHashMap<>(event(id,player.getUniqueId().toString(),player.getName(),action,args,now));
        attributedEvent.put("connectionId",connections.getOrDefault(player.getUniqueId(),""));
        events.put(id,Collections.unmodifiableMap(attributedEvent));
        try { persist(); recentRequests.put(player.getUniqueId(),now); player.sendMessage(ChatColor.GRAY + "Request queued: " + action + " (" + id.substring(0,8) + ")."); }
        catch (IOException error) { events.remove(id); available=false; player.sendMessage("The request could not be safely saved. Service paused for operator review."); plugin.getLogger().severe("Playable queue persistence failed."); return null; }
        return id;
    }

    public Map<String,Object> inventoryShopReply(Map<String,Object> input){
        String id=(String)input.get("operationId");UUID.fromString(id);
        if(!(input.get("result") instanceof Map<?,?> result))throw new IllegalArgumentException("inventory_shop_result_required");
        @SuppressWarnings("unchecked") Map<String,Object> value=(Map<String,Object>)result;
        boolean shown=inventoryMarket!=null&&inventoryMarket.complete(id,value);
        acknowledge(id,shown?"Marketplace updated.":"Marketplace request finished; reopen /market to continue.");
        return Map.of("ok",true,"shown",shown);
    }
    public synchronized List<Map<String,Object>> pendingEvents() { return available ? events.values().stream().filter(this::dispatchable).toList() : List.of(); }
    private boolean dispatchable(Map<String,Object> value){
        if(!EconomyMode.onchainOnly(plugin))return true;
        String action=(String)value.get("action");if(Set.of("balance","pay","accept","sell","agent_sell","crypto_sell","join","starter","coin_starter").contains(action))return false;
        if(action.equals("bazaar")){Object args=value.get("args");return args instanceof List<?> values&&!values.isEmpty()&&Set.of("cancel","claim").contains(values.get(0));}return true;
    }

    @EventHandler public void left(PlayerQuitEvent event) { connections.remove(event.getPlayer().getUniqueId()); cityArrivals.remove(event.getPlayer().getUniqueId()); }

    public Map<String,Object> connection(UUID playerId) {
        if(!Bukkit.isPrimaryThread())throw new IllegalStateException("session_main_thread");
        Player player=Bukkit.getPlayer(playerId);String connection=connections.get(playerId);
        if(player==null||!player.isOnline()||connection==null)return Map.of("online",false,"playerId",playerId.toString());
        Map<String,Object> value=new LinkedHashMap<>(Map.of("online",true,"playerId",playerId.toString(),"connectionId",connection));
        if(discordAccess!=null)value.putAll(discordAccess.enrich(player,connection));
        return Collections.unmodifiableMap(value);
    }
    public DiscordGameAccess discordAccess(){if(!Bukkit.isPrimaryThread())throw new IllegalStateException("discord_access_main_thread");return discordAccess;}

    public synchronized void acknowledge(String operationId,String message) {
        UUID.fromString(operationId);
        Map<String,Object> event = events.remove(operationId);
        if (event == null) return;
        try { persist(); }
        catch (IOException error) { events.put(operationId,event); available=false; throw new IllegalStateException("playable_ack_persistence_failed",error); }
        UUID playerId = UUID.fromString((String)event.get("playerId"));
        String safe = Objects.requireNonNullElse(message,"Request processed.").replaceAll("[\\p{Cntrl}&&[^\\n]]","");
        if (safe.length() > 2000) safe = safe.substring(0,2000);
        final String reply = safe;
        Bukkit.getScheduler().runTask(plugin,() -> { Player player=Bukkit.getPlayer(playerId); if(player!=null)player.sendMessage(ChatColor.AQUA + reply); });
    }

    public synchronized Map<String,Object> status() {
        Map<String,Object> value=new LinkedHashMap<>();
        value.put("available",available); value.put("hubInitialized",lobbyInitialized); value.put("safetyExitInitialized",lobbyInitialized);
        value.put("economyMode",EconomyMode.onchainOnly(plugin)?"ONCHAIN_ONLY":"LEGACY_FIXTURE_ONLY"); value.put("retiredPendingRequests",events.values().stream().filter(event->!dispatchable(event)).count()); value.put("onboardedPlayers",onboarded.size()); value.put("pendingRequests",events.size()); value.put("npcCount",5);
        value.put("currency","CITY"); value.put("blockchainLinked",true);
        value.put("lobbyWorld",lobbyWorld.getName()); value.put("playWorld",playWorld.getName()); value.put("museumWorld",world.getName());
        if (mumbai != null) {
            value.put("mumbai", mumbai.status()); value.put("defaultWorld",MumbaiWorld.NAME);
            value.put("mumbaiAgentSpawn",Map.of("x",1698.5,"y",69,"z",2815.5));
            value.put("mumbaiAgentBounds",mumbai.bounds());
        }
        value.put("playSpawn",Map.of("x",playX+0.5,"y",playY,"z",playZ+0.5));
        value.put("taskBounds",Map.of("min",Map.of("x",playX-48,"y",playY,"z",playZ-48),"max",Map.of("x",playX+48,"y",playY+20,"z",playZ+48)));
        value.put("taskRegions",taskRegions()); value.put("taskPadsInitialized",taskPadsInitialized);
        value.put("personalAgentCapacity",mumbai!=null?5:3); value.put("initializedTaskPads",initializedTaskPads+(mumbaiPadsInitialized?2:0));
        value.put("taskMaterialGrants","One time per slot: 128 oak planks and 64 cobblestone; disclosed local fixture stock, not token backing.");
        return Collections.unmodifiableMap(value);
    }
}

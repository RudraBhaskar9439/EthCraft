package org.agentcity.paper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.function.Predicate;
import java.util.function.BiPredicate;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.Difficulty;
import org.bukkit.GameMode;
import org.bukkit.GameRule;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.WorldCreator;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockExplodeEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.entity.EntityChangeBlockEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.EntityExplodeEvent;
import org.bukkit.event.entity.EntityPickupItemEvent;
import org.bukkit.event.hanging.HangingBreakEvent;
import org.bukkit.event.inventory.InventoryOpenEvent;
import org.bukkit.event.player.PlayerChangedWorldEvent;
import org.bukkit.event.player.PlayerDropItemEvent;
import org.bukkit.event.player.PlayerInteractEntityEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.plugin.java.JavaPlugin;

/** Mumbai city hub. Generated scenery stays protected and never becomes task stock or backing. */
final class MumbaiWorld implements Listener {
    static final String NAME = "agentcity_mumbai";

    record Point(int x, int y, int z) {}
    record Config(UUID worldUuid, Point spawn, Point min, Point max, int yaw) {
        static Config parse(String text) {
            Map<String,Object> value = StrictJson.object(text);
            if (!Set.of("schema", "world", "worldUuid", "spawn", "bounds", "yaw").containsAll(value.keySet())
                    || !"agentcity.mumbai-world.v1".equals(value.get("schema")) || !NAME.equals(value.get("world"))) {
                throw new IllegalArgumentException("mumbai_config_schema");
            }
            UUID uuid;
            try { uuid = UUID.fromString((String)value.get("worldUuid")); }
            catch (RuntimeException error) { throw new IllegalArgumentException("mumbai_world_uuid"); }
            Point spawn = point(value.get("spawn"));
            if (!(value.get("bounds") instanceof Map<?,?> bounds) || !bounds.keySet().equals(Set.of("min", "max"))) {
                throw new IllegalArgumentException("mumbai_bounds");
            }
            Point min = point(bounds.get("min")), max = point(bounds.get("max"));
            if (min.x < 0 || min.z < 0 || max.x > 4096 || max.z > 4096 || max.x <= min.x || max.z <= min.z || max.x - min.x > 4096
                    || max.z - min.z > 4096 || min.y < -64 || max.y > 319 || max.y <= min.y
                    || spawn.x < min.x || spawn.x > max.x || spawn.z < min.z || spawn.z > max.z
                    || spawn.y <= min.y || spawn.y >= max.y) throw new IllegalArgumentException("mumbai_bounds");
            Object rawYaw = value.getOrDefault("yaw", 0L);
            if (!(rawYaw instanceof Long yaw) || yaw < -180 || yaw > 180) throw new IllegalArgumentException("mumbai_yaw");
            return new Config(uuid, spawn, min, max, yaw.intValue());
        }

        private static Point point(Object value) {
            if (!(value instanceof List<?> list) || list.size() != 3 || list.stream().anyMatch(n -> !(n instanceof Long))) {
                throw new IllegalArgumentException("mumbai_integer_point");
            }
            try { return new Point(Math.toIntExact((Long)list.get(0)), Math.toIntExact((Long)list.get(1)), Math.toIntExact((Long)list.get(2))); }
            catch (ArithmeticException error) { throw new IllegalArgumentException("mumbai_point_range"); }
        }
    }

    private final World world;
    private final Config config;
    private final Location spawn;
    private UniRockBank bank;
    private Predicate<Inventory> ownedInventory=inventory->false;
    private Predicate<Entity> ownedNpc=entity->false;
    private Predicate<Player> authorizedAgent=player->false;
    private Predicate<Player> approvedHuman=player->false;
    private BiPredicate<Player,Location> ownedContainer=(player,at)->false;
    private BiPredicate<Player,Location> ownedBuild=(player,at)->false;

    private MumbaiWorld(World world, Config config) {
        this.world = world;
        this.config = config;
        this.spawn = new Location(world, config.spawn.x + 0.5, config.spawn.y, config.spawn.z + 0.5, config.yaw, 0);
    }

    static MumbaiWorld load(JavaPlugin plugin) throws IOException {
        Path file = plugin.getDataFolder().toPath().resolve("mumbai-world.json");
        if (!Files.exists(file)) return null;
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) throw new IllegalArgumentException("mumbai_config_file");
        Config config = Config.parse(Files.readString(file));
        MumbaiWorldStorage.verify(Bukkit.getWorldContainer().toPath(), config.worldUuid);
        World existing = Bukkit.getWorld(config.worldUuid);
        if (existing != null && !existing.getName().equals(NAME)) throw new IllegalArgumentException("mumbai_world_uuid_collision");
        World loaded = Bukkit.createWorld(new WorldCreator(NAME).generateStructures(false));
        if (loaded == null || !loaded.getUID().equals(config.worldUuid)) throw new IllegalArgumentException("mumbai_world_identity");
        MumbaiWorld result = new MumbaiWorld(loaded, config);
        if (!result.safeSpawn()) throw new IllegalArgumentException("mumbai_safe_spawn_required");
        loaded.setKeepSpawnInMemory(false);
        loaded.setViewDistance(8);
        loaded.setSimulationDistance(2);
        loaded.setDifficulty(Difficulty.NORMAL);
        loaded.setPVP(false);
        loaded.setGameRule(GameRule.DO_DAYLIGHT_CYCLE, true);
        loaded.setGameRule(GameRule.DO_WEATHER_CYCLE, true);
        loaded.setGameRule(GameRule.DO_MOB_SPAWNING, true);
        loaded.setGameRule(GameRule.MOB_GRIEFING, true);
        loaded.setGameRule(GameRule.DO_FIRE_TICK, true);
        loaded.setGameRule(GameRule.DO_TILE_DROPS, true);
        loaded.setGameRule(GameRule.DO_ENTITY_DROPS, true);
        loaded.setGameRule(GameRule.RANDOM_TICK_SPEED, 3);
        loaded.getWorldBorder().setCenter((config.min.x + config.max.x + 1) / 2.0, (config.min.z + config.max.z + 1) / 2.0);
        loaded.getWorldBorder().setSize(Math.max(config.max.x - config.min.x + 1, config.max.z - config.min.z + 1));
        try { result.bank=UniRockBank.prepare(plugin,loaded); }
        catch(IOException error) { throw error; }
        catch(Exception error) { throw new IllegalArgumentException("unirock_bank_prepare_failed",error); }
        loaded.setSpawnLocation(result.hubSpawn());
        Bukkit.getPluginManager().registerEvents(result, plugin);
        return result;
    }

    private boolean safeSpawn() {
        Location feet = spawn.clone();
        return feet.getY() > world.getMinHeight() && feet.getY() + 1 < world.getMaxHeight()
                && feet.clone().subtract(0, 1, 0).getBlock().getType().isSolid()
                && feet.getBlock().isPassable() && !feet.getBlock().isLiquid()
                && feet.clone().add(0, 1, 0).getBlock().isPassable() && !feet.clone().add(0, 1, 0).getBlock().isLiquid();
    }

    boolean contains(World value) { return world.equals(value); }
    World world() { return world; }
    Map<String,Object> bounds() { return Map.of("min",Map.of("x",config.min.x,"y",world.getMinHeight(),"z",config.min.z),"max",Map.of("x",config.max.x,"y",world.getMaxHeight()-1,"z",config.max.z)); }
    Location hubSpawn() {
        Location target=bank==null?spawn.clone():bank.spawn();
        if(walkable(target))return target;
        for(int radius=1;radius<=8;radius++)for(int x=-radius;x<=radius;x++)for(int z=-radius;z<=radius;z++)if(Math.abs(x)==radius||Math.abs(z)==radius){Location candidate=target.clone().add(x,0,z);if(walkable(candidate))return candidate;}
        return target;
    }
    private static boolean walkable(Location at){return at.clone().subtract(0,1,0).getBlock().getType().isSolid()&&at.getBlock().isPassable()&&at.clone().add(0,1,0).getBlock().isPassable()&&!at.getBlock().isLiquid();}
    boolean inBank(Location location) { return bank!=null&&bank.contains(location); }
    Location npcLocation(String key) { if(bank==null)throw new IllegalStateException("unirock_bank_unavailable");return bank.npcLocation(key); }
    Map<String,Location> agentDisplayLocations() { return bank==null?Map.of():bank.agentDisplayLocations(); }
    void controls(Predicate<Inventory> inventories,Predicate<Entity> npcs,Predicate<Player> agents,Predicate<Player> humans,
                  BiPredicate<Player,Location> containers,BiPredicate<Player,Location> builds) {
        ownedInventory=Objects.requireNonNull(inventories);ownedNpc=Objects.requireNonNull(npcs);authorizedAgent=Objects.requireNonNull(agents);approvedHuman=Objects.requireNonNull(humans);
        ownedContainer=Objects.requireNonNull(containers);ownedBuild=Objects.requireNonNull(builds);
    }
    static GameMode arrivalMode(boolean human,boolean agent) { return human||agent?GameMode.SURVIVAL:GameMode.ADVENTURE; }
    private boolean workEffect(Player player,Location at) {
        return at!=null&&contains(at.getWorld())&&authorizedAgent.test(player);
    }
    private boolean humanBuild(Player player,Location at) {
        return at!=null&&contains(at.getWorld())&&approvedHuman.test(player);
    }
    private boolean humanContainer(Player player,Location at) {
        return at!=null&&contains(at.getWorld())&&approvedHuman.test(player);
    }

    void visit(Player player) {
        Location target=hubSpawn();
        if (!target.clone().subtract(0,1,0).getBlock().getType().isSolid()||!target.getBlock().isPassable()||!target.clone().add(0,1,0).getBlock().isPassable()) {
            player.sendMessage("The Mumbai arrival area needs operator review. Your inventory was not changed.");return;
        }
        GameMode before = player.getGameMode();
        player.closeInventory();
        player.setOp(false);
        player.setGameMode(arrivalMode(approvedHuman.test(player),authorizedAgent.test(player)));
        if (player.teleport(target)) {
            player.sendMessage(ChatColor.GREEN + "Welcome to UniRock, AgentCity's South Mumbai bank and agent hub. Click the staffed desks inside; /lobby returns here.");
            player.sendMessage(ChatColor.GRAY + "Generated with Arnis. Map data © OpenStreetMap contributors (ODbL); elevation: Mapterhorn. This is an approximation of the city.");
        }
        else { player.setGameMode(before); player.sendMessage("Mumbai travel did not complete. Your inventory was not changed."); }
    }

    Map<String,Object> status() {
        Location at=hubSpawn();
        return Map.of("ready",true,"world",NAME,"worldUuid",world.getUID().toString(),"readOnly",false,"survival",true,"bounds",bounds(),
            "spawn",List.of(at.getBlockX(),at.getBlockY(),at.getBlockZ()),"command","/mumbai","bank",bank.status());
    }

    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true) public void enter(PlayerChangedWorldEvent e) { if (contains(e.getPlayer().getWorld())) e.getPlayer().setGameMode(arrivalMode(approvedHuman.test(e.getPlayer()),authorizedAgent.test(e.getPlayer()))); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true) public void breakBlock(BlockBreakEvent e) { if (contains(e.getBlock().getWorld())&&!workEffect(e.getPlayer(),e.getBlock().getLocation())&&!humanBuild(e.getPlayer(),e.getBlock().getLocation())) e.setCancelled(true); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true) public void placeBlock(BlockPlaceEvent e) { if (contains(e.getBlock().getWorld())&&!workEffect(e.getPlayer(),e.getBlock().getLocation())&&!humanBuild(e.getPlayer(),e.getBlock().getLocation())) e.setCancelled(true); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true) public void damage(EntityDamageEvent e) { if (contains(e.getEntity().getWorld())&&(ownedNpc.test(e.getEntity())||e.getEntity() instanceof Player player&&!approvedHuman.test(player)&&!authorizedAgent.test(player))) e.setCancelled(true); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true) public void pickup(EntityPickupItemEvent e) { if (contains(e.getEntity().getWorld())&&(!(e.getEntity() instanceof Player player)||!workEffect(player,e.getItem().getLocation())&&!humanBuild(player,e.getItem().getLocation()))) e.setCancelled(true); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true) public void drop(PlayerDropItemEvent e) { if (contains(e.getPlayer().getWorld())&&!workEffect(e.getPlayer(),e.getItemDrop().getLocation())&&!humanBuild(e.getPlayer(),e.getItemDrop().getLocation())) e.setCancelled(true); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true) public void interact(PlayerInteractEvent e) {
        if(!contains(e.getPlayer().getWorld()))return;
        if(approvedHuman.test(e.getPlayer())||authorizedAgent.test(e.getPlayer()))return;
        if(e.getClickedBlock()==null){e.setCancelled(true);return;}
        Location at=e.getClickedBlock().getLocation(),target=e.getClickedBlock().getRelative(e.getBlockFace()).getLocation();
        if(!workEffect(e.getPlayer(),at)&&!workEffect(e.getPlayer(),target)&&!humanContainer(e.getPlayer(),at)
            &&!humanBuild(e.getPlayer(),at)&&!humanBuild(e.getPlayer(),target))e.setCancelled(true);
    }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true) public void interact(PlayerInteractEntityEvent e) { if (contains(e.getPlayer().getWorld())&&!approvedHuman.test(e.getPlayer())&&!ownedNpc.test(e.getRightClicked())) e.setCancelled(true); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true) public void inventory(InventoryOpenEvent e) { if (contains(e.getPlayer().getWorld())&&!ownedInventory.test(e.getInventory())&&!(e.getPlayer() instanceof Player player&&(approvedHuman.test(player)||workEffect(player,e.getInventory().getLocation())))) e.setCancelled(true); }
    @EventHandler(priority=EventPriority.HIGHEST, ignoreCancelled=true) public void boundary(PlayerMoveEvent e) {
        Location to = e.getTo();
        if (to != null && contains(to.getWorld()) && (to.getX() < config.min.x || to.getX() >= config.max.x + 1
                || to.getZ() < config.min.z || to.getZ() >= config.max.z + 1)) e.setCancelled(true);
    }
}

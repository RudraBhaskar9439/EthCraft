package org.agentcity.construction.fixture;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import org.bukkit.*;
import org.bukkit.block.Chest;
import org.bukkit.entity.Player;
import org.bukkit.event.*;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.java.JavaPlugin;

/** Bootstrap stock and fixed access only; runtime writes are observations, never construction. */
public final class ConstructionFixture extends JavaPlugin implements Listener {
    private static final Gson JSON = new Gson();
    private static final Set<String> NAMES = Set.of("WorldBuilder", "WorldRequester", "WorldInspector");
    private final ExecutorService writer = Executors.newSingleThreadExecutor();
    private final Path root = Path.of(".");
    private World world;
    private int[] min, max, chest, origin, reserve;
    private long tick;
    private volatile boolean failed;

    @Override public void onEnable() {
        try {
            if (!Boolean.getBoolean("agentcity.localFixture")) throw new IllegalStateException("local_fixture_required");
            JsonObject plan = JSON.fromJson(Files.readString(root.resolve("construction-fixture.json")), JsonObject.class);
            if (!plan.get("purpose").getAsString().equals("isolated_non_token_p2_construction")) throw new IllegalArgumentException("fixture_purpose");
            JsonObject deployment = plan.getAsJsonObject("deployment");
            world = Bukkit.getWorld(deployment.get("world").getAsString());
            if (world == null) throw new IllegalStateException("fixture_world_missing");
            min = xyz(deployment.getAsJsonArray("plotMin")); max = xyz(deployment.getAsJsonArray("plotMax"));
            chest = xyz(deployment.getAsJsonArray("chest")); origin = new int[]{min[0] + 4, min[1] + 1, min[2] + 4};
            if (Files.exists(root.resolve("fixture-initialized"))) throw new IllegalStateException("fresh_world_required");
            for (int x = min[0] - 2; x <= max[0] + 2; x++) for (int z = min[2] - 2; z <= max[2] + 2; z++) {
                world.getBlockAt(x, min[1], z).setType(Material.STONE, false);
                for (int y = min[1] + 1; y <= max[1]; y++) world.getBlockAt(x, y, z).setType(Material.AIR, false);
            }
            JsonObject access = JSON.fromJson(Files.readString(root.resolve("plugins/AgentCity/construction-access.json")), JsonObject.class);
            for (JsonElement value : access.getAsJsonArray("positions")) {
                int[] p = xyz(value.getAsJsonArray());
                world.getBlockAt(origin[0] + p[0], origin[1] + p[1], origin[2] + p[2]).setType(Material.GLASS, false);
            }
            for (JsonElement value : access.getAsJsonArray("bottom_slabs")) {
                int[] p = xyz(value.getAsJsonArray());
                world.getBlockAt(origin[0] + p[0], origin[1] + p[1], origin[2] + p[2]).setBlockData(Bukkit.createBlockData("minecraft:stone_slab[type=bottom,waterlogged=false]"), false);
            }
            world.getBlockAt(chest[0], chest[1], chest[2]).setBlockData(Bukkit.createBlockData("minecraft:chest[facing=north,type=single,waterlogged=false]"), false);
            Chest stock = (Chest) world.getBlockAt(chest[0], chest[1], chest[2]).getState();
            stock.getBlockInventory().clear();
            for (var entry : plan.getAsJsonObject("material_bill").entrySet()) {
                Material material = Material.matchMaterial(entry.getKey());
                if (material == null || !stock.getBlockInventory().addItem(new ItemStack(material, entry.getValue().getAsInt())).isEmpty()) throw new IllegalStateException("stock_capacity_or_material");
            }
            if (!plan.get("operator_reserve_chest").isJsonNull()) {
                reserve = xyz(plan.getAsJsonArray("operator_reserve_chest"));
                world.getBlockAt(reserve[0], reserve[1], reserve[2]).setBlockData(Bukkit.createBlockData("minecraft:chest[facing=north,type=single,waterlogged=false]"), false);
                Chest held = (Chest) world.getBlockAt(reserve[0], reserve[1], reserve[2]).getState();
                held.getBlockInventory().clear();
                for (var entry : plan.getAsJsonObject("withheld_stock").entrySet()) {
                    Material material = Material.matchMaterial(entry.getKey());
                    if (material == null || !held.getBlockInventory().addItem(new ItemStack(material, entry.getValue().getAsInt())).isEmpty()) throw new IllegalStateException("reserve_capacity_or_material");
                }
            }
            if (!plan.get("occupied_target_relative").isJsonNull()) {
                int[] target = xyz(plan.getAsJsonArray("occupied_target_relative"));
                world.getBlockAt(origin[0] + target[0], origin[1] + target[1], origin[2] + target[2]).setType(Material.GLASS, false);
            }
            world.setSpawnLocation(-15, 81, 3); world.setTime(6000); world.setStorm(false); world.save();
            Files.writeString(root.resolve("fixture-initialized"), plan.get("run_id").getAsString() + "\n", StandardOpenOption.CREATE_NEW);
            getServer().getPluginManager().registerEvents(this, this);
            Bukkit.getScheduler().runTaskTimer(this, () -> { tick++; if (tick % 5 == 0) snapshot(); }, 1, 1);
        } catch (Exception error) { fail(error); }
    }

    private static int[] xyz(JsonArray a) { return new int[]{a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()}; }
    private void fail(Exception error) { failed = true; getLogger().severe("Construction fixture failed: " + error); getServer().shutdown(); }
    private static Map<String,Integer> counts(ItemStack[] items) {
        Map<String,Integer> result = new TreeMap<>();
        for (ItemStack item : items) if (item != null && !item.getType().isAir()) result.merge(item.getType().getKey().toString(), item.getAmount(), Integer::sum);
        return result;
    }
    @EventHandler public void join(PlayerJoinEvent event) {
        Player player = event.getPlayer();
        if (!NAMES.contains(player.getName())) { player.kickPlayer("Local construction fixture identities only"); return; }
        player.setOp(false); player.setGameMode(GameMode.SURVIVAL); player.setFoodLevel(20); player.setSaturation(20);
        try {
            Path marker = root.resolve("fixture-player-" + player.getUniqueId());
            if (!Files.exists(marker)) {
                player.getInventory().clear();
                Location spawn = switch (player.getName()) {
                    case "WorldBuilder" -> new Location(world, -14.5, 81, 3.5);
                    case "WorldRequester" -> new Location(world, 12.5, 81, 5.5);
                    default -> new Location(world, 12.5, 81, -6.5);
                };
                player.teleport(spawn);
                Files.writeString(marker, player.getName() + "\n", StandardOpenOption.CREATE_NEW);
            }
        } catch (Exception error) { fail(error); }
    }
    private void snapshot() {
        if (failed) return;
        Map<String,Object> value = new TreeMap<>();
        value.put("tick", tick); value.put("observed_at_ms", System.currentTimeMillis());
        Map<String,String> blocks = new TreeMap<>();
        for (int x = min[0]; x <= max[0]; x++) for (int y = min[1]; y <= max[1]; y++) for (int z = min[2]; z <= max[2]; z++) {
            var block = world.getBlockAt(x, y, z);
            if (!block.isEmpty()) blocks.put(x + "," + y + "," + z, block.getBlockData().getAsString());
        }
        value.put("blocks", blocks);
        if (world.getBlockAt(chest[0], chest[1], chest[2]).getState() instanceof Chest stock) value.put("stock", counts(stock.getBlockInventory().getContents()));
        else value.put("stock_error", "missing_stock_chest");
        if (reserve != null && world.getBlockAt(reserve[0], reserve[1], reserve[2]).getState() instanceof Chest held) value.put("operator_reserve", counts(held.getBlockInventory().getContents()));
        else value.put("operator_reserve", Map.of());
        Map<String,Object> players = new TreeMap<>();
        for (Player player : Bukkit.getOnlinePlayers()) if (NAMES.contains(player.getName())) players.put(player.getName(), Map.of("uuid", player.getUniqueId().toString(), "mode", player.getGameMode().name(), "items", counts(player.getInventory().getContents()), "position", List.of(player.getX(), player.getY(), player.getZ())));
        value.put("players", players);
        String encoded = JSON.toJson(value) + "\n";
        writer.execute(() -> { try { Path temp = root.resolve("construction-observation.tmp"); Files.writeString(temp, encoded); Files.move(temp, root.resolve("construction-observation.json"), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); } catch (Exception error) { failed = true; getLogger().severe("Observation write failed: " + error); } });
    }
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = false) public void place(BlockPlaceEvent event) {
        Map<String,Object> row = Map.of("event", "native_place", "tick", tick, "actor", event.getPlayer().getUniqueId().toString(), "position", List.of(event.getBlock().getX(), event.getBlock().getY(), event.getBlock().getZ()), "state", event.getBlock().getBlockData().getAsString(), "cancelled", event.isCancelled());
        String encoded = JSON.toJson(row) + "\n";
        writer.execute(() -> { try { Files.writeString(root.resolve("construction-events.jsonl"), encoded, StandardOpenOption.CREATE, StandardOpenOption.APPEND); } catch (Exception error) { failed = true; getLogger().severe("Event retention failed: " + error); } });
    }
    @Override public void onDisable() { writer.shutdown(); try { writer.awaitTermination(10, TimeUnit.SECONDS); } catch (InterruptedException error) { Thread.currentThread().interrupt(); } }
}

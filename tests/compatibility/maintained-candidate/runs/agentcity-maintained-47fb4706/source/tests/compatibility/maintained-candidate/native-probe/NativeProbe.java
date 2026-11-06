package org.agentcity.maintained.fixture;

import com.google.gson.Gson;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.Location;
import org.bukkit.event.Listener;
import org.bukkit.event.EventHandler;
import org.spigotmc.event.player.PlayerSpawnLocationEvent;
import org.bukkit.block.Block;
import org.bukkit.block.data.Powerable;
import org.bukkit.plugin.Plugin;
import org.bukkit.plugin.java.JavaPlugin;

/** Invoke the unchanged plugin's actual native lever path outside the circuit plot. */
public final class NativeProbe extends JavaPlugin implements Listener {
    @Override public void onEnable() {
        Bukkit.getPluginManager().registerEvents(this, this);
        Bukkit.getScheduler().runTaskLater(this, () -> {
            Map<String,Object> report = new LinkedHashMap<>();
            report.put("status", "fail");
            report.put("server", Bukkit.getVersion());
            Block floor = Bukkit.getWorlds().getFirst().getBlockAt(22, 80, 5);
            Block lever = floor.getRelative(0, 1, 0);
            var oldFloor = floor.getBlockData();
            var oldLever = lever.getBlockData();
            try {
                if (!Boolean.getBoolean("agentcity.localFixture")) throw new IllegalStateException("local_fixture_required");
                floor.setType(Material.STONE, false);
                lever.setBlockData(Bukkit.createBlockData("minecraft:lever[face=floor,facing=north,powered=false]"), false);
                Plugin plugin = Bukkit.getPluginManager().getPlugin("AgentCity");
                if (plugin == null || !plugin.isEnabled()) throw new IllegalStateException("agentcity_not_enabled");
                Class<?> nativeLever = Class.forName("org.agentcity.paper.NativeLever", true, plugin.getClass().getClassLoader());
                var set = nativeLever.getDeclaredMethod("set", Block.class, boolean.class);
                set.setAccessible(true);
                set.invoke(null, lever, true);
                if (!((Powerable) lever.getBlockData()).isPowered()) throw new IllegalStateException("native_power_on_failed");
                set.invoke(null, lever, false);
                if (((Powerable) lever.getBlockData()).isPowered()) throw new IllegalStateException("native_power_off_failed");
                report.put("status", "pass");
                report.put("path", "candidate AgentCity NativeLever.set true then false");
            } catch (Throwable error) {
                Throwable cause = error;
                while (cause.getCause() != null) cause = cause.getCause();
                report.put("error", cause.getClass().getName() + ": " + cause.getMessage());
            } finally {
                lever.setBlockData(oldLever, false);
                floor.setBlockData(oldFloor, false);
                report.put("outside_plot_probe_restored", true);
                try { Files.writeString(Path.of("maintained-native-probe.json"), new Gson().toJson(report) + "\n"); }
                catch (Exception error) { getLogger().severe("Cannot retain native probe: " + error.getClass().getName()); }
            }
        }, 60L);
    }

    @EventHandler public void spawn(PlayerSpawnLocationEvent event) {
        if (!Boolean.getBoolean("agentcity.localFixture")) return;
        var world = event.getSpawnLocation().getWorld();
        if (world == null || !world.getName().startsWith("agentcity-maintained-")) return;
        Location target = switch (event.getPlayer().getName()) {
            case "WorldBuilder" -> new Location(world, -14.5, 81, 3.5);
            case "WorldRequester" -> new Location(world, 12.5, 81, 5.5);
            case "WorldInspector" -> new Location(world, 12.5, 81, -6.5);
            default -> null;
        };
        if (target != null) event.setSpawnLocation(target);
    }
}

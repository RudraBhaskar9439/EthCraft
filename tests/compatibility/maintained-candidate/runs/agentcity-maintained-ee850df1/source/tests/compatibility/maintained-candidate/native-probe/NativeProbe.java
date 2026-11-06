package org.agentcity.maintained.fixture;

import com.google.gson.Gson;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.lang.reflect.Modifier;
import java.nio.file.StandardOpenOption;
import io.netty.channel.Channel;
import io.netty.channel.ChannelInboundHandlerAdapter;
import io.netty.channel.ChannelHandlerContext;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.event.Listener;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.craftbukkit.entity.CraftPlayer;
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

    private static Object field(Object target, String name) throws Exception {
        for (Class<?> type = target.getClass(); type != null; type = type.getSuperclass()) {
            try { var value = type.getDeclaredField(name); value.setAccessible(true); return value.get(target); }
            catch (NoSuchFieldException ignored) { }
        }
        throw new NoSuchFieldException(name);
    }

    private synchronized void decoded(Map<String,Object> row) {
        try { Files.writeString(Path.of("decoded-movement.jsonl"), new Gson().toJson(row) + "\n", StandardOpenOption.CREATE, StandardOpenOption.APPEND); }
        catch (Exception ignored) { }
    }

    @EventHandler(priority=EventPriority.LOWEST) public void movement(PlayerJoinEvent event) {
        if (!Boolean.getBoolean("agentcity.localFixture")) return;
        try {
            Object player = ((CraftPlayer) event.getPlayer()).getHandle();
            Channel channel = (Channel) field(field(field(player, "connection"), "connection"), "channel");
            channel.eventLoop().execute(() -> {
                channel.pipeline().addBefore("packet_handler", "agentcity-candidate-readonly-movement", new ChannelInboundHandlerAdapter() {
                    private int count;
                    @Override public void channelRead(ChannelHandlerContext context, Object packet) throws Exception {
                        String type = packet.getClass().getName();
                        if (count < 16 && (type.contains("ServerboundMovePlayerPacket") || type.contains("ServerboundAcceptTeleportationPacket") || type.contains("ServerboundClientTickEndPacket"))) {
                            count++;
                            Map<String,Object> values = new LinkedHashMap<>();
                            for (Class<?> parent = packet.getClass(); parent != null; parent = parent.getSuperclass()) {
                                for (var member : parent.getDeclaredFields()) {
                                    if (Modifier.isStatic(member.getModifiers())) continue;
                                    member.setAccessible(true);
                                    values.put(member.getName(), String.valueOf(member.get(packet)));
                                }
                            }
                            decoded(Map.of("player", event.getPlayer().getName(), "packet", type, "fields", values));
                        }
                        super.channelRead(context, packet);
                    }
                });
            });
        } catch (Exception error) { decoded(Map.of("setup_error", error.getClass().getName() + ": " + error.getMessage())); }
    }
}

package org.agentcity.compat;

import java.util.Set;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.block.Chest;
import org.bukkit.block.data.FaceAttachable;
import org.bukkit.block.data.Lightable;
import org.bukkit.block.data.Powerable;
import org.bukkit.block.data.type.RedstoneWire;
import org.bukkit.block.data.type.Switch;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.java.JavaPlugin;

public final class CompatibilityPlugin extends JavaPlugin implements Listener {
    private static final Set<String> FIXTURE_PLAYERS = Set.of("FixtureBuilder", "FixtureObserver");
    private World world;

    @Override
    public void onEnable() {
        world = Bukkit.getWorlds().get(0);
        // This isolated smoke-test fixture is not a production job or material-delivery API.
        for (int x = -3; x <= 5; x++) {
            for (int z = -3; z <= 5; z++) {
                world.getBlockAt(x, 80, z).setType(Material.STONE, false);
            }
        }

        Block leverBlock = world.getBlockAt(1, 81, 0);
        leverBlock.setType(Material.LEVER, false);
        Switch lever = (Switch) leverBlock.getBlockData();
        lever.setAttachedFace(FaceAttachable.AttachedFace.FLOOR);
        lever.setFacing(BlockFace.EAST);
        lever.setPowered(false);
        leverBlock.setBlockData(lever, true);
        world.getBlockAt(2, 81, 0).setType(Material.REDSTONE_WIRE, true);
        world.getBlockAt(3, 81, 0).setType(Material.REDSTONE_LAMP, true);

        Block chestBlock = world.getBlockAt(0, 81, 2);
        chestBlock.setType(Material.CHEST, true);
        Chest chest = (Chest) chestBlock.getState();
        chest.getInventory().clear();
        chest.getInventory().addItem(new ItemStack(Material.COBBLESTONE, 2));
        world.getBlockAt(2, 81, 2).setType(Material.AIR, true);
        getServer().getPluginManager().registerEvents(this, this);
    }

    @EventHandler
    public void onPlayerJoin(PlayerJoinEvent event) {
        Player player = event.getPlayer();
        if (!FIXTURE_PLAYERS.contains(player.getName())) {
            return;
        }
        player.setOp(false);
        player.setGameMode(GameMode.SURVIVAL);
        player.getInventory().clear();
        player.setFoodLevel(20);
        player.setSaturation(20);
        player.setHealth(Math.min(20.0, player.getMaxHealth()));
        player.setFallDistance(0);
        boolean builder = player.getName().equals("FixtureBuilder");
        player.teleport(new Location(world, builder ? 0.5 : -1.5, 81, builder ? 0.5 : 1.5));
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!(sender instanceof Player player) || !FIXTURE_PLAYERS.contains(player.getName())) {
            sender.sendMessage("Compatibility observations are restricted to isolated fixture players.");
            return true;
        }
        if (args.length != 1 || !args[0].equals("observe")) {
            return false;
        }
        if (!(world.getBlockAt(1, 81, 0).getBlockData() instanceof Powerable lever)
                || !(world.getBlockAt(3, 81, 0).getBlockData() instanceof Lightable lamp)
                || !(world.getBlockAt(2, 81, 0).getBlockData() instanceof RedstoneWire wire)
                || !(world.getBlockAt(0, 81, 2).getState() instanceof Chest chest)) {
            sender.sendMessage("AC_COMPAT_ERROR fixture interface mismatch");
            return true;
        }
        int stock = 0;
        for (ItemStack item : chest.getInventory().getContents()) {
            if (item != null && item.getType() == Material.COBBLESTONE) {
                stock += item.getAmount();
            }
        }
        Player builder = Bukkit.getPlayerExact("FixtureBuilder");
        if (builder == null || !builder.isOnline()) {
            sender.sendMessage("AC_COMPAT_ERROR builder unavailable");
            return true;
        }
        Location position = builder.getLocation();
        sender.sendMessage("AC_COMPAT {\"builder_position\":[" + position.getBlockX() + "," + position.getBlockY() + "," + position.getBlockZ() + "],\"lever\":" + lever.isPowered()
                + ",\"lamp\":" + lamp.isLit()
                + ",\"wire\":" + wire.getPower()
                + ",\"stock\":" + stock
                + ",\"target\":\"" + world.getBlockAt(2, 81, 2).getType().name()
                + "\",\"server\":\"" + jsonString(getServer().getVersion())
                + "\",\"plugin\":\"" + jsonString(getDescription().getVersion()) + "\"}");
        return true;
    }

    private static String jsonString(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
    }
}

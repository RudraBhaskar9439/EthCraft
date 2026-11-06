package org.agentcity.fixture;

import java.nio.file.Files;
import java.util.Set;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.enchantments.Enchantment;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.event.EventPriority;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.Damageable;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.plugin.java.JavaPlugin;

/** One disclosed test sword per controlled actor in the new laptop namespace. */
public final class LaptopBankStock extends JavaPlugin implements Listener {
    @Override public void onEnable() {
        var root = getDataFolder().toPath().toAbsolutePath().normalize().getParent().getParent();
        if (!Files.isRegularFile(root.resolve("laptop-bank-fixture"))) throw new IllegalStateException("laptop_fixture_marker_required");
        getServer().getPluginManager().registerEvents(this, this);
    }

    @EventHandler public void joined(PlayerJoinEvent event) {
        var player = event.getPlayer();
        if (!Set.of("BankBorrower", "BankSeller").contains(player.getName())) return;
        getServer().getScheduler().runTaskLater(this, () -> {
            try {
                var marker = getDataFolder().toPath().resolve("granted-" + player.getUniqueId());
                if (Files.exists(marker) || !player.isOnline()) return;
                if (player.getInventory().getItem(8) != null) throw new IllegalStateException("fresh_fixture_slot_required");
                var sword = new ItemStack(Material.DIAMOND_SWORD);
                var meta = sword.getItemMeta();
                meta.setDisplayName(player.getName() + " testnet collateral");
                meta.setLore(java.util.List.of("Disclosed laptop fixture stock", "Controlled actor and testnet assets only"));
                ((Damageable) meta).setDamage(7);
                meta.addEnchant(Enchantment.SHARPNESS, 2, false);
                meta.getPersistentDataContainer().set(new NamespacedKey(this, "native_proof"), PersistentDataType.STRING, player.getName());
                sword.setItemMeta(meta);
                Files.createDirectories(marker.getParent());
                Files.writeString(marker, "One disclosed test sword for " + player.getName() + "\n");
                player.getInventory().setItem(8, sword);
                player.saveData();
            } catch (Exception error) {
                getLogger().severe("Laptop bank stock grant failed closed");
                getServer().shutdown();
            }
        }, 20);
    }

    @EventHandler(priority=EventPriority.HIGHEST,ignoreCancelled=false) public void fixtureCommand(PlayerCommandPreprocessEvent event) {
        var player=event.getPlayer();
        if(!Set.of("BankBorrower","BankSeller").contains(player.getName())||!event.getMessage().startsWith("/bankfixture "))return;
        event.setCancelled(true);String operation=event.getMessage().substring(13);
        if(!Set.of("damage","enchant","pdc","reset").contains(operation))return;
        var sword=player.getInventory().getItem(8);if(sword==null||sword.getType()!=Material.DIAMOND_SWORD)return;
        var meta=sword.getItemMeta();
        if(operation.equals("damage"))((Damageable)meta).setDamage(8);
        if(operation.equals("enchant"))meta.addEnchant(Enchantment.SHARPNESS,3,false);
        if(operation.equals("pdc"))meta.getPersistentDataContainer().set(new NamespacedKey(this,"native_proof"),PersistentDataType.STRING,player.getName()+"-changed");
        if(operation.equals("reset")){((Damageable)meta).setDamage(7);meta.addEnchant(Enchantment.SHARPNESS,2,false);meta.getPersistentDataContainer().set(new NamespacedKey(this,"native_proof"),PersistentDataType.STRING,player.getName());}
        sword.setItemMeta(meta);player.getInventory().setItem(8,sword);player.saveData();
    }
}

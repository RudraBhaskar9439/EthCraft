package org.agentcity.fixture;

import java.nio.file.Files;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.enchantments.Enchantment;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.Damageable;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.plugin.java.JavaPlugin;

/** Exactly one disclosed equipment stack in a new, labelled seam fixture. */
public final class SeamEquipmentStock extends JavaPlugin implements Listener {
    @Override public void onEnable(){
        var root=getDataFolder().toPath().toAbsolutePath().normalize().getParent().getParent();
        if(!Files.isRegularFile(root.resolve("world-assets-seam-fixture")))throw new IllegalStateException("seam_fixture_marker_required");
        getServer().getPluginManager().registerEvents(this,this);
    }
    @EventHandler public void joined(PlayerJoinEvent event){
        if(!event.getPlayer().getName().equals("EscSeller"))return;
        getServer().getScheduler().runTask(this,()->{
            try{
                var marker=getDataFolder().toPath().resolve("one-equipment-grant");if(Files.exists(marker))return;
                if(java.util.Arrays.stream(event.getPlayer().getInventory().getContents()).anyMatch(item->item!=null&&!item.getType().isAir()))throw new IllegalStateException("fresh_fixture_inventory_required");
                var root=getDataFolder().toPath().toAbsolutePath().normalize().getParent().getParent();String mode=Files.exists(root.resolve("fixture-stock-mode"))?Files.readString(root.resolve("fixture-stock-mode")).trim():"sword";
                if(!java.util.Set.of("sword","resource","both").contains(mode))throw new IllegalArgumentException("fixture_stock_mode");
                Files.createDirectories(marker.getParent());Files.writeString(marker,"Disclosed one-time fixture stock mode: "+mode+"\n");
                if(!mode.equals("resource")){ItemStack item=new ItemStack(Material.DIAMOND_SWORD);var meta=item.getItemMeta();meta.setDisplayName("Seam fixture blade");meta.setLore(java.util.List.of("Actual isolated Paper stock; synthetic test owners."));((Damageable)meta).setDamage(7);meta.addEnchant(Enchantment.SHARPNESS,2,false);meta.getPersistentDataContainer().set(new NamespacedKey(this,"native_proof"),PersistentDataType.STRING,"seam-only");item.setItemMeta(meta);event.getPlayer().getInventory().setItem(8,item);}
                if(!mode.equals("sword"))event.getPlayer().getInventory().setItem(7,new ItemStack(Material.STICK,3));event.getPlayer().saveData();
            }catch(Exception error){getLogger().severe("Isolated seam fixture equipment grant failed");getServer().shutdown();}
        });
    }
}

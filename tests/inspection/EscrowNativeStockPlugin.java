package org.agentcity.fixture;

import java.nio.file.Files;
import org.bukkit.Material;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.event.EventPriority;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.HeightMap;
import org.bukkit.NamespacedKey;
import org.bukkit.enchantments.Enchantment;
import org.bukkit.inventory.meta.Damageable;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.java.JavaPlugin;

/** Disclosed stock for a NEW isolated escrow fixture, never the shared server. */
public final class EscrowNativeStockPlugin extends JavaPlugin implements Listener {
    @Override public void onEnable(){getServer().getPluginManager().registerEvents(this,this);}
    @EventHandler public void joined(PlayerJoinEvent event){
        String name=event.getPlayer().getName();if(!java.util.Set.of("EscSeller","CityAgent2").contains(name))return;
        getServer().getScheduler().runTask(this,()->{
            try{
                var marker=getDataFolder().toPath().resolve("stock-granted-"+name);if(Files.exists(marker))return;
                Files.createDirectories(marker.getParent());Files.writeString(marker,"Disclosed isolated fixture:20 plain oak planks and2 modified oak planks.\n");
                ItemStack modified=new ItemStack(Material.OAK_PLANKS,2);var meta=modified.getItemMeta();meta.setDisplayName("fixture-modified");modified.setItemMeta(meta);
                ItemStack[] stock=name.equals("EscSeller")?new ItemStack[]{new ItemStack(Material.OAK_PLANKS,20),modified}:new ItemStack[]{new ItemStack(Material.COBBLESTONE,6)};
                if(!event.getPlayer().getInventory().addItem(stock).isEmpty())throw new IllegalStateException("fixture_inventory_full");
                if(name.equals("EscSeller")&&Files.exists(getDataFolder().toPath().getParent().resolve("AgentCity/world-assets-enabled"))){
                    ItemStack equipment=new ItemStack(Material.DIAMOND_SWORD);var equipmentMeta=equipment.getItemMeta();equipmentMeta.setDisplayName("Fixture blade");equipmentMeta.setLore(java.util.List.of("Isolated native fixture stock"));((Damageable)equipmentMeta).setDamage(7);equipmentMeta.addEnchant(Enchantment.SHARPNESS,2,false);equipmentMeta.getPersistentDataContainer().set(new NamespacedKey(this,"provenance"),PersistentDataType.STRING,"isolated-native-stock");equipment.setItemMeta(equipmentMeta);event.getPlayer().getInventory().setItem(8,equipment);event.getPlayer().getInventory().addItem(new ItemStack(Material.STONE,2),new ItemStack(Material.CHEST));
                }
                event.getPlayer().saveData();
            }catch(Exception error){getLogger().severe("Isolated fixture stock setup failed");getServer().shutdown();}
        });
    }
    @EventHandler(priority=EventPriority.LOWEST) public void control(PlayerCommandPreprocessEvent event){
        if(!java.util.Set.of("EscSeller","EscBuyer").contains(event.getPlayer().getName())||!event.getMessage().startsWith("/nativefixture "))return;
        event.setCancelled(true);String action=event.getMessage().substring("/nativefixture ".length());var player=event.getPlayer();
        if(action.equals("op")){player.setOp(true);player.addAttachment(this,"worldguard.region.bypass.agentcity_estates",true);player.sendMessage("NATIVE_FIXTURE_OP true");return;}
        var world=Bukkit.getWorld("agentcity_estates");if(world==null)return;
        double x=action.equals("road")?-0.5:action.equals("inside")?0.5:Double.NaN;if(!Double.isFinite(x))return;
        int y=world.getHighestBlockYAt(0,8,HeightMap.MOTION_BLOCKING)+1;
        if(action.equals("road"))for(int rx=-3;rx<0;rx++)for(int rz=7;rz<=9;rz++){
            world.getBlockAt(rx,y-1,rz).setType(Material.STONE,false);
            for(int ry=y;ry<y+3;ry++)world.getBlockAt(rx,ry,rz).setType(Material.AIR,false);
        }
        boolean moved=player.teleport(new Location(world,x,y,8.5));player.sendMessage("NATIVE_FIXTURE_MOVE "+moved);
    }
}

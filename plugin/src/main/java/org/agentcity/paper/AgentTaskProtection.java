package org.agentcity.paper;

import java.util.*;
import java.nio.file.*;
import java.nio.channels.FileChannel;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import com.google.gson.Gson;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.entity.Player;
import org.bukkit.event.*;
import org.bukkit.event.block.*;
import org.bukkit.event.inventory.InventoryOpenEvent;
import org.bukkit.event.inventory.InventoryMoveItemEvent;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryDragEvent;
import org.bukkit.event.inventory.CraftItemEvent;
import org.bukkit.event.inventory.InventoryType;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.plugin.java.JavaPlugin;

/** The receiving boundary confines each personal bot to its declared task area. */
final class AgentTaskProtection implements Listener {
    private final PlayableExperience experience;
    private final Map<String,Map<String,Object>> locks=new HashMap<>();
    private final Path stateFile;
    private final RemoteTaskGrants remoteGrants;
    @SuppressWarnings("unchecked") AgentTaskProtection(JavaPlugin plugin,PlayableExperience experience) throws Exception {
        this.experience=experience;stateFile=plugin.getDataFolder().toPath().resolve("task-region-locks.json");
        remoteGrants=new RemoteTaskGrants(plugin.getDataFolder().toPath());
        if(Files.exists(stateFile))for(var entry:StrictJson.object(Files.readString(stateFile)).entrySet())locks.put(entry.getKey(),(Map<String,Object>)entry.getValue());
    }
    void remoteGrant(Map<String,Object> value)throws Exception{remoteGrants.update(value);}
    private boolean active(Player player,String effect){return remoteGrants.allows(locks.get(player.getName()),player.getName(),effect);}
    private void persist() throws Exception {
        Path temporary=stateFile.resolveSibling("task-region-locks.tmp");
        try(FileChannel file=FileChannel.open(temporary,StandardOpenOption.CREATE,StandardOpenOption.TRUNCATE_EXISTING,StandardOpenOption.WRITE)){
            ByteBuffer bytes=StandardCharsets.UTF_8.encode(new Gson().toJson(locks));while(bytes.hasRemaining())file.write(bytes);file.force(true);
        }
        Files.move(temporary,stateFile,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
        try(FileChannel directory=FileChannel.open(stateFile.getParent(),StandardOpenOption.READ)){directory.force(true);}
    }
    void lock(Map<String,Object> input) throws Exception {
        if(!Bukkit.isPrimaryThread())throw new IllegalStateException("task_lock_main_thread");
        String slot=(String)input.get("slotName"),task=UUID.fromString((String)input.get("taskId")).toString(),owner=UUID.fromString((String)input.get("ownerId")).toString();
        if(!PlayableExperience.AGENTS.contains(slot))throw new IllegalArgumentException("task_slot");
        Map<String,Object> previous=locks.get(slot);
        if(previous!=null&&(!task.equals(previous.get("taskId"))||!owner.equals(previous.get("ownerId"))))throw new IllegalStateException("task_region_already_locked");
        if(Boolean.TRUE.equals(input.get("locked"))) {
            if(input.get("remoteGrantId") instanceof String id){
                String grant=UUID.fromString(id).toString(),tool=RemoteTaskGrants.tool((String)input.get("tool"));
                if(!remoteGrants.valid(grant,slot,owner,tool))throw new IllegalArgumentException("remote_task_authority_required");
                locks.put(slot,Map.of("taskId",task,"ownerId",owner,"remoteGrantId",grant,"tool",tool));
            }else{
                String gameOwner=input.get("ownerPlayerId") instanceof String actual?UUID.fromString(actual).toString():owner;
                if(Bukkit.getPlayer(UUID.fromString(gameOwner))==null)throw new IllegalArgumentException("task_owner_offline");
                locks.put(slot,Map.of("taskId",task,"ownerId",owner));
            }
        }else locks.remove(slot);
        try { persist(); }
        catch(Exception error){if(previous==null)locks.remove(slot);else locks.put(slot,previous);throw error;}
        experience.positionTaskAgent(slot,Boolean.TRUE.equals(input.get("locked")));
    }
    private boolean agent(Player player){return PlayableExperience.AGENTS.contains(player.getName());}
    @SuppressWarnings("unchecked") private Map<String,Object> region(Player player){
        Map<String,Object> status=experience.status();
        Object regions=status.get("taskRegions");if(!(regions instanceof List<?> list))return null;
        for(Object value:list)if(value instanceof Map<?,?> map&&player.getName().equals(map.get("slotName"))
            &&player.getWorld().getName().equals(map.getOrDefault("worldName",null)))return (Map<String,Object>)map;
        return null;
    }
    @SuppressWarnings("unchecked") private boolean inside(Player player,Location position){
        Map<String,Object> region=region(player);if(region==null)return false;
        if(!player.getWorld().equals(position.getWorld()))return false;
        Map<String,Object> min=(Map<String,Object>)region.get("min"),max=(Map<String,Object>)region.get("max");
        int[] xyz={position.getBlockX(),position.getBlockY(),position.getBlockZ()};int i=0;
        for(String axis:List.of("x","y","z")){if(xyz[i]<((Number)min.get(axis)).intValue()||xyz[i]>((Number)max.get(axis)).intValue())return false;i++;}
        return true;
    }
    @EventHandler(priority=EventPriority.HIGHEST,ignoreCancelled=true) public void place(BlockPlaceEvent event){
        if(agent(event.getPlayer())?(!active(event.getPlayer(),"place")||!inside(event.getPlayer(),event.getBlock().getLocation())||accessStrip(event.getPlayer(),event.getBlock().getLocation())):lockedAt(event.getBlock().getLocation()))event.setCancelled(true);
    }
    @EventHandler(priority=EventPriority.HIGHEST,ignoreCancelled=true) public void dig(BlockBreakEvent event){
        if(agent(event.getPlayer())?(!active(event.getPlayer(),"dig")||!inside(event.getPlayer(),event.getBlock().getLocation())||accessStrip(event.getPlayer(),event.getBlock().getLocation())):lockedAt(event.getBlock().getLocation()))event.setCancelled(true);
    }
    @SuppressWarnings("unchecked") private boolean accessStrip(Player player,Location location){
        Map<String,Object> region=region(player);if(region==null)return true;
        Map<String,Object> min=(Map<String,Object>)region.get("min");
        // Both fixed chests sit on this strip. Keep stock and the native entry
        // corridor intact for all tasks, including gathering and custom builds.
        return location.getBlockX()<((Number)min.get("x")).intValue()+2||location.getBlockZ()<((Number)min.get("z")).intValue()+2;
    }
    private boolean activeInside(Player player,Location location){return active(player,"craft")&&inside(player,location);}
    @SuppressWarnings("unchecked") private boolean allowedInventory(Player player,Inventory inventory){
        if(!active(player,"open"))return false;
        Location location=inventory.getLocation();
        // Some Bukkit workbench inventories expose no block location. The native
        // block-interaction guard below still checks the actual clicked table.
        if(inventory.getType()==InventoryType.WORKBENCH)return inside(player,location==null?player.getLocation():location);
        if(location==null)return false;
        Map<String,Object> region=region(player);if(region==null||!inside(player,location))return false;
        for(String key:List.of("sourceChest","destinationChest")){
            Object raw=region.get(key);if(!(raw instanceof List<?> xyz)||xyz.size()!=3)continue;
            if(location.getBlockX()==((Number)xyz.get(0)).intValue()&&location.getBlockY()==((Number)xyz.get(1)).intValue()&&location.getBlockZ()==((Number)xyz.get(2)).intValue())return true;
        }
        return false;
    }
    @EventHandler(priority=EventPriority.HIGHEST,ignoreCancelled=true) public void workbench(PlayerInteractEvent event){
        if(agent(event.getPlayer())&&event.getClickedBlock()!=null&&event.getClickedBlock().getType()==Material.CRAFTING_TABLE&&!activeInside(event.getPlayer(),event.getClickedBlock().getLocation()))event.setCancelled(true);
    }
    @EventHandler(priority=EventPriority.HIGHEST,ignoreCancelled=true) public void craft(CraftItemEvent event){
        if(event.getWhoClicked() instanceof Player player&&agent(player)){
            boolean allowed=event.getInventory().getType()==InventoryType.WORKBENCH?allowedInventory(player,event.getInventory()):activeInside(player,player.getLocation());
            if(!allowed)event.setCancelled(true);
        }
    }
    @EventHandler(priority=EventPriority.HIGHEST,ignoreCancelled=true) public void chest(InventoryOpenEvent event){
        if(!(event.getPlayer() instanceof Player player))return;
        Location location=event.getInventory().getLocation();
        if(!agent(player)){if(location!=null&&lockedAt(location))event.setCancelled(true);return;}
        if(!allowedInventory(player,event.getInventory()))event.setCancelled(true);
    }
    @EventHandler(priority=EventPriority.HIGHEST,ignoreCancelled=true) public void automate(InventoryMoveItemEvent event){
        Location source=event.getSource().getLocation(),destination=event.getDestination().getLocation();
        if(source!=null&&lockedAt(source)||destination!=null&&lockedAt(destination))event.setCancelled(true);
    }
    @EventHandler(priority=EventPriority.HIGHEST,ignoreCancelled=true) public void click(InventoryClickEvent event){
        if(event.getWhoClicked() instanceof Player player&&agent(player)&&event.getView().getTopInventory().getType()!=InventoryType.CRAFTING){
            if(!allowedInventory(player,event.getView().getTopInventory())||!active(player,"transfer"))event.setCancelled(true);return;
        }
        Location location=event.getView().getTopInventory().getLocation();
        if(location!=null&&lockedAt(location)&&event.getWhoClicked() instanceof Player player&&!agent(player))event.setCancelled(true);
    }
    @EventHandler(priority=EventPriority.HIGHEST,ignoreCancelled=true) public void drag(InventoryDragEvent event){
        if(event.getWhoClicked() instanceof Player player&&agent(player)&&event.getView().getTopInventory().getType()!=InventoryType.CRAFTING){
            if(!allowedInventory(player,event.getView().getTopInventory())||!active(player,"transfer"))event.setCancelled(true);return;
        }
        Location location=event.getView().getTopInventory().getLocation();
        if(location!=null&&lockedAt(location)&&event.getWhoClicked() instanceof Player player&&!agent(player))event.setCancelled(true);
    }
    @SuppressWarnings("unchecked") private boolean lockedAt(Location location){
        Map<String,Object> status=experience.status();
        if(!(status.get("taskRegions") instanceof List<?> list))return false;
        for(Object value:list){Map<String,Object> region=(Map<String,Object>)value;if(!locks.containsKey((String)region.get("slotName"))
            ||!location.getWorld().getName().equals(region.getOrDefault("worldName",status.get("playWorld"))))continue;
            Map<String,Object> min=(Map<String,Object>)region.get("min"),max=(Map<String,Object>)region.get("max");int[] xyz={location.getBlockX(),location.getBlockY(),location.getBlockZ()};int i=0;boolean inside=true;
            for(String axis:List.of("x","y","z")){if(xyz[i]<((Number)min.get(axis)).intValue()||xyz[i]>((Number)max.get(axis)).intValue())inside=false;i++;}if(inside)return true;
        }return false;
    }
}

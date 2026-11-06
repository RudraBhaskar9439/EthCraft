package org.agentcity.paper;

import com.google.gson.Gson;
import java.util.*;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.Chest;
import org.bukkit.block.data.BlockData;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;

/** A comparable observation, not a claim of atomic world/journal persistence. */
final class WorldProjection {
    private static final Gson JSON=new Gson();
    private static final Set<String> DYNAMIC=Set.of("lit","powered","power","locked","east","west","north","south");
    private final World world;
    private final int[] min,max,chest;
    private final Set<UUID> actors;
    WorldProjection(World world,int[] min,int[] max,int[] chest,Set<UUID> actors) {
        this.world=world;this.min=min.clone();this.max=max.clone();this.chest=chest.clone();this.actors=Set.copyOf(actors);
    }
    static String key(int x,int y,int z) {return x+","+y+","+z;}
    static String structural(BlockData data) {
        String raw=data.getAsString();int start=raw.indexOf('[');
        if(start<0)return raw;
        SortedMap<String,String> properties=new TreeMap<>();
        boolean wire=data.getMaterial()==Material.REDSTONE_WIRE;
        for(String property:raw.substring(start+1,raw.length()-1).split(",")) {
            String[] pair=property.split("=",2);
            if(!DYNAMIC.contains(pair[0]) || (!wire && Set.of("east","west","north","south").contains(pair[0]))) properties.put(pair[0],pair[1]);
        }
        return raw.substring(0,start)+(properties.isEmpty()?"":"["+String.join(",",properties.entrySet().stream().map(e->e.getKey()+"="+e.getValue()).toList())+"]");
    }
    boolean loaded() {
        for(int x=min[0]>>4;x<=max[0]>>4;x++)for(int z=min[2]>>4;z<=max[2]>>4;z++) if(!world.isChunkLoaded(x,z))return false;
        return true;
    }
    Snapshot observe() {
        if(!Bukkit.isPrimaryThread())throw new IllegalStateException("game_thread_required");
        if(!loaded())throw new IllegalStateException("plot_unloaded");
        SortedMap<String,String> blocks=new TreeMap<>();
        for(int x=min[0];x<=max[0];x++)for(int y=min[1];y<=max[1];y++)for(int z=min[2];z<=max[2];z++) {
            Block b=world.getBlockAt(x,y,z);
            if(!b.isEmpty())blocks.put(key(x,y,z),structural(b.getBlockData()));
        }
        Block b=world.getBlockAt(chest[0],chest[1],chest[2]);
        if(!(b.getState() instanceof Chest stock))throw new IllegalStateException("stock_chest_missing");
        SortedMap<String,ItemStack[]> inventories=new TreeMap<>();
        inventories.put("stock",cloneItems(stock.getBlockInventory().getContents()));
        for(UUID id:actors) {
            Player p=Bukkit.getPlayer(id);
            if(p==null||!p.isOnline())throw new IllegalStateException("actor_inventory_unavailable:"+id);
            inventories.put(id.toString(),cloneItems(p.getInventory().getContents()));
        }
        return new Snapshot(blocks,inventories);
    }
    private static ItemStack[] cloneItems(ItemStack[] source) {return Arrays.stream(source).map(i->i==null?null:i.clone()).toArray(ItemStack[]::new);}
    static final class Snapshot {
        final SortedMap<String,String> blocks;
        final SortedMap<String,ItemStack[]> inventories;
        Snapshot(SortedMap<String,String> blocks,SortedMap<String,ItemStack[]> inventories) {this.blocks=blocks;this.inventories=inventories;}
        Snapshot copy() {
            SortedMap<String,ItemStack[]> copied=new TreeMap<>();inventories.forEach((k,v)->copied.put(k,cloneItems(v)));
            return new Snapshot(new TreeMap<>(blocks),copied);
        }
        void block(int x,int y,int z,String state) {if(state.equals("minecraft:air"))blocks.remove(key(x,y,z));else blocks.put(key(x,y,z),state);}
        void consume(UUID actor,int slot,Material item) {
            ItemStack[] items=inventories.get(actor.toString());ItemStack held=items[slot];
            if(held==null||held.getType()!=item||held.getAmount()<1||held.hasItemMeta())throw new IllegalArgumentException("wrong_or_missing_item");
            if(held.getAmount()==1)items[slot]=null;else held.setAmount(held.getAmount()-1);
        }
        void transfer(String from,String to,Material material,int count) {
            ItemStack[] source=inventories.get(from),target=inventories.get(to);
            int available=Arrays.stream(source).filter(i->i!=null&&i.getType()==material&&!i.hasItemMeta()).mapToInt(ItemStack::getAmount).sum();
            if(available<count)throw new IllegalArgumentException("stock_shortage");
            int left=count;
            for(int slot=0;slot<source.length&&left>0;slot++) {
                ItemStack i=source[slot];if(i==null||i.getType()!=material||i.hasItemMeta())continue;
                int taken=Math.min(left,i.getAmount());left-=taken;
                if(taken==i.getAmount())source[slot]=null;else i.setAmount(i.getAmount()-taken);
            }
            left=count;
            // Player storage has 36 slots; armor/offhand cannot receive a custody transfer.
            int slots=to.equals("stock")?target.length:Math.min(36,target.length);
            for(int slot=0;slot<slots&&left>0;slot++) {
                ItemStack i=target[slot];if(i==null||i.getType()!=material||i.hasItemMeta())continue;
                int added=Math.min(left,material.getMaxStackSize()-i.getAmount());i.setAmount(i.getAmount()+added);left-=added;
            }
            for(int slot=0;slot<slots&&left>0;slot++)if(target[slot]==null||target[slot].getType().isAir()) {
                int added=Math.min(left,material.getMaxStackSize());target[slot]=new ItemStack(material,added);left-=added;
            }
            if(left!=0)throw new IllegalArgumentException("destination_full");
        }
        String canonical() {
            SortedMap<String,SortedMap<String,Integer>> itemData=new TreeMap<>();
            inventories.forEach((k,v)->{
                SortedMap<String,Integer> counts=new TreeMap<>();
                for(ItemStack item:v)if(item!=null&&!item.getType().isAir()) {
                    ItemStack unit=item.clone();unit.setAmount(1);
                    counts.merge(Base64.getEncoder().encodeToString(unit.serializeAsBytes()),item.getAmount(),Integer::sum);
                }
                itemData.put(k,counts);
            });
            SortedMap<String,Object> projection=new TreeMap<>();
            projection.put("blocks",blocks);projection.put("inventories",itemData);return JSON.toJson(projection);
        }
    }
}

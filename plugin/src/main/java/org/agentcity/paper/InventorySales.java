package org.agentcity.paper;

import com.google.gson.Gson;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.bukkit.*;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.java.JavaPlugin;

/** Durable, bounded native inventory receipts; never grants or signs currency. */
final class InventorySales {
    private static final Gson JSON = new Gson();
    private final JavaPlugin plugin;
    private final Path journal;
    private final Map<String,Map<String,Object>> records = new HashMap<>();
    InventorySales(JavaPlugin plugin) throws Exception {
        this.plugin=plugin; journal=plugin.getDataFolder().toPath().resolve("inventory-sales.jsonl");
        if(Files.exists(journal)) for(String line:Files.readAllLines(journal)) {
            Map<String,Object> record=StrictJson.object(line);
            records.put((String)record.get("operationId"),record);
        }
    }
    private void append(Map<String,Object> record) throws Exception {
        byte[] bytes=(JSON.toJson(record)+"\n").getBytes(StandardCharsets.UTF_8);
        try(FileChannel channel=FileChannel.open(journal,StandardOpenOption.CREATE,StandardOpenOption.APPEND,StandardOpenOption.WRITE)) {
            ByteBuffer buffer=ByteBuffer.wrap(bytes); while(buffer.hasRemaining())channel.write(buffer);channel.force(true);
        }
        try(FileChannel directory=FileChannel.open(journal.getParent(),StandardOpenOption.READ)){directory.force(true);}
        records.put((String)record.get("operationId"),record);
    }
    Map<String,Object> remove(Map<String,Object> input) throws Exception {
        if(!Bukkit.isPrimaryThread())throw new IllegalStateException("inventory_main_thread_required");
        String operationId=UUID.fromString((String)input.get("operationId")).toString();
        String ownerId=UUID.fromString((String)input.get("playerId")).toString();
        String actorId=UUID.fromString((String)input.getOrDefault("inventoryPlayerId",ownerId)).toString();
        String item=(String)input.get("item");long count=(Long)input.get("count");
        if(!Set.of("minecraft:cobblestone","minecraft:oak_planks").contains(item)||count<1||count>64)throw new IllegalArgumentException("sale_catalog_or_count");
        Map<String,Object> previous=records.get(operationId);
        if(previous!=null) {
            if(!ownerId.equals(previous.get("playerId"))||!actorId.equals(previous.get("inventoryPlayerId"))||!item.equals(previous.get("item"))||count!=((Number)previous.get("count")).longValue())throw new IllegalArgumentException("sale_operation_binding_changed");
            if(previous.containsKey("removed"))return previous;
            throw new IllegalStateException("SALE_RECONCILIATION_REQUIRED");
        }
        EconomyMode.requireLegacy(plugin);
        Player owner=Bukkit.getPlayer(UUID.fromString(ownerId)), actor=Bukkit.getPlayer(UUID.fromString(actorId));
        if(owner==null||actor==null||!owner.isOnline()||!actor.isOnline())throw new IllegalArgumentException("sale_actor_offline");
        if(!ownerId.equals(actorId)&&!PlayableExperience.AGENTS.contains(actor.getName()))throw new IllegalArgumentException("sale_inventory_actor");
        Material material=Material.matchMaterial(item);
        ItemStack[] contents=actor.getInventory().getStorageContents();int total=0;
        for(ItemStack stack:contents)if(stack!=null&&stack.getType()==material)total+=stack.getAmount();
        Map<String,Object> record=new LinkedHashMap<>();
        record.put("operationId",operationId);record.put("playerId",ownerId);record.put("inventoryPlayerId",actorId);record.put("item",item);record.put("count",count);
        if(total<count){record.put("removed",false);record.put("reason","insufficient_items");append(record);return record;}
        record.put("beforeCount",total);append(record);
        int remaining=(int)count;
        for(int i=0;i<contents.length&&remaining>0;i++) {
            ItemStack stack=contents[i];if(stack==null||stack.getType()!=material)continue;
            int taken=Math.min(remaining,stack.getAmount());remaining-=taken;
            if(stack.getAmount()==taken)contents[i]=null;else stack.setAmount(stack.getAmount()-taken);
        }
        actor.getInventory().setStorageContents(contents);actor.saveData();
        Map<String,Object> receipt=new LinkedHashMap<>(record);receipt.put("removed",true);append(receipt);
        return receipt;
    }
}

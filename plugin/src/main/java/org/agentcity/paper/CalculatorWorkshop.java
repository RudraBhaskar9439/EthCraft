package org.agentcity.paper;

import com.google.gson.Gson;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.block.data.BlockData;
import org.bukkit.plugin.java.JavaPlugin;

/** Editable block-data copy, outside the reference plot. No container contents or entities are copied. */
final class CalculatorWorkshop {
    private static final int OFFSET = 128;
    private final World world;
    private final int[] min, max;
    private final Path file;
    private boolean ready;

    CalculatorWorkshop(JavaPlugin plugin, World world, int[] min, int[] max) {
        this.world = world; this.min = min.clone(); this.max = max.clone();
        file = plugin.getDataFolder().toPath().resolve("calculator-workshop.json");
    }
    private String hash(String text) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
    }
    private void save(String binding, String layout, String phase) throws Exception {
        Path temporary = file.resolveSibling("calculator-workshop.tmp");
        byte[] bytes = new Gson().toJson(Map.of("version",1,"binding",binding,"layoutSha256",layout,"phase",phase)).getBytes(StandardCharsets.UTF_8);
        try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE)) {
            ByteBuffer buffer = ByteBuffer.wrap(bytes); while (buffer.hasRemaining()) channel.write(buffer); channel.force(true);
        }
        Files.move(temporary,file,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
        try (FileChannel directory = FileChannel.open(file.getParent(),StandardOpenOption.READ)) { directory.force(true); }
    }
    private void prepare() throws Exception {
        if (ready) return;
        String binding = hash(world.getUID()+":"+Arrays.toString(min)+":"+Arrays.toString(max)+":"+OFFSET);
        Map<String,Object> record = Files.exists(file) ? StrictJson.object(Files.readString(file)) : null;
        if (record != null) {
            if (!binding.equals(record.get("binding")) || !Set.of("installing","complete").contains(record.get("phase"))) throw new IllegalStateException("calculator_workshop_binding_changed");
            if (record.get("phase").equals("complete")) { ready=true; return; }
        }
        List<BlockData> blocks = new ArrayList<>();
        for (int x=min[0];x<=max[0];x++) for (int y=min[1];y<=max[1];y++) for (int z=min[2];z<=max[2];z++) blocks.add(world.getBlockAt(x,y,z).getBlockData().clone());
        String layout = hash(String.join("\n",blocks.stream().map(BlockData::getAsString).toList()));
        if (record != null && !layout.equals(record.get("layoutSha256"))) throw new IllegalStateException("calculator_workshop_source_changed_during_install");
        int index=0;
        for (int x=min[0];x<=max[0];x++) for (int y=min[1];y<=max[1];y++) for (int z=min[2];z<=max[2];z++) {
            var target=world.getBlockAt(x+OFFSET,y,z); BlockData expected=blocks.get(index++);
            if (!target.getType().isAir() && (record==null || !target.getBlockData().equals(expected))) throw new IllegalStateException("calculator_workshop_destination_occupied");
        }
        if (record==null) save(binding,layout,"installing");
        index=0;
        for (int x=min[0];x<=max[0];x++) for (int y=min[1];y<=max[1];y++) for (int z=min[2];z<=max[2];z++) {
            var target=world.getBlockAt(x+OFFSET,y,z); BlockData expected=blocks.get(index++);
            if (!expected.getMaterial().isAir() && target.getType().isAir()) target.setBlockData(expected,false);
        }
        world.save(); save(binding,layout,"complete"); ready=true;
    }
    private boolean safe(int x,int y,int z) {
        return world.getBlockAt(x,y,z).getType().isAir() && world.getBlockAt(x,y+1,z).getType().isAir() && world.getBlockAt(x,y-1,z).getType().isSolid();
    }
    Location entrance() throws Exception {
        prepare();
        int x=max[0]+OFFSET-3,y=min[1]+1,z=max[2]-2;
        if (safe(x,y,z)) return new Location(world,x+0.5,y,z+0.5);
        for (y=min[1]+1;y<=max[1]+2;y++) for (x=min[0]+OFFSET;x<=max[0]+OFFSET;x++) for (z=min[2];z<=max[2];z++)
            if (safe(x,y,z)) return new Location(world,x+0.5,y,z+0.5);
        throw new IllegalStateException("calculator_workshop_needs_safe_floor");
    }
    Map<String,Object> status() {
        return Map.of("world",world.getName(),"worldUuid",world.getUID().toString(),"ready",ready,"command","/calculator","gameMode","SURVIVAL",
            "min",List.of(min[0]+OFFSET,min[1],min[2]),"max",List.of(max[0]+OFFSET,max[1],max[2]),"containerContentsCopied",false);
    }
}

package org.agentcity.paper;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.TileState;
import org.bukkit.block.data.BlockData;
import org.bukkit.plugin.java.JavaPlugin;

/** Operator-built scenery and service desks; no inventory or economic stock is created. */
final class UniRockBank {
    static final int FLOOR = 68;
    record Cell(int x, int y, int z) {}
    record Box(int minX,int minY,int minZ,int maxX,int maxY,int maxZ) {
        boolean contains(int x,int z) { return x>=minX&&x<=maxX&&z>=minZ&&z<=maxZ; }
    }
    private static final List<Box> SITE = List.of(new Box(1660,68,2799,1722,94,2854),
        new Box(1660,68,2793,1718,72,2798),new Box(1641,68,2780,1645,72,2797),new Box(1646,68,2793,1659,72,2797),
        new Box(1723,68,2814,1757,68,2816),new Box(1730,68,2810,1741,68,2821),new Box(1746,68,2810,1757,68,2821),
        new Box(1723,68,2808,1757,72,2809),new Box(1723,68,2810,1729,72,2813));
    private static final Map<String,Integer> DESKS = Map.of("guide",1669,"agents",1680,"jobs",1691,"economy",1702,"play",1713);
    private final World world;
    private final int validatedBlockStates;
    private UniRockBank(World world,int validatedBlockStates) { this.world=world;this.validatedBlockStates=validatedBlockStates; }

    static UniRockBank prepare(JavaPlugin plugin,World world) throws Exception {
        Map<Cell,String> plan=blueprint(),legacy=legacyBlueprint();
        String hash=planHash(plan),previous=planHash(legacy);
        Path marker=plugin.getDataFolder().toPath().resolve("unirock-bank.json");
        Map<String,Object> saved=readJournal(marker);
        String phase=saved==null?null:(String)saved.get("phase");
        boolean migrating=saved!=null&&"agentcity.unirock-bank.v1".equals(saved.get("schema"));
        if(saved!=null)validateJournal(saved,migrating?"agentcity.unirock-bank.v1":"agentcity.unirock-bank.v2",world,migrating?previous:hash);
        Map<String,BlockData> states=new HashMap<>();
        Set<String> descriptors=new TreeSet<>(plan.values());descriptors.addAll(legacy.values());descriptors.add("minecraft:air");
        for(String state:descriptors) {
            try { states.put(state,Bukkit.createBlockData(state)); }
            catch(RuntimeException error) {
                plugin.getLogger().severe("UniRock public template block state refused: "+state);
                throw new IllegalArgumentException("unirock_template_block_state_invalid");
            }
        }
        if(migrating) {
            if(!"ready".equals(phase))throw new IllegalStateException("unirock_legacy_install_incomplete");
            migrate(plugin,world,marker,legacy,previous,hash,states);
        } else if(!"ready".equals(phase)) {
            // Initial retries adopt only exact template blocks or empty cells.
            for(Box box:SITE)for(int x=box.minX;x<=box.maxX;x++)for(int y=box.minY;y<=box.maxY;y++)for(int z=box.minZ;z<=box.maxZ;z++) {
                Block block=world.getBlockAt(x,y,z);
                if(block.getState() instanceof TileState)throw new IllegalStateException("unirock_site_contains_inventory_or_tile");
                String expected=plan.get(new Cell(x,y,z));
                if(phase!=null&&expected!=null&&matches(block,expected,states))continue;
                if(!block.getType().isAir())throw new IllegalStateException("unirock_site_not_clear");
            }
            saveMarker(marker,world,hash,"intent");
            for(var entry:plan.entrySet())set(world,entry.getKey(),entry.getValue(),states);
            world.save();saveMarker(marker,world,hash,"ready");
            plugin.getLogger().info("UniRock prepared as operator scenery only; no inventory or economic stock granted.");
        }
        // A completed Survival bank is editable; preserve changes on restart instead of rebuilding or refusing startup.
        if(migrating||!"ready".equals(phase)){
            for(var entry:plan.entrySet())if(!matches(at(world,entry.getKey()),entry.getValue(),states))throw new IllegalStateException("unirock_owned_build_changed");
            for(var entry:migrationDelta().entrySet())if(entry.getValue().after()==null&&!at(world,entry.getKey()).getType().isAir())throw new IllegalStateException("unirock_owned_clearance_changed");
        }
        return new UniRockBank(world,descriptors.size()-1);
    }
    record Change(String before,String after) {}
    static Map<Cell,Change> migrationDelta() {
        Map<Cell,String> old=legacyBlueprint(),next=blueprint();Map<Cell,Change> delta=new LinkedHashMap<>();
        Set<Cell> cells=new LinkedHashSet<>(old.keySet());cells.addAll(next.keySet());
        for(Cell cell:cells)if(!Objects.equals(old.get(cell),next.get(cell)))delta.put(cell,new Change(old.get(cell),next.get(cell)));
        return Collections.unmodifiableMap(delta);
    }
    private static void migrate(JavaPlugin plugin,World world,Path marker,Map<Cell,String> old,String previous,String hash,Map<String,BlockData> states) throws IOException {
        Path journal=marker.resolveSibling("unirock-bank-migration-v1-v2.json");
        Map<String,Object> migration=readJournal(journal);boolean resuming=migration!=null;
        if(resuming) {
            validateJournal(migration,"agentcity.unirock-bank-migration.v1-v2",world,hash);
            if(!previous.equals(migration.get("previousBlueprintSha256")))throw new IllegalStateException("unirock_migration_binding_changed");
        }
        Map<Cell,Change> delta=migrationDelta();
        // Validate every affected cell before the first write, including cells being cleared.
        for(var entry:delta.entrySet()) {
            Block block=at(world,entry.getKey());Change change=entry.getValue();
            if(block.getState() instanceof TileState||!migrationStateAllowed(matches(block,change.before(),states),matches(block,change.after(),states),resuming))throw new IllegalStateException("unirock_migration_unknown_block:"+entry.getKey());
        }
        for(var entry:old.entrySet())if(!delta.containsKey(entry.getKey())&&!matches(at(world,entry.getKey()),entry.getValue(),states))throw new IllegalStateException("unirock_owned_build_changed");
        Path archive=marker.resolveSibling("unirock-bank-v1.json");byte[] original=Files.readAllBytes(marker);
        if(Files.exists(archive,LinkOption.NOFOLLOW_LINKS)) {
            if(!Files.isRegularFile(archive,LinkOption.NOFOLLOW_LINKS)||!Arrays.equals(original,Files.readAllBytes(archive)))throw new IllegalStateException("unirock_legacy_archive_changed");
        } else saveBytes(archive,original);
        saveMigration(journal,world,previous,hash,"intent");
        for(var entry:delta.entrySet())set(world,entry.getKey(),entry.getValue().after(),states);
        world.save();saveMigration(journal,world,previous,hash,"ready");saveMarker(marker,world,hash,"ready");
        plugin.getLogger().info("UniRock v1-v2 decoration migration ready: "+delta.size()+" owned cells; inventories and work plots preserved.");
    }
    static boolean migrationStateAllowed(boolean matchesBefore,boolean matchesAfter,boolean resuming) { return matchesBefore||resuming&&matchesAfter; }
    private static Block at(World world,Cell cell) { return world.getBlockAt(cell.x,cell.y,cell.z); }
    private static boolean matches(Block block,String state,Map<String,BlockData> states) {
        return states.get(state==null?"minecraft:air":state).getAsString().equals(block.getBlockData().getAsString());
    }
    private static void set(World world,Cell cell,String state,Map<String,BlockData> states) { at(world,cell).setBlockData(states.get(state==null?"minecraft:air":state).clone(),false); }
    private static Map<String,Object> readJournal(Path path) throws IOException {
        if(!Files.exists(path,LinkOption.NOFOLLOW_LINKS))return null;
        if(!Files.isRegularFile(path,LinkOption.NOFOLLOW_LINKS))throw new IllegalStateException("unirock_marker_file");
        return StrictJson.object(Files.readString(path));
    }
    private static void validateJournal(Map<String,Object> saved,String schema,World world,String hash) {
        if(!schema.equals(saved.get("schema"))||!world.getUID().toString().equals(saved.get("worldUuid"))||!hash.equals(saved.get("blueprintSha256"))||!Set.of("intent","ready").contains(saved.get("phase")))throw new IllegalStateException("unirock_marker_binding_changed");
    }
    private static void saveMarker(Path path,World world,String hash,String phase) throws IOException {
        saveBytes(path,("{\"schema\":\"agentcity.unirock-bank.v2\",\"worldUuid\":\""+world.getUID()+"\",\"blueprintSha256\":\""+hash+"\",\"phase\":\""+phase+"\"}\n").getBytes(StandardCharsets.UTF_8));
    }
    private static void saveMigration(Path path,World world,String previous,String hash,String phase) throws IOException {
        saveBytes(path,("{\"schema\":\"agentcity.unirock-bank-migration.v1-v2\",\"worldUuid\":\""+world.getUID()+"\",\"blueprintSha256\":\""+hash+"\",\"previousBlueprintSha256\":\""+previous+"\",\"phase\":\""+phase+"\"}\n").getBytes(StandardCharsets.UTF_8));
    }
    private static void saveBytes(Path path,byte[] content) throws IOException {
        Files.createDirectories(path.getParent());Path temporary=path.resolveSibling(path.getFileName()+"."+UUID.randomUUID()+".tmp");
        try {
            try(FileChannel file=FileChannel.open(temporary,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE)) {
                ByteBuffer bytes=ByteBuffer.wrap(content);while(bytes.hasRemaining())file.write(bytes);file.force(true);
            }
            Files.move(temporary,path,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
            try(FileChannel directory=FileChannel.open(path.getParent(),StandardOpenOption.READ)){directory.force(true);}
        } finally { Files.deleteIfExists(temporary); }
    }
    static String planHash(Map<Cell,String> plan) throws Exception {
        MessageDigest hash=MessageDigest.getInstance("SHA-256");
        for(var entry:plan.entrySet().stream().sorted(Comparator.comparingInt((Map.Entry<Cell,String> e)->e.getKey().x).thenComparingInt(e->e.getKey().y).thenComparingInt(e->e.getKey().z)).toList())
            hash.update((entry.getKey().x+","+entry.getKey().y+","+entry.getKey().z+":"+entry.getValue()+"\n").getBytes(StandardCharsets.UTF_8));
        return HexFormat.of().formatHex(hash.digest());
    }
    Location spawn() { return new Location(world,1698.5,69,2808.5,0,0); }
    Location npcLocation(String key) {
        Integer x=DESKS.get(key);if(x==null)throw new IllegalArgumentException("unirock_npc_role");
        return new Location(world,x+0.5,69,2846.5,180,0);
    }
    Map<String,Location> agentDisplayLocations() {
        return Map.of("CityAgent4",new Location(world,1687.5,69,2812.5,180,0),"CityAgent5",new Location(world,1692.5,69,2812.5,180,0));
    }
    boolean contains(Location location) { return world.equals(location.getWorld())&&SITE.subList(0,4).stream().anyMatch(box->box.contains(location.getBlockX(),location.getBlockZ())); }
    static boolean agentPlot(String name,int x,int y,int z) {
        int minX="CityAgent4".equals(name)?1730:"CityAgent5".equals(name)?1746:Integer.MAX_VALUE;
        return minX!=Integer.MAX_VALUE&&x>=minX&&x<=minX+11&&y>=69&&y<=76&&z>=2810&&z<=2821;
    }
    static boolean buildArea(int x,int y,int z) {
        return y>=69&&y<=76&&z>=2812&&z<=2821&&(x>=1732&&x<=1741||x>=1748&&x<=1757);
    }
    static boolean anyAgentPlot(int x,int y,int z) { return agentPlot("CityAgent4",x,y,z)||agentPlot("CityAgent5",x,y,z); }
    Map<String,Object> status() { return Map.of("name","UniRock","ready",true,"operatorScenery",true,"stockGranted",0,"validatedBlockStates",validatedBlockStates,"templateVersion",2,"bounds",List.of(1660,68,2793,1722,94,2854)); }

    private static void fill(Map<Cell,String> plan,int x1,int y1,int z1,int x2,int y2,int z2,String state) {
        for(int x=x1;x<=x2;x++)for(int y=y1;y<=y2;y++)for(int z=z1;z<=z2;z++)plan.put(new Cell(x,y,z),"minecraft:"+state);
    }
    static Map<Cell,String> blueprint() {
        Map<Cell,String> plan=new LinkedHashMap<>(legacyBlueprint());
        // North-side visitors see screen-right toward decreasing world x; reflect the whole word.
        List<Cell> glyphs=plan.entrySet().stream().filter(e->e.getValue().equals("minecraft:gold_block")&&e.getKey().z==2799).map(Map.Entry::getKey).toList();
        for(Cell cell:glyphs)plan.remove(cell);
        for(Cell cell:glyphs)plan.put(new Cell(3382-cell.x,cell.y,cell.z),"minecraft:gold_block");
        for(int x:DESKS.values()) {
            clear(plan,x-3,69,2844,x+3,70,2844);
            clear(plan,x-3,69,2845,x-3,70,2848);
            clear(plan,x+3,69,2845,x+3,70,2848);
        }
        clear(plan,1684,69,2800,1699,81,2801);
        return Collections.unmodifiableMap(plan);
    }
    private static void clear(Map<Cell,String> plan,int x1,int y1,int z1,int x2,int y2,int z2) {
        plan.keySet().removeIf(at->at.x>=x1&&at.x<=x2&&at.y>=y1&&at.y<=y2&&at.z>=z1&&at.z<=z2);
    }
    static Map<Cell,String> legacyBlueprint() {
        Map<Cell,String> plan=new LinkedHashMap<>();
        // Pier and marble promenade connect to the original, preserved arrival pavement.
        fill(plan,1660,68,2793,1722,68,2854,"smooth_quartz");
        fill(plan,1641,68,2780,1645,68,2797,"smooth_quartz");
        fill(plan,1646,68,2793,1659,68,2797,"smooth_quartz");
        fill(plan,1641,68,2780,1645,68,2780,"smooth_quartz_slab[type=bottom]");
        fill(plan,1723,68,2814,1757,68,2816,"smooth_quartz");
        // Public access stays outside both build plots, so one owner's wall cannot cut off the other desk.
        fill(plan,1723,68,2808,1757,68,2809,"smooth_quartz");
        fill(plan,1723,68,2810,1729,68,2813,"smooth_quartz");
        fill(plan,1730,68,2810,1741,68,2821,"stone_bricks");
        fill(plan,1746,68,2810,1757,68,2821,"stone_bricks");
        for(int x=1661;x<=1721;x++)for(int z=2801;z<=2853;z++) {
            if(x<1664||x>1718||z<2804||z>2850)fill(plan,x,68,z,x,68,z,"polished_blackstone");
            else if((x+z)%9==0)fill(plan,x,68,z,x,68,z,"polished_diorite");
        }
        fill(plan,1688,68,2793,1694,68,2841,"cyan_terracotta");
        for(int x:new int[]{1660,1722})fill(plan,x,69,2800,x,83,2854,"smooth_quartz");
        for(int z:new int[]{2800,2854})fill(plan,1660,69,z,1722,83,z,"smooth_quartz");
        // Full glass blocks avoid unloaded pane-connection state changes during restart checks.
        for(int x=1663;x<=1719;x++)if(x%8!=3) {
            if(x<1686||x>1696)fill(plan,x,72,2800,x,80,2800,"cyan_stained_glass");
            fill(plan,x,72,2854,x,80,2854,"cyan_stained_glass");
        }
        for(int z=2804;z<=2850;z++)if(z%8!=4)for(int x:new int[]{1660,1722})fill(plan,x,72,z,x,80,z,"cyan_stained_glass");
        // The grand entrance stays physically open; no door, chest or other tile entity is added.
        for(int x=1686;x<=1696;x++)for(int y=69;y<=79;y++)plan.remove(new Cell(x,y,2800));
        for(int z=2813;z<=2817;z++)for(int y=69;y<=73;y++)plan.remove(new Cell(1722,y,z));
        for(int x:new int[]{1662,1670,1678,1686,1696,1704,1712,1720}) {
            fill(plan,x,69,2800,x+1,82,2801,"quartz_pillar[axis=y]");
            fill(plan,x-1,82,2799,x+2,83,2802,"chiseled_quartz_block");
        }
        fill(plan,1659,84,2799,1723,85,2855,"smooth_quartz");
        // Trim remains inside the preflight footprint.
        plan.keySet().removeIf(at->SITE.stream().noneMatch(box->at.x>=box.minX&&at.x<=box.maxX&&at.y>=box.minY&&at.y<=box.maxY&&at.z>=box.minZ&&at.z<=box.maxZ));
        fill(plan,1678,85,2818,1704,85,2838,"light_blue_stained_glass");
        fill(plan,1682,86,2822,1700,86,2834,"cyan_stained_glass");
        for(int x:new int[]{1665,1676,1687,1698,1709,1720})for(int z:new int[]{2807,2818,2829,2840,2851})fill(plan,x,83,z,x,83,z,"sea_lantern");
        // Five staffed service desks, seating alcoves, indoor planting and chandelier.
        for(int x:DESKS.values()) {
            fill(plan,x-3,69,2844,x+3,69,2844,"dark_oak_planks");
            fill(plan,x-3,70,2844,x+3,70,2844,"dark_oak_slab[type=bottom]");
            fill(plan,x-3,69,2845,x-3,70,2848,"dark_oak_planks");
            fill(plan,x+3,69,2845,x+3,70,2848,"dark_oak_planks");
            fill(plan,x-2,69,2849,x+2,71,2849,"bookshelf");
            fill(plan,x,69,2850,x,70,2850,"sea_lantern");
        }
        for(int x:new int[]{1666,1716})for(int z:new int[]{2812,2822,2832}) {
            fill(plan,x-1,69,z-2,x+1,69,z+2,"quartz_stairs[facing="+(x<1691?"east":"west")+"]");
            fill(plan,x-1,69,z-3,x+1,69,z-3,"dark_oak_trapdoor[half=bottom,open=true,facing=south]");
            fill(plan,x-1,69,z+3,x+1,69,z+3,"dark_oak_trapdoor[half=bottom,open=true,facing=north]");
        }
        for(int x:new int[]{1664,1718})for(int z:new int[]{2805,2840,2851}) {
            fill(plan,x,69,z,x+1,69,z+1,"polished_blackstone_bricks");
            fill(plan,x,70,z,x+1,72,z+1,"flowering_azalea_leaves[persistent=true]");
        }
        for(int x:new int[]{1688,1694})for(int z:new int[]{2823,2829}) {
            fill(plan,x,80,z,x,84,z,"iron_chain[axis=y]");fill(plan,x-1,79,z-1,x+1,79,z+1,"sea_lantern");
        }
        // Raised gold name on the front facade: UNI ROCK.
        String[][] letters={ {"10001","10001","10001","10001","10001","10001","01110"},
            {"10001","11001","11001","10101","10011","10011","10001"},
            {"11111","00100","00100","00100","00100","00100","11111"},
            {"11110","10001","10001","11110","10100","10010","10001"},
            {"01110","10001","10001","10001","10001","10001","01110"},
            {"01111","10000","10000","10000","10000","10000","01111"},
            {"10001","10010","10100","11000","10100","10010","10001"} };
        fill(plan,1668,86,2800,1713,94,2800,"polished_blackstone");
        int start=1670;
        for(int i=0;i<letters.length;i++)for(int row=0;row<7;row++)for(int col=0;col<5;col++)if(letters[i][row].charAt(col)=='1') {
            int x=start+i*6+col+(i>=3?2:0);fill(plan,x,93-row,2799,x,93-row,2799,"gold_block");
        }
        return Collections.unmodifiableMap(plan);
    }
}

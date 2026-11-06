package org.agentcity.inspection.fixture;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.*;
import java.util.concurrent.*;
import org.bukkit.*;
import org.bukkit.block.Chest;
import org.bukkit.entity.Player;
import org.bukkit.event.*;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.player.*;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.java.JavaPlugin;

/** One-shot world setup. Runtime fault control changes only one declared player's game mode. */
public final class WorldFixture extends JavaPlugin implements Listener {
    private static final Gson JSON=new Gson();
    private static final Set<String> NAMES=Set.of("WorldBuilder","WorldRequester","WorldInspector","WorldStranger");
    private final ExecutorService writer=Executors.newSingleThreadExecutor();
    private final Set<String> modeSteps=ConcurrentHashMap.newKeySet();
    private final Path root=Path.of(".");
    private World world;
    private JsonObject plan;
    private List<int[]> positions;
    private long tick;
    private volatile boolean failed;

    @Override public void onEnable() {
        try {
            if(!Boolean.getBoolean("agentcity.localFixture"))throw new IllegalStateException("explicit_local_fixture_required");
            plan=JSON.fromJson(Files.readString(root.resolve("boundary-fixture.json")),JsonObject.class);
            if(!plan.get("purpose").getAsString().equals("isolated_non_token_p1_boundary"))throw new IllegalArgumentException("fixture_purpose");
            world=Bukkit.getWorld(plan.get("world").getAsString());if(world==null)throw new IllegalArgumentException("fixture_world");
            JsonObject blueprint=JSON.fromJson(Files.readString(Path.of("plugins/AgentCity/blueprint.json")),JsonObject.class);
            positions=new ArrayList<>();
            for(JsonElement value:blueprint.getAsJsonArray("placements"))positions.add(absolute(value.getAsJsonObject().getAsJsonArray("position")));
            if(!Files.exists(root.resolve("fixture-initialized"))) {
                for(int x=-16;x<=15;x++)for(int z=-8;z<=7;z++) {
                    world.getBlockAt(x,80,z).setType(Material.STONE,false);
                    for(int y=81;y<=95;y++)world.getBlockAt(x,y,z).setType(Material.AIR,false);
                }
                // A declared pad outside the plot prevents fixture clients falling while connecting.
                for(int x=-19;x<=18;x++)for(int z=-11;z<=10;z++)if(x< -16||x>15||z< -8||z>7)world.getBlockAt(x,80,z).setType(Material.STONE,false);
                int[] omitted=position(plan.getAsJsonArray("placement_target"));
                for(JsonElement value:blueprint.getAsJsonArray("placements")) {
                    JsonObject p=value.getAsJsonObject();int[] xyz=absolute(p.getAsJsonArray("position"));
                    if(Arrays.equals(omitted,xyz))continue;
                    String spec=p.get("block").getAsString();List<String> fields=new ArrayList<>();
                    p.getAsJsonObject("properties").entrySet().forEach(e->fields.add(e.getKey()+"="+e.getValue().getAsString()));
                    if(!fields.isEmpty())spec+="["+String.join(",",fields)+"]";
                    world.getBlockAt(xyz[0],xyz[1],xyz[2]).setBlockData(Bukkit.createBlockData(spec),false);
                }
                world.getBlockAt(-14,81,5).setBlockData(Bukkit.createBlockData("minecraft:chest[facing=north,type=single,waterlogged=false]"),false);
                Chest stock=(Chest)world.getBlockAt(-14,81,5).getState();stock.getBlockInventory().clear();
                for(var entry:blueprint.getAsJsonObject("material_bill").entrySet()) {
                    Material item=Material.matchMaterial(entry.getKey());if(item==null)throw new IllegalArgumentException("stock_material");
                    if(!stock.getBlockInventory().addItem(new ItemStack(item,entry.getValue().getAsInt())).isEmpty())throw new IllegalStateException("stock_capacity");
                }
                world.setSpawnLocation(-15,81,-7);world.setTime(6000);world.setStorm(false);
                world.save();Files.writeString(root.resolve("fixture-initialized"),plan.get("run_id").getAsString()+"\n",StandardOpenOption.CREATE_NEW);
            } else if(!Files.readString(root.resolve("fixture-initialized")).equals(plan.get("run_id").getAsString()+"\n"))throw new IllegalStateException("fixture_identity_changed");
            getServer().getPluginManager().registerEvents(this,this);
            Bukkit.getScheduler().runTaskTimer(this,()->{tick++;if(tick%5==0)snapshot();},1,1);
            Bukkit.getScheduler().runTaskTimerAsynchronously(this,this::modeFault,5,5);
        }catch(Exception error){failed=true;getLogger().severe("Boundary fixture setup failed: "+error);getServer().shutdown();}
    }
    private static int[] position(JsonArray a){if(a.size()!=3)throw new IllegalArgumentException("position");return new int[]{a.get(0).getAsInt(),a.get(1).getAsInt(),a.get(2).getAsInt()};}
    private static int[] absolute(JsonArray a){int[] p=position(a);return new int[]{-12+p[0],81+p[1],-4+p[2]};}
    private static String key(int[] p){return p[0]+","+p[1]+","+p[2];}
    private static Map<String,Integer> counts(ItemStack[] items){Map<String,Integer> out=new TreeMap<>();for(ItemStack item:items)if(item!=null&&!item.getType().isAir())out.merge(item.getType().getKey().toString(),item.getAmount(),Integer::sum);return out;}
    @EventHandler public void join(PlayerJoinEvent e) {
        Player p=e.getPlayer();if(!NAMES.contains(p.getName())){p.kickPlayer("Isolated fixture identities only");return;}
        p.setOp(false);p.setGameMode(GameMode.SURVIVAL);p.setFoodLevel(20);p.setSaturation(20);
        try {
            Path marker=root.resolve("fixture-player-"+p.getUniqueId());
            if(!Files.exists(marker)) {
                p.getInventory().clear();
                if(p.getName().equals("WorldRequester"))p.getInventory().addItem(new ItemStack(Material.WATER_BUCKET),new ItemStack(Material.LAVA_BUCKET));
                if(p.getName().equals("WorldStranger"))p.getInventory().addItem(new ItemStack(Material.COBBLESTONE));
                Files.writeString(marker,p.getName()+"\n",StandardOpenOption.CREATE_NEW);
            }
            Location spawn=switch(p.getName()) {
                case "WorldBuilder"->new Location(world,-14.5,81,3.5);
                case "WorldRequester"->new Location(world,-12.5,81,-6.5);
                case "WorldInspector"->new Location(world,12.5,81,5.5);
                default->new Location(world,12.5,81,-6.5);
            };
            p.teleport(spawn);
            if(p.getName().equals("WorldStranger")){p.setDisplayName("WorldBuilder");p.setPlayerListName("WorldBuilder");}
            event("join",p,Map.of("display_name",p.getDisplayName(),"mode",p.getGameMode().name()));
        }catch(Exception error){failed=true;getLogger().severe("Fixture player initialization failed: "+error);getServer().shutdown();}
    }
    private void snapshot() {
        if(failed)return;
        Map<String,Object> out=new TreeMap<>();out.put("tick",tick);out.put("observed_at_ms",System.currentTimeMillis());
        Map<String,String> blocks=new TreeMap<>();for(int[] p:positions)blocks.put(key(p),world.getBlockAt(p[0],p[1],p[2]).getBlockData().getAsString());out.put("blocks",blocks);
        if(world.getBlockAt(-14,81,5).getState() instanceof Chest stock)out.put("stock",counts(stock.getBlockInventory().getContents()));else out.put("stock_error","missing_chest");
        Map<String,Object> players=new TreeMap<>();for(Player p:Bukkit.getOnlinePlayers())if(NAMES.contains(p.getName()))players.put(p.getName(),Map.of("uuid",p.getUniqueId().toString(),"display_name",p.getDisplayName(),"mode",p.getGameMode().name(),"items",counts(p.getInventory().getContents()),"position",List.of(p.getX(),p.getY(),p.getZ())));out.put("players",players);
        String value=JSON.toJson(out)+"\n";
        writer.execute(()->{try{Path temporary=root.resolve("boundary-observation.tmp");Files.writeString(temporary,value);Files.move(temporary,root.resolve("boundary-observation.json"),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);}catch(Exception e){failed=true;getLogger().severe("Fixture observation storage failed: "+e);}});
    }
    private void event(String type,Player p,Map<String,Object> detail) {
        Map<String,Object> out=new TreeMap<>(detail);out.put("event",type);out.put("actor",p.getUniqueId().toString());out.put("name",p.getName());out.put("tick",tick);out.put("at_ms",System.currentTimeMillis());
        String row=JSON.toJson(out)+"\n";writer.execute(()->{try{Files.writeString(root.resolve("boundary-events.jsonl"),row,StandardOpenOption.CREATE,StandardOpenOption.APPEND);}catch(Exception e){failed=true;}});
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=false) public void place(BlockPlaceEvent e){event("native_place",e.getPlayer(),Map.of("cancelled",e.isCancelled(),"block",e.getBlock().getBlockData().getAsString(),"position",List.of(e.getBlock().getX(),e.getBlock().getY(),e.getBlock().getZ())));}
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=false) public void remove(BlockBreakEvent e){event("native_break",e.getPlayer(),Map.of("cancelled",e.isCancelled(),"block",e.getBlock().getBlockData().getAsString(),"position",List.of(e.getBlock().getX(),e.getBlock().getY(),e.getBlock().getZ())));}
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=false) public void interact(PlayerInteractEvent e){if(e.getClickedBlock()!=null)event("interact",e.getPlayer(),Map.of("cancelled",e.isCancelled(),"action",e.getAction().name(),"use_block",e.useInteractedBlock().name(),"use_item",e.useItemInHand().name(),"position",List.of(e.getClickedBlock().getX(),e.getClickedBlock().getY(),e.getClickedBlock().getZ())));}
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=false) public void bucket(PlayerBucketEmptyEvent e){event("bucket_empty",e.getPlayer(),Map.of("cancelled",e.isCancelled(),"position",List.of(e.getBlock().getX(),e.getBlock().getY(),e.getBlock().getZ())));}
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=false) public void move(PlayerMoveEvent e){if(e.getTo()!=null&&(e.getFrom().getBlockX()!=e.getTo().getBlockX()||e.getFrom().getBlockY()!=e.getTo().getBlockY()||e.getFrom().getBlockZ()!=e.getTo().getBlockZ()))event("player_move_block",e.getPlayer(),Map.of("cancelled",e.isCancelled(),"from",List.of(e.getFrom().getX(),e.getFrom().getY(),e.getFrom().getZ()),"to",List.of(e.getTo().getX(),e.getTo().getY(),e.getTo().getZ())));}
    private void modeFault() {
        try {
            Path file=root.resolve("boundary-mode-step");if(!Files.isRegularFile(file))return;
            String step=Files.readString(file).trim();if(!Set.of("creative_begin","creative_end").contains(step)||!modeSteps.add(step))return;
            if(step.equals("creative_end")&&!modeSteps.contains("creative_begin"))throw new IllegalStateException("fault_order");
            Bukkit.getScheduler().runTask(this,()->{Player p=Bukkit.getPlayerExact("WorldBuilder");if(p==null){failed=true;return;}p.setGameMode(step.equals("creative_begin")?GameMode.CREATIVE:GameMode.SURVIVAL);event("sealed_mode_fault",p,Map.of("step",step,"mode",p.getGameMode().name()));});
        }catch(Exception e){failed=true;getLogger().severe("Fixture mode fault failed: "+e);}
    }
    @Override public void onDisable(){writer.shutdown();try{writer.awaitTermination(10,TimeUnit.SECONDS);}catch(InterruptedException e){Thread.currentThread().interrupt();}}
}

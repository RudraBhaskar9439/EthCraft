package org.agentcity.paper;

import com.google.gson.Gson;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.*;
import org.agentcity.core.Command;
import org.agentcity.core.JobEngine;
import org.agentcity.core.InspectionReport;
import org.bukkit.*;
import org.bukkit.block.Block;
import org.bukkit.block.Chest;
import org.bukkit.block.data.BlockData;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.*;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.inventory.InventoryOpenEvent;
import org.bukkit.event.player.*;
import org.bukkit.event.server.ServerCommandEvent;
import org.bukkit.event.server.PluginEnableEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.java.JavaPlugin;

/** Local non-token prototype. Real account/wallet verification remains a later gate. */
public final class AgentCityPlugin extends JavaPlugin implements Listener, PlotProtection.Authority {
    private static final Gson JSON=new Gson();
    private final Semaphore queuedCommands=new Semaphore(32);
    private final Deque<Long> commandTimes=new ArrayDeque<>();
    private long lastNativeInteraction=Long.MIN_VALUE;
    private final Map<UUID,String> sessions=new ConcurrentHashMap<>();
    private final Map<UUID,Arm> arms=new HashMap<>();
    private final List<String> refusals=new ArrayList<>();
    private final Clock clock=Clock.systemUTC();
    private JobEngine engine;
    private JobEngine.Config config;
    private Map<UUID,JobEngine.Role> roles;
    private World world;
    private WorldProjection projection;
    private CalculatorInspector inspector;
    private CalculatorInspector.Context inspectionContext;
    private final SortedMap<String,String> approved=new TreeMap<>();
    private final SortedMap<String,String> constructionAccess=new TreeMap<>();
    private final Set<String> repairRegion=new HashSet<>();
    private int[] min,max,chest;
    private String apiToken;
    private HttpServer http;
    private ExecutorService httpExecutor;
    private final ExecutorService reports=Executors.newSingleThreadExecutor();
    private boolean disabled;
    private String inspectionOwner;
    private UUID inspectionActor;
    private record Arm(Command command,String session,WorldProjection.Snapshot before,WorldProjection.Snapshot after) {}

    @Override public void onEnable() {
        try {
            if(!getServer().getOnlineMode() && !Boolean.getBoolean("agentcity.localFixture")) throw new IllegalStateException("offline_mode_requires_local_fixture");
            if(!java.util.Set.of("1.21.11","26.3").contains(Bukkit.getMinecraftVersion()))throw new IllegalStateException("unsupported_game_version");
            apiToken=System.getenv("AGENTCITY_API_TOKEN");
            if(apiToken==null||apiToken.length()<32)throw new IllegalStateException("api_credential_required");
            getDataFolder().mkdirs();
            Map<String,Object> d=StrictJson.object(Files.readString(getDataFolder().toPath().resolve("deployment.json")));
            Set<String> deploymentFields=new HashSet<>(Set.of("serverId","jobId","agreementVersion","authorizationReference","world","plotMin","plotMax","chest","actors","blueprintSha256","testManifestSha256","workDeadlineMs","reviewDeadlineMs","obligationMode","localPassValidityMs"));
            if(d.containsKey("constructionAccessSha256"))deploymentFields.add("constructionAccessSha256");
            if(!d.keySet().equals(deploymentFields))throw new IllegalArgumentException("deployment_fields");
            world=Bukkit.getWorld(text(d,"world"));if(world==null)throw new IllegalArgumentException("world_missing");
            min=position(d.get("plotMin"));max=position(d.get("plotMax"));chest=position(d.get("chest"));
            if(max[0]-min[0]!=31||max[1]-min[1]!=15||max[2]-min[2]!=15||min[1]<world.getMinHeight()||max[1]>=world.getMaxHeight())throw new IllegalArgumentException("plot_dimensions");
            roles=new HashMap<>();
            object(d.get("actors")).forEach((id,role)->roles.put(UUID.fromString(id),JobEngine.Role.valueOf((String)role)));
            if(roles.size()>8)throw new IllegalArgumentException("actor_limit");
            config=new JobEngine.Config(text(d,"serverId"),text(d,"jobId"),number(d,"agreementVersion"),new JobEngine.Bounds(min[0],min[1],min[2],max[0],max[1],max[2]),roles,text(d,"authorizationReference"),text(d,"blueprintSha256"),text(d,"testManifestSha256"),number(d,"workDeadlineMs"),number(d,"reviewDeadlineMs"),JobEngine.ObligationMode.valueOf(text(d,"obligationMode")),number(d,"localPassValidityMs"));
            if(config.obligationMode()!=JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS)throw new IllegalArgumentException("this_milestone_is_local_non_token_only");
            if(number(d,"reviewDeadlineMs")-number(d,"workDeadlineMs")!=900000)throw new IllegalArgumentException("deadline_schedule");
            if(!config.bounds().contains(chest[0],chest[1],chest[2]))throw new IllegalArgumentException("chest_outside_plot");
            for(int x=min[0]>>4;x<=max[0]>>4;x++)for(int z=min[2]>>4;z<=max[2]>>4;z++)world.getChunkAt(x,z);
            Set<UUID> physical=new HashSet<>();roles.forEach((id,role)->{if(role==JobEngine.Role.BOT||role==JobEngine.Role.BUILDER||role==JobEngine.Role.REQUESTER)physical.add(id);});
            if(physical.isEmpty())throw new IllegalArgumentException("physical_actor_required");
            projection=new WorldProjection(world,min,max,chest,physical);
            Path journal=getDataFolder().toPath().resolve("operations.journal"),marker=getDataFolder().toPath().resolve("initialized-job"),grant=getDataFolder().toPath().resolve("bootstrap-grant");
            String bootstrap=config.jobId()+"\n"+sha(Files.readAllBytes(getDataFolder().toPath().resolve("deployment.json")))+"\n";
            if(Files.exists(marker)) {
                if(!Files.isRegularFile(journal)||!Files.readString(marker).equals(bootstrap))throw new IllegalStateException("initialized_job_persistence_missing_or_changed");
            }else if(!Files.isRegularFile(grant)||!Files.readString(grant).equals(bootstrap))throw new IllegalStateException("explicit_new_job_bootstrap_required");
            engine=new JobEngine(journal,config,clock);
            if(!Files.exists(marker)) {
                byte[] bytes=bootstrap.getBytes(StandardCharsets.UTF_8);
                try(FileChannel file=FileChannel.open(marker,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE)){ByteBuffer buffer=ByteBuffer.wrap(bytes);while(buffer.hasRemaining())file.write(buffer);file.force(true);}
            }
            Files.deleteIfExists(grant);
            try(FileChannel directory=FileChannel.open(getDataFolder().toPath(),StandardOpenOption.READ)){directory.force(true);}
            loadBlueprint(text(d,"blueprintSha256"),text(d,"testManifestSha256"));
            if(d.containsKey("constructionAccessSha256"))loadConstructionAccess(text(d,"constructionAccessSha256"));
            for(var loaded:getServer().getPluginManager().getPlugins())if(!allowedPlugin(loaded.getName()))throw new IllegalStateException("unapproved_plugin:"+loaded.getName());
            getServer().getPluginManager().registerEvents(this,this);
            getServer().getPluginManager().registerEvents(new PlotProtection(world,min,max,this),this);
            for(Player player:Bukkit.getOnlinePlayers())session(player);
            System.setProperty("sun.net.httpserver.maxReqTime","5");
            System.setProperty("sun.net.httpserver.maxRspTime","5");
            http=HttpServer.create(new java.net.InetSocketAddress("0.0.0.0",25578),32);
            httpExecutor=new ThreadPoolExecutor(2,2,0,TimeUnit.SECONDS,new ArrayBlockingQueue<>(32),new ThreadPoolExecutor.AbortPolicy());
            http.setExecutor(httpExecutor);http.createContext("/",this::request);http.start();
            Bukkit.getScheduler().runTaskTimer(this,this::expireArms,1,1);
            getLogger().info("Local non-token AgentCity boundary active; control port must be published on host loopback only.");
        }catch(Exception e){disabled=true;getLogger().severe("AgentCity startup failed closed: "+e.getMessage());getServer().shutdown();}
    }
    private void loadBlueprint(String blueprintHash,String testsHash) throws Exception {
        Path blueprint=getDataFolder().toPath().resolve("blueprint.json"),tests=getDataFolder().toPath().resolve("tests.json");
        if(!sha(Files.readAllBytes(blueprint)).equals(blueprintHash)||!sha(Files.readAllBytes(tests)).equals(testsHash))throw new IllegalArgumentException("manifest_hash");
        Map<String,Object> b=StrictJson.object(Files.readString(blueprint)),t=StrictJson.object(Files.readString(tests));
        if(!"physically_validated".equals(b.get("status"))||!Boolean.TRUE.equals(t.get("timing_calibrated"))||!blueprintHash.equals(t.get("blueprint_sha256")))throw new IllegalArgumentException("unvalidated_manifest");
        for(Object entry:list(b.get("placements"))) {
            Map<String,Object> p=object(entry);int[] xyz=absolute(position(p.get("position")));
            BlockData data=Bukkit.createBlockData(text(p,"block"));
            Map<String,Object> props=object(p.get("properties"));
            if(!props.isEmpty())data=Bukkit.createBlockData(text(p,"block")+"["+String.join(",",props.entrySet().stream().map(e->e.getKey()+"="+e.getValue()).toList())+"]");
            if(!config.bounds().contains(xyz[0],xyz[1],xyz[2])||approved.put(WorldProjection.key(xyz[0],xyz[1],xyz[2]),WorldProjection.structural(data))!=null)throw new IllegalArgumentException("blueprint_bounds_or_duplicate");
        }
        List<CalculatorInspector.Port> inputs=new ArrayList<>(),outputs=new ArrayList<>();
        for(Object entry:list(b.get("inputs"))) {
            Map<String,Object> p=object(entry);int[] xyz=absolute(position(p.get("position")));
            requirePort(xyz,Material.LEVER);
            inputs.add(new CalculatorInspector.Port(text(p,"name"),xyz[0],xyz[1],xyz[2],Math.toIntExact(number(p,"weight")),text(p,"group")));
        }
        for(Object entry:list(b.get("outputs"))) {
            Map<String,Object> p=object(entry);int[] xyz=absolute(position(p.get("proposed_lamp_position")));
            requirePort(xyz,Material.REDSTONE_LAMP);
            outputs.add(new CalculatorInspector.Port(text(p,"name"),xyz[0],xyz[1],xyz[2],Math.toIntExact(number(p,"weight")),"output"));
            if(number(p,"weight")==4) {
                int[] source=absolute(position(p.get("source_position")));
                int[] expected=absolute(new int[]{11,6,0});
                if(!Arrays.equals(source,expected))throw new IllegalArgumentException("carry_source_mapping");
                requirePort(source,Material.REDSTONE_WALL_TORCH);repairRegion.add(WorldProjection.key(source[0],source[1],source[2]));
            }
        }
        Set<String> pairs=new HashSet<>();
        for(Object entry:list(t.get("cases"))) {
            Map<String,Object> row=object(entry);long a=number(row,"a"),v=number(row,"b");
            if(a<0||a>3||v<0||v>3||number(row,"expected")!=a+v||!pairs.add(a+","+v))throw new IllegalArgumentException("test_cases");
        }
        if(pairs.size()!=16||number(t,"reset_ticks")!=40||number(t,"settle_ticks")!=40||number(t,"stable_observations")!=5||number(t,"min_interaction_spacing_ns")!=500000000L||number(t,"min_interaction_spacing_ticks")!=10||number(t,"initialization_high_ticks")!=80||number(t,"initialization_low_ticks")!=80||number(t,"initialization_elapsed_ns_ceiling")!=30000000000L)throw new IllegalArgumentException("test_manifest");
        CalculatorInspector.Port anchor=inputs.stream().filter(port->port.name().equals("a0")).findFirst().orElseThrow();
        int[] expectedAnchor=absolute(new int[]{0,4,0});
        if(anchor.x()!=expectedAnchor[0]||anchor.y()!=expectedAnchor[1]||anchor.z()!=expectedAnchor[2])throw new IllegalArgumentException("control_origin_mapping");
        inspectionContext=new CalculatorInspector.Context(config.serverId(),config.jobId(),config.agreementVersion(),blueprintHash,testsHash);
        inspector=new CalculatorInspector(this,world,projection,inputs,outputs,()->{
            JobEngine.State state=engine.state();
            if(state.quarantined()||state.lockMode()!=JobEngine.LockMode.INSPECTION||inspectionActor==null||!engine.activeActor(inspectionActor)||clock.millis()>=config.workDeadlineMs())throw new IllegalStateException("inspection_authority_unavailable");
            return state.revision();
        },clock);
    }
    private void requirePort(int[] xyz,Material material) {
        String state=approved.get(WorldProjection.key(xyz[0],xyz[1],xyz[2]));
        if(!config.bounds().contains(xyz[0],xyz[1],xyz[2])||state==null||Bukkit.createBlockData(state).getMaterial()!=material)throw new IllegalArgumentException("port_outside_approved_interface");
    }
    private void loadConstructionAccess(String expectedHash) throws Exception {
        Path path = getDataFolder().toPath().resolve("construction-access.json");
        constructionAccess.putAll(ConstructionAccessPlan.load(path, expectedHash, min, max,
                absolute(new int[]{0, 0, 0}), chest, approved.keySet()));
    }
    private int[] absolute(int[] relative){return new int[]{Math.addExact(min[0]+4,relative[0]),Math.addExact(min[1]+1,relative[1]),Math.addExact(min[2]+4,relative[2])};}
    private void request(HttpExchange request) {
        try {
            if(!constant(apiToken,request.getRequestHeaders().getFirst("Authorization"),"Bearer ")){respond(request,401,Map.of("code","AUTHENTICATION"));return;}
            if(request.getRequestMethod().equals("GET")&&request.getRequestURI().getPath().equals("/status")) {
                if(!queuedCommands.tryAcquire()){respond(request,429,Map.of("code","QUEUE_FULL"));return;}
                engine.durableState().whenComplete((state,error)->sendAsync(request,error==null?200:503,error==null?Map.of("state",state,"refusals",refusals()):Map.of("code","STATE_UNAVAILABLE"),queuedCommands::release));return;
            }
            if(!request.getRequestMethod().equals("POST")||!request.getRequestURI().getPath().equals("/command")){respond(request,404,Map.of("code","NOT_FOUND"));return;}
            byte[] body=request.getRequestBody().readNBytes(65537);
            if(body.length>65536)throw new IllegalArgumentException("payload_size");
            Command command=Command.parse(StrictJson.object(new String(body,StandardCharsets.UTF_8)));
            String session=request.getRequestHeaders().getFirst("X-AgentCity-Session");
            if(!validSession(command.actorId(),session)){respond(request,401,Map.of("code","ACTOR_SESSION"));return;}
            if(!queuedCommands.tryAcquire()){respond(request,429,Map.of("code","QUEUE_FULL"));return;}
            if(!admitCommand()){queuedCommands.release();respond(request,429,Map.of("code","RATE_LIMIT"));return;}
            try {
                Bukkit.getScheduler().runTask(this,()->dispatch(command,session).orTimeout(12,TimeUnit.SECONDS).whenComplete((result,error)->sendAsync(request,error==null?200:409,error==null?result:Map.of("code","UNAVAILABLE","reason",safe(error)),queuedCommands::release)));
            }catch(Exception e){queuedCommands.release();throw e;}
        }catch(Exception e){respond(request,400,Map.of("code","INVALID_REQUEST","reason",safe(e)));}
    }
    private CompletableFuture<JobEngine.Result> dispatch(Command c,String session) {
        try {
            if(disabled||!validSession(c.actorId(),session))return refused(c,"ACTOR_SESSION");
            JobEngine.Result known=engine.lookup(c,c.actorId());if(known!=null)return CompletableFuture.completedFuture(known);
            if(c.action()==Command.Action.UNLOCK&&(inspector.running()||inspectionOwner!=null))return refused(c,"CHECKER_OWNS_LOCK");
            if(c.action()==Command.Action.DELIVER)return refused(c,"LIVE_DELIVERY_NOT_IMPLEMENTED");
            WorldProjection.Snapshot before=projection.observe();initialCustody(before);WorldProjection.Snapshot after=before.copy();
            if(c.structural()) {
                int x=(int)c.coordinate("x"),y=(int)c.coordinate("y"),z=(int)c.coordinate("z");String key=WorldProjection.key(x,y,z);
                if(!config.bounds().contains(x,y,z))return refused(c,"OUT_OF_BOUNDS");
                if(c.action()==Command.Action.BREAK) {
                    if(!approved.containsKey(key)||!approved.get(key).equals(before.blocks.get(key)))return refused(c,"UNEXPECTED_STRUCTURE");
                    after.block(x,y,z,"minecraft:air");
                }else {
                    BlockData desired=Bukkit.createBlockData((String)c.params().get("state"));String state=WorldProjection.structural(desired);
                    if(!state.equals(approved.get(key))||(c.action()==Command.Action.REPAIR&&!repairRegion.contains(key)))return refused(c,"UNAPPROVED_STATE_OR_REPAIR_REGION");
                    if(before.blocks.containsKey(key))return refused(c,"TARGET_OCCUPIED");
                    Player actor=Bukkit.getPlayer(c.actorId());if(actor==null)return refused(c,"ACTOR_OFFLINE");
                    after.consume(c.actorId(),actor.getInventory().getHeldItemSlot(),item(desired.getMaterial()));after.block(x,y,z,state);
                }
            }else if(c.action()==Command.Action.WITHDRAW||c.action()==Command.Action.RETURN) {
                Player actor=Bukkit.getPlayer(c.actorId());
                if(actor==null||actor.getOpenInventory().getTopInventory().getLocation()==null||!sameChest(actor.getOpenInventory().getTopInventory().getLocation()))return refused(c,"STOCK_NOT_OPEN");
                Material material=Material.matchMaterial((String)c.params().get("item"));
                if(material==null||approved.values().stream().map(s->item(Bukkit.createBlockData(s).getMaterial())).noneMatch(material::equals))return refused(c,"UNAPPROVED_ITEM");
                boolean withdraw=c.action()==Command.Action.WITHDRAW;
                after.transfer(withdraw?"stock":c.actorId().toString(),withdraw?c.actorId().toString():"stock",material,Math.toIntExact((Long)c.params().get("count")));
            }else if(c.action()==Command.Action.INSPECT){validateStructure(before);inspector.validate();}
            CompletableFuture<JobEngine.Result> response=new CompletableFuture<>();
            engine.prepare(c,c.actorId(),before.canonical(),after.canonical()).whenComplete((prepared,error)->Bukkit.getScheduler().runTask(this,()->{
                try {
                    if(error!=null){response.completeExceptionally(error);return;}
                    if(prepared.status()!=JobEngine.Status.PREPARED){response.complete(prepared);return;}
                    if(!validSession(c.actorId(),session)){response.complete(new JobEngine.Result(JobEngine.Status.REFUSED,"ACTOR_SESSION",c.operationId(),engine.state().revision()));return;}
                    if(c.structural()) {arms.put(c.actorId(),new Arm(c,session,before,after));response.complete(prepared);return;}
                    if((c.action()==Command.Action.WITHDRAW||c.action()==Command.Action.RETURN)&&!nativeBudget()) {
                        engine.reconcile(projection.observe().canonical());response.complete(new JobEngine.Result(JobEngine.Status.REFUSED,"RATE_LIMIT",c.operationId(),engine.state().revision()));return;
                    }
                    if(c.action()==Command.Action.UNLOCK&&(inspector.running()||inspectionOwner!=null)) {
                        engine.reconcile(projection.observe().canonical());response.complete(new JobEngine.Result(JobEngine.Status.REFUSED,"CHECKER_OWNS_LOCK",c.operationId(),engine.state().revision()));return;
                    }
                    JobEngine.Result authorized=engine.consumePrepared(c.operationId(),c.actorId(),projection.observe().canonical());
                    if(authorized.status()!=JobEngine.Status.AUTHORIZED){response.complete(authorized);return;}
                    if(c.action()==Command.Action.INSPECT){inspectionOwner=c.operationId();inspectionActor=c.actorId();}
                    if(c.action()==Command.Action.WITHDRAW||c.action()==Command.Action.RETURN){applyTransfer(after,c.actorId());lastNativeInteraction=System.nanoTime();}
                    saveWorld();engine.complete(c.operationId(),projection.observe().canonical()).whenComplete((completed,failure)->{
                        if(failure!=null)response.completeExceptionally(failure);else{
                            response.complete(completed);
                            if(c.action()==Command.Action.INSPECT) {
                                if(completed.status()==JobEngine.Status.APPLIED)Bukkit.getScheduler().runTask(this,()->inspect(c));
                                else if(completed.status()==JobEngine.Status.REFUSED)Bukkit.getScheduler().runTask(this,()->{if(c.operationId().equals(inspectionOwner)){inspectionOwner=null;inspectionActor=null;}});
                            }
                        }
                    });
                }catch(Exception failure){response.completeExceptionally(failure);}
            }));
            return response;
        }catch(Exception e){return CompletableFuture.completedFuture(new JobEngine.Result(JobEngine.Status.REFUSED,safe(e),c.operationId(),engine.state().revision()));}
    }
    private CompletableFuture<JobEngine.Result> refused(Command command,String code){return CompletableFuture.completedFuture(new JobEngine.Result(JobEngine.Status.REFUSED,code,command.operationId(),engine.state().revision()));}
    private void initialCustody(WorldProjection.Snapshot observed) {
        if(engine.hasObservedEffect()||engine.state().pendingOperation()!=null)return;
        roles.forEach((id,role)->{
            if(role==JobEngine.Role.BOT||role==JobEngine.Role.BUILDER)for(ItemStack item:observed.inventories.get(id.toString()))if(item!=null&&!item.getType().isAir())throw new IllegalStateException("initial_builder_inventory_must_be_empty");
        });
    }
    private void applyTransfer(WorldProjection.Snapshot after,UUID actor) {
        Chest stock=(Chest)world.getBlockAt(chest[0],chest[1],chest[2]).getState();
        stock.getBlockInventory().setContents(after.inventories.get("stock"));Bukkit.getPlayer(actor).getInventory().setContents(after.inventories.get(actor.toString()));
    }
    private void saveWorld(){world.save();for(UUID id:roles.keySet()){Player player=Bukkit.getPlayer(id);if(player!=null)player.saveData();}}
    private void validateStructure(WorldProjection.Snapshot snapshot) {
        for(var expected:approved.entrySet()) {
            String observed=snapshot.blocks.get(expected.getKey());
            // The disclosed missing carry feed must produce a retained failed electrical report.
            if(observed==null&&repairRegion.contains(expected.getKey()))continue;
            if(!expected.getValue().equals(observed))throw new IllegalStateException("blueprint_structure_mismatch:"+expected.getKey());
        }
        String stockState=WorldProjection.structural(Bukkit.createBlockData("minecraft:chest[facing=north,type=single,waterlogged=false]"));
        for(var block:snapshot.blocks.entrySet()) {
            if(approved.containsKey(block.getKey()))continue;
            if(block.getValue().equals(constructionAccess.get(block.getKey())))continue;
            String[] xyz=block.getKey().split(",");int x=Integer.parseInt(xyz[0]),y=Integer.parseInt(xyz[1]),z=Integer.parseInt(xyz[2]);
            if(y==min[1]&&block.getValue().equals("minecraft:stone"))continue;
            if(x==chest[0]&&y==chest[1]&&z==chest[2]&&block.getValue().equals(stockState))continue;
            throw new IllegalStateException("unexpected_plot_block:"+block.getKey());
        }
        for(var access:constructionAccess.entrySet())if(!access.getValue().equals(snapshot.blocks.get(access.getKey())))throw new IllegalStateException("construction_access_changed:"+access.getKey());
        for(int x=min[0];x<=max[0];x++)for(int z=min[2];z<=max[2];z++)if(!"minecraft:stone".equals(snapshot.blocks.get(WorldProjection.key(x,min[1],z))))throw new IllegalStateException("fixture_floor_missing");
    }
    private void inspect(Command command) {
        try {
            JobEngine.State state=engine.state();
            if(!command.operationId().equals(inspectionOwner)||state.lockMode()!=JobEngine.LockMode.INSPECTION||state.pendingOperation()!=null||state.quarantined()||state.revision()!=command.expectedRevision()||!engine.activeActor(command.actorId()))throw new IllegalStateException("inspection_start_context_lost");
            inspector.run(UUID.randomUUID().toString(),inspectionContext,engine.state().revision()).whenComplete((report,error)->{
                lastNativeInteraction=System.nanoTime();
                if(error!=null){unavailable("inspection_error");return;}
                CompletableFuture.runAsync(()->retain(report),reports).whenComplete((ignored,failure)->{
                    if(failure!=null){unavailable("report_storage_unavailable");return;}
                    Bukkit.getScheduler().runTask(this,()->{
                        try {
                            InspectionReport result=new InspectionReport(report.runId(),report.context().serverId(),report.context().jobId(),report.context().agreementVersion(),report.revision(),report.context().blueprintHash(),report.context().testVersion(),report.startedAtMs(),report.completedAtMs(),report.rows().stream().map(r->new InspectionReport.CaseResult(r.a(),r.b(),r.expected(),r.observed())).toList(),config.obligationMode());
                            engine.finishInspection(result,command.actorId(),projection.observe().canonical()).whenComplete((stored,storeError)->{
                                if(storeError==null&&(stored.status()==JobEngine.Status.APPLIED||stored.status()==JobEngine.Status.REPLAY))Bukkit.getScheduler().runTask(this,()->{if(command.operationId().equals(inspectionOwner)){inspectionOwner=null;inspectionActor=null;}});
                            });
                        }catch(Exception e){unavailable("inspection_report_rejected");}
                    });
                });
            });
        }catch(Exception e){unavailable(safe(e));}
    }
    private void retain(CalculatorInspector.Report report) {
        try {
            Path dir=getDataFolder().toPath().resolve("reports");Files.createDirectories(dir);
            byte[] bytes=(JSON.toJson(report)+"\n").getBytes(StandardCharsets.UTF_8);
            try(FileChannel file=FileChannel.open(dir.resolve(report.runId()+".json"),StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE)){
                ByteBuffer buffer=ByteBuffer.wrap(bytes);while(buffer.hasRemaining())file.write(buffer);file.force(true);
            }
            try(FileChannel directory=FileChannel.open(dir,StandardOpenOption.READ)){directory.force(true);}
        }catch(Exception e){throw new CompletionException(e);}
    }
    @Override public boolean place(BlockPlaceEvent event) {
        Arm arm=arms.get(event.getPlayer().getUniqueId());
        if(event.getPlayer().getGameMode()!=GameMode.SURVIVAL||!nativeBudget())return false;
        if(arm==null||arm.command().action()==Command.Action.BREAK||!nativeMatches(arm,event.getPlayer(),event.getBlock()))return false;
        if(!WorldProjection.structural(event.getBlock().getBlockData()).equals(arm.after().blocks.get(WorldProjection.key(event.getBlock().getX(),event.getBlock().getY(),event.getBlock().getZ()))))return false;
        WorldProjection.Snapshot before=projection.observe();before.block(event.getBlock().getX(),event.getBlock().getY(),event.getBlock().getZ(),WorldProjection.structural(event.getBlockReplacedState().getBlockData()));
        JobEngine.Result authorization=engine.consumePrepared(arm.command().operationId(),event.getPlayer().getUniqueId(),before.canonical());
        if(authorization.status()!=JobEngine.Status.AUTHORIZED)return false;
        lastNativeInteraction=System.nanoTime();arms.remove(event.getPlayer().getUniqueId());afterNative(arm);return true;
    }
    @Override public boolean remove(BlockBreakEvent event) {
        Arm arm=arms.get(event.getPlayer().getUniqueId());
        if(event.getPlayer().getGameMode()!=GameMode.SURVIVAL||!nativeBudget())return false;
        if(arm==null||arm.command().action()!=Command.Action.BREAK||!nativeMatches(arm,event.getPlayer(),event.getBlock()))return false;
        JobEngine.Result authorization=engine.consumePrepared(arm.command().operationId(),event.getPlayer().getUniqueId(),projection.observe().canonical());
        if(authorization.status()!=JobEngine.Status.AUTHORIZED)return false;
        // Explicit destructive repair consumes the removed block; it never creates replacement stock.
        event.setDropItems(false);event.setExpToDrop(0);lastNativeInteraction=System.nanoTime();arms.remove(event.getPlayer().getUniqueId());afterNative(arm);return true;
    }
    private boolean nativeMatches(Arm arm,Player actor,Block block) {
        Command c=arm.command();JobEngine.State state=engine.state();return !disabled&&engine.activeActor(actor.getUniqueId())&&clock.millis()<c.expiresAtMs()&&state.revision()==c.expectedRevision()&&state.lockMode()==JobEngine.LockMode.NONE&&c.operationId().equals(state.pendingOperation())&&validSession(actor.getUniqueId(),arm.session())&&block.getWorld().equals(world)
            &&block.getX()==c.coordinate("x")&&block.getY()==c.coordinate("y")&&block.getZ()==c.coordinate("z");
    }
    private void afterNative(Arm arm){Bukkit.getScheduler().runTask(this,()->{try{saveWorld();engine.complete(arm.command().operationId(),projection.observe().canonical());}catch(Exception e){unavailable("native_observation_unavailable");}});}
    @Override public boolean input(PlayerInteractEvent event) {
        if(disabled||event.getClickedBlock()==null)return false;Player actor=event.getPlayer();if(!engine.activeActor(actor.getUniqueId()))return false;Arm arm=arms.get(actor.getUniqueId());
        if(arm!=null&&arm.command().action()==Command.Action.BREAK&&event.getAction()==org.bukkit.event.block.Action.LEFT_CLICK_BLOCK&&event.getHand()==org.bukkit.inventory.EquipmentSlot.HAND&&nativeMatches(arm,actor,event.getClickedBlock())) {
            return true;
        }
        if(arm!=null&&arm.command().action()!=Command.Action.BREAK&&event.getAction()==org.bukkit.event.block.Action.RIGHT_CLICK_BLOCK&&event.getHand()==org.bukkit.inventory.EquipmentSlot.HAND) {
            Block target=event.getClickedBlock().getRelative(event.getBlockFace());
            if(nativeMatches(arm,actor,target)) {
                Material reference=event.getClickedBlock().getType();
                if(reference==Material.REPEATER||reference==Material.REDSTONE_WIRE) {
                    if(!actor.isSneaking())return false;
                    Material required=item(Bukkit.createBlockData((String)arm.command().params().get("state")).getMaterial());
                    if(actor.getGameMode()!=GameMode.SURVIVAL||actor.getInventory().getItemInMainHand().getType()!=required)return false;
                    // Sneaking suppresses repeater activation; DENY also prevents native item placement.
                    event.setUseInteractedBlock(Event.Result.DEFAULT);
                    event.setUseItemInHand(Event.Result.ALLOW);
                    return true;
                }
                return Set.of(Material.STONE,Material.STONE_BRICKS,Material.GLASS,Material.REDSTONE_LAMP,Material.REDSTONE_TORCH,Material.REDSTONE_WALL_TORCH).contains(reference);
            }
        }
        if(event.getAction()!=org.bukkit.event.block.Action.RIGHT_CLICK_BLOCK||actor.isSneaking()||event.getHand()!=org.bukkit.inventory.EquipmentSlot.HAND)return false;
        if(sameChest(event.getClickedBlock().getLocation())&&(roles.get(actor.getUniqueId())==JobEngine.Role.BOT||roles.get(actor.getUniqueId())==JobEngine.Role.BUILDER)) {
            event.setUseItemInHand(Event.Result.DENY);return true;
        }
        if(inspector.isInput(event.getClickedBlock())&&!inspector.running()&&engine.state().lockMode()!=JobEngine.LockMode.INSPECTION&&roles.get(actor.getUniqueId())==JobEngine.Role.REQUESTER&&nativeBudget()) {
            event.setUseItemInHand(Event.Result.DENY);lastNativeInteraction=System.nanoTime();return true;
        }
        return false;
    }
    @Override public boolean open(InventoryOpenEvent event) {
        return !disabled&&event.getPlayer() instanceof Player actor&&engine.activeActor(actor.getUniqueId())&&sameChest(event.getInventory().getLocation())
            &&(roles.get(actor.getUniqueId())==JobEngine.Role.BOT||roles.get(actor.getUniqueId())==JobEngine.Role.BUILDER);
    }
    @Override public boolean registered(Player player){return roles!=null&&roles.containsKey(player.getUniqueId());}
    @Override public void unavailable(String reason){if(inspector!=null)inspector.unavailable(reason);refused(reason);}
    private synchronized List<String> refusals(){return List.copyOf(refusals);}
    @Override public synchronized void refused(String reason){if(refusals.size()==256)refusals.remove(0);refusals.add(reason);}
    private synchronized boolean admitCommand(){long now=System.nanoTime();while(!commandTimes.isEmpty()&&now-commandTimes.peekFirst()>=1000000000L)commandTimes.removeFirst();if(commandTimes.size()>=2)return false;commandTimes.addLast(now);return true;}
    private boolean nativeBudget(){return lastNativeInteraction==Long.MIN_VALUE||System.nanoTime()-lastNativeInteraction>=500000000L;}
    private boolean sameChest(Location location){return location!=null&&location.getWorld().equals(world)&&location.getBlockX()==chest[0]&&location.getBlockY()==chest[1]&&location.getBlockZ()==chest[2];}
    private void expireArms(){
        if(engine==null||disabled)return;
        List<UUID> expired=arms.entrySet().stream().filter(e->clock.millis()>=e.getValue().command().expiresAtMs()||!validSession(e.getKey(),e.getValue().session())).map(Map.Entry::getKey).toList();
        for(UUID actor:expired)arms.remove(actor);
        if(!expired.isEmpty())try{engine.reconcile(projection.observe().canonical());}catch(Exception ignored){unavailable("expired_arm_observation_unavailable");}
    }
    private void session(Player player){
        if(!registered(player))return;byte[] random=new byte[32];new SecureRandom().nextBytes(random);String token=Base64.getUrlEncoder().withoutPadding().encodeToString(random);sessions.put(player.getUniqueId(),token);
        Bukkit.getScheduler().runTaskLater(this,()->{if(player.isOnline()&&validSession(player.getUniqueId(),token))player.sendMessage("AC_SESSION "+player.getUniqueId()+" "+token);},20);
    }
    @EventHandler public void join(PlayerJoinEvent event){session(event.getPlayer());Bukkit.getScheduler().runTaskLater(this,()->{try{if(arms.isEmpty()){WorldProjection.Snapshot observed=projection.observe();initialCustody(observed);engine.reconcile(observed.canonical());}}catch(Exception ignored){unavailable("awaiting_player_inventory");}},40);}
    @EventHandler public void quit(PlayerQuitEvent event){sessions.remove(event.getPlayer().getUniqueId());if(registered(event.getPlayer()))unavailable("actor_disconnected");}
    @EventHandler(priority=EventPriority.HIGHEST) public void commands(PlayerCommandPreprocessEvent event){if(!event.getMessage().equalsIgnoreCase("/agentcity session"))event.setCancelled(true);}
    @EventHandler(priority=EventPriority.HIGHEST) public void commands(ServerCommandEvent event){String command=event.getCommand().split(" ",2)[0].toLowerCase(Locale.ROOT);if(!Set.of("stop","list","save-all").contains(command))event.setCancelled(true);}
    @EventHandler public void plugin(PluginEnableEvent event){if(!allowedPlugin(event.getPlugin().getName())){disabled=true;unavailable("unapproved_plugin");getServer().shutdown();}}
    @Override public boolean onCommand(CommandSender sender,org.bukkit.command.Command command,String label,String[] args){if(sender instanceof Player player&&registered(player)&&args.length==1&&args[0].equals("session"))session(player);return true;}
    private boolean allowedPlugin(String name){
        if(name.equals("AgentCity"))return true;
        if(!Boolean.getBoolean("agentcity.localFixture"))return false;
        if(name.equals("AgentCityWorldFixture")||name.equals("AgentCityMaintainedNativeProbe"))return true;
        if(Bukkit.getMinecraftVersion().equals("26.3")&&(name.equals("ViaVersion")||name.equals("ViaBackwards"))){
            var plugin=getServer().getPluginManager().getPlugin(name);
            return plugin!=null&&plugin.getDescription().getVersion().equals("5.12.2");
        }
        return false;
    }
    private boolean validSession(UUID actor,String supplied){return sessions.containsKey(actor)&&constant(sessions.get(actor),supplied,"");}
    private static boolean constant(String expected,String supplied,String prefix){return expected!=null&&supplied!=null&&supplied.startsWith(prefix)&&MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),supplied.substring(prefix.length()).getBytes(StandardCharsets.UTF_8));}
    private static String safe(Throwable error){Throwable current=error;while(current.getCause()!=null)current=current.getCause();return current.getMessage()==null?current.getClass().getSimpleName():current.getMessage();}
    private static String sha(byte[] bytes)throws Exception{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}
    private void sendAsync(HttpExchange request,int status,Object result,Runnable cleanup){try{httpExecutor.execute(()->{try{respond(request,status,result);}finally{cleanup.run();}});}catch(RejectedExecutionException unavailable){request.close();cleanup.run();}}
    private static void respond(HttpExchange request,int status,Object result){try{byte[] bytes=JSON.toJson(result).getBytes(StandardCharsets.UTF_8);request.getResponseHeaders().set("Content-Type","application/json; charset=utf-8");request.sendResponseHeaders(status,bytes.length);try(var output=request.getResponseBody()){output.write(bytes);}}catch(Exception ignored){request.close();}}
    @SuppressWarnings("unchecked") private static Map<String,Object> object(Object value){if(!(value instanceof Map<?,?>))throw new IllegalArgumentException("object_required");return (Map<String,Object>)value;}
    @SuppressWarnings("unchecked") private static List<Object> list(Object value){if(!(value instanceof List<?>))throw new IllegalArgumentException("array_required");return (List<Object>)value;}
    private static String text(Map<String,Object> map,String key){if(!(map.get(key) instanceof String value)||value.isEmpty())throw new IllegalArgumentException("string_required:"+key);return value;}
    private static long number(Map<String,Object> map,String key){if(!(map.get(key) instanceof Long value))throw new IllegalArgumentException("integer_required:"+key);return value;}
    private static int[] position(Object value){List<Object> a=list(value);if(a.size()!=3)throw new IllegalArgumentException("position");int[] out=new int[3];for(int i=0;i<3;i++){if(!(a.get(i) instanceof Long n)||n< -1000000||n>1000000)throw new IllegalArgumentException("coordinate");out[i]=(int)(long)(Long)a.get(i);}return out;}
    private static Material item(Material block){return switch(block){case REDSTONE_WIRE->Material.REDSTONE;case REDSTONE_WALL_TORCH->Material.REDSTONE_TORCH;case WALL_TORCH->Material.TORCH;default->block;};}
    @Override public void onDisable(){disabled=true;if(http!=null)http.stop(0);if(httpExecutor!=null)httpExecutor.shutdownNow();reports.shutdown();if(engine!=null)try{engine.close();}catch(Exception e){getLogger().severe("Journal close failed: "+e.getMessage());}}
}

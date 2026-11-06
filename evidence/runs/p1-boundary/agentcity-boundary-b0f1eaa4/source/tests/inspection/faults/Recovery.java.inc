    private static final Set<String> RECOVERY_SCENARIOS=Set.of("crash-before-intent","crash-after-intent","crash-after-native-before-receipt","crash-after-applied-before-ack","partial-inventory-before-world-save");
    private boolean recoveryGateInstalled;
    private boolean recoveryChannelClosed;
    private boolean recoveryNativeAllowed;
    private volatile boolean recoveryHaltPending;
    private boolean recoveryScenario(){return RECOVERY_SCENARIOS.contains(faultScenario());}
    private Object member(Object value,String name) throws Exception {java.lang.reflect.Field field=value.getClass().getDeclaredField(name);field.setAccessible(true);return field.get(value);}
    private Object authority() {return Bukkit.getPluginManager().getPlugin("AgentCity");}
    private Object engine() throws Exception {return member(authority(),"engine");}
    private Object journal() throws Exception {return member(engine(),"journal");}
    @SuppressWarnings("unchecked") private List<Map<String,String>> journalRows() throws Exception {Object journal=journal();return (List<Map<String,String>>)journal.getClass().getMethod("records").invoke(journal);}
    private String recoveryOperation() throws Exception {
        JsonObject value=JSON.fromJson(Files.readString(root.resolve("recovery-operation.json")),JsonObject.class);
        if(!value.get("action").getAsString().equals("PLACE")||!value.get("jobId").getAsString().equals(plan.get("run_id").getAsString()))throw new IllegalArgumentException("recovery_operation_context");
        JsonObject params=value.getAsJsonObject("params");
        if(!params.keySet().equals(Set.of("x","y","z","state"))||params.get("x").getAsInt()!=-2||params.get("y").getAsInt()!=82||params.get("z").getAsInt()!=-4||!params.get("state").getAsString().equals("minecraft:redstone_wire"))throw new IllegalArgumentException("recovery_target_not_sealed");
        String id=value.get("operationId").getAsString();UUID.fromString(id);return id;
    }
    private boolean hasRow(String operation,String type) throws Exception {return journalRows().stream().anyMatch(row->operation.equals(row.get("op"))&&type.equals(row.get("type")));}
    private int carriedRedstone(){Player player=Bukkit.getPlayerExact("WorldBuilder");if(player==null)throw new IllegalStateException("recovery_actor_offline");return counts(player.getInventory().getContents()).getOrDefault("minecraft:redstone",0);}
    private boolean wirePresent(){return world.getBlockAt(-2,82,-4).getType()==Material.REDSTONE_WIRE;}
    private Map<String,Object> pendingDetails() throws Exception {
        Object pending=member(engine(),"pending");if(pending==null)return Map.of();
        Map<String,Object> out=new TreeMap<>();for(String key:List.of("id","durable","consumed","writing","before","after"))out.put(key,member(pending,key));return out;
    }
    private Object engineState() throws Exception {return engine().getClass().getMethod("state").invoke(engine());}
    private void durableJson(Path path,Object data) throws Exception {
        byte[] bytes=(JSON.toJson(data)+"\n").getBytes(StandardCharsets.UTF_8);
        Path temporary=path.resolveSibling(path.getFileName()+".tmp");
        try(java.nio.channels.FileChannel channel=java.nio.channels.FileChannel.open(temporary,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE)){
            java.nio.ByteBuffer buffer=java.nio.ByteBuffer.wrap(bytes);while(buffer.hasRemaining())channel.write(buffer);channel.force(true);
        }
        Files.move(temporary,path,StandardCopyOption.ATOMIC_MOVE);
        try(java.nio.channels.FileChannel directory=java.nio.channels.FileChannel.open(path.toAbsolutePath().getParent(),StandardOpenOption.READ)){directory.force(true);}
    }
    private void haltAt(String stage,String operation) throws Exception {
        if(!Boolean.getBoolean("agentcity.localFixture")||!world.getName().equals(plan.get("run_id").getAsString())||!world.getName().startsWith("agentcity-fault-")||!plan.getAsJsonObject("deployment").get("obligationMode").getAsString().equals("LOCAL_NO_EXTERNAL_OBLIGATIONS"))throw new IllegalStateException("owned_local_halt_context");
        Object journal=journal();
        synchronized(journal){
            boolean intent=hasRow(operation,"INTENT"),applied=hasRow(operation,"APPLIED");
            int carried=carriedRedstone();boolean wire=wirePresent();
            Map<String,Object> pending=pendingDetails();
            if(stage.equals("before_durable_intent")&&(!operation.equals(pending.get("id"))||Boolean.TRUE.equals(pending.get("durable"))||!Boolean.TRUE.equals(pending.get("writing"))))throw new IllegalStateException("receiving_before_intent_barrier_not_proved");
            if(stage.equals("before_durable_intent")&&(intent||applied||wire||carried!=1))throw new IllegalStateException("before_intent_point_not_proved");
            if(stage.equals("after_intent_before_native")&&(!intent||applied||wire||carried!=1))throw new IllegalStateException("after_intent_point_not_proved");
            if(stage.equals("after_native_effect_before_receipt")&&(!intent||applied||!wire||carried!=0||!(boolean)member(engine(),"ioFailed")))throw new IllegalStateException("missing_receipt_point_not_proved");
            if(stage.equals("after_durable_applied_before_workflow_ack")&&(!applied||!wire||carried!=0))throw new IllegalStateException("applied_point_not_proved");
            if(stage.equals("inventory_saved_world_save_not_run")&&(!intent||applied||!wire||carried!=0))throw new IllegalStateException("partial_durability_point_not_proved");
            Map<String,Object> point=new TreeMap<>();point.put("stage",stage);point.put("scenario",faultScenario());point.put("operation_id",operation);point.put("at_ms",System.currentTimeMillis());point.put("tick",Bukkit.getCurrentTick());point.put("target",List.of(-2,82,-4));point.put("actual_target",actual(new int[]{-2,82,-4}));point.put("carried_redstone",carried);point.put("ports",portStates());point.put("engine_state",engineState());point.put("pending",pendingDetails());point.put("journal_records",journalRows());point.put("journal_channel_open",((java.nio.channels.FileChannel)member(journal,"channel")).isOpen());point.put("native_event_ultimately_allowed",recoveryNativeAllowed);
            byte[] raw=Files.readAllBytes(root.resolve("plugins/AgentCity/operations.journal"));point.put("raw_journal_sha256",java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(raw)));
            durableJson(root.resolve("recovery-point.json"),point);
            // The JVM belongs to this uniquely labeled, isolated Docker test server.
            Runtime.getRuntime().halt(77);
        }
    }
    private void recoveryTick() throws Exception {
        if(Files.exists(root.resolve("recovery-point.json"))||recoveryHaltPending||!Files.exists(root.resolve("recovery-arm")))return;
        if(!Files.readString(root.resolve("recovery-arm")).equals(faultScenario()+"\n"))throw new IllegalArgumentException("sealed_recovery_arm_mismatch");
        String operation=recoveryOperation();
        if(faultScenario().equals("crash-before-intent")&&!recoveryGateInstalled){
            recoveryGateInstalled=true;Object engine=engine();ExecutorService io=(ExecutorService)member(engine,"io");
            io.submit(()->{
                try{
                    Files.writeString(root.resolve("recovery-gate-ready"),operation+"\n",StandardOpenOption.CREATE_NEW);
                    long deadline=System.nanoTime()+12000000000L;
                    while(System.nanoTime()<deadline){
                        Object state=engine.getClass().getMethod("state").invoke(engine);
                        String pending=(String)state.getClass().getMethod("pendingOperation").invoke(state);
                        if(operation.equals(pending)){
                            recoveryHaltPending=true;
                            Bukkit.getScheduler().runTask(this,()->{try{haltAt("before_durable_intent",operation);}catch(Exception error){faultError=error.toString();}});
                            new CountDownLatch(1).await(12,TimeUnit.SECONDS);throw new IllegalStateException("owned_process_did_not_halt");
                        }
                        Thread.sleep(5);
                    }
                    throw new IllegalStateException("receiver_pending_before_intent_not_observed");
                }catch(Exception error){faultError=error.toString();}
            });
        }else if(faultScenario().equals("crash-after-intent")&&hasRow(operation,"INTENT")&&!hasRow(operation,"APPLIED")){
            haltAt("after_intent_before_native",operation);
        }else if(faultScenario().equals("crash-after-native-before-receipt")&&recoveryChannelClosed&&recoveryNativeAllowed&&(boolean)member(engine(),"ioFailed")){
            haltAt("after_native_effect_before_receipt",operation);
        }else if(faultScenario().equals("crash-after-applied-before-ack")&&recoveryNativeAllowed&&hasRow(operation,"APPLIED")){
            haltAt("after_durable_applied_before_workflow_ack",operation);
        }
    }
    @EventHandler(priority=EventPriority.LOWEST,ignoreCancelled=false) public void recoveryPlaceLowest(BlockPlaceEvent event){
        if(!recoveryScenario()||!event.getPlayer().getName().equals("WorldBuilder")||event.getBlock().getX()!=-2||event.getBlock().getY()!=82||event.getBlock().getZ()!=-4||!Files.exists(root.resolve("recovery-arm")))return;
        try{
            String operation=recoveryOperation();if(!hasRow(operation,"INTENT")||hasRow(operation,"APPLIED"))throw new IllegalStateException("native_recovery_requires_durable_intent");
            if(faultScenario().equals("crash-after-native-before-receipt")){
                Object journal=journal();((java.nio.channels.FileChannel)member(journal,"channel")).close();recoveryChannelClosed=true;
                faultEvent("sealed_journal_channel_closed_after_intent",Map.of("operation_id",operation,"actual_target_in_event",actual(new int[]{-2,82,-4}),"carried_redstone_in_event",carriedRedstone(),"journal_records",journalRows()));
            }
            if(faultScenario().equals("partial-inventory-before-world-save"))Bukkit.getScheduler().runTask(this,()->{
                try{
                    if(event.isCancelled()||!event.canBuild()||!wirePresent()||carriedRedstone()!=0)throw new IllegalStateException("partial_native_event_not_ultimately_allowed");
                    recoveryNativeAllowed=true;event.getPlayer().saveData();haltAt("inventory_saved_world_save_not_run",operation);
                }catch(Exception error){faultError=error.toString();}
            });
        }catch(Exception error){faultError=error.toString();}
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=false) public void recoveryPlaceMonitor(BlockPlaceEvent event){
        if(!recoveryScenario()||!event.getPlayer().getName().equals("WorldBuilder")||event.getBlock().getX()!=-2||event.getBlock().getY()!=82||event.getBlock().getZ()!=-4)return;
        recoveryNativeAllowed=!event.isCancelled()&&event.canBuild();faultEvent("sealed_recovery_native_event_final",Map.of("cancelled",event.isCancelled(),"can_build",event.canBuild(),"actual_target",actual(new int[]{-2,82,-4}),"carried_redstone",carriedRedstone()));
    }

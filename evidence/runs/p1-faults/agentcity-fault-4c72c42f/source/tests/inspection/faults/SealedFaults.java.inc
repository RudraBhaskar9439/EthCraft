    // Test-only fixed controls. No command, arbitrary coordinate or stock edit endpoint exists.
    private boolean faultChunkFreeze;
    private boolean faultApplied;
    private volatile String faultError;
    private Map<String,Object> pendingUnloadPhase;
    private Map<String,Object> actualUnloadPhase;
    private int unloadAttempts;
    private static final Map<String,int[]> PORTS=Map.of(
        "a0",new int[]{-12,85,-4},"a1",new int[]{-8,84,-3},
        "b0",new int[]{-12,84,-3},"b1",new int[]{-8,82,-3},
        "s0",new int[]{-8,88,-5},"s1",new int[]{1,90,-2},"c1",new int[]{-1,87,-5});
    private String faultScenario(){return plan.get("fault_scenario").getAsString();}
    private boolean unloadScenario(){return faultScenario().startsWith("unloaded-chunk-s1-");}
    private boolean preflightScenario(){return faultScenario().endsWith("-preflight");}
    private int[] faultTarget(){
        if(recoveryScenario())return new int[]{-2,82,-4};
        if(faultScenario().startsWith("missing-lamp-s0-"))return PORTS.get("s0");
        if(faultScenario().startsWith("wrong-input-a0-"))return PORTS.get("a0");
        if(faultScenario().startsWith("missing-input-support-a0-"))return new int[]{-12,84,-4};
        if(unloadScenario())return PORTS.get("s1");
        if(faultScenario().startsWith("adapter-unavailable-"))return PORTS.get("a0");
        throw new IllegalArgumentException("unrecognized_sealed_fault");
    }
    private void validateFaultScenario(){
        Set<String> allowed=new HashSet<>(Set.of("missing-lamp-s0-preflight","wrong-input-a0-preflight","missing-input-support-a0-preflight"));
        for(String kind:List.of("missing-lamp-s0","wrong-input-a0","missing-input-support-a0","adapter-unavailable","unloaded-chunk-s1"))
            for(String window:List.of("input_setting","lamp_measurement"))allowed.add(kind+"-"+window);
        allowed.addAll(RECOVERY_SCENARIOS);
        if(!allowed.contains(faultScenario()))throw new IllegalArgumentException("unknown_sealed_scenario");
    }
    private String actual(int[] xyz){
        if(!world.isChunkLoaded(xyz[0]>>4,xyz[2]>>4))return "UNAVAILABLE_CHUNK";
        return world.getBlockAt(xyz[0],xyz[1],xyz[2]).getBlockData().getAsString();
    }
    private Map<String,Object> portStates(){
        Map<String,Object> out=new TreeMap<>();PORTS.forEach((name,xyz)->out.put(name,Map.of("position",List.of(xyz[0],xyz[1],xyz[2]),"actual",actual(xyz))));
        out.put("a0_support",Map.of("position",List.of(-12,84,-4),"actual",actual(new int[]{-12,84,-4})));return out;
    }
    private void faultEvent(String event,Map<String,Object> fields){
        try{
            Map<String,Object> out=new TreeMap<>(fields);out.put("event",event);out.put("scenario",faultScenario());out.put("tick",Bukkit.getCurrentTick());out.put("at_ms",System.currentTimeMillis());
            Files.writeString(root.resolve("fault-events.jsonl"),JSON.toJson(out)+"\n",StandardOpenOption.CREATE,StandardOpenOption.APPEND);
        }catch(Exception error){throw new IllegalStateException("fault_evidence_write",error);}
    }
    private void bootstrapFault(){
        validateFaultScenario();
        if(unloadScenario()){
            // Move all player/spawn tickets away before inspection. Fixed diagnostic landing only.
            world.setKeepSpawnInMemory(false);world.setSpawnLocation(513,81,513);
            for(int x=512;x<=515;x++)for(int z=512;z<=515;z++)world.getBlockAt(x,80,z).setType(Material.STONE,false);
            for(int x=-1;x<=0;x++)for(int z=-1;z<=0;z++){world.getChunkAt(x,z);world.setChunkForceLoaded(x,z,false);world.addPluginChunkTicket(x,z,this);}
        }
        if(preflightScenario()){
            int[] xyz=faultTarget();String before=actual(xyz);
            world.getBlockAt(xyz[0],xyz[1],xyz[2]).setType(faultScenario().startsWith("wrong-input")?Material.STONE:Material.AIR,false);
            faultEvent("sealed_bootstrap_fault",Map.of("position",List.of(xyz[0],xyz[1],xyz[2]),"before",before,"after",actual(xyz),"ports",portStates()));
            try{Files.writeString(root.resolve("fault-applied"),faultScenario()+"\n",StandardOpenOption.CREATE_NEW);}catch(Exception error){throw new IllegalStateException(error);}
            faultApplied=true;
        }
    }
    private void faultJoin(Player player){
        validateFaultScenario();
        if(unloadScenario()){
            int offset=switch(player.getName()){case "WorldBuilder"->0;case "WorldRequester"->1;case "WorldInspector"->2;default->3;};
            player.teleport(new Location(world,512.5+offset,81,513.5));
        }
    }
    private Map<String,Object> checkerPhase(){
        try{
            for(org.bukkit.scheduler.BukkitTask task:Bukkit.getScheduler().getPendingTasks()){
                if(!task.getOwner().getName().equals("AgentCity"))continue;
                Object runnable=task.getClass().getField("rTask").get(task);
                if(runnable==null||!runnable.getClass().getName().equals("org.agentcity.paper.CalculatorInspector$1"))continue;
                Map<String,Object> state=new TreeMap<>();state.put("task_id",task.getTaskId());state.put("task_class",runnable.getClass().getName());
                for(String name:List.of("phase","index","ticks")){java.lang.reflect.Field field=runnable.getClass().getDeclaredField(name);field.setAccessible(true);state.put(name,field.getInt(runnable));}
                return state;
            }
            return Map.of();
        }catch(Exception error){throw new IllegalStateException("exact_checker_barrier_unavailable",error);}
    }
    private void faultSnapshot(){
        Map<String,Object> out=new TreeMap<>();out.put("at_ms",System.currentTimeMillis());out.put("tick",Bukkit.getCurrentTick());out.put("scenario",faultScenario());out.put("fault_applied",faultApplied);out.put("chunk_snapshot_freeze",faultChunkFreeze);out.put("ports",portStates());out.put("checker",checkerPhase());
        int[] target=faultTarget();out.put("target_chunk_loaded",world.isChunkLoaded(target[0]>>4,target[2]>>4));
        out.put("target_actual",actual(target));
        Map<String,Object> players=new TreeMap<>();for(Player p:Bukkit.getOnlinePlayers())if(NAMES.contains(p.getName()))players.put(p.getName(),Map.of("uuid",p.getUniqueId().toString(),"mode",p.getGameMode().name(),"position",List.of(p.getX(),p.getY(),p.getZ()),"items",counts(p.getInventory().getContents())));out.put("players",players);
        if(world.isChunkLoaded(-14>>4,5>>4)&&world.getBlockAt(-14,81,5).getState() instanceof Chest stock)out.put("stock",counts(stock.getBlockInventory().getContents()));else out.put("stock_unavailable",true);
        if(faultError!=null)out.put("fixture_error",faultError);
        String encoded=JSON.toJson(out)+"\n";writer.execute(()->{try{Path temp=root.resolve("fault-observation.tmp");Files.writeString(temp,encoded);Files.move(temp,root.resolve("fault-observation.json"),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);}catch(Exception error){failed=true;}});
    }
    private void sealedFaultTick(){
        try{
            validateFaultScenario();
            if(recoveryScenario()){recoveryTick();if(tick%5==0)faultSnapshot();return;}
            if(Files.exists(root.resolve("fault-applied")))faultApplied=true;
            if(!faultApplied&&pendingUnloadPhase!=null&&!world.isChunkLoaded(faultTarget()[0]>>4,faultTarget()[2]>>4)){
                if(actualUnloadPhase==null||!Objects.equals(actualUnloadPhase.get("phase"),pendingUnloadPhase.get("phase"))||!Objects.equals(actualUnloadPhase.get("index"),pendingUnloadPhase.get("index")))throw new IllegalStateException("chunk_unload_not_proved_in_declared_window");
                faultApplied=true;Files.writeString(root.resolve("fault-applied"),faultScenario()+"\n",StandardOpenOption.CREATE_NEW);
                faultEvent("sealed_active_fault_after",Map.of("checker",actualUnloadPhase,"requested_checker",pendingUnloadPhase,"ports",portStates(),"target_chunk_loaded",false));
            }
            if(!faultApplied&&!preflightScenario()&&Files.exists(root.resolve("fault-arm"))){
                if(!Files.readString(root.resolve("fault-arm")).equals(faultScenario()+"\n"))throw new IllegalArgumentException("sealed_fault_arm_mismatch");
                Map<String,Object> phase=checkerPhase();boolean setting=faultScenario().endsWith("-input_setting");
                if(!phase.isEmpty()&&((setting&&(int)phase.get("phase")==3&&(int)phase.get("index")==3)||(!setting&&(int)phase.get("phase")==5&&(int)phase.get("index")==0))){
                    int[] target=faultTarget();Map<String,Object> before=portStates();
                    faultEvent("sealed_active_fault_before",Map.of("checker",phase,"ports",before,"target_chunk_loaded",world.isChunkLoaded(target[0]>>4,target[2]>>4)));
                    boolean applied=true;
                    if(unloadScenario()){
                        if(++unloadAttempts>6)throw new IllegalStateException("real_chunk_unload_not_achieved");
                        faultChunkFreeze=true;world.removePluginChunkTickets(this);pendingUnloadPhase=phase;
                        boolean requested=world.unloadChunk(target[0]>>4,target[2]>>4,true);
                        applied=!world.isChunkLoaded(target[0]>>4,target[2]>>4);
                        faultEvent("sealed_unload_attempt",Map.of("checker",phase,"request_accepted",requested,"actual_unloaded",applied,"loaded_after",world.isChunkLoaded(target[0]>>4,target[2]>>4),"plugin_tickets",world.getPluginChunkTickets(target[0]>>4,target[2]>>4).stream().map(org.bukkit.plugin.Plugin::getName).toList()));
                    }else if(faultScenario().startsWith("adapter-unavailable-")){
                        org.bukkit.plugin.Plugin authority=Bukkit.getPluginManager().getPlugin("AgentCity");
                        authority.getClass().getMethod("unavailable",String.class).invoke(authority,"sealed_test_adapter_unavailable");
                    }else world.getBlockAt(target[0],target[1],target[2]).setType(faultScenario().startsWith("wrong-input")?Material.STONE:Material.AIR,true);
                    if(applied){
                        faultApplied=true;Files.writeString(root.resolve("fault-applied"),faultScenario()+"\n",StandardOpenOption.CREATE_NEW);
                        faultEvent("sealed_active_fault_after",Map.of("checker",phase,"ports",portStates(),"target_chunk_loaded",world.isChunkLoaded(target[0]>>4,target[2]>>4)));
                    }
                }
            }
            if(tick%5==0)faultSnapshot();
        }catch(Exception error){faultError=error.toString();failed=true;getLogger().severe("Sealed fault fixture failed: "+error);try{faultSnapshot();}catch(Exception ignored){}}
    }
    @EventHandler(priority=EventPriority.MONITOR,ignoreCancelled=false) public void sealedChunkUnload(org.bukkit.event.world.ChunkUnloadEvent event){
        if(!unloadScenario()||pendingUnloadPhase==null||event.getWorld()!=world||event.getChunk().getX()!=(faultTarget()[0]>>4)||event.getChunk().getZ()!=(faultTarget()[2]>>4))return;
        actualUnloadPhase=checkerPhase();faultEvent("actual_chunk_unload_event",Map.of("checker",actualUnloadPhase,"chunk",List.of(event.getChunk().getX(),event.getChunk().getZ())));
    }

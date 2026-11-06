package org.agentcity.paper;

import java.time.Clock;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.function.LongSupplier;
import org.bukkit.Bukkit;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.data.Lightable;
import org.bukkit.block.data.Powerable;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitRunnable;

/** The oracle reads lamps; arithmetic is only the independent expected value. */
final class CalculatorInspector {
    record Port(String name,int x,int y,int z,int weight,String group) {}
    record Context(String serverId,String jobId,long agreementVersion,String blueprintHash,String testVersion) {}
    record Sample(long tick,long elapsedNs,List<Boolean> controls,List<Boolean> lamps) {}
    record Row(int a,int b,int expected,int observed,List<Boolean> lamps,long elapsedMs,long resetElapsedNs,long settleElapsedNs,List<Sample> stableObservations) {}
    record Report(String runId,Context context,long revision,long startedAtMs,long completedAtMs,String status,String reason,List<Sample> initialization,List<Row> rows) {}
    private final JavaPlugin plugin;
    private final World world;
    private final WorldProjection projection;
    private final List<Port> inputs,outputs;
    private final LongSupplier revision;
    private final Clock clock;
    private boolean running;
    private volatile String unavailable;
    private long lastPull,inspectionTick,lastPullTick;
    private boolean setInputs(int a,int b) {
        validate();
        for(Port p:inputs) {
            boolean desired=((p.group().equals("a")?a:b)&p.weight())!=0;
            if(((Powerable)block(p).getBlockData()).isPowered()==desired)continue;
            if(inspectionTick-lastPullTick<10||System.nanoTime()-lastPull<500000000L)return false;
            NativeLever.set(block(p),desired);lastPull=System.nanoTime();lastPullTick=inspectionTick;return false;
        }
        return true;
    }
    CalculatorInspector(JavaPlugin plugin,World world,WorldProjection projection,List<Port> inputs,List<Port> outputs,LongSupplier revision,Clock clock) {
        this.plugin=plugin;this.world=world;this.projection=projection;this.inputs=List.copyOf(inputs);this.outputs=List.copyOf(outputs);this.revision=revision;this.clock=clock;
        if(inputs.size()!=4||outputs.size()!=3||!new HashSet<>(inputs.stream().map(Port::name).toList()).equals(Set.of("a0","a1","b0","b1"))
            ||!new HashSet<>(outputs.stream().map(Port::name).toList()).equals(Set.of("s0","s1","c1")))throw new IllegalArgumentException("interface_mapping");
        Port anchor=inputs.stream().filter(p->p.name().equals("a0")).findFirst().orElseThrow();
        int ox=anchor.x(),oy=anchor.y()-4,oz=anchor.z();
        Map<String,int[]> coordinates=Map.of("a0",new int[]{0,4,0},"a1",new int[]{4,3,1},"b0",new int[]{0,3,1},"b1",new int[]{4,1,1},"s0",new int[]{4,7,-1},"s1",new int[]{13,9,2},"c1",new int[]{11,6,-1});
        for(Port p:java.util.stream.Stream.concat(inputs.stream(),outputs.stream()).toList()) {
            int[] expected=coordinates.get(p.name());
            int weight=Set.of("a0","b0","s0").contains(p.name())?1:p.name().equals("c1")?4:2;
            String group=p.name().startsWith("a")?"a":p.name().startsWith("b")?"b":"output";
            if(p.x()!=ox+expected[0]||p.y()!=oy+expected[1]||p.z()!=oz+expected[2]||p.weight()!=weight||!p.group().equals(group))throw new IllegalArgumentException("interface_mapping");
        }
    }
    boolean running(){return running;}
    void unavailable(String reason){unavailable=reason;}
    boolean isInput(Block block) {return inputs.stream().anyMatch(p->p.x()==block.getX()&&p.y()==block.getY()&&p.z()==block.getZ());}
    private Block block(Port port){return world.getBlockAt(port.x(),port.y(),port.z());}
    void validate() {
        if(!projection.loaded())throw new IllegalStateException("plot_unloaded");
        for(Port p:inputs) {
            if(block(p).getType()!=org.bukkit.Material.LEVER||!(block(p).getBlockData() instanceof org.bukkit.block.data.type.Switch lever))throw new IllegalStateException("input_missing_or_wrong_type:"+p.name());
            org.bukkit.block.BlockFace support=switch(lever.getAttachedFace()) {
                case FLOOR -> org.bukkit.block.BlockFace.DOWN;
                case CEILING -> org.bukkit.block.BlockFace.UP;
                case WALL -> lever.getFacing().getOppositeFace();
            };
            if(!block(p).getRelative(support).getType().isSolid())throw new IllegalStateException("input_support_missing:"+p.name());
        }
        for(Port p:outputs)if(block(p).getType()!=org.bukkit.Material.REDSTONE_LAMP||!(block(p).getBlockData() instanceof Lightable))throw new IllegalStateException("lamp_missing_or_wrong_type:"+p.name());
    }
    private List<Boolean> controls(){return inputs.stream().map(p->((Powerable)block(p).getBlockData()).isPowered()).toList();}
    private List<Boolean> expectedControls(int a,int b){return inputs.stream().map(p->((p.group().equals("a")?a:b)&p.weight())!=0).toList();}
    private List<Boolean> lamps() {
        validate();return outputs.stream().map(p->((Lightable)block(p).getBlockData()).isLit()).toList();
    }
    CompletableFuture<Report> run(String runId,Context context,long lockedRevision) {
        if(!Bukkit.isPrimaryThread())throw new IllegalStateException("game_thread_required");
        if(running)throw new IllegalStateException("inspection_busy");
        validate();running=true;unavailable=null;lastPull=System.nanoTime();inspectionTick=0;lastPullTick=0;
        CompletableFuture<Report> result=new CompletableFuture<>();long start=clock.millis(),startNanos=System.nanoTime();List<Row> rows=new ArrayList<>();List<Sample> initialization=new ArrayList<>();
        new BukkitRunnable() {
            int index=0,ticks=0,phase=-4;long caseStart=startNanos,lastWall=start,resetStart,resetElapsed,settleStart;List<Boolean> stable;List<Sample> samples;
            void finish(String status,String reason) {
                running=false;cancel();result.complete(new Report(runId,context,lockedRevision,start,clock.millis(),status,reason,List.copyOf(initialization),List.copyOf(rows)));
            }
            @Override public void run() {
                try {
                    if(unavailable!=null)throw new IllegalStateException(unavailable);
                    if(revision.getAsLong()!=lockedRevision)throw new IllegalStateException("revision_changed");
                    long wall=clock.millis(),nanos=System.nanoTime();
                    if(wall<lastWall)throw new IllegalStateException("authority_clock_reversed");lastWall=wall;
                    if(nanos-startNanos>=180000000000L||nanos-caseStart>=(phase<0?30000000000L:15000000000L))throw new IllegalStateException("inspection_timeout");
                    validate();inspectionTick++;int a=index/4,b=index%4;
                    if(phase==-4){if(setInputs(3,3)){ticks=0;phase=-3;}return;}
                    if(phase==-3){if(++ticks>=80){initialization.add(new Sample(inspectionTick,System.nanoTime()-startNanos,controls(),lamps()));phase=-2;}return;}
                    if(phase==-2){if(setInputs(0,0)){ticks=0;phase=-1;}return;}
                    if(phase==-1){if(++ticks>=80){initialization.add(new Sample(inspectionTick,System.nanoTime()-startNanos,controls(),lamps()));phase=0;caseStart=System.nanoTime();}return;}
                    if(phase==0){caseStart=System.nanoTime();resetStart=caseStart;phase=1;return;}
                    if(phase==1){if(setInputs(0,0)){ticks=0;phase=2;}return;}
                    if(phase==3){if(setInputs(a,b)){ticks=0;phase=4;}return;}
                    ticks++;
                    if(phase==2&&ticks>=40){resetElapsed=System.nanoTime()-resetStart;settleStart=System.nanoTime();phase=3;return;}
                    if(phase==4&&ticks>=40){if(!controls().equals(expectedControls(a,b)))throw new IllegalStateException("input_state_mismatch");stable=lamps();samples=new ArrayList<>();samples.add(new Sample(inspectionTick,System.nanoTime()-caseStart,controls(),stable));ticks=0;phase=5;return;}
                    if(phase==5){
                        List<Boolean> current=lamps();
                        if(!stable.equals(current))throw new IllegalStateException("unstable_outputs");
                        if(!controls().equals(expectedControls(a,b)))throw new IllegalStateException("input_state_mismatch");
                        samples.add(new Sample(inspectionTick,System.nanoTime()-caseStart,controls(),current));
                        if(ticks>=4){
                            int observed=0;for(int i=0;i<current.size();i++)if(current.get(i))observed+=outputs.get(i).weight();
                            rows.add(new Row(a,b,a+b,observed,current,(System.nanoTime()-caseStart)/1000000,resetElapsed,System.nanoTime()-settleStart,List.copyOf(samples)));
                            if(++index==16){finish(rows.stream().allMatch(r->r.expected()==r.observed())?"PASS":"FAIL",null);return;}
                            phase=0;
                        }
                    }
                }catch(Exception e){finish("INCOMPLETE",e.getMessage());}
            }
        }.runTaskTimer(plugin,1,1);
        return result;
    }
}

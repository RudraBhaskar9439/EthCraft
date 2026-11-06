package org.agentcity.paper;

import java.util.*;
import org.bukkit.GameMode;

/** Pure template checks; actual world creation and inventory preservation need the isolated host. */
public final class UniRockBankTemplateTest {
    private static void check(boolean value,String message) { if(!value)throw new AssertionError(message); }
    private static void arrival(Map<UniRockBank.Cell,String> plan,int x,int z) {
        check(plan.containsKey(new UniRockBank.Cell(x,68,z)),"Arrival has no planned floor");
        check(!plan.containsKey(new UniRockBank.Cell(x,69,z))&&!plan.containsKey(new UniRockBank.Cell(x,70,z)),"Arrival headroom blocked");
    }
    public static void main(String[] args) throws Exception {
        Map<UniRockBank.Cell,String> plan=UniRockBank.blueprint();
        check(plan.size()>10000&&plan.size()<30000,"Unexpected scenery footprint");
        check(plan.keySet().stream().allMatch(at->at.x()>=1640&&at.x()<=1757&&at.y()>=68&&at.y()<=94&&at.z()>=2780&&at.z()<=2854),"Template escapes surveyed district");
        arrival(plan,1698,2808);arrival(plan,1687,2812);arrival(plan,1692,2812);
        for(int x:new int[]{1669,1680,1691,1702,1713})arrival(plan,x,2846);
        for(int z=2800;z<=2842;z++)arrival(plan,1691,z);
        arrival(plan,1722,2815);
        for(int x:new int[]{1730,1741,1746,1757})for(int z:new int[]{2810,2821})arrival(plan,x,z);
        check(plan.values().stream().noneMatch(value->value.contains("chest")||value.contains("barrel")||value.contains("shulker")||value.contains("hopper")),"Scenery must not create material stock containers");
        Map<UniRockBank.Cell,String> reversed=new LinkedHashMap<>();
        List<UniRockBank.Cell> keys=new ArrayList<>(plan.keySet());Collections.reverse(keys);
        for(UniRockBank.Cell at:keys)reversed.put(at,plan.get(at));
        check(UniRockBank.planHash(plan).equals(UniRockBank.planHash(reversed)),"Marker digest changes with map iteration order");
        check(UniRockBank.agentPlot("CityAgent4",1730,69,2810)&&UniRockBank.agentPlot("CityAgent5",1757,76,2821),"Agent work areas missing");
        check(!UniRockBank.agentPlot("CityAgent4",1691,69,2812)&&!UniRockBank.agentPlot("CityAgent4",1746,69,2810)
            &&!UniRockBank.agentPlot("Micro",1730,69,2810)&&!UniRockBank.agentPlot("CityAgent4",1730,68,2810),"Agent effects escaped assigned work volume");
        check(MumbaiWorld.arrivalMode(false,false)==GameMode.ADVENTURE&&MumbaiWorld.arrivalMode(true,false)==GameMode.SURVIVAL
            &&MumbaiWorld.arrivalMode(false,true)==GameMode.SURVIVAL,"Only authenticated humans or authorized agents enter Survival");
        check(UniRockBank.buildArea(1732,69,2812)&&UniRockBank.buildArea(1757,76,2821)&&!UniRockBank.buildArea(1730,69,2812)
            &&!UniRockBank.buildArea(1732,68,2812)&&!UniRockBank.buildArea(1691,69,2812),"Owner building must exclude containers, foundation and scenery");
        for(int x=1723;x<=1757;x++)for(int z=2808;z<=2809;z++){
            arrival(plan,x,z);check(!UniRockBank.buildArea(x,69,z)&&!UniRockBank.anyAgentPlot(x,69,z),"Public approach overlaps a private task volume");
        }
        check(plan.containsValue("minecraft:iron_chain[axis=y]")&&plan.values().stream().noneMatch(value->value.startsWith("minecraft:chain[")),"Pinned runtime uses iron_chain, not the removed chain ID");
        Map<UniRockBank.Cell,String> legacy=UniRockBank.legacyBlueprint();
        check(legacy.size()==16590&&UniRockBank.planHash(legacy).equals("155deeb4fdb983a76e648570d8be5377ca9897a4748954952968f694ad15915a"),"Installed v1 blueprint must remain reproducible");
        for(int x:new int[]{1669,1680,1691,1702,1713})for(int z=2842;z<=2848;z++)for(int dx=-2;dx<=2;dx++)arrival(plan,x+dx,z);
        for(int x=1684;x<=1699;x++)for(int z=2800;z<=2801;z++)for(int y=69;y<=81;y++)check(!plan.containsKey(new UniRockBank.Cell(x,y,z)),"Bank entrance blocked");
        for(var entry:legacy.entrySet())if(entry.getValue().equals("minecraft:gold_block")) {
            var at=entry.getKey();check("minecraft:gold_block".equals(plan.get(new UniRockBank.Cell(3382-at.x(),at.y(),at.z()))),"North-facing UniRock sign must mirror the complete glyph plane");
        }
        Map<UniRockBank.Cell,UniRockBank.Change> delta=UniRockBank.migrationDelta();
        check(!delta.isEmpty()&&delta.size()<1000,"Migration must remain a small decoration change");
        for(var entry:delta.entrySet()) {
            var at=entry.getKey();check(at.y()>=69&&at.z()>=2799&&at.z()<=2848&&at.x()>=1666&&at.x()<=1716,"Migration touches foundations, work plots or retained storage");
            check(!Objects.equals(entry.getValue().before(),entry.getValue().after()),"Migration contains unchanged cells");
        }
        check(UniRockBank.migrationStateAllowed(true,false,false),"Original owned decoration must migrate");
        check(!UniRockBank.migrationStateAllowed(false,true,false),"A target state without a matching intent must not be adopted");
        check(UniRockBank.migrationStateAllowed(false,true,true),"A matching intent must resume target cells");
        check(!UniRockBank.migrationStateAllowed(false,false,true),"Unknown blocks must never be removed on retry");
        System.out.println("{\"status\":\"pass\",\"checks\":18,\"blocks\":"+plan.size()+",\"scope\":\"Pure UniRock template, safe arrival/headroom, no stock grants, stable retry hash, assigned-agent/owner volumes, public approach, approved Survival and current chain ID checks\"}");
    }
}

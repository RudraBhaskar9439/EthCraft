package org.agentcity.paper;

import java.util.*;

/** Focused layout/state checks; this does not mutate a Minecraft world. */
public final class AgentCapacityCheck {
    private static void require(boolean value,String reason){if(!value)throw new AssertionError(reason);}
    @SuppressWarnings("unchecked") public static void main(String[] arguments)throws Exception {
        require(PlayableExperience.AGENTS.equals(Set.of("CityAgent1","CityAgent2","CityAgent3")),"exact admitted agents");
        require(PlayableExperience.initializedTaskPads(Map.of("taskPadsInitialized",true))==2,"legacy pads remain initialized");
        require(PlayableExperience.initializedTaskPads(Map.of())==0,"fresh world has no initialized pads");
        require(PlayableExperience.initializedTaskPads(Map.of("initializedTaskPads",3.0))==3,"expanded save loads exactly");
        try{PlayableExperience.initializedTaskPads(Map.of("initializedTaskPads",4));throw new AssertionError("unknown pad count accepted");}catch(java.io.IOException expected){}
        var regions=PlayableExperience.taskRegions(0,64,0);
        require(regions.size()==3,"three registered work areas");
        require(regions.get(0).get("origin").equals(List.of(22,64,-4)),"first origin preserved");
        require(regions.get(1).get("origin").equals(List.of(-29,64,-4)),"second origin preserved");
        require(regions.get(2).get("origin").equals(List.of(25,64,20)),"third origin is separate");
        require(PlayableExperience.taskRegions(-16,64,8).get(2).get("sourceChest").equals(List.of(7,64,26)),"third pad uses the inspected clear host location");
        require(PlayableExperience.taskHome(PlayableExperience.taskRegions(-16,64,8).get(2)).equals(List.of(8.5,64.0,27.5)),"third agent spawns on its clear access strip");
        for(var region:regions){
            var home=PlayableExperience.taskHome(region);var chest=(List<Integer>)region.get("sourceChest");
            require(Math.hypot(home.get(0)-chest.get(0),home.get(2)-chest.get(2))<=2.5,"agent home reaches its own stock without a shared-world approach");
        }
        for(int a=0;a<regions.size();a++)for(int b=a+1;b<regions.size();b++){
            var amin=(Map<String,Integer>)regions.get(a).get("min");var amax=(Map<String,Integer>)regions.get(a).get("max");
            var bmin=(Map<String,Integer>)regions.get(b).get("min");var bmax=(Map<String,Integer>)regions.get(b).get("max");
            require(amax.get("x")<bmin.get("x")||bmax.get("x")<amin.get("x")||amax.get("z")<bmin.get("z")||bmax.get("z")<amin.get("z"),"work areas must not overlap");
        }
        System.out.println("PASS three admitted agents, legacy pad-state migration and separate stable work areas; no live-world claim");
    }
}

package org.agentcity.paper;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import org.bukkit.Bukkit;
import org.bukkit.GameRule;
import org.bukkit.NamespacedKey;
import org.bukkit.World;
import org.bukkit.entity.Entity;
import org.bukkit.entity.LivingEntity;
import org.bukkit.entity.Player;
import org.bukkit.entity.ArmorStand;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.CreatureSpawnEvent;
import org.bukkit.event.world.EntitiesLoadEvent;
import org.bukkit.event.world.WorldLoadEvent;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.plugin.java.JavaPlugin;

/** Local playable server: keep service NPCs, remove roaming creatures without drops. */
final class MobFreePlay implements Listener {
    private static volatile Map<String,Object> snapshot=Map.of();
    private static final Set<String> SERVICES=Set.of("guide","agents","jobs","economy","play");
    private static final NamespacedKey NPC=new NamespacedKey("agentcity","playable_npc");
    private static boolean service(Entity entity){return SERVICES.contains(entity.getPersistentDataContainer().getOrDefault(NPC,PersistentDataType.STRING,""));}
    private static boolean creature(Entity entity){return entity instanceof LivingEntity&&!(entity instanceof Player)&&!(entity instanceof ArmorStand);}
    private static void clear(World world){world.setGameRule(GameRule.DO_MOB_SPAWNING,false);for(LivingEntity mob:world.getLivingEntities())if(creature(mob)&&!service(mob))mob.remove();}
    static void install(JavaPlugin plugin){
        Bukkit.getPluginManager().registerEvents(new MobFreePlay(),plugin);
        Bukkit.getScheduler().runTaskTimer(plugin,()->{Bukkit.getWorlds().forEach(MobFreePlay::clear);snapshot=capture();},1L,20L);
    }
    @EventHandler public void spawn(CreatureSpawnEvent event){
        // Service NPCs receive their persistent identity immediately after a CUSTOM spawn.
        if(event.getSpawnReason()!=CreatureSpawnEvent.SpawnReason.CUSTOM)event.setCancelled(true);
    }
    @EventHandler public void loaded(EntitiesLoadEvent event){for(Entity entity:event.getEntities())if(creature(entity)&&!service(entity))entity.remove();}
    @EventHandler public void world(WorldLoadEvent event){clear(event.getWorld());}
    static Map<String,Object> status(){return snapshot;}
    private static Map<String,Object> capture(){
        Map<String,Object> result=new LinkedHashMap<>();
        for(World world:Bukkit.getWorlds())result.put(world.getName(),Map.of("naturalSpawning",Boolean.TRUE.equals(world.getGameRuleValue(GameRule.DO_MOB_SPAWNING)),"roamingMobs",world.getLivingEntities().stream().filter(mob->creature(mob)&&!service(mob)).count(),"serviceNpcs",world.getLivingEntities().stream().filter(MobFreePlay::service).count()));
        return Map.copyOf(result);
    }
}

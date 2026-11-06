package org.agentcity.paper;

import com.google.gson.Gson;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import org.bukkit.Bukkit;

/** Private operator-issued, short refreshed leases for Discord-authorized work. */
final class RemoteTaskGrants {
    private final Path file;
    private final Map<String,Map<String,Object>> grants=new HashMap<>();
    @SuppressWarnings("unchecked") RemoteTaskGrants(Path directory)throws Exception{
        file=directory.resolve("remote-grants.json");
        if(Files.exists(file))for(var entry:StrictJson.object(Files.readString(file)).entrySet())grants.put(entry.getKey(),(Map<String,Object>)entry.getValue());
    }
    static String tool(String value){return value.startsWith("build_")?"build":value;}
    private void save()throws Exception{
        Path temporary=file.resolveSibling("remote-grants.tmp");
        try(FileChannel channel=FileChannel.open(temporary,StandardOpenOption.CREATE,StandardOpenOption.TRUNCATE_EXISTING,StandardOpenOption.WRITE)){
            ByteBuffer bytes=StandardCharsets.UTF_8.encode(new Gson().toJson(grants));while(bytes.hasRemaining())channel.write(bytes);channel.force(true);
        }
        Files.move(temporary,file,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
        try(FileChannel directory=FileChannel.open(file.getParent(),StandardOpenOption.READ)){directory.force(true);}
    }
    void update(Map<String,Object> input)throws Exception{
        if(!Bukkit.isPrimaryThread())throw new IllegalStateException("remote_grant_main_thread");
        String grant=UUID.fromString((String)input.get("grantId")).toString(),owner=UUID.fromString((String)input.get("ownerId")).toString(),slot=(String)input.get("slotName");
        if(!PlayableExperience.AGENTS.contains(slot))throw new IllegalArgumentException("remote_grant_slot");
        Map<String,Object> old=grants.get(grant),value=new LinkedHashMap<>();
        if(old!=null&&(!owner.equals(old.get("ownerId"))||!slot.equals(old.get("slotName"))))throw new IllegalArgumentException("remote_grant_owner_changed");
        value.put("grantId",grant);value.put("ownerId",owner);value.put("slotName",slot);
        if(Boolean.TRUE.equals(input.get("revoked"))){if(old!=null)value.putAll(old);value.put("revoked",true);}
        else{
            if(old!=null&&Boolean.TRUE.equals(old.get("revoked")))throw new IllegalArgumentException("remote_grant_revoked");
            long now=System.currentTimeMillis(),expiry=((Number)input.get("expiresAtMs")).longValue(),lease=((Number)input.get("leaseExpiresAtMs")).longValue(),generation=((Number)input.get("generation")).longValue();
            if(expiry<=now||expiry>now+86400000L||lease<=now||lease>now+10000L||lease>expiry||generation<1)throw new IllegalArgumentException("remote_grant_expiry");
            if(!(input.get("tools") instanceof List<?> raw)||raw.isEmpty()||raw.size()>16)throw new IllegalArgumentException("remote_grant_tools");
            List<String> tools=new ArrayList<>();
            for(Object item:raw){if(!(item instanceof String action)||!Set.of("status","inspect","screenshot","build","gather","craft","collect","deliver","wait","follow","come").contains(action))throw new IllegalArgumentException("remote_grant_tool");if(!tools.contains(action))tools.add(action);}
            Collections.sort(tools);
            if(old!=null&&(!tools.equals(old.get("tools"))||expiry!=((Number)old.get("expiresAtMs")).longValue()||generation!=((Number)old.get("generation")).longValue()))throw new IllegalArgumentException("remote_grant_terms_changed");
            value.put("expiresAtMs",expiry);value.put("leaseExpiresAtMs",lease);value.put("generation",generation);value.put("tools",List.copyOf(tools));value.put("revoked",false);
        }
        grants.put(grant,value);
        try{save();}catch(Exception error){if(old==null)grants.remove(grant);else grants.put(grant,old);throw error;}
    }
    boolean valid(String id,String slot,String owner,String action){
        Map<String,Object> grant=grants.get(id);
        if(grant==null||Boolean.TRUE.equals(grant.get("revoked"))||!slot.equals(grant.get("slotName"))||!owner.equals(grant.get("ownerId")))return false;
        long now=System.currentTimeMillis();return now<((Number)grant.get("expiresAtMs")).longValue()&&now<((Number)grant.get("leaseExpiresAtMs")).longValue()&&grant.get("tools") instanceof List<?> tools&&tools.contains(tool(action));
    }
    boolean allows(Map<String,Object> lock,String slot,String effect){
        if(lock==null)return false;
        if(!(lock.get("remoteGrantId") instanceof String id))return true;
        String action=(String)lock.get("tool");
        if(!valid(id,slot,(String)lock.get("ownerId"),action))return false;
        return switch(effect){case "place"->action.equals("build");case "dig"->action.equals("gather");case "craft"->Set.of("build","craft").contains(action);case "open"->Set.of("inspect","build","craft","collect","deliver").contains(action);case "transfer"->Set.of("build","craft","collect","deliver").contains(action);default->false;};
    }
}

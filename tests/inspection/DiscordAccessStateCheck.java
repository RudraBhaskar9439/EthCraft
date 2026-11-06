package org.agentcity.paper;

import java.nio.file.*;
import java.util.*;
import com.google.gson.Gson;

/** Focused private-state parsing regression, not native-world verification. */
public final class DiscordAccessStateCheck {
    private static void require(boolean value,String reason){if(!value)throw new AssertionError(reason);}
    private static void rejected(Runnable operation){try{operation.run();throw new AssertionError("invalid state accepted");}catch(IllegalArgumentException expected){}}
    @SuppressWarnings("unchecked") public static void main(String[] arguments)throws Exception{
        Map<String,Object> original=DiscordGameAccess.stateObject("{\"x\":-20.5,\"y\":-60.0,\"z\":11.5,\"yaw\":0.0,\"expiresAtMs\":1793448000000}");
        Map<String,Object> roundTrip=DiscordGameAccess.stateObject(new Gson().toJson(original));
        require(original.equals(roundTrip),"fractional Bukkit locations must round-trip exactly");require(original.get("expiresAtMs") instanceof Long,"integer expiry remains exact");
        rejected(()->DiscordGameAccess.stateObject("{\"x\":1e999}"));rejected(()->DiscordGameAccess.stateObject("{\"x\":1,\"x\":2}"));
        rejected(()->StrictJson.object("{\"x\":-20.5}"));require(StrictJson.object("{\"x\":20}").get("x") instanceof Long,"command integer parsing unchanged");
        System.out.println("PASS finite-decimal private state round-trip, duplicate/nonfinite refusal, command decimals still refused");
        if(arguments.length==1){Map<String,Object> state=DiscordGameAccess.stateObject(Files.readString(Path.of(arguments[0])));require("agentcity.discord-game-access.v1".equals(state.get("schema")),"actual private state schema");Map<String,Object> holds=(Map<String,Object>)state.get("holds");require(!holds.isEmpty(),"actual failed hold is preserved");for(Object raw:holds.values()){Map<String,Object> hold=(Map<String,Object>)raw;for(String field:List.of("x","y","z","yaw","pitch"))require(hold.get(field) instanceof Number n&&Double.isFinite(n.doubleValue()),"actual stored location must load");}System.out.println("PASS actual retained private hold state parsed read-only without rewriting it");}
    }
}

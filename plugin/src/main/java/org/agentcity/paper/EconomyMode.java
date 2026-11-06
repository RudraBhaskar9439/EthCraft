package org.agentcity.paper;

import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.Map;
import java.util.WeakHashMap;
import org.bukkit.plugin.java.JavaPlugin;

/** Live defaults to on-chain only; historical currency fixtures must opt in. */
final class EconomyMode {
    private static final Map<JavaPlugin,Boolean> latched=new WeakHashMap<>();
    static synchronized boolean onchainOnly(JavaPlugin plugin){
        if(Boolean.TRUE.equals(latched.get(plugin)))return true;
        Path directory=plugin.getDataFolder().toPath();
        boolean enabled=Files.exists(directory.resolve("onchain-only"))||Files.exists(directory.resolve("onchain-only.json"))||!(Boolean.getBoolean("agentcity.localFixture")&&Boolean.getBoolean("agentcity.legacyGameCoinsFixture"));
        if(enabled)latched.put(plugin,true);return enabled;
    }
    static void initialize(JavaPlugin plugin)throws Exception {
        if(!onchainOnly(plugin))return;
        Path directory=plugin.getDataFolder().toPath();Files.createDirectories(directory);
        for(String name:new String[]{"onchain-only","onchain-only.json"}){
            Path file=directory.resolve(name);if(Files.exists(file))continue;
            byte[] bytes=(name.endsWith(".json")?"{\"schema\":\"agentcity.economy-mode.v1\",\"mode\":\"ONCHAIN_ONLY\"}\n":"ONCHAIN_ONLY\n").getBytes(StandardCharsets.UTF_8);
            try(FileChannel channel=FileChannel.open(file,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE)){ByteBuffer data=ByteBuffer.wrap(bytes);while(data.hasRemaining())channel.write(data);channel.force(true);}
        }
        try(FileChannel channel=FileChannel.open(directory,StandardOpenOption.READ)){channel.force(true);}
    }
    static void requireLegacy(JavaPlugin plugin){if(onchainOnly(plugin))throw new IllegalStateException("onchain_only_legacy_financial_action_disabled");}
}

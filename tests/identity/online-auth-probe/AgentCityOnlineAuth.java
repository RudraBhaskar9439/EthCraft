package org.agentcity.authprobe;

import com.google.gson.Gson;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.java.JavaPlugin;

/** Identity observations only. No game entitlement, economy or permission depends on a wallet. */
public final class AgentCityOnlineAuth extends JavaPlugin implements Listener {
    private static final Gson JSON = new Gson();
    private static final long LIVE_TTL_MS = 30000;
    private final Map<UUID, Session> sessions = new HashMap<>();
    private final String bootId = UUID.randomUUID().toString();
    private String serverId, apiToken;
    private HttpServer http;
    private ExecutorService executor;
    private boolean ready;
    private record Session(UUID player, String name, String id, long joined, String wallet, long paired) {}

    private boolean directOnlineMode() {
        if (!Files.isRegularFile(Path.of("config/paper-global.yml"))) return false;
        var global = YamlConfiguration.loadConfiguration(Path.of("config/paper-global.yml").toFile());
        return Bukkit.getOnlineMode() && !Bukkit.spigot().getConfig().getBoolean("settings.bungeecord", false)
            && !global.getBoolean("proxies.velocity.enabled", false)
            && !global.getBoolean("proxies.proxy-protocol", false);
    }
    @Override public void onEnable() {
        try {
            serverId = System.getenv("AGENTCITY_AUTH_SERVER_ID");
            apiToken = System.getenv("AGENTCITY_AUTH_API_TOKEN");
            if (!"26.3".equals(Bukkit.getMinecraftVersion()) || serverId == null || !serverId.matches("agentcity-online-auth-[a-f0-9]{32}")
                || apiToken == null || !apiToken.matches("[a-f0-9]{64}") || !directOnlineMode()) throw new IllegalStateException("direct_online_auth_required");
            for (var plugin : Bukkit.getPluginManager().getPlugins())
                if (!Set.of("AgentCityOnlineAuth", "ViaVersion", "ViaBackwards").contains(plugin.getName())) throw new IllegalStateException("unapproved_auth_probe_plugin");
            Files.createDirectories(getDataFolder().toPath());
            Bukkit.getPluginManager().registerEvents(this, this);
            http = HttpServer.create(new InetSocketAddress("0.0.0.0", 25579), 8);
            executor = Executors.newFixedThreadPool(2);
            http.setExecutor(executor);
            http.createContext("/", this::request);
            ready = true;
            http.start();
            event("BOOT", null);
            getLogger().info("Direct online-mode authentication probe ready; empty software readiness is not human verification.");
        } catch (Exception error) {
            ready = false;
            getLogger().severe("Authentication probe refused unsafe setup: " + error.getMessage());
            Bukkit.getServer().shutdown();
        }
    }
    private void request(HttpExchange request) {
        try {
            String supplied = request.getRequestHeaders().getFirst("Authorization");
            if (supplied == null || !MessageDigest.isEqual(("Bearer " + apiToken).getBytes(StandardCharsets.UTF_8), supplied.getBytes(StandardCharsets.UTF_8))) { reply(request, 401, Map.of("error", "AUTHENTICATION")); return; }
            if (!request.getRequestMethod().equals("GET") || !request.getRequestURI().getPath().equals("/status") || request.getRequestURI().getRawQuery() != null) { reply(request, 405, Map.of("error", "READ_ONLY")); return; }
            var result = new CompletableFuture<Map<String,Object>>();
            Bukkit.getScheduler().runTask(this, () -> {
                try { result.complete(snapshot()); } catch (Exception error) { result.completeExceptionally(error); }
            });
            reply(request, 200, result.get(5, TimeUnit.SECONDS));
        } catch (Exception error) { reply(request, 503, Map.of("error", "AUTHORITY_UNAVAILABLE")); }
    }
    private Map<String,Object> snapshot() {
        if (!ready || !directOnlineMode()) throw new IllegalStateException("online_authority_unavailable");
        long now = System.currentTimeMillis();
        List<Map<String,Object>> people = new ArrayList<>();
        for (Session session : sessions.values()) {
            Player player = Bukkit.getPlayer(session.player());
            if (player == null || !player.isOnline()) continue;
            Map<String,Object> value = new LinkedHashMap<>();
            value.put("serverId", serverId); value.put("serverBootId", bootId);
            value.put("playerUuid", session.player().toString()); value.put("name", session.name());
            value.put("sessionId", session.id()); value.put("joinedAtMs", session.joined());
            value.put("connected", true); value.put("expiresAtMs", now + LIVE_TTL_MS);
            value.put("wallet", session.wallet()); value.put("pairedAtMs", session.paired());
            people.add(value);
        }
        people.sort(Comparator.comparing(value -> (String)value.get("playerUuid")));
        return Map.of("serverId", serverId, "serverBootId", bootId, "onlineMode", true,
            "directAuthentication", true, "atMs", now, "ready", true, "sessions", people,
            "economicBridge", false, "humanWalletLinksVerifiedByServer", false);
    }
    @EventHandler public void joined(PlayerJoinEvent event) {
        if (!ready || !directOnlineMode()) { event.getPlayer().kickPlayer("Direct authenticated mode is required."); return; }
        Player player = event.getPlayer();
        Session session = new Session(player.getUniqueId(), player.getName(), UUID.randomUUID().toString(), System.currentTimeMillis(), null, 0);
        sessions.put(player.getUniqueId(), session);
        event("JOIN", session);
        player.sendMessage("AgentCity verified an online-mode login. To request a wallet identity link, use /walletlink PUBLIC_WALLET_ADDRESS. No items or access depend on this.");
    }
    @EventHandler public void quit(PlayerQuitEvent event) {
        Session session = sessions.remove(event.getPlayer().getUniqueId());
        if (session != null) event("QUIT", session);
    }
    @Override public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!(sender instanceof Player player) || !ready || !directOnlineMode()) { sender.sendMessage("A live authenticated player must initiate this pairing."); return true; }
        Session previous = sessions.get(player.getUniqueId());
        if (previous == null || !player.isOnline()) { sender.sendMessage("Reconnect to establish an authenticated session."); return true; }
        if (args.length != 1 || !args[0].matches("0x[0-9a-fA-F]{40}") || args[0].matches("0x0{40}")) { sender.sendMessage("Use /walletlink PUBLIC_WALLET_ADDRESS. Never enter a private key or password."); return true; }
        String wallet = args[0].toLowerCase(Locale.ROOT);
        if (previous.wallet() != null && !previous.wallet().equals(wallet)) { sender.sendMessage("A different wallet was already requested for this login. Disconnect and rejoin to start a new session."); return true; }
        Session paired = previous.wallet() == null ? new Session(previous.player(), previous.name(), previous.id(), previous.joined(), wallet, System.currentTimeMillis()) : previous;
        sessions.put(player.getUniqueId(), paired);
        if (previous.wallet() == null) event("PAIR_REQUEST", paired);
        player.sendMessage("Pairing requested for " + wallet + ". Keep this game connected while you review and sign the separate wallet identity message. Your public login session is " + paired.id());
        return true;
    }
    private void event(String kind, Session session) {
        try {
            Map<String,Object> value = new LinkedHashMap<>();
            value.put("event", kind); value.put("atMs", System.currentTimeMillis());
            value.put("serverId", serverId); value.put("serverBootId", bootId); value.put("onlineMode", true); value.put("directAuthentication", true);
            if (session != null) { value.put("playerUuid", session.player().toString()); value.put("name", session.name()); value.put("sessionId", session.id()); value.put("wallet", session.wallet()); }
            Files.writeString(getDataFolder().toPath().resolve("events.jsonl"), JSON.toJson(value) + "\n", StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (Exception error) { ready = false; getLogger().severe("Authentication event could not be retained; probe stopped."); Bukkit.getServer().shutdown(); }
    }
    private static void reply(HttpExchange exchange, int status, Object value) {
        try {
            byte[] bytes = (JSON.toJson(value) + "\n").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.sendResponseHeaders(status, bytes.length);
            try (var output = exchange.getResponseBody()) { output.write(bytes); }
        } catch (Exception ignored) { exchange.close(); }
    }
    @Override public void onDisable() {
        ready = false; sessions.clear();
        if (http != null) http.stop(0);
        if (executor != null) executor.shutdownNow();
    }
}

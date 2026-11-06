package org.agentcity.worldtest;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.data.Lightable;
import org.bukkit.block.data.Powerable;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.craftbukkit.block.CraftBlock;
import net.minecraft.world.level.block.LeverBlock;

public final class CandidatePlugin extends JavaPlugin implements Listener {
    private final Gson gson = new GsonBuilder().setPrettyPrinting().create();
    private final Gson compact = new Gson();
    private final Path resultPath = Path.of("candidate-result.json");
    private JsonObject config;
    private JsonObject report;
    private JsonArray suiteResults;
    private World world;
    private Player observer;
    private int suiteIndex;
    private int caseIndex;
    private int revision = 1;
    private boolean running;
    private long began;
    private JsonArray currentRows;
    private JsonObject currentSuite;
    private Runnable afterNativeInputs;
    private int desiredA;
    private int desiredB;
    private int nativeRequest;
    private int pendingNative;
    private int nativeSteps;
    private boolean finished;
    private boolean carryFault;
    private long caseBegan;
    private long suiteBegan;
    private int caseStartTick;
    private JsonObject precondition;
    private int lastEngineInteractionTick = -10;

    @Override
    public void onEnable() {
        if (!Boolean.getBoolean("agentcity.candidate.fixture")) {
            getLogger().severe("Candidate fixture requires an explicit isolated-run property.");
            getServer().getPluginManager().disablePlugin(this);
            return;
        }
        try {
            config = gson.fromJson(Files.readString(Path.of("candidate-run.json")), JsonObject.class);
            if (!config.get("purpose").getAsString().equals("isolated_physical_candidate_test")) {
                throw new IllegalArgumentException("Unexpected candidate purpose");
            }
            world = Bukkit.getWorlds().get(0);
            // This fixture seeds only its fresh isolated plot, before any protected job exists.
            for (int x = -2; x <= 15; x++) {
                for (int z = -4; z <= 4; z++) {
                    world.getBlockAt(x, 79, z).setType(Material.STONE, false);
                }
            }
            for (JsonElement item : config.getAsJsonArray("placements")) {
                JsonObject placement = item.getAsJsonObject();
                at(placement.getAsJsonArray("position")).setBlockData(Bukkit.createBlockData(blockSpec(placement)), false);
            }
            getServer().getPluginManager().registerEvents(this, this);
        } catch (Exception error) {
            getLogger().severe("Candidate initialization failed: " + error);
            getServer().getPluginManager().disablePlugin(this);
        }
    }

    private String blockSpec(JsonObject placement) {
        String spec = placement.get("block").getAsString();
        JsonObject properties = placement.getAsJsonObject("properties");
        List<String> fields = new ArrayList<>();
        properties.entrySet().forEach(entry -> fields.add(entry.getKey() + "=" + entry.getValue().getAsString()));
        return fields.isEmpty() ? spec : spec + "[" + String.join(",", fields) + "]";
    }

    private Block at(JsonArray position) {
        int x = position.get(0).getAsInt(), y = position.get(1).getAsInt(), z = position.get(2).getAsInt();
        if (x < 0 || x > 13 || y < 0 || y > 9 || z < -1 || z > 2) {
            throw new IllegalArgumentException("Candidate placement outside reviewed bounds");
        }
        return world.getBlockAt(x, 80 + y, z);
    }

    @EventHandler
    public void join(PlayerJoinEvent event) {
        Player player = event.getPlayer();
        if (!player.getName().equals("WorldObserver")) return;
        player.setOp(false);
        player.setGameMode(GameMode.SURVIVAL);
        player.getInventory().clear();
        player.setFoodLevel(20);
        player.setSaturation(20);
        player.teleport(new Location(world, 6.5, 80, -2.5));
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!(sender instanceof Player player) || !player.getName().equals("WorldObserver")) return true;
        if (args.length == 2 && args[0].equals("clicked") && afterNativeInputs != null) {
            try {
                if (Integer.parseInt(args[1]) != pendingNative) throw new IllegalArgumentException("Stale native input acknowledgement");
                pendingNative = 0;
                later(this::nextNativeInput, 1);
            } catch (Exception error) {
                fail(error);
            }
            return true;
        }
        if (args.length != 1 || !args[0].equals("run") || running) return false;
        observer = player;
        running = true;
        began = System.nanoTime();
        report = new JsonObject();
        report.addProperty("schema", "agentcity.p1.candidate-result.v1");
        report.addProperty("purpose", "actual physical candidate evidence, not a phase approval");
        report.addProperty("full_phase_gate_passed", false);
        report.addProperty("independent_humans", 0);
        report.addProperty("server", getServer().getVersion());
        report.addProperty("input_adapter", config.get("input_adapter").getAsString());
        if (config.get("input_adapter").getAsString().equals("native_click")) {
            // Teleported electrical-test actuator only; this grants no building or navigation proof.
            observer.setAllowFlight(true);
            observer.setFlying(true);
            report.addProperty("actuator_fixture", "teleported flight-enabled survival observer; no construction proof");
        }
        report.add("sources", config.get("sources").deepCopy());
        report.addProperty("reset_ticks", config.get("reset_ticks").getAsInt());
        report.addProperty("settle_ticks", config.get("settle_ticks").getAsInt());
        report.addProperty("stable_ticks", config.get("stable_ticks").getAsInt());
        report.addProperty("case_wall_limit_ms", 15000);
        report.addProperty("suite_wall_limit_ms", 180000);
        report.add("initial_structure", structure());
        suiteResults = new JsonArray();
        report.add("suites", suiteResults);
        try {
            // Exercise real input transitions so imported settled states are not the sole initialization.
            changeInputs(3, 3, () -> later(() -> changeInputs(0, 0, () -> later(this::beginSuite, 80)), 80));
        } catch (Exception error) {
            fail(error);
        }
        return true;
    }

    private void later(Runnable task, long ticks) {
        Bukkit.getScheduler().runTaskLater(this, () -> {
            try {
                task.run();
            } catch (Exception error) {
                fail(error);
            }
        }, ticks);
    }

    private void setInputs(int a, int b) {
        for (JsonElement element : config.getAsJsonArray("inputs")) {
            JsonObject input = element.getAsJsonObject();
            Block block = at(input.getAsJsonArray("position"));
            if (!(block.getBlockData() instanceof Powerable lever)) throw new IllegalStateException("Missing real lever");
            int value = input.get("group").getAsString().equals("a") ? a : b;
            lever.setPowered((value & input.get("weight").getAsInt()) != 0);
            block.setBlockData(lever, true);
        }
    }

    private void changeInputs(int a, int b, Runnable then) {
        if (config.get("input_adapter").getAsString().equals("bukkit_setter")) {
            setInputs(a, b);
            then.run();
            return;
        }
        if (config.get("input_adapter").getAsString().equals("native_engine")) {
            desiredA = a;
            desiredB = b;
            afterNativeInputs = then;
            nativeSteps = 0;
            nextEngineInput();
            return;
        }
        desiredA = a;
        desiredB = b;
        afterNativeInputs = then;
        nativeSteps = 0;
        nextNativeInput();
    }

    private void nextEngineInput() {
        if (finished) return;
        for (JsonElement element : config.getAsJsonArray("inputs")) {
            JsonObject input = element.getAsJsonObject();
            Block block = at(input.getAsJsonArray("position"));
            if (!(block.getBlockData() instanceof Powerable lever)) throw new IllegalStateException("Missing real engine input lever");
            int value = input.get("group").getAsString().equals("a") ? desiredA : desiredB;
            boolean powered = (value & input.get("weight").getAsInt()) != 0;
            if (lever.isPowered() == powered) continue;
            int wait = 10 - (Bukkit.getCurrentTick() - lastEngineInteractionTick);
            if (wait > 0) {
                later(this::nextEngineInput, wait);
                return;
            }
            if (++nativeSteps > 8) throw new IllegalStateException("Engine inputs did not converge");
            CraftBlock craft = (CraftBlock) block;
            var state = craft.getNMS();
            if (!(state.getBlock() instanceof LeverBlock nativeLever)) throw new IllegalStateException("Pinned engine lever unavailable");
            nativeLever.pull(state, craft.getCraftWorld().getHandle(), craft.getPosition(), null);
            lastEngineInteractionTick = Bukkit.getCurrentTick();
            if (((Powerable) block.getBlockData()).isPowered() != powered) throw new IllegalStateException("Engine input failed to toggle actual lever");
            nextEngineInput();
            return;
        }
        Runnable then = afterNativeInputs;
        afterNativeInputs = null;
        then.run();
    }

    private void nextNativeInput() {
        if (finished) return;
        if (++nativeSteps > 8) throw new IllegalStateException("Native lever inputs did not converge");
        for (JsonElement element : config.getAsJsonArray("inputs")) {
            JsonObject input = element.getAsJsonObject();
            Block block = at(input.getAsJsonArray("position"));
            if (!(block.getBlockData() instanceof Powerable lever)) throw new IllegalStateException("Missing real native input lever");
            int desired = input.get("group").getAsString().equals("a") ? desiredA : desiredB;
            boolean powered = (desired & input.get("weight").getAsInt()) != 0;
            if (lever.isPowered() == powered) continue;
            observer.teleport(new Location(world, block.getX() + 0.5, block.getY(), block.getZ() + 2.5));
            pendingNative = ++nativeRequest;
            final int request = pendingNative;
            JsonObject click = new JsonObject();
            click.addProperty("request", request);
            click.add("position", absolute(input.getAsJsonArray("position")));
            click.addProperty("desired_powered", powered);
            observer.sendMessage("AC_CANDIDATE_CLICK " + compact.toJson(click));
            later(() -> {
                if (pendingNative == request) throw new IllegalStateException("Native input acknowledgement timed out");
            }, 60);
            return;
        }
        Runnable then = afterNativeInputs;
        afterNativeInputs = null;
        then.run();
    }

    private void beginSuite() {
        if (suiteIndex >= config.getAsJsonArray("suites").size()) {
            finish(true);
            return;
        }
        JsonObject plan = config.getAsJsonArray("suites").get(suiteIndex).getAsJsonObject();
        String mutation = plan.get("mutation").getAsString();
        if (!mutation.equals("none")) {
            JsonObject carry = config.getAsJsonObject("carry_source");
            Block block = at(carry.getAsJsonArray("position"));
            if (mutation.equals("remove_carry")) {
                block.setType(Material.AIR, true);
                carryFault = true;
            }
            else if (mutation.equals("restore_carry")) {
                block.setBlockData(Bukkit.createBlockData(blockSpec(carry)), true);
                carryFault = false;
            }
            else throw new IllegalArgumentException("Unsupported fixture mutation");
            revision++;
        }
        currentSuite = new JsonObject();
        currentSuite.addProperty("name", plan.get("name").getAsString());
        currentSuite.addProperty("fixture_revision", revision);
        currentSuite.addProperty("carry_fault", carryFault);
        suiteBegan = System.nanoTime();
        currentRows = new JsonArray();
        currentSuite.add("cases", currentRows);
        suiteResults.add(currentSuite);
        caseIndex = 0;
        beginCase();
    }

    private void beginCase() {
        JsonObject plan = config.getAsJsonArray("suites").get(suiteIndex).getAsJsonObject();
        JsonArray cases = plan.getAsJsonArray("cases");
        if (caseIndex >= cases.size()) {
            int passed = 0;
            for (JsonElement row : currentRows) if (row.getAsJsonObject().get("passed").getAsBoolean()) passed++;
            currentSuite.addProperty("passed_count", passed);
            currentSuite.addProperty("case_count", currentRows.size());
            currentSuite.addProperty("elapsed_ms", (System.nanoTime() - suiteBegan) / 1000000);
            boolean ok = passed == plan.get("expected_pass_count").getAsInt();
            for (JsonElement row : currentRows) {
                if (!row.getAsJsonObject().get("fixture_expectation_met").getAsBoolean()) ok = false;
            }
            currentSuite.addProperty("expectation_met", ok);
            if (!ok) {
                finish(false);
                return;
            }
            suiteIndex++;
            later(this::beginSuite, 10);
            return;
        }
        JsonObject test = cases.get(caseIndex).getAsJsonObject();
        caseBegan = System.nanoTime();
        caseStartTick = Bukkit.getCurrentTick();
        int fromA = test.has("from_a") ? test.get("from_a").getAsInt() : 0;
        int fromB = test.has("from_b") ? test.get("from_b").getAsInt() : 0;
        changeInputs(fromA, fromB, () -> later(() -> precondition(test, fromA, fromB, new JsonArray(), 0), config.get("reset_ticks").getAsInt()));
    }

    private int observed(JsonArray readings) {
        int value = 0;
        for (JsonElement item : readings) {
            JsonObject lamp = item.getAsJsonObject();
            if (lamp.get("lit").getAsBoolean()) value += lamp.get("weight").getAsInt();
        }
        return value;
    }

    private boolean controlsMatch(JsonArray readings, int a, int b) {
        JsonArray inputs = config.getAsJsonArray("inputs");
        for (int i = 0; i < inputs.size(); i++) {
            JsonObject input = inputs.get(i).getAsJsonObject();
            int value = input.get("group").getAsString().equals("a") ? a : b;
            boolean expected = (value & input.get("weight").getAsInt()) != 0;
            if (readings.get(i).getAsJsonObject().get("powered").getAsBoolean() != expected) return false;
        }
        return true;
    }

    private JsonObject snapshot() {
        JsonObject snapshot = new JsonObject();
        snapshot.add("controls", controls());
        snapshot.add("lamps", lamps());
        snapshot.addProperty("tick", Bukkit.getCurrentTick());
        snapshot.addProperty("timestamp", java.time.Instant.now().toString());
        return snapshot;
    }

    private void precondition(JsonObject test, int a, int b, JsonArray samples, int count) {
        samples.add(snapshot());
        if (count + 1 < config.get("stable_ticks").getAsInt()) {
            later(() -> precondition(test, a, b, samples, count + 1), 1);
            return;
        }
        int expected = carryFault ? ((a + b) & 3) : a + b;
        for (JsonElement item : samples) {
            JsonObject state = item.getAsJsonObject();
            if (!controlsMatch(state.getAsJsonArray("controls"), a, b) || observed(state.getAsJsonArray("lamps")) != expected) {
                throw new IllegalStateException("Actual physical source state failed before target transition");
            }
        }
        precondition = new JsonObject();
        precondition.addProperty("a", a);
        precondition.addProperty("b", b);
        precondition.addProperty("expected", expected);
        precondition.addProperty("passed", true);
        precondition.add("samples", samples);
        changeInputs(test.get("a").getAsInt(), test.get("b").getAsInt(),
                () -> later(() -> sample(test, new JsonArray(), 0), config.get("settle_ticks").getAsInt()));
    }

    private JsonArray controls() {
        JsonArray readings = new JsonArray();
        for (JsonElement element : config.getAsJsonArray("inputs")) {
            JsonObject input = element.getAsJsonObject();
            Block block = at(input.getAsJsonArray("position"));
            if (!(block.getBlockData() instanceof Powerable lever)) throw new IllegalStateException("Missing real lever");
            JsonObject reading = new JsonObject();
            reading.addProperty("name", input.get("name").getAsString());
            reading.add("position", absolute(input.getAsJsonArray("position")));
            reading.addProperty("powered", lever.isPowered());
            reading.addProperty("block_data", block.getBlockData().getAsString());
            readings.add(reading);
        }
        return readings;
    }

    private JsonArray lamps() {
        JsonArray readings = new JsonArray();
        for (JsonElement element : config.getAsJsonArray("outputs")) {
            JsonObject output = element.getAsJsonObject();
            Block block = at(output.getAsJsonArray("proposed_lamp_position"));
            if (!(block.getBlockData() instanceof Lightable lamp)) throw new IllegalStateException("Missing real output lamp");
            JsonObject reading = new JsonObject();
            reading.addProperty("name", output.get("name").getAsString());
            reading.add("position", absolute(output.getAsJsonArray("proposed_lamp_position")));
            reading.addProperty("weight", output.get("weight").getAsInt());
            reading.addProperty("lit", lamp.isLit());
            reading.addProperty("block_data", block.getBlockData().getAsString());
            readings.add(reading);
        }
        return readings;
    }

    private JsonArray absolute(JsonArray relative) {
        JsonArray position = relative.deepCopy();
        position.set(1, new com.google.gson.JsonPrimitive(relative.get(1).getAsInt() + 80));
        return position;
    }

    private void sample(JsonObject test, JsonArray samples, int count) {
        samples.add(snapshot());
        if (count + 1 < config.get("stable_ticks").getAsInt()) {
            later(() -> sample(test, samples, count + 1), 1);
            return;
        }
        JsonObject row = test.deepCopy();
        row.addProperty("suite", currentSuite.get("name").getAsString());
        row.addProperty("case_index", caseIndex);
        row.addProperty("fixture_revision", revision);
        row.addProperty("start_tick", caseStartTick);
        row.addProperty("elapsed_ms", (System.nanoTime() - caseBegan) / 1000000);
        row.add("precondition", precondition);
        row.add("samples", samples);
        JsonObject last = samples.get(samples.size() - 1).getAsJsonObject();
        row.add("controls", last.get("controls").deepCopy());
        row.add("lamps", last.get("lamps").deepCopy());
        int observed = 0;
        for (JsonElement element : last.getAsJsonArray("lamps")) {
            JsonObject lamp = element.getAsJsonObject();
            if (lamp.get("lit").getAsBoolean()) observed += lamp.get("weight").getAsInt();
        }
        boolean stable = true;
        for (JsonElement sample : samples) {
            if (!sample.getAsJsonObject().get("lamps").equals(last.get("lamps"))) stable = false;
        }
        boolean controlsMatch = true;
        JsonArray inputs = config.getAsJsonArray("inputs");
        for (int i = 0; i < inputs.size(); i++) {
            JsonObject input = inputs.get(i).getAsJsonObject();
            int desired = test.get(input.get("group").getAsString()).getAsInt();
            boolean expectedPower = (desired & input.get("weight").getAsInt()) != 0;
            if (last.getAsJsonArray("controls").get(i).getAsJsonObject().get("powered").getAsBoolean() != expectedPower) controlsMatch = false;
        }
        row.addProperty("observed", observed);
        row.addProperty("stable", stable);
        row.addProperty("controls_match", controlsMatch);
        boolean withinDeadline = (System.nanoTime() - caseBegan) / 1000000 < 15000 && (System.nanoTime() - suiteBegan) / 1000000 < 180000;
        row.addProperty("within_deadline", withinDeadline);
        row.addProperty("passed", withinDeadline && stable && controlsMatch && observed == test.get("expected").getAsInt());
        int expectedObserved = test.has("expected_observed") ? test.get("expected_observed").getAsInt() : (carryFault ? (test.get("expected").getAsInt() & 3) : test.get("expected").getAsInt());
        row.addProperty("fixture_expectation_met", withinDeadline && stable && controlsMatch && observed == expectedObserved);
        currentRows.add(row);
        try {
            Files.writeString(Path.of("candidate-cases.jsonl"), compact.toJson(row) + "\n", StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (Exception error) {
            throw new IllegalStateException("Could not retain actual candidate case", error);
        }
        JsonObject message = row.deepCopy();
        message.remove("samples");
        message.remove("precondition");
        String payload = compact.toJson(message);
        if (payload.length() > 3900) throw new IllegalStateException("Candidate observation exceeds fixture chat boundary");
        getLogger().info("Actual candidate " + currentSuite.get("name").getAsString() + " " + test.get("a") + "+" + test.get("b") + ": observed=" + observed + " expected=" + test.get("expected") + " stable=" + stable);
        observer.sendMessage("AC_CANDIDATE " + payload);
        caseIndex++;
        later(this::beginCase, 5);
    }

    private JsonArray structure() {
        JsonArray result = new JsonArray();
        for (JsonElement element : config.getAsJsonArray("placements")) {
            JsonObject placement = element.getAsJsonObject();
            JsonObject actual = new JsonObject();
            Block block = at(placement.getAsJsonArray("position"));
            actual.add("position", absolute(placement.getAsJsonArray("position")));
            actual.addProperty("expected_material", placement.get("block").getAsString());
            actual.addProperty("actual_material", block.getType().getKey().toString());
            actual.addProperty("block_data", block.getBlockData().getAsString());
            result.add(actual);
        }
        return result;
    }

    private void fail(Exception error) {
        if (report == null) report = new JsonObject();
        report.addProperty("error", error.toString());
        finish(false);
    }

    private void finish(boolean passed) {
        if (finished) return;
        finished = true;
        pendingNative = 0;
        report.addProperty("status", passed ? "pass" : "fail");
        report.addProperty("elapsed_ms", (System.nanoTime() - began) / 1000000);
        report.add("final_structure", structure());
        try {
            Files.writeString(resultPath, gson.toJson(report) + "\n");
        } catch (Exception error) {
            report.addProperty("status", "fail");
            report.addProperty("evidence_error", error.toString());
        }
        JsonObject summary = new JsonObject();
        summary.addProperty("status", report.get("status").getAsString());
        summary.addProperty("suite_count", suiteResults.size());
        summary.addProperty("result_file", resultPath.toString());
        if (report.has("error")) summary.add("error", report.get("error"));
        if (observer != null) observer.sendMessage("AC_CANDIDATE_RESULT " + compact.toJson(summary));
    }
}

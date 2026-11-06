package org.agentcity.paper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Set;
import java.util.Map;

/** Focused checks for the extra structure permission boundary. */
public final class ConstructionAccessCheck {
    private static final int[] MINIMUM = {-16, 80, -8};
    private static final int[] MAXIMUM = {15, 95, 7};
    private static final int[] ORIGIN = {-12, 81, -4};
    private static final int[] CHEST = {-14, 81, 5};
    private static int checks;

    private static String hash(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static Map<String, String> load(Path path, String expectedHash) throws Exception {
        return ConstructionAccessPlan.load(path, expectedHash, MINIMUM, MAXIMUM, ORIGIN,
                CHEST, Set.of("-12,82,-4"));
    }

    private static void rejects(Path path, String content) throws Exception {
        Files.writeString(path, content);
        try {
            load(path, hash(Files.readAllBytes(path)));
        } catch (IllegalArgumentException expected) {
            checks++;
            return;
        }
        throw new AssertionError("Invalid access manifest was accepted");
    }

    public static void main(String[] args) throws Exception {
        Path path = Files.createTempFile("agentcity-access-", ".json");
        try {
            String prefix = "{\"schema\":\"agentcity.construction-access.v1\",\"positions\":";
            Files.writeString(path, prefix + "[[1,2,3]]}");
            if (!load(path, hash(Files.readAllBytes(path))).equals(Map.of("-11,83,-1", "minecraft:glass"))) {
                throw new AssertionError("Relative coordinates were not bound to the plot");
            }
            checks++;
            try {
                load(path, "0".repeat(64));
                throw new AssertionError("Changed access bytes were accepted");
            } catch (IllegalArgumentException expected) { checks++; }
            rejects(path, prefix + "[[0,1,0]]}"); // Existing circuit position.
            rejects(path, prefix + "[[-2,0,9]]}"); // Stock chest.
            rejects(path, prefix + "[[1,-1,3]]}"); // Protected floor.
            rejects(path, prefix + "[[100,2,3]]}");
            rejects(path, prefix + "[[1,2,3],[1,2,3]]}");
            Files.writeString(path, prefix + "[[1,2,3]],\"bottom_slabs\":[[2,2,3]]}");
            if (!"minecraft:stone_slab[type=bottom,waterlogged=false]".equals(
                    load(path, hash(Files.readAllBytes(path))).get("-10,83,-1"))) {
                throw new AssertionError("Slab state was not fixed to the approved bottom slab");
            }
            checks++;
            rejects(path, prefix + "[[1,2,3]],\"bottom_slabs\":[[1,2,3]]}");
            System.out.println("ConstructionAccessCheck PASS: " + checks + " checks");
        } finally {
            Files.deleteIfExists(path);
        }
    }
}

package org.agentcity.paper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Fixed operator access structures. These positions never authorize bot mutations. */
final class ConstructionAccessPlan {
    private ConstructionAccessPlan() {}

    static Map<String, String> load(Path path, String expectedHash, int[] minimum, int[] maximum,
                            int[] origin, int[] chest, Set<String> circuitPositions) throws Exception {
        byte[] bytes = Files.readAllBytes(path);
        String actualHash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        if (!expectedHash.matches("[0-9a-f]{64}") || !actualHash.equals(expectedHash)) {
            throw new IllegalArgumentException("construction_access_hash");
        }

        Map<String, Object> manifest = StrictJson.object(new String(bytes, java.nio.charset.StandardCharsets.UTF_8));
        if (!"agentcity.construction-access.v1".equals(manifest.get("schema"))
                || !(manifest.get("positions") instanceof List<?> positions)
                || positions.isEmpty() || positions.size() > 2048) {
            throw new IllegalArgumentException("construction_access_manifest");
        }

        Object slabValue = manifest.getOrDefault("bottom_slabs", List.of());
        if (!(slabValue instanceof List<?> slabs) || positions.size() + slabs.size() > 2048) {
            throw new IllegalArgumentException("construction_access_slabs");
        }
        Map<String, String> approvedAccess = new HashMap<>();
        addPositions(positions, "minecraft:glass", approvedAccess, minimum, maximum, origin, chest, circuitPositions);
        addPositions(slabs, "minecraft:stone_slab[type=bottom,waterlogged=false]", approvedAccess,
                minimum, maximum, origin, chest, circuitPositions);
        return Map.copyOf(approvedAccess);
    }

    private static void addPositions(List<?> positions, String state, Map<String, String> approvedAccess,
                                     int[] minimum, int[] maximum, int[] origin, int[] chest,
                                     Set<String> circuitPositions) {
        for (Object value : positions) {
            if (!(value instanceof List<?> relative) || relative.size() != 3) {
                throw new IllegalArgumentException("construction_access_position");
            }
            int[] absolute = new int[3];
            for (int axis = 0; axis < 3; axis++) {
                if (!(relative.get(axis) instanceof Long coordinate)) {
                    throw new IllegalArgumentException("construction_access_coordinate");
                }
                absolute[axis] = Math.addExact(origin[axis], Math.toIntExact(coordinate));
                if (absolute[axis] < minimum[axis] || absolute[axis] > maximum[axis]) {
                    throw new IllegalArgumentException("construction_access_outside_plot");
                }
            }
            String position = absolute[0] + "," + absolute[1] + "," + absolute[2];
            String chestPosition = chest[0] + "," + chest[1] + "," + chest[2];
            if (absolute[1] <= minimum[1] || circuitPositions.contains(position)
                    || position.equals(chestPosition) || approvedAccess.putIfAbsent(position, state) != null) {
                throw new IllegalArgumentException("construction_access_collision");
            }
        }
    }
}

package org.agentcity.paper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Fixed operator glass supports. These positions never authorize bot mutations. */
final class ConstructionAccessPlan {
    private ConstructionAccessPlan() {}

    static Set<String> load(Path path, String expectedHash, int[] minimum, int[] maximum,
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

        Set<String> approvedAccess = new HashSet<>();
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
                    || position.equals(chestPosition) || !approvedAccess.add(position)) {
                throw new IllegalArgumentException("construction_access_collision");
            }
        }
        return Set.copyOf(approvedAccess);
    }
}

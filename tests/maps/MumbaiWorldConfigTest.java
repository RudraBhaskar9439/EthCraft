package org.agentcity.paper;

import java.io.DataOutputStream;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.UUID;
import java.util.zip.GZIPOutputStream;

public final class MumbaiWorldConfigTest {
    private static final String VALID = """
        {"schema":"agentcity.mumbai-world.v1","world":"agentcity_mumbai",
         "worldUuid":"be915875-64ec-4498-ae2a-1a6800dd1e53","spawn":[1640,70,2779],
         "bounds":{"min":[0,-64,0],"max":[2629,319,3224]},"yaw":110}
        """;

    private static void refused(String text) {
        try { MumbaiWorld.Config.parse(text); throw new AssertionError("Invalid config accepted"); }
        catch (IllegalArgumentException expected) {}
    }

    private static void metadata(Path file, UUID uuid, int length) throws Exception {
        Files.createDirectories(file.getParent());
        try (var output = new DataOutputStream(new GZIPOutputStream(Files.newOutputStream(file)))) {
            output.writeByte(10); output.writeUTF("");
            output.writeByte(3); output.writeUTF("DataVersion"); output.writeInt(5023);
            output.writeByte(10); output.writeUTF("data"); output.writeByte(11); output.writeUTF("uuid"); output.writeInt(length);
            output.writeInt((int)(uuid.getMostSignificantBits() >>> 32)); output.writeInt((int)uuid.getMostSignificantBits());
            output.writeInt((int)(uuid.getLeastSignificantBits() >>> 32)); output.writeInt((int)uuid.getLeastSignificantBits());
            output.writeByte(0); output.writeByte(0);
        }
    }

    private static void storage() throws Exception {
        Path root = Files.createTempDirectory("agentcity-mumbai-storage-");
        UUID uuid = UUID.fromString("be915875-64ec-4498-ae2a-1a6800dd1e53");
        try {
            Path legacy = root.resolve("agentcity_mumbai");
            Files.createDirectories(legacy.resolve("region"));
            Files.write(legacy.resolve("region/r.0.0.mca"), new byte[8193]);
            Files.write(legacy.resolve("level.dat"), new byte[]{10, 0, 0, 0});
            Files.write(legacy.resolve("uid.dat"), ByteBuffer.allocate(16).putLong(uuid.getMostSignificantBits()).putLong(uuid.getLeastSignificantBits()).array());
            if (!MumbaiWorldStorage.verify(root, uuid).equals(legacy)) throw new AssertionError("Legacy import not found");
            Path migrated = root.resolve("primary/dimensions/minecraft/agentcity_mumbai");
            Files.createDirectories(migrated);
            Files.move(legacy.resolve("region"), migrated.resolve("region"));
            Files.delete(legacy.resolve("level.dat")); Files.delete(legacy.resolve("uid.dat")); Files.delete(legacy);
            Path meta = migrated.resolve("data/paper/metadata.dat");
            metadata(meta, uuid, 4);
            if (!MumbaiWorldStorage.verify(root, uuid).equals(migrated)) throw new AssertionError("Migrated world not found");
            try { MumbaiWorldStorage.verify(root, UUID.randomUUID()); throw new AssertionError("Changed persisted UUID accepted"); }
            catch (IllegalArgumentException expected) {}
            metadata(meta, uuid, 5);
            try { MumbaiWorldStorage.metadataUuid(meta); throw new AssertionError("Malformed persisted UUID accepted"); }
            catch (IllegalArgumentException expected) {}
            metadata(meta, uuid, 4);
            Files.delete(migrated.resolve("region/r.0.0.mca"));
            try { MumbaiWorldStorage.verify(root, uuid); throw new AssertionError("Empty regenerated world accepted"); }
            catch (IllegalArgumentException expected) {}
        } finally {
            try (var files = Files.walk(root)) { for (Path path : files.sorted(Comparator.reverseOrder()).toList()) Files.delete(path); }
        }
    }

    public static void main(String[] args) throws Exception {
        MumbaiWorld.Config value = MumbaiWorld.Config.parse(VALID);
        if (value.spawn().x() != 1640 || value.spawn().y() != 70 || value.yaw() != 110
                || !value.worldUuid().toString().equals("be915875-64ec-4498-ae2a-1a6800dd1e53")) throw new AssertionError("Config binding changed");
        refused(VALID.replace("agentcity_mumbai", "agentcity_play"));
        refused(VALID.replace("be915875-64ec-4498-ae2a-1a6800dd1e53", "wrong-uuid"));
        refused(VALID.replace("1640,70,2779", "1640,70,4000"));
        refused(VALID.replace("1640,70,2779", "1640,319,2779"));
        refused(VALID.replace("2629,319,3224", "2147483647,319,3224"));
        refused(VALID.replace("1640,70,2779", "1640,70.5,2779"));
        storage();
        System.out.println("{\"status\":\"pass\",\"checks\":12,\"scope\":\"Static optional Mumbai config and both persisted storage layouts; no server/world mutation\"}");
    }
}

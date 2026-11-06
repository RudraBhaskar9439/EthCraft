package org.agentcity.paper;

import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;
import java.util.zip.GZIPInputStream;

/** Recognize both the initial import and Paper's persisted dimension migration. */
final class MumbaiWorldStorage {
    static Path verify(Path container, UUID expected) throws IOException {
        Path root = container.toRealPath();
        Set<Path> found = new LinkedHashSet<>();
        Path legacy = root.resolve(MumbaiWorld.NAME);
        if (Files.isDirectory(legacy, LinkOption.NOFOLLOW_LINKS)) found.add(legacy);
        try (var children = Files.list(root)) {
            for (Path level : children.filter(path -> Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)).toList()) {
                Path migrated = level.resolve("dimensions/minecraft").resolve(MumbaiWorld.NAME);
                if (Files.isDirectory(migrated, LinkOption.NOFOLLOW_LINKS)) found.add(migrated);
            }
        }
        if (found.size() != 1) throw new IllegalArgumentException("mumbai_imported_world_required");
        Path folder = found.iterator().next();
        if (!folder.toRealPath().startsWith(root)) throw new IllegalArgumentException("mumbai_world_path");
        UUID actual;
        if (folder.equals(legacy)) {
            requireFile(folder.resolve("level.dat"));
            Path uid = folder.resolve("uid.dat");
            requireFile(uid);
            if (Files.size(uid) != 16) throw new IllegalArgumentException("mumbai_world_uuid");
            ByteBuffer data = ByteBuffer.wrap(Files.readAllBytes(uid));
            actual = new UUID(data.getLong(), data.getLong());
        } else actual = metadataUuid(folder.resolve("data/paper/metadata.dat"));
        if (!actual.equals(expected)) throw new IllegalArgumentException("mumbai_world_uuid");
        Path region = folder.resolve("region");
        if (!Files.isDirectory(region, LinkOption.NOFOLLOW_LINKS)) throw new IllegalArgumentException("mumbai_region_required");
        try (var files = Files.list(region)) {
            if (files.noneMatch(file -> file.getFileName().toString().matches("r\\.-?[0-9]+\\.-?[0-9]+\\.mca")
                    && Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) && file.toFile().length() > 8192)) {
                throw new IllegalArgumentException("mumbai_region_required");
            }
        }
        return folder;
    }

    private static void requireFile(Path file) {
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) throw new IllegalArgumentException("mumbai_imported_world_required");
    }

    static UUID metadataUuid(Path file) throws IOException {
        requireFile(file);
        if (Files.size(file) > 65536) throw new IllegalArgumentException("mumbai_metadata_size");
        byte[] raw = Files.readAllBytes(file);
        byte[] decoded;
        try (var gzip = new GZIPInputStream(new ByteArrayInputStream(raw))) { decoded = gzip.readNBytes(4097); }
        if (decoded.length > 4096) throw new IllegalArgumentException("mumbai_metadata_size");
        try (var input = new DataInputStream(new ByteArrayInputStream(decoded))) {
            if (input.readUnsignedByte() != 10 || !input.readUTF().isEmpty()) throw new IllegalArgumentException("mumbai_metadata_format");
            UUID uuid = null;
            boolean version = false;
            int type;
            // Pinned Paper metadata contains only DataVersion and data.uuid.
            // Unknown fields require an explicit storage-format migration review.
            while ((type = input.readUnsignedByte()) != 0) {
                String name = input.readUTF();
                if (type == 3 && name.equals("DataVersion") && !version) { input.readInt(); version = true; }
                else if (type == 10 && name.equals("data") && uuid == null) {
                    if (input.readUnsignedByte() != 11 || !input.readUTF().equals("uuid") || input.readInt() != 4) throw new IllegalArgumentException("mumbai_metadata_uuid");
                    long most = ((long)input.readInt() << 32) | (input.readInt() & 0xffffffffL);
                    long least = ((long)input.readInt() << 32) | (input.readInt() & 0xffffffffL);
                    uuid = new UUID(most, least);
                    if (input.readUnsignedByte() != 0) throw new IllegalArgumentException("mumbai_metadata_format");
                } else throw new IllegalArgumentException("mumbai_metadata_format");
            }
            if (!version || uuid == null || input.available() != 0) throw new IllegalArgumentException("mumbai_metadata_format");
            return uuid;
        }
    }
}

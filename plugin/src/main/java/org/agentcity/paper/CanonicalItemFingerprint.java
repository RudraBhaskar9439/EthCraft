package org.agentcity.paper;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.GZIPInputStream;

/** Sort NBT compound keys only; gzip and compound insertion order are not item identity. */
final class CanonicalItemFingerprint {
    static final String VERSION = "canonical_nbt_v1";
    private static final int MAX_BYTES = 1_048_576;
    private static final int MAX_DEPTH = 64;
    private record Entry(int type, byte[] name, byte[] payload) {}

    private CanonicalItemFingerprint() {}

    static String hash(String encoded) {
        return hash(Base64.getDecoder().decode(encoded));
    }

    static String hash(byte[] serialized) {
        try {
            byte[] canonical = canonical(serialized);
            MessageDigest hash = MessageDigest.getInstance("SHA-256");
            hash.update(("agentcity.item." + VERSION + "\0").getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash.digest(canonical));
        } catch (Exception error) {
            throw new IllegalArgumentException("escrow_canonical_item_invalid", error);
        }
    }

    static boolean same(String a, String b) {
        return hash(a).equals(hash(b));
    }

    private static byte[] exact(DataInputStream input, int length) throws IOException {
        if (length < 0 || length > MAX_BYTES) throw new IOException("nbt_length");
        byte[] bytes = input.readNBytes(length);
        if (bytes.length != length) throw new EOFException("nbt_truncated");
        return bytes;
    }

    private static int length(DataInputStream input) throws IOException {
        int value = input.readInt();
        if (value < 0 || value > MAX_BYTES) throw new IOException("nbt_length");
        return value;
    }

    private static byte[] utf(DataInputStream input) throws IOException {
        int length=input.readUnsignedShort();
        var bytes=new ByteArrayOutputStream(length+2);var output=new DataOutputStream(bytes);
        output.writeShort(length);output.write(exact(input,length));return bytes.toByteArray();
    }

    private static byte[] canonical(byte[] serialized) throws IOException {
        if (serialized.length > MAX_BYTES) throw new IOException("item_length");
        var source = new DataInputStream(new ByteArrayInputStream(serialized));
        var bytes = new ByteArrayOutputStream();
        var output = new DataOutputStream(bytes);
        int version = source.readUnsignedByte(), count = source.readInt();
        if (version != 1 || count < 0 || count > 4096) throw new IOException("item_format");
        output.writeByte(version); output.writeInt(count);
        for (int i = 0; i < count; i++) {
            int size = length(source);
            if (size == 0) { output.writeInt(0); continue; }
            byte[] compressed = exact(source, size), nbt;
            try (var gzip = new GZIPInputStream(new ByteArrayInputStream(compressed))) {
                nbt = gzip.readNBytes(MAX_BYTES + 1);
            }
            if (nbt.length > MAX_BYTES) throw new IOException("nbt_size");
            var input = new DataInputStream(new ByteArrayInputStream(nbt));
            var itemBytes = new ByteArrayOutputStream();
            var item = new DataOutputStream(itemBytes);
            int type = input.readUnsignedByte();
            if (type != 10) throw new IOException("item_root");
            item.writeByte(type); item.write(utf(input)); payload(type, input, item, 0, new int[1]);
            if (input.available() != 0) throw new IOException("nbt_trailing_data");
            item.flush(); output.writeInt(itemBytes.size()); itemBytes.writeTo(output);
        }
        if (source.available() != 0) throw new IOException("item_trailing_data");
        output.flush();
        return bytes.toByteArray();
    }

    private static void payload(int type, DataInputStream input, DataOutputStream output, int depth, int[] tags) throws IOException {
        if (depth > MAX_DEPTH || ++tags[0]>65536) throw new IOException("nbt_depth_or_count");
        switch (type) {
            case 0 -> { }
            case 1 -> output.writeByte(input.readByte());
            case 2 -> output.writeShort(input.readShort());
            case 3, 5 -> output.writeInt(input.readInt());
            case 4, 6 -> output.writeLong(input.readLong());
            case 7, 11, 12 -> {
                int count = length(input), width = type == 7 ? 1 : type == 11 ? 4 : 8;
                output.writeInt(count); output.write(exact(input, Math.multiplyExact(count, width)));
            }
            case 8 -> output.write(utf(input));
            case 9 -> {
                int element = input.readUnsignedByte(), count = length(input);
                if (element > 12 || element == 0 && count != 0) throw new IOException("nbt_list_type");
                output.writeByte(element); output.writeInt(count);
                for (int i = 0; i < count; i++) payload(element, input, output, depth + 1,tags);
            }
            case 10 -> {
                SortedMap<String, Entry> entries = new TreeMap<>();
                for (int child; (child = input.readUnsignedByte()) != 0;) {
                    if (child > 12) throw new IOException("nbt_tag_type");
                    byte[] name=utf(input);String key=new DataInputStream(new ByteArrayInputStream(name)).readUTF();
                    var bytes = new ByteArrayOutputStream();
                    payload(child, input, new DataOutputStream(bytes), depth + 1,tags);
                    if (entries.putIfAbsent(key, new Entry(child,name,bytes.toByteArray())) != null) throw new IOException("nbt_duplicate_key");
                }
                for (var pair : entries.entrySet()) {
                    output.writeByte(pair.getValue().type()); output.write(pair.getValue().name()); output.write(pair.getValue().payload());
                }
                output.writeByte(0);
            }
            default -> throw new IOException("nbt_tag_type");
        }
    }
}

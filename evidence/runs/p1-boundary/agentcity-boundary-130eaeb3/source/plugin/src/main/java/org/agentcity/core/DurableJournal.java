package org.agentcity.core;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Framed, hash-chained local journal. A valid record is not proof of world durability. */
public final class DurableJournal implements AutoCloseable {
    static final long MIN_MUTATION_FREE_BYTES = 1_073_741_824L;
    @FunctionalInterface interface SpaceProbe { long usableBytes() throws IOException; }
    private static final int MAGIC = 0x41434a31;
    private static final int MAX_RECORD = 512 * 1024;
    // shortcut: a bounded single-job log; add reviewed compaction before long-running multi-job service.
    private static final long MAX_FILE = 64L * 1024 * 1024;
    private final FileChannel channel;
    private final FileLock lock;
    private final SpaceProbe spaceProbe;
    private final List<Map<String, String>> records = new ArrayList<>();
    private byte[] previous = new byte[32];

    public DurableJournal(Path path) throws IOException {
        this(path, () -> Files.getFileStore(path.toAbsolutePath().getParent()).getUsableSpace());
    }

    DurableJournal(Path path, SpaceProbe spaceProbe) throws IOException {
        this.spaceProbe = java.util.Objects.requireNonNull(spaceProbe);
        Path parent = path.toAbsolutePath().getParent();
        Files.createDirectories(parent);
        channel = FileChannel.open(path, StandardOpenOption.CREATE, StandardOpenOption.READ, StandardOpenOption.WRITE);
        FileLock acquired = null;
        try {
            acquired = channel.tryLock();
            if (acquired == null) throw new IOException("journal already owned");
            lock = acquired;
            if (channel.size() > MAX_FILE) throw new IOException("journal capacity exceeded");
            read();
        } catch (IOException | RuntimeException failure) {
            if (acquired != null) acquired.release();
            channel.close();
            throw failure;
        }
    }

    public synchronized List<Map<String, String>> records() { return List.copyOf(records); }

    public synchronized void append(Map<String, String> fields) throws IOException {
        // INTENT is appended on the journal worker before any native mutation permit exists.
        // Preserve room for post-effect receipts even when the admission reserve is exhausted.
        if ("INTENT".equals(fields.get("type")) && spaceProbe.usableBytes() < MIN_MUTATION_FREE_BYTES)
            throw new IOException("insufficient free disk before mutation intent");
        byte[] payload = encode(fields);
        byte[] digest = digest(previous, payload);
        ByteBuffer frame = ByteBuffer.allocate(8 + 32 + payload.length + 32);
        frame.putInt(MAGIC).putInt(payload.length).put(previous).put(payload).put(digest).flip();
        if (channel.size() + frame.remaining() > MAX_FILE) throw new IOException("journal capacity exceeded");
        channel.position(channel.size());
        while (frame.hasRemaining()) channel.write(frame);
        channel.force(true);
        previous = digest;
        records.add(Collections.unmodifiableMap(new TreeMap<>(fields)));
    }

    private void read() throws IOException {
        channel.position(0);
        while (channel.position() < channel.size()) {
            ByteBuffer header = ByteBuffer.allocate(8);
            readFully(header); header.flip();
            if (header.getInt() != MAGIC) throw new IOException("journal frame magic");
            int length = header.getInt();
            if (length < 4 || length > MAX_RECORD) throw new IOException("journal frame length");
            ByteBuffer frame = ByteBuffer.allocate(32 + length + 32);
            readFully(frame); frame.flip();
            byte[] prior = new byte[32], payload = new byte[length], expected = new byte[32];
            frame.get(prior).get(payload).get(expected);
            if (!Arrays.equals(previous, prior) || !Arrays.equals(digest(prior, payload), expected))
                throw new IOException("journal checksum or chain mismatch");
            records.add(decode(payload)); previous = expected;
        }
    }

    private void readFully(ByteBuffer target) throws IOException {
        while (target.hasRemaining()) if (channel.read(target) < 0) throw new IOException("truncated journal");
    }

    private static byte[] encode(Map<String, String> fields) throws IOException {
        if (fields.isEmpty() || fields.size() > 64) throw new IOException("journal fields");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (DataOutputStream out = new DataOutputStream(bytes)) {
            out.writeInt(fields.size());
            for (var entry : new TreeMap<>(fields).entrySet()) {
                if (entry.getKey() == null || entry.getValue() == null) throw new IOException("null journal field");
                Command.write(out, entry.getKey()); Command.write(out, entry.getValue());
            }
        }
        if (bytes.size() > MAX_RECORD) throw new IOException("journal record size");
        return bytes.toByteArray();
    }

    private static Map<String, String> decode(byte[] bytes) throws IOException {
        try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(bytes))) {
            int count = in.readInt();
            if (count < 1 || count > 64) throw new IOException("journal field count");
            Map<String, String> result = new TreeMap<>();
            for (int i = 0; i < count; i++) {
                String key = readString(in), value = readString(in);
                if (result.put(key, value) != null) throw new IOException("duplicate journal field");
            }
            if (in.available() != 0) throw new IOException("journal trailing content");
            return Collections.unmodifiableMap(result);
        }
    }

    private static String readString(DataInputStream in) throws IOException {
        int length = in.readInt();
        if (length < 0 || length > MAX_RECORD || length > in.available()) throw new IOException("journal string length");
        byte[] bytes = in.readNBytes(length);
        try {
            return java.nio.charset.StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                    .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString();
        } catch (java.nio.charset.CharacterCodingException malformed) { throw new IOException("journal UTF-8", malformed); }
    }

    private static byte[] digest(byte[] prior, byte[] payload) {
        byte[] joined = Arrays.copyOf(prior, prior.length + payload.length);
        System.arraycopy(payload, 0, joined, prior.length, payload.length);
        return HexFormat.of().parseHex(Command.sha256(joined));
    }

    @Override public synchronized void close() throws IOException {
        try { channel.force(true); }
        finally { try { lock.release(); } finally { channel.close(); } }
    }
}

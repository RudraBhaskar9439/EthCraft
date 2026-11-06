package org.agentcity.core;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Collections;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;

/** Strict typed envelope. Raw JSON decoding must also reject duplicate keys. */
public record Command(String operationId, String serverId, String jobId, long agreementVersion,
                      UUID actorId, long expectedRevision, String authorizationReference,
                      long expiresAtMs, Action action, Map<String, Object> params) {
    public enum Action { OBSERVE, PLACE, BREAK, REPAIR, WITHDRAW, RETURN, DELIVER, LOCK, UNLOCK, INSPECT }
    private static final Set<String> KEYS = Set.of("operationId", "serverId", "jobId", "agreementVersion",
            "actorId", "expectedRevision", "authorizationReference", "expiresAtMs", "action", "params");

    public Command {
        identifier(operationId, 128);
        identifier(serverId, 64);
        identifier(jobId, 64);
        identifier(authorizationReference, 256);
        if (agreementVersion < 1 || expectedRevision < 0 || expectedRevision == Long.MAX_VALUE
                || expiresAtMs < 1 || actorId == null || action == null || params == null) {
            throw new IllegalArgumentException("invalid envelope value");
        }
        params = normalizeParams(action, params);
    }

    public static Command parse(Map<String, Object> map) {
        if (map == null || !map.keySet().equals(KEYS)) throw new IllegalArgumentException("envelope fields");
        String actor = text(map.get("actorId"), 36);
        UUID uuid = UUID.fromString(actor);
        if (!uuid.toString().equalsIgnoreCase(actor)) throw new IllegalArgumentException("actor UUID");
        Object parameters = map.get("params");
        if (!(parameters instanceof Map<?, ?> raw)) throw new IllegalArgumentException("params object");
        Map<String, Object> values = stringMap(raw);
        return new Command(text(map.get("operationId"), 128), text(map.get("serverId"), 64),
                text(map.get("jobId"), 64), integer(map.get("agreementVersion")), uuid,
                integer(map.get("expectedRevision")), text(map.get("authorizationReference"), 256),
                integer(map.get("expiresAtMs")), Action.valueOf(text(map.get("action"), 16)), values);
    }

    public boolean structural() { return action == Action.PLACE || action == Action.BREAK || action == Action.REPAIR; }

    public long coordinate(String axis) { return (Long) params.get(axis); }

    public String fingerprint() {
        try {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (DataOutputStream out = new DataOutputStream(bytes)) {
                write(out, operationId); write(out, serverId); write(out, jobId);
                out.writeLong(agreementVersion); write(out, actorId.toString());
                out.writeLong(expectedRevision); write(out, authorizationReference);
                out.writeLong(expiresAtMs); write(out, action.name());
                canonical(out, params);
            }
            if (bytes.size() > 65_536) throw new IllegalArgumentException("command size");
            return sha256(bytes.toByteArray());
        } catch (IOException impossible) { throw new IllegalStateException(impossible); }
    }

    static long integer(Object value) {
        try {
            if (value instanceof Long n) return n;
            if (value instanceof Integer n) return n.longValue();
            if (value instanceof Short n) return n.longValue();
            if (value instanceof Byte n) return n.longValue();
            if (value instanceof BigInteger n) return n.longValueExact();
            if (value instanceof BigDecimal n) return n.longValueExact();
        } catch (ArithmeticException invalid) { throw new IllegalArgumentException("integral range", invalid); }
        throw new IllegalArgumentException("integer required");
    }

    static String text(Object value, int maxBytes) {
        if (!(value instanceof String s) || s.isEmpty() || s.getBytes(StandardCharsets.UTF_8).length > maxBytes)
            throw new IllegalArgumentException("bounded string required");
        return s;
    }

    private static void identifier(String value, int max) {
        if (value == null || value.length() > max || !value.matches("[A-Za-z0-9_.:/-]+"))
            throw new IllegalArgumentException("identifier");
    }

    private static Map<String, Object> stringMap(Map<?, ?> raw) {
        Map<String, Object> result = new TreeMap<>();
        for (var entry : raw.entrySet()) {
            if (!(entry.getKey() instanceof String key)) throw new IllegalArgumentException("string key required");
            result.put(key, entry.getValue());
        }
        return result;
    }

    private static Map<String, Object> normalizeParams(Action action, Map<String, Object> input) {
        Set<String> expected = switch (action) {
            case PLACE, REPAIR -> Set.of("x", "y", "z", "state");
            case BREAK -> Set.of("x", "y", "z");
            case WITHDRAW, RETURN -> Set.of("item", "count");
            case DELIVER -> Set.of("claimId", "items");
            default -> Set.of();
        };
        if (!input.keySet().equals(expected)) throw new IllegalArgumentException("action parameter fields");
        Map<String, Object> normalized = new TreeMap<>();
        for (var entry : input.entrySet()) {
            String key = entry.getKey(); Object value = entry.getValue();
            switch (key) {
                case "x", "y", "z" -> {
                    long n = integer(value);
                    if (n < Integer.MIN_VALUE || n > Integer.MAX_VALUE) throw new IllegalArgumentException("coordinate range");
                    normalized.put(key, n);
                }
                case "count" -> {
                    long n = integer(value);
                    if (n < 1 || n > 64) throw new IllegalArgumentException("stack quantity");
                    normalized.put(key, n);
                }
                case "state" -> {
                    String s = text(value, 512);
                    if (!s.matches("minecraft:[a-z0-9_]+(?:\\[[a-z0-9_,=]+\\])?")) throw new IllegalArgumentException("block state");
                    normalized.put(key, s);
                }
                case "item" -> {
                    String s = text(value, 96);
                    if (!s.matches("minecraft:[a-z0-9_]+")) throw new IllegalArgumentException("item");
                    normalized.put(key, s);
                }
                case "claimId" -> {
                    String s = text(value, 128); identifier(s, 128); normalized.put(key, s);
                }
                case "items" -> {
                    if (!(value instanceof Map<?, ?> raw) || raw.isEmpty() || raw.size() > 128)
                        throw new IllegalArgumentException("delivery items");
                    Map<String, Object> items = new TreeMap<>();
                    for (var item : stringMap(raw).entrySet()) {
                        if (item.getKey().length() > 96 || !item.getKey().matches("minecraft:[a-z0-9_]+")) throw new IllegalArgumentException("delivery item");
                        long n = integer(item.getValue());
                        if (n < 1 || n > 1_048_576) throw new IllegalArgumentException("delivery quantity");
                        items.put(item.getKey(), n);
                    }
                    normalized.put(key, Collections.unmodifiableMap(items));
                }
                default -> throw new IllegalArgumentException("unknown parameter");
            }
        }
        return Collections.unmodifiableMap(normalized);
    }

    private static void canonical(DataOutputStream out, Map<String, Object> values) throws IOException {
        out.writeInt(values.size());
        for (var entry : new TreeMap<>(values).entrySet()) {
            write(out, entry.getKey());
            if (entry.getValue() instanceof String s) { out.writeByte(1); write(out, s); }
            else if (entry.getValue() instanceof Long n) { out.writeByte(2); out.writeLong(n); }
            else if (entry.getValue() instanceof Map<?, ?> map) { out.writeByte(3); canonical(out, stringMap(map)); }
            else throw new IllegalArgumentException("noncanonical value");
        }
    }

    static void write(DataOutputStream out, String value) throws IOException {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        out.writeInt(bytes.length); out.write(bytes);
    }

    static String sha256(byte[] value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value)); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
}

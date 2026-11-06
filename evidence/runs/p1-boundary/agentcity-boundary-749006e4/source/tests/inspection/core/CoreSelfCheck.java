package org.agentcity.core;

import java.io.IOException;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** Standard-library protocol tests. These strings are not actual world observations. */
public final class CoreSelfCheck {
    private static final UUID BUILDER = id(1), BOT = id(2), REQUESTER = id(3), INSPECTOR = id(4), OPERATOR = id(5), DELIVERY = id(6);
    private static int checks;
    private static final class TestClock extends Clock {
        long now = 1000;
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return Instant.ofEpochMilli(now); }
        @Override public long millis() { return now; }
    }
    @FunctionalInterface private interface Throwing { void run() throws Exception; }
    private static UUID id(int n) { return UUID.fromString(String.format("00000000-0000-0000-0000-%012d", n)); }
    private static void check(boolean okay, String message) { checks++; if (!okay) throw new AssertionError(message); }
    private static void rejects(Throwing action, String message) throws Exception {
        boolean refused = false;
        try { action.run(); } catch (IOException | IllegalArgumentException | IllegalStateException expected) { refused = true; }
        check(refused, message);
    }
    private static JobEngine.Config config() {
        return new JobEngine.Config("server", "job", 1, new JobEngine.Bounds(-2, 79, -2, 4, 90, 4),
                Map.of(BUILDER, JobEngine.Role.BUILDER, BOT, JobEngine.Role.BOT, REQUESTER, JobEngine.Role.REQUESTER,
                        INSPECTOR, JobEngine.Role.INSPECTOR, OPERATOR, JobEngine.Role.OPERATOR, DELIVERY, JobEngine.Role.DELIVERY_WORKER),
                "local-authorized-v1", "calculator-v1", "calculator-v1", 20_000, 30_000,
                JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS, 5000);
    }
    private static Map<String, Object> params() { return Map.of("x", 0L, "y", 80L, "z", 0L, "state", "minecraft:stone_bricks"); }
    private static Map<String, Object> envelope(String op, Command.Action action, UUID actor, long revision, long expiry, Map<String, Object> params) {
        return new HashMap<>(Map.ofEntries(Map.entry("operationId", op), Map.entry("serverId", "server"),
                Map.entry("jobId", "job"), Map.entry("agreementVersion", 1L), Map.entry("actorId", actor.toString()),
                Map.entry("expectedRevision", revision), Map.entry("authorizationReference", "local-authorized-v1"),
                Map.entry("expiresAtMs", expiry), Map.entry("action", action.name()), Map.entry("params", params)));
    }
    private static Command place(String op, long revision, TestClock clock) {
        return Command.parse(envelope(op, Command.Action.PLACE, BUILDER, revision, clock.now + 5000, params()));
    }
    private static JobEngine.Result await(CompletableFuture<JobEngine.Result> future) throws Exception { return future.get(10, TimeUnit.SECONDS); }
    private static void apply(JobEngine engine, Command command, UUID actor, String before, String after) throws Exception {
        check(await(engine.prepare(command, actor, before, after)).status() == JobEngine.Status.PREPARED, "durable prepare");
        check(engine.consumePrepared(command.operationId(), actor, before).status() == JobEngine.Status.AUTHORIZED, "native action authorized");
        check(await(engine.complete(command.operationId(), after)).status() == JobEngine.Status.APPLIED, "observed receipt durable");
    }

    private static void parsing() throws Exception {
        TestClock clock = new TestClock();
        Map<String, Object> valid = envelope("parse", Command.Action.PLACE, BUILDER, 0, 5000, params());
        check(Command.parse(valid).fingerprint().equals(Command.parse(new HashMap<>(valid)).fingerprint()), "canonical key order");
        for (String field : valid.keySet()) {
            Map<String, Object> missing = new HashMap<>(valid); missing.remove(field);
            rejects(() -> Command.parse(missing), "missing " + field);
        }
        Map<String, Object> extra = new HashMap<>(valid); extra.put("role", "OPERATOR");
        rejects(() -> Command.parse(extra), "unknown field cannot grant role");
        for (Object invalid : List.of(0.5, 1.0, new BigDecimal("1.5"), BigInteger.ONE.shiftLeft(70), "1", true)) {
            Map<String, Object> value = new HashMap<>(valid); value.put("agreementVersion", invalid);
            rejects(() -> Command.parse(value), "strict integer type/range");
        }
        for (String actor : List.of("1-1-1-1-1", "FixtureBuilder", "not-a-uuid")) {
            Map<String, Object> value = new HashMap<>(valid); value.put("actorId", actor);
            rejects(() -> Command.parse(value), "strict actor identity");
        }
        for (String action : List.of("place", "ACCEPT", "MINT", "ROOT")) {
            Map<String, Object> value = new HashMap<>(valid); value.put("action", action);
            rejects(() -> Command.parse(value), "unknown/forbidden action name");
        }
        for (Map<String, Object> p : List.of(Map.<String, Object>of(), Map.<String, Object>of("x", 0L, "y", 80L, "z", 0L, "state", "bad state"),
                Map.<String, Object>of("x", Long.MAX_VALUE, "y", 80L, "z", 0L, "state", "minecraft:stone"),
                Map.<String, Object>of("x", 0L, "y", 80L, "z", 0L, "state", "minecraft:" + "a".repeat(600)))) {
            Map<String, Object> value = new HashMap<>(valid); value.put("params", p);
            rejects(() -> Command.parse(value), "parameter bounds/schema");
        }
        for (long quantity : new long[] {-1, 0, 65, Long.MAX_VALUE}) {
            rejects(() -> Command.parse(envelope("quantity", Command.Action.WITHDRAW, BOT, 0, 5000,
                    Map.of("item", "minecraft:redstone", "count", quantity))), "stack boundary");
        }
        rejects(() -> Command.parse(envelope("items", Command.Action.DELIVER, DELIVERY, 0, 5000,
                Map.of("claimId", "claim", "items", Map.of("minecraft:redstone", 0L)))), "delivery quantity");
        rejects(() -> Command.parse(envelope("large-item", Command.Action.DELIVER, DELIVERY, 0, 5000,
                Map.of("claimId", "claim", "items", Map.of("minecraft:" + "x".repeat(100), 1L)))), "delivery item name bound");
        check(place("one", 0, clock).structural(), "placement is structural");
    }

    private static void boundaries() throws Exception {
        TestClock clock = new TestClock(); Path dir = Files.createTempDirectory("ac-boundaries");
        try (JobEngine engine = new JobEngine(dir.resolve("journal"), config(), clock)) {
            Map<String, Object> original = envelope("bad", Command.Action.PLACE, BUILDER, 0, 6000, params());
            Map<String, Object> mutations = Map.of("serverId", "other", "jobId", "other", "agreementVersion", 2L,
                    "actorId", id(99).toString(), "authorizationReference", "changed", "expectedRevision", 1L,
                    "expiresAtMs", clock.now);
            for (var entry : mutations.entrySet()) {
                Map<String, Object> altered = new HashMap<>(original); altered.put(entry.getKey(), entry.getValue());
                check(await(engine.prepare(Command.parse(altered), BUILDER, "before", "after")).status() == JobEngine.Status.REFUSED,
                        "receiver rejects altered " + entry.getKey());
            }
            check(await(engine.prepare(place("wrong-actual", 0, clock), BOT, "before", "after")).status() == JobEngine.Status.REFUSED, "verified actor binding");
            for (long expiry : new long[] {clock.now - 1, clock.now, clock.now + 10_001, Long.MAX_VALUE}) {
                Command c = Command.parse(envelope("expiry", Command.Action.PLACE, BUILDER, 0, expiry, params()));
                check(await(engine.prepare(c, BUILDER, "before", "after")).status() == JobEngine.Status.REFUSED, "expiry boundary");
            }
            for (Map<String, Object> outside : List.of(Map.<String, Object>of("x", -3L, "y", 80L, "z", 0L, "state", "minecraft:stone"),
                    Map.<String, Object>of("x", 5L, "y", 80L, "z", 0L, "state", "minecraft:stone"),
                    Map.<String, Object>of("x", 0L, "y", 78L, "z", 0L, "state", "minecraft:stone"),
                    Map.<String, Object>of("x", 0L, "y", 91L, "z", 0L, "state", "minecraft:stone"),
                    Map.<String, Object>of("x", 0L, "y", 80L, "z", -3L, "state", "minecraft:stone"),
                    Map.<String, Object>of("x", 0L, "y", 80L, "z", 5L, "state", "minecraft:stone"))) {
                Command c = Command.parse(envelope("outside", Command.Action.PLACE, BUILDER, 0, 6000, outside));
                check(await(engine.prepare(c, BUILDER, "before", "after")).code().equals("OUT_OF_BOUNDS"), "all outside faces denied");
            }
            for (UUID actor : List.of(REQUESTER, OPERATOR, INSPECTOR, DELIVERY)) {
                Command c = Command.parse(envelope("forbidden", Command.Action.PLACE, actor, 0, 6000, params()));
                check(await(engine.prepare(c, actor, "before", "after")).code().equals("FORBIDDEN"), "role cannot place");
            }
            check(engine.state().revision() == 0 && engine.state().pendingOperation() == null, "refusals have no effects");
        }
    }

    private static void operationsAndRaces() throws Exception {
        TestClock clock = new TestClock(); Path path = Files.createTempDirectory("ac-effects").resolve("journal");
        try (JobEngine engine = new JobEngine(path, config(), clock)) {
            Command c = place("once", 0, clock);
            check(await(engine.prepare(c, BUILDER, "before", "after")).status() == JobEngine.Status.PREPARED, "prepare once");
            check(await(engine.prepare(c, BUILDER, "before", "after")).status() == JobEngine.Status.PREPARED, "identical duplicate prepared");
            Command lock = Command.parse(envelope("racing-lock", Command.Action.LOCK, INSPECTOR, 0, 6000, Map.of()));
            check(await(engine.prepare(lock, INSPECTOR, "before", "before")).code().equals("BUSY"), "lock cannot race prepared effect");
            check(engine.consumePrepared("once", BUILDER, "before").status() == JobEngine.Status.AUTHORIZED, "consume permit");
            check(engine.consumePrepared("once", BUILDER, "before").status() == JobEngine.Status.REFUSED, "permit consumed once");
            check(await(engine.complete("once", "after")).status() == JobEngine.Status.APPLIED, "complete exact effect");
            check(engine.state().revision() == 1, "one structural revision");
            clock.now = 10_000;
            check(await(engine.prepare(c, BUILDER, "after", "different")).status() == JobEngine.Status.REPLAY, "expired original retry is receipt only");
            Map<String, Object> changed = envelope("once", Command.Action.PLACE, BUILDER, 1, 15_000,
                    Map.of("x", 0L, "y", 80L, "z", 0L, "state", "minecraft:glass"));
            check(await(engine.prepare(Command.parse(changed), BUILDER, "after", "different")).code().equals("OPERATION_ID_COLLISION"), "changed retry rejected");
            check(await(engine.prepare(place("stale", 0, clock), BUILDER, "after", "later")).code().equals("STALE_REVISION"), "stale new command rejected");
            Command expired = place("expire-before-native", 1, clock);
            await(engine.prepare(expired, BUILDER, "after", "later")); clock.now = expired.expiresAtMs();
            check(engine.consumePrepared(expired.operationId(), BUILDER, "after").code().equals("EXPIRED"), "expiry rechecked at native event");
            check(await(engine.reconcile("after")).code().equals("PROVED_NOT_APPLIED"), "unused expired permit clears from actual before");
            check(engine.state().revision() == 1, "no false revision after non-effect");
        }
        Path incompletePath = Files.createTempDirectory("ac-incomplete").resolve("journal");
        clock.now = 1000;
        try (JobEngine engine = new JobEngine(incompletePath, config(), clock)) {
            apply(engine, Command.parse(envelope("missing-lock", Command.Action.INSPECT, INSPECTOR, 0, 6000, Map.of())), INSPECTOR, "world", "world");
            InspectionReport incomplete = new InspectionReport("missing-case", "server", "job", 1, 0,
                    "calculator-v1", "calculator-v1", 900, 1000, report("template", 0, 0).cases().subList(0, 15), JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS);
            check(await(engine.finishInspection(incomplete, INSPECTOR, "world")).code().equals("INCOMPLETE"), "missing case never passes");
            check(!engine.state().readyForReview() && engine.reports().size() == 1, "incomplete evidence retained without readiness");
        }
    }

    private static void crashes() throws Exception {
        for (String observed : List.of("before", "after", "partial")) {
            TestClock clock = new TestClock(); Path path = Files.createTempDirectory("ac-crash").resolve("journal");
            Command c = place("crash", 0, clock);
            try (JobEngine engine = new JobEngine(path, config(), clock)) {
                await(engine.prepare(c, BUILDER, "before", "after"));
                if (!observed.equals("before")) engine.consumePrepared(c.operationId(), BUILDER, "before");
            }
            try (JobEngine engine = new JobEngine(path, config(), clock)) {
                check(engine.state().quarantined(), "restart requires world reconciliation");
                check(await(engine.prepare(c, BUILDER, "before", "after")).status() == JobEngine.Status.RECONCILIATION_REQUIRED, "restart refuses blind replay");
                JobEngine.Result result = await(engine.reconcile(observed));
                if (observed.equals("partial")) check(result.status() == JobEngine.Status.RECONCILIATION_REQUIRED && engine.state().quarantined(), "unknown remains quarantined");
                else {
                    check(!engine.state().quarantined(), "proved state reconciles");
                    check(engine.state().revision() == (observed.equals("after") ? 1 : 0), "only observed structural effect advances revision");
                    check(result.code().equals(observed.equals("after") ? "OBSERVED_APPLIED" : "PROVED_NOT_APPLIED"), "correct crash outcome");
                }
            }
        }
        TestClock clock = new TestClock(); Path path = Files.createTempDirectory("ac-rollback").resolve("journal");
        try (JobEngine engine = new JobEngine(path, config(), clock)) { apply(engine, place("done", 0, clock), BUILDER, "before", "after"); }
        try (JobEngine engine = new JobEngine(path, config(), clock)) {
            check(await(engine.reconcile("before")).status() == JobEngine.Status.RECONCILIATION_REQUIRED, "receipt cannot prove rolled-back world is after");
            check(await(engine.reconcile("after")).code().equals("RECONCILED"), "latest full effect verified without applying it");
            check(await(engine.prepare(place("done", 0, clock), BUILDER, "after", "other")).status() == JobEngine.Status.REPLAY, "receipt replay only after reconciliation");
        }
    }

    private static InspectionReport report(String name, long revision, int missingCarry) {
        List<InspectionReport.CaseResult> cases = new ArrayList<>();
        for (int a = 0; a < 4; a++) for (int b = 0; b < 4; b++) {
            int expected = a + b;
            cases.add(new InspectionReport.CaseResult(a, b, expected, missingCarry == 1 ? expected & 3 : expected));
        }
        return new InspectionReport(name, "server", "job", 1, revision, "calculator-v1", "calculator-v1", 900, 1000, cases, JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS);
    }

    private static void inspection() throws Exception {
        TestClock clock = new TestClock(); Path path = Files.createTempDirectory("ac-report").resolve("journal");
        InspectionReport failed = report("fault", 0, 1);
        check(failed.cases().stream().filter(InspectionReport.CaseResult::passed).count() == 10, "six carry failures");
        rejects(() -> new InspectionReport.CaseResult(3, 1, 0, 0), "cannot change expected arithmetic");
        rejects(() -> new InspectionReport("duplicate", "server", "job", 1, 0, "calculator-v1", "calculator-v1", 0, 1,
                List.of(new InspectionReport.CaseResult(0, 0, 0, 0), new InspectionReport.CaseResult(0, 0, 0, 0))), "duplicate input pairs rejected");
        try (JobEngine engine = new JobEngine(path, config(), clock)) {
            Command lock = Command.parse(envelope("inspect-fault", Command.Action.INSPECT, INSPECTOR, 0, 6000, Map.of()));
            apply(engine, lock, INSPECTOR, "before", "before");
            check(engine.state().lockMode() == JobEngine.LockMode.INSPECTION, "inspection lock active");
            check(await(engine.prepare(place("edit-under-lock", 0, clock), BUILDER, "before", "after")).code().equals("LOCKED"), "locked structure blocks edits");
            check(await(engine.finishInspection(failed, BUILDER, "before")).code().equals("ACTOR"), "builder cannot attest");
            check(await(engine.finishInspection(report("stale", 1, 0), INSPECTOR, "before")).code().equals("REPORT_CONTEXT"), "wrong revision cannot pass");
            check(await(engine.finishInspection(failed, INSPECTOR, "before")).code().equals("FAIL"), "actual failure retained");
            check(engine.state().lockMode() == JobEngine.LockMode.NONE && !engine.state().readyForReview(), "failed report releases for repair only");
            Command repair = Command.parse(envelope("repair", Command.Action.REPAIR, BUILDER, 0, 6000, params()));
            apply(engine, repair, BUILDER, "before", "repaired");
            lock = Command.parse(envelope("inspect-repair", Command.Action.INSPECT, INSPECTOR, 1, 6000, Map.of()));
            apply(engine, lock, INSPECTOR, "repaired", "repaired");
            InspectionReport passed = report("repaired-pass", 1, 0);
            check(await(engine.finishInspection(passed, INSPECTOR, "repaired")).code().equals("READY_FOR_REVIEW"), "exact repaired report ready");
            check(engine.state().readyForReview() && engine.state().lockMode() == JobEngine.LockMode.REVIEW, "passing structure protected");
            check(engine.reports().size() == 2 && !engine.reports().get(0).passed(), "failed history is not rewritten");
            Command unlock = Command.parse(envelope("unlock", Command.Action.UNLOCK, INSPECTOR, 1, 6000, Map.of()));
            check(await(engine.prepare(unlock, INSPECTOR, "repaired", "repaired")).code().equals("NO_EARLY_UNLOCK"), "no early review unlock");
            check(await(engine.finishInspection(passed, INSPECTOR, "repaired")).status() == JobEngine.Status.REPLAY, "same immutable report returns evidence");
        }
        try (JobEngine engine = new JobEngine(path, config(), clock)) {
            check(engine.state().lockMode() == JobEngine.LockMode.REVIEW && engine.state().quarantined(), "review lock survives restart");
            await(engine.reconcile("repaired"));
            check(engine.reports().size() == 2 && engine.state().readyForReview(), "retained report and actual effect reconcile");
            clock.now = 30_000;
            check(!engine.state().readyForReview() && engine.state().lockMode() == JobEngine.LockMode.REVIEW, "exact expiry invalidates readiness but never assumes finality unlock");
        }
        TestClock lateClock = new TestClock(); Path latePath = Files.createTempDirectory("ac-late").resolve("journal");
        try (JobEngine engine = new JobEngine(latePath, config(), lateClock)) {
            apply(engine, Command.parse(envelope("late-lock", Command.Action.INSPECT, INSPECTOR, 0, 6000, Map.of())), INSPECTOR, "world", "world");
            lateClock.now = 20_000;
            InspectionReport late = new InspectionReport("late", "server", "job", 1, 0, "calculator-v1", "calculator-v1", 19_000, 20_000, report("unused", 0, 0).cases(), JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS);
            check(await(engine.finishInspection(late, INSPECTOR, "world")).code().equals("LATE_PASS_NOT_READY"), "late numerical pass cannot create readiness");
            check(!engine.state().readyForReview(), "work deadline equality denied");
        }
    }

    private static void persistenceAndRevocation() throws Exception {
        TestClock clock = new TestClock(); Path path = Files.createTempDirectory("ac-revoke").resolve("journal");
        try (JobEngine engine = new JobEngine(path, config(), clock)) {
            Command c = place("revoked", 0, clock); await(engine.prepare(c, BUILDER, "before", "after"));
            check(await(engine.revokeActor(BUILDER, BOT)).status() == JobEngine.Status.REFUSED, "builder cannot revoke");
            check(await(engine.revokeActor(OPERATOR, BUILDER)).status() == JobEngine.Status.APPLIED, "explicit operator revokes");
            check(engine.consumePrepared(c.operationId(), BUILDER, "before").code().equals("ACTOR"), "revocation checked at execution");
            await(engine.reconcile("before"));
        }
        try (JobEngine engine = new JobEngine(path, config(), clock)) {
            await(engine.reconcile("before"));
            check(await(engine.prepare(place("again", 0, clock), BUILDER, "before", "after")).code().equals("ACTOR"), "revocation persists");
        }
        byte[] valid = Files.readAllBytes(path);
        for (boolean truncate : new boolean[] {true, false}) {
            Path corrupt = Files.createTempDirectory("ac-corrupt").resolve("journal");
            byte[] bytes = truncate ? Arrays.copyOf(valid, valid.length - 1) : valid.clone();
            if (!truncate) bytes[bytes.length / 2] ^= 1;
            Files.write(corrupt, bytes);
            rejects(() -> { try (JobEngine candidate = new JobEngine(corrupt, config(), clock)) { candidate.state(); } }, "corrupt/truncated journal fails closed");
            check(Arrays.equals(bytes, Files.readAllBytes(corrupt)), "startup never replaces corrupted evidence");
        }
        JobEngine.Config wrong = new JobEngine.Config("foreign", "job", 1, config().bounds(), config().actors(), "local-authorized-v1",
                "calculator-v1", "calculator-v1", 20_000, 30_000);
        rejects(() -> { try (JobEngine candidate = new JobEngine(path, wrong, clock)) { candidate.state(); } }, "configuration drift cannot reuse receipts");
        try (JobEngine engine = new JobEngine(path, config(), clock)) {
            check(!engine.activeActor(BUILDER), "revoked actor remains inactive");
            check(!engine.activeActor(REQUESTER), "restart does not grant native permissions before reconciliation");
            await(engine.reconcile("before"));
            check(engine.activeActor(REQUESTER), "registered unrevoked actor active after reconciled startup");
            check(!engine.activeActor(id(99)), "unknown actor inactive");
            rejects(() -> { try (JobEngine candidate = new JobEngine(path, config(), clock)) { candidate.state(); } }, "one durable journal writer");
        }
    }

    private static void lookupAndAudit() throws Exception {
        for (Command.Action action : List.of(Command.Action.PLACE, Command.Action.BREAK, Command.Action.WITHDRAW,
                Command.Action.RETURN, Command.Action.DELIVER, Command.Action.LOCK, Command.Action.INSPECT, Command.Action.OBSERVE)) {
            TestClock clock = new TestClock();
            Path path = Files.createTempDirectory("ac-lookup-" + action).resolve("journal");
            UUID actor = switch (action) {
                case LOCK, INSPECT -> INSPECTOR;
                case DELIVER -> DELIVERY;
                default -> BUILDER;
            };
            Map<String, Object> parameters = switch (action) {
                case PLACE -> params();
                case BREAK -> Map.of("x", 0L, "y", 80L, "z", 0L);
                case WITHDRAW, RETURN -> Map.of("item", "minecraft:stone_bricks", "count", 1L);
                case DELIVER -> Map.of("claimId", "claim", "items", Map.of("minecraft:stone_bricks", 1L));
                default -> Map.of();
            };
            Command original = Command.parse(envelope("retained", action, actor, 0, 6000, parameters));
            Command collision = Command.parse(envelope("retained", action, actor, 1, 6000, parameters));
            try (JobEngine engine = new JobEngine(path, config(), clock)) {
                check(engine.lookup(original, actor) == null, "unknown operation continues to effect preconditions " + action);
                apply(engine, original, actor, "before", "after");
                long revision = engine.state().revision(); JobEngine.LockMode mode = engine.state().lockMode();
                clock.now = 10_000;
                check(engine.lookup(original, actor).status() == JobEngine.Status.REPLAY, "lookup replays before changed target precondition " + action);
                check(engine.lookup(original, REQUESTER).code().equals("ACTOR"), "binding precedes receipt disclosure " + action);
                check(engine.lookup(collision, actor).code().equals("OPERATION_ID_COLLISION"), "lookup changed payload rejected " + action);
                check(engine.lookup(collision, actor).code().equals("OPERATION_ID_COLLISION"), "repeated collision remains rejected " + action);
                engine.durableState().get(10, TimeUnit.SECONDS);
                check(engine.collisionAudits().size() == 1, "durable deduplicated fingerprint audit " + action);
                check(engine.state().revision() == revision && engine.state().lockMode() == mode, "collision never changes revision or lock " + action);
            }
            try (JobEngine engine = new JobEngine(path, config(), clock)) {
                check(engine.lookup(original, actor).status() == JobEngine.Status.RECONCILIATION_REQUIRED, "lookup cannot bypass restart reconciliation " + action);
                await(engine.reconcile("after"));
                check(engine.lookup(original, actor).status() == JobEngine.Status.REPLAY, "replay survives journal reopen " + action);
                check(engine.collisionAudits().size() == 1, "fingerprint audit retained on reopen " + action);
            }
        }
    }

    private static void authorityClock() throws Exception {
        TestClock clock = new TestClock(); Path path = Files.createTempDirectory("ac-clock-native").resolve("journal");
        try (JobEngine engine = new JobEngine(path, config(), clock)) {
            Command c = place("clock-native", 0, clock);
            await(engine.prepare(c, BUILDER, "before", "after"));
            clock.now--;
            check(engine.consumePrepared(c.operationId(), BUILDER, "before").code().equals("CLOCK_REGRESSION"), "rollback cannot revive native authority");
            check(engine.durableState().get(10, TimeUnit.SECONDS).quarantined(), "regression is durably quarantined");
        }
        clock.now = 2000;
        try (JobEngine engine = new JobEngine(path, config(), clock)) {
            check(await(engine.reconcile("before")).code().equals("CLOCK_REGRESSION"), "clock catching up cannot clear recorded regression");
        }
        clock = new TestClock(); path = Files.createTempDirectory("ac-clock-pass").resolve("journal");
        try (JobEngine engine = new JobEngine(path, config(), clock)) {
            apply(engine, Command.parse(envelope("pass-lock", Command.Action.INSPECT, INSPECTOR, 0, 6000, Map.of())), INSPECTOR, "world", "world");
            await(engine.finishInspection(report("clock-pass", 0, 0), INSPECTOR, "world"));
            check(engine.durableState().get(10, TimeUnit.SECONDS).readyForReview(), "durable readiness before deadline");
            clock.now = 30_000;
            check(!engine.durableState().get(10, TimeUnit.SECONDS).readyForReview(), "deadline equality durably expires readiness");
            check(engine.state().lockMode() == JobEngine.LockMode.REVIEW, "expiry retains protection pending authoritative finality");
        }
        clock.now = 29_999;
        try (JobEngine engine = new JobEngine(path, config(), clock)) {
            check(!engine.state().readyForReview(), "restart rollback cannot revive expired pass");
            check(await(engine.reconcile("world")).code().equals("CLOCK_REGRESSION"), "rollback blocks recovery authority");
            check(!engine.durableState().get(10, TimeUnit.SECONDS).readyForReview(), "rollback status is durably denied");
        }
        clock.now = 40_000;
        try (JobEngine engine = new JobEngine(path, config(), clock)) {
            check(await(engine.reconcile("world")).code().equals("CLOCK_REGRESSION"), "persisted rollback remains latched after clock correction");
        }
        clock = new TestClock(); clock.now = 19_999; path = Files.createTempDirectory("ac-work-boundary").resolve("journal");
        try (JobEngine engine = new JobEngine(path, config(), clock)) {
            Command c = place("deadline-native", 0, clock); await(engine.prepare(c, BUILDER, "before", "after"));
            clock.now = 20_000;
            check(engine.consumePrepared(c.operationId(), BUILDER, "before").code().equals("WORK_EXPIRED"), "native execution rechecks fixed work deadline");
        }
    }

    private static void journalSemantics() throws Exception {
        TestClock clock = new TestClock(); Path path = Files.createTempDirectory("ac-journal-semantics").resolve("journal");
        List<Map<String, String>> records;
        try (JobEngine engine = new JobEngine(path, config(), clock)) {
            apply(engine, place("journal-original", 0, clock), BUILDER, "before", "after");
            Command changed = Command.parse(envelope("journal-original", Command.Action.PLACE, BUILDER, 1, 6000, params()));
            engine.lookup(changed, BUILDER); clock.now = 2000;
            engine.durableState().get(10, TimeUnit.SECONDS);
        }
        try (DurableJournal journal = new DurableJournal(path)) { records = journal.records(); }
        for (String mutation : List.of("missing-time", "backward-time", "invalid-clock", "wrong-original", "equal-hashes", "duplicate-audit", "clear-regression")) {
            Path mutated = Files.createTempDirectory("ac-bad-" + mutation).resolve("journal");
            try (DurableJournal journal = new DurableJournal(mutated)) {
                Map<String, String> audit = null;
                for (Map<String, String> row : records) {
                    Map<String, String> replacement = new HashMap<>(row);
                    if (row.get("type").equals("CLOCK")) {
                        if (mutation.equals("missing-time")) replacement.remove("authorityTime");
                        if (mutation.equals("backward-time")) replacement.put("authorityTime", "999");
                        if (mutation.equals("invalid-clock")) replacement.put("regressed", "maybe");
                        if (mutation.equals("clear-regression")) {
                            replacement.put("regressed", "true"); journal.append(replacement); replacement.put("regressed", "false");
                        }
                    }
                    if (row.get("type").equals("COLLISION")) {
                        audit = row;
                        if (mutation.equals("wrong-original")) replacement.put("originalHash", "0".repeat(64));
                        if (mutation.equals("equal-hashes")) replacement.put("rejectedHash", row.get("originalHash"));
                    }
                    journal.append(replacement);
                }
                if (mutation.equals("duplicate-audit")) {
                    Map<String, String> duplicate = new HashMap<>(audit); duplicate.put("authorityTime", "2000"); journal.append(duplicate);
                }
            }
            rejects(() -> { try (JobEngine engine = new JobEngine(mutated, config(), clock)) { engine.state(); } }, "semantic journal corruption rejected: " + mutation);
        }
    }

    private static InspectionReport reportAt(String name, long revision, long completed, JobEngine.ObligationMode mode) {
        return new InspectionReport(name, "server", "job", 1, revision, "calculator-v1", "calculator-v1",
                completed - 100, completed, report("template", revision, 0).cases(), mode);
    }
    private static JobEngine.Config withMode(JobEngine.ObligationMode mode, long ttl) {
        JobEngine.Config c = config();
        return new JobEngine.Config(c.serverId(), c.jobId(), c.agreementVersion(), c.bounds(), c.actors(), c.authorizationReference(),
                c.blueprintId(), c.testManifestId(), c.workDeadlineMs(), c.reviewDeadlineMs(), mode, ttl);
    }
    private static void localPassLifecycle() throws Exception {
        rejects(() -> withMode(null, 0), "missing obligation mode rejected");
        rejects(() -> withMode(JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS, 0), "local pass lifetime must be explicit positive");
        rejects(() -> withMode(JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS, 10_001), "local pass lifetime bounded by fixed review window");
        rejects(() -> withMode(JobEngine.ObligationMode.EXTERNAL_OBLIGATIONS, 5000), "external obligations cannot opt into local TTL");
        TestClock clock = new TestClock(); Path path = Files.createTempDirectory("ac-local-lifecycle").resolve("journal");
        InspectionReport old = reportAt("local-old", 0, 1000, JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS);
        InspectionReport externalShape = reportAt("local-old", 0, 1000, JobEngine.ObligationMode.EXTERNAL_OBLIGATIONS);
        check(!old.fingerprint().equals(externalShape.fingerprint()), "obligation mode bound into report digest");
        try (JobEngine engine = new JobEngine(path, config(), clock)) {
            apply(engine, Command.parse(envelope("old-inspect", Command.Action.INSPECT, INSPECTOR, 0, 6000, Map.of())), INSPECTOR, "world", "world");
            check(await(engine.finishInspection(externalShape, INSPECTOR, "world")).code().equals("REPORT_CONTEXT"), "local engine rejects external-mode observation");
            check(await(engine.finishInspection(old, INSPECTOR, "world")).code().equals("READY_FOR_REVIEW"), "explicit local observation establishes bounded readiness");
            check(engine.state().passValidUntilMs() == 6000, "local TTL is based on completion and bounded by review expiry");
            clock.now = 5999;
            check(await(engine.prepare(Command.parse(envelope("early-unlock", Command.Action.UNLOCK, INSPECTOR, 0, 7000, Map.of())), INSPECTOR, "world", "world")).code().equals("NO_EARLY_UNLOCK"), "usable local pass cannot unlock");
            clock.now = 6000;
            check(engine.validateReport(old.runId()).code().equals("REPORT_EXPIRED"), "local validity equality expired");
            apply(engine, Command.parse(envelope("expired-unlock", Command.Action.UNLOCK, INSPECTOR, 0, 7000, Map.of())), INSPECTOR, "world", "world");
            apply(engine, Command.parse(envelope("same-revision-inspect", Command.Action.INSPECT, INSPECTOR, 0, 7000, Map.of())), INSPECTOR, "world", "world");
            check(await(engine.finishInspection(reportAt("same-revision-new", 0, 6000, JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS), INSPECTOR, "world")).code().equals("READY_FOR_REVIEW"), "new full inspection uses unchanged deadlines");
            check(engine.validateReport(old.runId()).code().equals("REPORT_EXPIRED"), "new report does not extend old report lifetime");
            clock.now = 10_999;
            check(await(engine.prepare(Command.parse(envelope("latest-early", Command.Action.UNLOCK, INSPECTOR, 0, 12_000, Map.of())), INSPECTOR, "world", "world")).code().equals("NO_EARLY_UNLOCK"), "all retained passes must expire");
            clock.now = 11_000;
            apply(engine, Command.parse(envelope("all-expired-unlock", Command.Action.UNLOCK, INSPECTOR, 0, 12_000, Map.of())), INSPECTOR, "world", "world");
            check(engine.state().lockMode() == JobEngine.LockMode.NONE && engine.state().revision() == 0, "safe local expiry release returns to bounded building");
            apply(engine, Command.parse(envelope("edit", Command.Action.BREAK, BUILDER, 0, 12_000, Map.of("x", 0L, "y", 80L, "z", 0L))), BUILDER, "world", "changed");
            apply(engine, place("restore", 1, clock), BUILDER, "changed", "world");
            check(engine.state().revision() == 2, "same restored shape retains two monotonic mutations");
            check(engine.validateReport(old.runId()).code().equals("REPORT_REVISION"), "old report rejected by revision independently of expired time");
            apply(engine, Command.parse(envelope("fresh-inspect", Command.Action.INSPECT, INSPECTOR, 2, 12_000, Map.of())), INSPECTOR, "world", "world");
            check(await(engine.finishInspection(reportAt("fresh-pass", 2, 11_000, JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS), INSPECTOR, "world")).code().equals("READY_FOR_REVIEW"), "fresh full16 establishes current-revision readiness within original deadline");
            check(engine.validateReport("fresh-pass").code().equals("LOCAL_READY_FOR_REVIEW"), "fresh report is local evidence only");
            check(engine.validateReport(old.runId()).code().equals("REPORT_REVISION"), "fresh readiness never resurrects old revision evidence");
        }
        try (JobEngine engine = new JobEngine(path, config(), clock)) {
            await(engine.reconcile("world"));
            check(engine.validateReport(old.runId()).code().equals("REPORT_REVISION"), "old revision rejection survives restart");
            check(engine.validateReport("fresh-pass").code().equals("LOCAL_READY_FOR_REVIEW"), "new report validity survives restart independently");
        }
        TestClock retainedClock = clock;
        rejects(() -> { try (JobEngine engine = new JobEngine(path, withMode(JobEngine.ObligationMode.EXTERNAL_OBLIGATIONS, 0), retainedClock)) { engine.state(); } }, "journal cannot be reinterpreted as external authority");
        clock = new TestClock(); Path external = Files.createTempDirectory("ac-external-mode").resolve("journal");
        try (JobEngine engine = new JobEngine(external, withMode(JobEngine.ObligationMode.EXTERNAL_OBLIGATIONS, 0), clock)) {
            apply(engine, Command.parse(envelope("external-inspect", Command.Action.INSPECT, INSPECTOR, 0, 6000, Map.of())), INSPECTOR, "world", "world");
            await(engine.finishInspection(reportAt("external-report", 0, 1000, JobEngine.ObligationMode.EXTERNAL_OBLIGATIONS), INSPECTOR, "world"));
            for (long now : new long[] {6000, 30_000}) {
                clock.now = now;
                check(await(engine.prepare(Command.parse(envelope("external-unlock-" + now, Command.Action.UNLOCK, INSPECTOR, 0, now + 1000, Map.of())), INSPECTOR, "world", "world")).code().equals("NO_EARLY_UNLOCK"), "external obligations never use local release even after expiry");
            }
        }
        clock = new TestClock(); Path disabled = Files.createTempDirectory("ac-reporting-disabled").resolve("journal");
        JobEngine.Config c = config();
        JobEngine.Config legacy = new JobEngine.Config(c.serverId(), c.jobId(), c.agreementVersion(), c.bounds(), c.actors(), c.authorizationReference(), c.blueprintId(), c.testManifestId(), c.workDeadlineMs(), c.reviewDeadlineMs());
        try (JobEngine engine = new JobEngine(disabled, legacy, clock)) {
            apply(engine, Command.parse(envelope("disabled-inspect", Command.Action.INSPECT, INSPECTOR, 0, 6000, Map.of())), INSPECTOR, "world", "world");
            check(await(engine.finishInspection(old, INSPECTOR, "world")).code().equals("INSPECTION_CONFIG_REQUIRED"), "legacy construction cannot enable reporting by default");
        }
    }

    private static void diskAdmission() throws Exception {
        long threshold = DurableJournal.MIN_MUTATION_FREE_BYTES;
        for (long space : new long[] {threshold - 1, threshold, threshold + 1}) {
            TestClock clock = new TestClock(); Path path = Files.createTempDirectory("ac-disk-" + space).resolve("journal");
            List<String> probeThreads = new ArrayList<>();
            try (JobEngine engine = new JobEngine(path, config(), clock, () -> {
                probeThreads.add(Thread.currentThread().getName()); return space;
            })) {
                check(probeThreads.isEmpty(), "disk probe does not run during initialization or game-thread admission");
                Command command = place("disk", 0, clock);
                JobEngine.Result result = await(engine.prepare(command, BUILDER, "before", "after"));
                check(probeThreads.size() == 1 && probeThreads.get(0).equals("agentcity-journal"), "mutation reserve stats only on journal worker");
                if (space < threshold) {
                    check(result.status() == JobEngine.Status.RECONCILIATION_REQUIRED && engine.state().quarantined(), "threshold minus one refuses before permit");
                    check(engine.consumePrepared(command.operationId(), BUILDER, "before").status() != JobEngine.Status.AUTHORIZED, "low disk never authorizes native effect");
                } else {
                    check(result.status() == JobEngine.Status.PREPARED, "exact threshold and above permit durable intent");
                    check(engine.consumePrepared(command.operationId(), BUILDER, "before").status() == JobEngine.Status.AUTHORIZED, "budget-established command authorizes once");
                    check(await(engine.complete(command.operationId(), "after")).status() == JobEngine.Status.APPLIED, "receipt remains durable after reserved admission");
                    check(probeThreads.size() == 1, "receipt does not depend on a new admission reserve check");
                }
            }
        }
        TestClock clock = new TestClock(); Path path = Files.createTempDirectory("ac-disk-drop").resolve("journal");
        long[] remaining = {threshold};
        try (JobEngine engine = new JobEngine(path, config(), clock, () -> remaining[0])) {
            Command command = place("before-drop", 0, clock); await(engine.prepare(command, BUILDER, "before", "after"));
            engine.consumePrepared(command.operationId(), BUILDER, "before"); remaining[0] = threshold - 1;
            check(await(engine.complete(command.operationId(), "after")).status() == JobEngine.Status.APPLIED, "reserve drop cannot intentionally suppress already-applied receipt");
            check(await(engine.prepare(place("after-drop", 1, clock), BUILDER, "after", "next")).status() == JobEngine.Status.RECONCILIATION_REQUIRED, "next intent after disk drop refuses and quarantines");
            check(engine.state().revision() == 1, "failed next admission never advances revision");
        }
        path = Files.createTempDirectory("ac-disk-stat-failure").resolve("journal");
        try (JobEngine engine = new JobEngine(path, config(), clock, () -> { throw new IOException("injected filesystem probe unavailable"); })) {
            check(await(engine.prepare(place("probe-unavailable", 0, clock), BUILDER, "before", "after")).status() == JobEngine.Status.RECONCILIATION_REQUIRED, "unknown filesystem space fails closed");
            check(engine.state().quarantined() && engine.state().revision() == 0, "probe error preserves revision and blocks mutation");
        }
    }

    private static void ownerCollisionAudit() throws Exception {
        TestClock clock = new TestClock(); Path path = Files.createTempDirectory("ac-owner-collision").resolve("journal");
        try (JobEngine engine = new JobEngine(path, config(), clock)) {
            check(!engine.hasObservedEffect(), "fresh job has no observed custody baseline");
            Command original = place("owned", 0, clock); apply(engine, original, BUILDER, "before", "after");
            check(engine.hasObservedEffect(), "actual receipted effect establishes observed baseline");
            Map<String, Object> changedFields = Map.of("serverId", "other-server", "jobId", "other-job",
                    "agreementVersion", 2L, "authorizationReference", "other-authority");
            for (var changed : changedFields.entrySet()) {
                Map<String, Object> payload = envelope("owned", Command.Action.PLACE, BUILDER, 0, 6000, params());
                payload.put(changed.getKey(), changed.getValue());
                JobEngine.Result refused = engine.lookup(Command.parse(payload), BUILDER);
                check(refused.status() == JobEngine.Status.REFUSED && !refused.code().equals("OPERATION_ID_COLLISION"), "changed context retains binding refusal " + changed.getKey());
            }
            engine.durableState().get(10, TimeUnit.SECONDS);
            check(engine.collisionAudits().size() == 4, "bound owner changed contexts get fingerprint-only audit");
            Map<String, Object> stranger = envelope("owned", Command.Action.PLACE, id(99), 0, 6000, params());
            check(engine.lookup(Command.parse(stranger), id(99)).code().equals("ACTOR"), "unknown actor cannot disclose known operation");
            check(engine.lookup(original, REQUESTER).code().equals("ACTOR"), "session mismatch cannot disclose known operation");
            Map<String, Object> otherRegistered = envelope("owned", Command.Action.PLACE, BOT, 0, 6000, params());
            check(engine.lookup(Command.parse(otherRegistered), BOT).code().equals("ACTOR"), "other registered actor cannot disclose another operation owner");
            engine.durableState().get(10, TimeUnit.SECONDS);
            check(engine.collisionAudits().size() == 4, "strangers cannot add owner-linked collision records");
        }
        try (JobEngine engine = new JobEngine(path, config(), clock)) {
            check(engine.hasObservedEffect(), "custody-baseline existence survives reopen");
            check(engine.collisionAudits().size() == 4, "changed context audits survive reopen");
        }
    }

    private static void nativePermissionHealth() throws Exception {
        TestClock clock = new TestClock(); Path path = Files.createTempDirectory("ac-native-permission-health").resolve("journal");
        try (JobEngine engine = new JobEngine(path, config(), clock)) {
            check(engine.activeActor(BUILDER) && engine.activeActor(REQUESTER), "fresh authorized job allows permissions before empty-custody baseline reconciliation");
            await(engine.reconcile("before"));
            check(engine.activeActor(REQUESTER), "healthy baseline preserves native permission");
            check(await(engine.reconcile("untracked-change")).status() == JobEngine.Status.RECONCILIATION_REQUIRED, "unexpected effect enters quarantine");
            check(!engine.activeActor(REQUESTER) && !engine.activeActor(BUILDER), "quarantine denies requester levers and stock-open permissions");
            await(engine.reconcile("before"));
            check(engine.activeActor(REQUESTER), "proved original effect restores healthy permissions");
            clock.now--;
            check(!engine.activeActor(REQUESTER) && !engine.activeActor(BUILDER), "native permission check itself detects reversed clock");
            check(engine.state().quarantined(), "permission clock guard latches quarantine");
            clock.now = 2000;
            check(!engine.activeActor(REQUESTER), "wall clock correction cannot clear permission regression");
            engine.durableState().get(10, TimeUnit.SECONDS);
        }
        try (JobEngine engine = new JobEngine(path, config(), clock)) {
            check(!engine.activeActor(REQUESTER), "persisted clock regression never grants native permission after restart");
        }
    }

    public static void main(String[] args) throws Exception {
        nativePermissionHealth(); ownerCollisionAudit(); diskAdmission(); localPassLifecycle(); lookupAndAudit(); authorityClock(); journalSemantics(); parsing(); boundaries(); operationsAndRaces(); crashes(); inspection(); persistenceAndRevocation();
        System.out.println("{\"suite\":\"core-selfchecks\",\"assertions\":" + checks
                + ",\"status\":\"pass\",\"scope\":\"pure core protocol; no actual world observations\"}");
    }
}

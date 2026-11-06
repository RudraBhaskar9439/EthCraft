package org.agentcity.core;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Clock;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** One plot, one in-flight effect. All supplied effects are trusted bridge observations. */
public final class JobEngine implements AutoCloseable {
    public enum ObligationMode { REPORTING_DISABLED, LOCAL_NO_EXTERNAL_OBLIGATIONS, EXTERNAL_OBLIGATIONS }
    public enum Role { REQUESTER, BUILDER, BOT, DELIVERY_WORKER, INSPECTOR, OPERATOR }
    public enum LockMode { NONE, INSPECTION, REVIEW }
    public enum Status { PREPARED, AUTHORIZED, APPLIED, REPLAY, REFUSED, RECONCILIATION_REQUIRED }
    public record Result(Status status, String code, String operationId, long revision) {}
    /** Rejection evidence retains fingerprints, never rejected payloads or secrets. */
    public record CollisionAudit(String operationId, String originalHash, String rejectedHash) {}
    public record State(long revision, LockMode lockMode, boolean quarantined, String pendingOperation,
                        boolean readyForReview, long passValidUntilMs) {}
    public record Bounds(int minX, int minY, int minZ, int maxX, int maxY, int maxZ) {
        public Bounds {
            if (minX > maxX || minY > maxY || minZ > maxZ) throw new IllegalArgumentException("bounds");
        }
        public boolean contains(long x, long y, long z) {
            return x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ;
        }
    }
    public record Config(String serverId, String jobId, long agreementVersion, Bounds bounds,
                         Map<UUID, Role> actors, String authorizationReference,
                         String blueprintId, String testManifestId, long workDeadlineMs, long reviewDeadlineMs,
                         ObligationMode obligationMode, long localPassValidityMs) {
        public Config(String serverId, String jobId, long agreementVersion, Bounds bounds,
                      Map<UUID, Role> actors, String authorizationReference) {
            this(serverId, jobId, agreementVersion, bounds, actors, authorizationReference, "", "", 0, 0, ObligationMode.REPORTING_DISABLED, 0);
        }
        /** Compatibility construction never opts into issuing usable reports. */
        public Config(String serverId, String jobId, long agreementVersion, Bounds bounds,
                      Map<UUID, Role> actors, String authorizationReference,
                      String blueprintId, String testManifestId, long workDeadlineMs, long reviewDeadlineMs) {
            this(serverId, jobId, agreementVersion, bounds, actors, authorizationReference,
                    blueprintId, testManifestId, workDeadlineMs, reviewDeadlineMs, ObligationMode.REPORTING_DISABLED, 0);
        }
        public Config {
            if (serverId == null || !serverId.matches("[A-Za-z0-9_.:/-]{1,64}")
                    || jobId == null || !jobId.matches("[A-Za-z0-9_.:/-]{1,64}") || agreementVersion < 1
                    || bounds == null || actors == null || actors.isEmpty() || authorizationReference == null
                    || !authorizationReference.matches("[A-Za-z0-9_.:/-]{1,256}")) throw new IllegalArgumentException("job config");
            if (blueprintId == null || testManifestId == null || workDeadlineMs < 0 || reviewDeadlineMs < 0)
                throw new IllegalArgumentException("inspection config");
            if (workDeadlineMs != 0 || reviewDeadlineMs != 0) {
                if (!blueprintId.matches("[A-Za-z0-9_.:/-]{1,128}") || !testManifestId.matches("[A-Za-z0-9_.:/-]{1,128}")
                        || workDeadlineMs < 1 || reviewDeadlineMs <= workDeadlineMs) throw new IllegalArgumentException("inspection config");
            }
            if (obligationMode == null || localPassValidityMs < 0) throw new IllegalArgumentException("explicit obligation mode required");
            if (obligationMode == ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS) {
                if (workDeadlineMs == 0 || localPassValidityMs < 1
                        || localPassValidityMs > reviewDeadlineMs - workDeadlineMs)
                    throw new IllegalArgumentException("bounded explicit local pass validity required");
            } else if (localPassValidityMs != 0 || obligationMode == ObligationMode.EXTERNAL_OBLIGATIONS && workDeadlineMs == 0)
                throw new IllegalArgumentException("obligation mode timing");
            actors = Map.copyOf(actors);
        }
    }

    private static final class Operation {
        final String id, hash, before, after;
        final UUID actor;
        final Command.Action action;
        final long expectedRevision, expiry;
        final LockMode beforeLock, afterLock;
        boolean durable, consumed, writing;
        String outcome = "INTENT";
        long resultRevision;
        Operation(Command c, String before, String after, LockMode mode) {
            id = c.operationId(); hash = c.fingerprint(); actor = c.actorId(); action = c.action();
            expectedRevision = c.expectedRevision(); expiry = c.expiresAtMs();
            this.before = before; this.after = after; beforeLock = mode;
            afterLock = switch (action) { case LOCK, INSPECT -> LockMode.INSPECTION; case UNLOCK -> LockMode.NONE; default -> mode; };
        }
        Operation(Map<String, String> row) {
            id = row.get("op"); hash = row.get("hash"); actor = UUID.fromString(row.get("actor"));
            action = Command.Action.valueOf(row.get("action")); expectedRevision = Long.parseLong(row.get("expectedRevision"));
            expiry = Long.parseLong(row.get("expiry")); before = row.get("before"); after = row.get("after");
            beforeLock = LockMode.valueOf(row.get("beforeLock")); afterLock = LockMode.valueOf(row.get("afterLock")); durable = true;
        }
        boolean structural() { return action == Command.Action.PLACE || action == Command.Action.BREAK || action == Command.Action.REPAIR; }
        Map<String, String> intent() {
            return Map.ofEntries(Map.entry("type", "INTENT"), Map.entry("op", id), Map.entry("hash", hash),
                    Map.entry("actor", actor.toString()), Map.entry("action", action.name()),
                    Map.entry("expectedRevision", Long.toString(expectedRevision)), Map.entry("expiry", Long.toString(expiry)),
                    Map.entry("before", before), Map.entry("after", after), Map.entry("beforeLock", beforeLock.name()),
                    Map.entry("afterLock", afterLock.name()));
        }
    }

    private final Config config;
    private final Clock clock;
    private final DurableJournal journal;
    private final ExecutorService io = Executors.newSingleThreadExecutor(task -> {
        Thread thread = new Thread(task, "agentcity-journal"); thread.setDaemon(true); return thread;
    });
    private final Map<String, Operation> operations = new HashMap<>();
    private final Set<CollisionAudit> collisionAudits = new HashSet<>();
    private final Set<CollisionAudit> collisionWriting = new HashSet<>();
    private final Set<UUID> revoked = new HashSet<>();
    private final Map<String, InspectionReport> reports = new TreeMap<>();
    private final Map<String, Long> reportValidities = new HashMap<>();
    private Operation pending;
    private long revision;
    private LockMode lockMode = LockMode.NONE;
    private boolean quarantined, ioFailed, closed, reportWriting;
    private String lastEffect;
    private long passValidUntilMs;
    private long authorityHighWaterMs, durableHighWaterMs;
    private boolean clockRegressed, durableClockRegression;
    private int clockStateWrites;


    public JobEngine(Path journalFile, Config config, Clock clock) throws IOException {
        this(journalFile, config, clock, null);
    }

    JobEngine(Path journalFile, Config config, Clock clock, DurableJournal.SpaceProbe spaceProbe) throws IOException {
        this.config = config; this.clock = clock;
        journal = spaceProbe == null ? new DurableJournal(journalFile) : new DurableJournal(journalFile, spaceProbe);
        try {
            long initialTime = clock.millis();
            if (initialTime < 0) throw new IOException("invalid authority clock");
            if (journal.records().isEmpty()) {
                authorityHighWaterMs = durableHighWaterMs = initialTime;
                journal.append(Map.of("type", "INIT", "config", configHash(), "authorityTime", Long.toString(initialTime)));
            } else replay();
            observeClock();
        } catch (IOException | RuntimeException invalid) {
            journal.close(); io.shutdownNow();
            throw new IOException("job journal cannot be safely recovered", invalid);
        }
    }

    public synchronized State state() {
        observeClock();
        return stateSnapshot();
    }

    private State stateSnapshot() {
        return new State(revision, lockMode, quarantined, pending == null ? null : pending.id,
                !closed && !ioFailed && !quarantined && !clockRegressed && clockStateWrites == 0 && !reportWriting
                        && lockMode == LockMode.REVIEW && authorityHighWaterMs < passValidUntilMs, passValidUntilMs);
    }

    /** External readiness reads await fsync; internal state() only gives immediate fail-closed checks. */
    public synchronized CompletableFuture<State> durableState() {
        observeClock();
        if (closed || ioFailed) return CompletableFuture.completedFuture(stateSnapshot());
        long watermark = authorityHighWaterMs;
        boolean regression = clockRegressed;
        clockStateWrites++;
        return persist(Map.of("type", "CLOCK", "regressed", Boolean.toString(regression)), () -> {
            clockStateWrites--;
            durableClockRegression |= regression;
        }, Status.APPLIED, "CLOCK_DURABLE", null).thenCompose(receipt -> {
            synchronized (this) {
                observeClock();
                if (receipt.status() != Status.APPLIED) return CompletableFuture.completedFuture(stateSnapshot());
                boolean crossedExpiry = passValidUntilMs != 0 && watermark < passValidUntilMs
                        && authorityHighWaterMs >= passValidUntilMs;
                if (crossedExpiry || clockRegressed && !durableClockRegression) return durableState();
                return CompletableFuture.completedFuture(stateSnapshot());
            }
        });
    }

    private long observeClock() {
        long now = clock.millis();
        if (now < 0 || now < authorityHighWaterMs) {
            clockRegressed = true;
            quarantined = true;
        } else authorityHighWaterMs = now;
        return now;
    }

    public synchronized List<InspectionReport> reports() { return List.copyOf(reports.values()); }

    public synchronized boolean activeActor(UUID actor) {
        observeClock();
        return !closed && !ioFailed && !quarantined && !clockRegressed
                && config.actors().containsKey(actor) && !revoked.contains(actor);
    }

    public synchronized CompletableFuture<Result> finishInspection(InspectionReport report, UUID inspector,
                                                                    String currentFullEffect) {
        observeClock();
        if (clockRegressed) return immediate(Status.RECONCILIATION_REQUIRED, "CLOCK_REGRESSION", report.runId());
        validateEffect(currentFullEffect);
        if (config.actors().get(inspector) != Role.INSPECTOR || revoked.contains(inspector))
            return immediate(Status.REFUSED, "ACTOR", report.runId());
        InspectionReport old = reports.get(report.runId());
        if (old != null) return immediate(old.fingerprint().equals(report.fingerprint()) ? Status.REPLAY : Status.REFUSED,
                old.fingerprint().equals(report.fingerprint()) ? "RECORDED_REPORT" : "REPORT_ID_COLLISION", report.runId());
        if (closed || ioFailed || quarantined) return immediate(Status.RECONCILIATION_REQUIRED, "RECONCILE", report.runId());
        if (pending != null || reportWriting || lockMode != LockMode.INSPECTION) return immediate(Status.REFUSED, "NOT_INSPECTING", report.runId());
        if (config.workDeadlineMs() == 0 || config.obligationMode() == ObligationMode.REPORTING_DISABLED)
            return immediate(Status.REFUSED, "INSPECTION_CONFIG_REQUIRED", report.runId());
        if (!config.serverId().equals(report.serverId()) || !config.jobId().equals(report.jobId())
                || config.agreementVersion() != report.agreementVersion() || report.revision() != revision
                || !config.blueprintId().equals(report.blueprintId()) || !config.testManifestId().equals(report.testManifestId()) || config.obligationMode() != report.obligationMode())
            return immediate(Status.REFUSED, "REPORT_CONTEXT", report.runId());
        if (report.completedAtMs() > authorityHighWaterMs) return immediate(Status.REFUSED, "REPORT_FUTURE_TIME", report.runId());
        if (lastEffect == null || !lastEffect.equals(currentFullEffect)) {
            quarantined = true;
            return immediate(Status.RECONCILIATION_REQUIRED, "INSPECTED_EFFECT_CHANGED", report.runId());
        }
        long candidateValidity = reportValidity(report);
        boolean ready = report.passed() && report.completedAtMs() < config.workDeadlineMs()
                && authorityHighWaterMs < candidateValidity;
        long validity = ready ? candidateValidity : 0;
        Map<String, String> row = new TreeMap<>(report.fields());
        row.put("type", "REPORT"); row.put("effect", currentFullEffect); row.put("ready", Boolean.toString(ready));
        row.put("validUntil", Long.toString(validity));
        // Reserve the single-job command slot while the full report is persisted.
        reportWriting = true;
        return persist(row, () -> {
            reports.put(report.runId(), report); reportValidities.put(report.runId(), validity); reportWriting = false;
            lockMode = ready ? LockMode.REVIEW : LockMode.NONE;
            passValidUntilMs = validity;
        }, Status.APPLIED, ready ? "READY_FOR_REVIEW" : report.passed() ? "LATE_PASS_NOT_READY" : report.outcome(), report.runId());
    }

    public synchronized boolean hasObservedEffect() { return lastEffect != null; }

    public synchronized List<CollisionAudit> collisionAudits() { return List.copyOf(collisionAudits); }

    /** Check retained receipts before deriving a target effect. Does not access the world. */
    public synchronized Result lookup(Command command, UUID verifiedActor) {
        observeClock();
        if (clockRegressed) return result(Status.RECONCILIATION_REQUIRED, "CLOCK_REGRESSION", command.operationId());
        String refusal = binding(command, verifiedActor);
        Operation old = operations.get(command.operationId());
        if (refusal != null) {
            // Audit a bound owner's changed context without revealing receipt existence to strangers.
            if (old != null && old.actor.equals(verifiedActor) && command.actorId().equals(verifiedActor)
                    && activeActor(verifiedActor) && !old.hash.equals(command.fingerprint())) auditCollision(old, command);
            return result(Status.REFUSED, refusal, command.operationId());
        }
        if (old != null) {
            if (!old.actor.equals(verifiedActor)) return result(Status.REFUSED, "ACTOR", command.operationId());
            if (!old.hash.equals(command.fingerprint())) {
                auditCollision(old, command);
                return result(Status.REFUSED, "OPERATION_ID_COLLISION", old.id);
            }
            if (closed || ioFailed || quarantined || old.outcome.equals("UNCERTAIN"))
                return result(Status.RECONCILIATION_REQUIRED, "RECONCILE", old.id);
            if (old.outcome.equals("APPLIED")) return new Result(Status.REPLAY, "RECORDED_APPLIED", old.id, old.resultRevision);
            if (old.outcome.equals("NOT_APPLIED")) return result(Status.REFUSED, "RECORDED_NOT_APPLIED", old.id);
            boolean available = old.durable && !old.consumed && !old.writing;
            return result(available ? Status.PREPARED : Status.REFUSED, available ? "ALREADY_PREPARED" : "BUSY", old.id);
        }
        if (closed || ioFailed || quarantined) return result(Status.RECONCILIATION_REQUIRED, "RECONCILE", command.operationId());
        return null;
    }

    private void auditCollision(Operation old, Command command) {
        CollisionAudit audit = new CollisionAudit(old.id, old.hash, command.fingerprint());
        if (!closed && !ioFailed && !collisionAudits.contains(audit) && collisionWriting.add(audit)) {
            persist(Map.of("type", "COLLISION", "op", audit.operationId(), "originalHash", audit.originalHash(),
                    "rejectedHash", audit.rejectedHash()), () -> {
                collisionWriting.remove(audit); collisionAudits.add(audit);
            }, Status.REFUSED, "OPERATION_ID_COLLISION", old.id);
        }
    }

    public synchronized CompletableFuture<Result> prepare(Command command, UUID verifiedActor,
                                                            String beforeEffect, String expectedAfterEffect) {
        Result retained = lookup(command, verifiedActor);
        if (retained != null) return CompletableFuture.completedFuture(retained);
        if (pending != null || reportWriting) return immediate(Status.REFUSED, "BUSY", command.operationId());
        String refusal = fresh(command);
        if (refusal != null) return immediate(Status.REFUSED, refusal, command.operationId());
        validateEffect(beforeEffect); validateEffect(expectedAfterEffect);
        if (lastEffect != null && !lastEffect.equals(beforeEffect)) {
            quarantined = true;
            return immediate(Status.RECONCILIATION_REQUIRED, "UNJOURNALED_STATE_CHANGE", command.operationId());
        }
        Operation op = new Operation(command, beforeEffect, expectedAfterEffect, lockMode);
        pending = op; operations.put(op.id, op); op.writing = true;
        return persist(op.intent(), () -> { op.durable = true; op.writing = false; }, Status.PREPARED, "INTENT_DURABLE", op.id);
    }

    /** Called on the game thread before allowing the exact native action. No disk IO here. */
    public synchronized Result consumePrepared(String operationId, UUID actualActor, String currentBeforeEffect) {
        observeClock();
        if (clockRegressed) return result(Status.RECONCILIATION_REQUIRED, "CLOCK_REGRESSION", operationId);
        Operation op = pending;
        if (closed || ioFailed || quarantined) return result(Status.RECONCILIATION_REQUIRED, "RECONCILE", operationId);
        if (op == null || !op.id.equals(operationId) || !op.durable || op.writing || op.consumed)
            return result(Status.REFUSED, "NOT_PREPARED", operationId);
        if (!op.actor.equals(actualActor) || revoked.contains(actualActor) || !config.actors().containsKey(actualActor))
            return result(Status.REFUSED, "ACTOR", operationId);
        long now = authorityHighWaterMs;
        if (now < 0 || now >= op.expiry) return result(Status.REFUSED, "EXPIRED", operationId);
        if (config.workDeadlineMs() != 0 && now >= config.workDeadlineMs()
                && (op.structural() || op.action == Command.Action.LOCK || op.action == Command.Action.INSPECT))
            return result(Status.REFUSED, "WORK_EXPIRED", op.id);
        if (op.action == Command.Action.UNLOCK && reviewReleaseRefusal() != null)
            return result(Status.REFUSED, reviewReleaseRefusal(), op.id);
        if (revision != op.expectedRevision || lockMode != op.beforeLock) return result(Status.REFUSED, "STALE", operationId);
        if (!op.before.equals(currentBeforeEffect)) {
            quarantined = true;
            return result(Status.RECONCILIATION_REQUIRED, "BEFORE_EFFECT_MISMATCH", operationId);
        }
        op.consumed = true;
        if (op.action == Command.Action.LOCK || op.action == Command.Action.INSPECT) lockMode = LockMode.INSPECTION;
        return result(Status.AUTHORIZED, "CONSUMED_ONCE", operationId);
    }

    /** The bridge observes the actual native world/inventory effect; this method never applies it. */
    public synchronized CompletableFuture<Result> complete(String operationId, String actualAfterEffect) {
        observeClock();
        validateEffect(actualAfterEffect);
        Operation op = pending;
        if (op == null || !op.id.equals(operationId) || !op.durable || !op.consumed || op.writing)
            return immediate(Status.REFUSED, "NOT_EXECUTING", operationId);
        if (!op.after.equals(actualAfterEffect)) {
            if (op.before.equals(actualAfterEffect)) return settle(op, "NOT_APPLIED", actualAfterEffect, op.expectedRevision, op.beforeLock);
            quarantined = true; op.outcome = "UNCERTAIN"; op.writing = true;
            return persist(Map.of("type", "UNCERTAIN", "op", op.id, "observed", actualAfterEffect),
                    () -> op.writing = false, Status.RECONCILIATION_REQUIRED, "AFTER_EFFECT_MISMATCH", op.id);
        }
        long next = op.structural() ? Math.addExact(revision, 1) : revision;
        return settle(op, "APPLIED", actualAfterEffect, next, op.afterLock);
    }

    /** Startup/timeout recovery uses a fresh full effect, never a blind re-application. */
    public synchronized CompletableFuture<Result> reconcile(String currentFullEffect) {
        observeClock();
        if (clockRegressed) return immediate(Status.RECONCILIATION_REQUIRED, "CLOCK_REGRESSION", pending == null ? null : pending.id);
        validateEffect(currentFullEffect);
        if (closed || ioFailed) return immediate(Status.RECONCILIATION_REQUIRED, "IO_UNAVAILABLE", pending == null ? null : pending.id);
        if (reportWriting) return immediate(Status.REFUSED, "BUSY", null);
        if (pending != null) {
            Operation op = pending;
            if (op.writing || !op.durable) return immediate(Status.REFUSED, "BUSY", op.id);
            if (currentFullEffect.equals(op.before)) return settle(op, "NOT_APPLIED", currentFullEffect, op.expectedRevision, op.beforeLock);
            if (currentFullEffect.equals(op.after)) {
                long next = op.structural() ? Math.addExact(op.expectedRevision, 1) : op.expectedRevision;
                return settle(op, "APPLIED", currentFullEffect, next, op.afterLock);
            }
            quarantined = true;
            return immediate(Status.RECONCILIATION_REQUIRED, "UNKNOWN_EFFECT", op.id);
        }
        if (lastEffect != null && !lastEffect.equals(currentFullEffect)) {
            quarantined = true;
            return immediate(Status.RECONCILIATION_REQUIRED, "LATEST_EFFECT_MISMATCH", null);
        }
        return persist(Map.of("type", "CHECKPOINT", "effect", currentFullEffect),
                () -> { lastEffect = currentFullEffect; quarantined = false; }, Status.APPLIED, "RECONCILED", null);
    }

    public synchronized CompletableFuture<Result> revokeActor(UUID operator, UUID target) {
        observeClock();
        if (clockRegressed) return immediate(Status.RECONCILIATION_REQUIRED, "CLOCK_REGRESSION", null);
        if (config.actors().get(operator) != Role.OPERATOR || revoked.contains(operator) || !config.actors().containsKey(target))
            return immediate(Status.REFUSED, "ACTOR", null);
        revoked.add(target);
        return persist(Map.of("type", "REVOKE", "actor", target.toString()), () -> {}, Status.APPLIED, "ACTOR_REVOKED", null);
    }

    private CompletableFuture<Result> settle(Operation op, String outcome, String effect, long nextRevision, LockMode nextLock) {
        op.writing = true;
        Map<String, String> row = Map.of("type", outcome, "op", op.id, "effect", effect,
                "revision", Long.toString(nextRevision), "lock", nextLock.name());
        return persist(row, () -> {
            op.outcome = outcome; op.resultRevision = nextRevision; op.writing = false;
            revision = nextRevision; lockMode = nextLock; lastEffect = effect; pending = null; quarantined = false;
        }, outcome.equals("APPLIED") ? Status.APPLIED : Status.REFUSED,
                outcome.equals("APPLIED") ? "OBSERVED_APPLIED" : "PROVED_NOT_APPLIED", op.id);
    }

    private String binding(Command command, UUID actor) {
        if (!command.actorId().equals(actor) || revoked.contains(actor) || !config.actors().containsKey(actor)) return "ACTOR";
        if (!config.serverId().equals(command.serverId())) return "SERVER";
        if (!config.jobId().equals(command.jobId())) return "JOB";
        if (config.agreementVersion() != command.agreementVersion()) return "AGREEMENT";
        if (!config.authorizationReference().equals(command.authorizationReference())) return "AUTHORIZATION";
        if (!permitted(config.actors().get(actor), command.action())) return "FORBIDDEN";
        return null;
    }

    private String fresh(Command command) {
        long now = authorityHighWaterMs;
        if (now < 0 || command.expiresAtMs() <= now || command.expiresAtMs() - now > 10_000) return "EXPIRED_OR_OVERLONG";
        if (command.expectedRevision() != revision) return "STALE_REVISION";
        if (config.workDeadlineMs() != 0 && now >= config.workDeadlineMs()
                && (command.structural() || command.action() == Command.Action.LOCK || command.action() == Command.Action.INSPECT))
            return "WORK_EXPIRED";
        if (command.structural() && !config.bounds().contains(command.coordinate("x"), command.coordinate("y"), command.coordinate("z"))) return "OUT_OF_BOUNDS";
        if (command.action() == Command.Action.UNLOCK) return reviewReleaseRefusal();
        if (lockMode != LockMode.NONE && command.action() != Command.Action.OBSERVE) return "LOCKED";
        return null;
    }

    private long reportValidity(InspectionReport report) {
        if (config.obligationMode() != ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS) return config.reviewDeadlineMs();
        long remaining = config.reviewDeadlineMs() - report.completedAtMs();
        return report.completedAtMs() + Math.min(config.localPassValidityMs(), Math.max(0, remaining));
    }

    /** Local observations cannot become externally redeemable attestation authority. */
    public synchronized Result validateReport(String runId) {
        observeClock();
        if (clockRegressed || closed || ioFailed || quarantined) return result(Status.RECONCILIATION_REQUIRED, "RECONCILE", runId);
        InspectionReport report = reports.get(runId);
        if (report == null) return result(Status.REFUSED, "REPORT_UNKNOWN", runId);
        // Revision rejection is independent of temporal expiry or restored block shape.
        if (report.revision() != revision) return result(Status.REFUSED, "REPORT_REVISION", runId);
        if (!report.passed()) return result(Status.REFUSED, "REPORT_NOT_PASS", runId);
        if (report.obligationMode() != config.obligationMode() || report.obligationMode() == ObligationMode.REPORTING_DISABLED)
            return result(Status.REFUSED, "REPORT_MODE", runId);
        if (authorityHighWaterMs >= reportValidities.getOrDefault(runId, 0L)) return result(Status.REFUSED, "REPORT_EXPIRED", runId);
        if (lockMode != LockMode.REVIEW || pending != null || reportWriting) return result(Status.REFUSED, "REPORT_NOT_READY", runId);
        return result(Status.APPLIED, config.obligationMode() == ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS
                ? "LOCAL_READY_FOR_REVIEW" : "REQUIRES_EXTERNAL_ATTESTATION", runId);
    }

    private String reviewReleaseRefusal() {
        if (lockMode == LockMode.INSPECTION) return null;
        if (lockMode != LockMode.REVIEW || config.obligationMode() != ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS)
            return "NO_EARLY_UNLOCK";
        if (reportWriting || reports.values().stream().anyMatch(report -> report.passed()
                && authorityHighWaterMs < reportValidities.getOrDefault(report.runId(), 0L))) return "NO_EARLY_UNLOCK";
        return null;
    }

    private static boolean permitted(Role role, Command.Action action) {
        if (action == Command.Action.OBSERVE) return true;
        return switch (role) {
            case BUILDER, BOT -> action == Command.Action.PLACE || action == Command.Action.BREAK || action == Command.Action.REPAIR
                    || action == Command.Action.WITHDRAW || action == Command.Action.RETURN;
            case DELIVERY_WORKER -> action == Command.Action.DELIVER;
            case INSPECTOR -> action == Command.Action.LOCK || action == Command.Action.UNLOCK || action == Command.Action.INSPECT;
            default -> false;
        };
    }

    private CompletableFuture<Result> persist(Map<String, String> row, Runnable committed, Status status, String code, String operationId) {
        if (closed || ioFailed) return immediate(Status.RECONCILIATION_REQUIRED, "IO_UNAVAILABLE", operationId);
        Map<String, String> stamped = new TreeMap<>(row);
        long watermark = authorityHighWaterMs;
        stamped.put("authorityTime", Long.toString(watermark));
        return CompletableFuture.supplyAsync(() -> {
            try {
                journal.append(stamped);
                synchronized (this) { durableHighWaterMs = watermark; committed.run(); return result(status, code, operationId); }
            } catch (IOException | RuntimeException failure) {
                synchronized (this) { quarantined = true; ioFailed = true; return result(Status.RECONCILIATION_REQUIRED, "JOURNAL_FAILURE", operationId); }
            }
        }, io);
    }

    private CompletableFuture<Result> immediate(Status status, String code, String operationId) {
        return CompletableFuture.completedFuture(result(status, code, operationId));
    }
    private Result result(Status status, String code, String operationId) { return new Result(status, code, operationId, revision); }
    private static void validateEffect(String effect) { Command.text(effect, 65_536); }

    private String configHash() {
        TreeMap<String, String> actors = new TreeMap<>();
        config.actors().forEach((id, role) -> actors.put(id.toString(), role.name()));
        String value = config.serverId() + "|" + config.jobId() + "|" + config.agreementVersion() + "|" + config.bounds()
                + "|" + actors + "|" + config.authorizationReference() + "|" + config.blueprintId()
                + "|" + config.testManifestId() + "|" + config.workDeadlineMs() + "|" + config.reviewDeadlineMs() + "|" + config.obligationMode() + "|" + config.localPassValidityMs();
        return Command.sha256(value.getBytes(StandardCharsets.UTF_8));
    }

    private void replay() throws IOException {
        boolean first = true;
        try {
            for (var retained : journal.records()) {
                Map<String, String> row = new TreeMap<>(retained);
                String time = row.remove("authorityTime");
                long watermark = Long.parseLong(time);
                if (watermark < durableHighWaterMs || watermark < 0) throw new IOException("authority time regressed in journal");
                authorityHighWaterMs = durableHighWaterMs = watermark;
                String type = row.get("type");
                if (first) {
                    requireFields(row, "type", "config");
                    if (!"INIT".equals(type) || !configHash().equals(row.get("config"))) throw new IOException("journal configuration mismatch");
                    first = false; continue;
                }
                if (clockRegressed && Set.of("INTENT", "REVOKE", "REPORT", "CHECKPOINT", "COLLISION").contains(type))
                    throw new IOException("new authority after recorded clock regression");
                switch (type) {
                    case "CLOCK" -> {
                        requireFields(row, "type", "regressed");
                        if (!Set.of("true", "false").contains(row.get("regressed"))) throw new IOException("invalid clock state");
                        if (row.get("regressed").equals("true")) clockRegressed = durableClockRegression = true;
                        if (durableClockRegression && row.get("regressed").equals("false")) throw new IOException("clock regression cannot be cleared");
                    }
                    case "COLLISION" -> {
                        requireFields(row, "type", "op", "originalHash", "rejectedHash");
                        Operation original = operations.get(row.get("op"));
                        CollisionAudit audit = new CollisionAudit(row.get("op"), row.get("originalHash"), row.get("rejectedHash"));
                        if (original == null || !original.hash.equals(audit.originalHash()) || audit.originalHash().equals(audit.rejectedHash())
                                || !audit.rejectedHash().matches("[0-9a-f]{64}") || !collisionAudits.add(audit))
                            throw new IOException("invalid collision audit");
                    }
                    case "INTENT" -> {
                        requireFields(row, "type", "op", "hash", "actor", "action", "expectedRevision", "expiry", "before", "after", "beforeLock", "afterLock");
                        Operation op = new Operation(row);
                        validateEffect(op.before); validateEffect(op.after);
                        LockMode expectedLock = switch (op.action) { case LOCK, INSPECT -> LockMode.INSPECTION; case UNLOCK -> LockMode.NONE; default -> lockMode; };
                        if (op.action == Command.Action.UNLOCK && reviewReleaseRefusal() != null)
                            throw new IOException("unsafe recorded unlock");
                        if (pending != null || operations.containsKey(op.id) || op.expectedRevision != revision
                                || op.expectedRevision < 0 || op.expectedRevision == Long.MAX_VALUE || op.expiry < 1
                                || !op.id.matches("[A-Za-z0-9_.:/-]{1,128}") || !op.hash.matches("[0-9a-f]{64}")
                                || !config.actors().containsKey(op.actor) || revoked.contains(op.actor)
                                || !permitted(config.actors().get(op.actor), op.action)
                                || op.beforeLock != lockMode || op.afterLock != expectedLock
                                || lastEffect != null && !lastEffect.equals(op.before))
                            throw new IOException("inconsistent journal intent");
                        pending = op; operations.put(op.id, op);
                    }
                    case "APPLIED", "NOT_APPLIED" -> {
                        requireFields(row, "type", "op", "effect", "revision", "lock");
                        if (pending == null || !pending.id.equals(row.get("op"))) throw new IOException("receipt without intent");
                        long next = Long.parseLong(row.get("revision"));
                        boolean applied = type.equals("APPLIED");
                        long expected = applied && pending.structural() ? Math.addExact(revision, 1) : revision;
                        String effect = applied ? pending.after : pending.before;
                        LockMode expectedLock = applied ? pending.afterLock : pending.beforeLock;
                        if (next != expected || !effect.equals(row.get("effect")) || !expectedLock.name().equals(row.get("lock")))
                            throw new IOException("receipt effect or revision mismatch");
                        lastEffect = row.get("effect");
                        pending.outcome = type; pending.resultRevision = next; revision = next;
                        lockMode = LockMode.valueOf(row.get("lock")); pending = null;
                    }
                    case "UNCERTAIN" -> {
                        requireFields(row, "type", "op", "observed");
                        if (pending == null || !pending.id.equals(row.get("op"))) throw new IOException("uncertain without intent");
                        pending.outcome = "UNCERTAIN";
                    }
                    case "CHECKPOINT" -> {
                        requireFields(row, "type", "effect");
                        validateEffect(row.get("effect"));
                        if (pending != null || lastEffect != null && !lastEffect.equals(row.get("effect"))) throw new IOException("invalid checkpoint");
                        lastEffect = row.get("effect");
                    }
                    case "REVOKE" -> {
                        requireFields(row, "type", "actor");
                        UUID actor = UUID.fromString(row.get("actor"));
                        if (!config.actors().containsKey(actor)) throw new IOException("unknown revoked actor");
                        revoked.add(actor);
                    }
                    case "REPORT" -> {
                        requireFields(row, "type", "runId", "server", "job", "agreement", "revision", "blueprint", "manifest", "started", "completed", "cases", "obligationMode", "effect", "ready", "validUntil");
                        InspectionReport report = InspectionReport.restore(row);
                        if (pending != null || lockMode != LockMode.INSPECTION || report.revision() != revision
                                || report.completedAtMs() > authorityHighWaterMs
                                || !config.serverId().equals(report.serverId()) || !config.jobId().equals(report.jobId())
                                || config.agreementVersion() != report.agreementVersion()
                                || !config.blueprintId().equals(report.blueprintId())
                                || !config.testManifestId().equals(report.testManifestId()) || config.obligationMode() != report.obligationMode()
                                || config.obligationMode() == ObligationMode.REPORTING_DISABLED
                                || reports.putIfAbsent(report.runId(), report) != null)
                            throw new IOException("report context mismatch");
                        if (!Set.of("true", "false").contains(row.get("ready"))) throw new IOException("invalid report readiness");
                        boolean ready = row.get("ready").equals("true");
                        long validity = Long.parseLong(row.get("validUntil"));
                        if (ready && (!report.passed() || report.completedAtMs() >= config.workDeadlineMs()
                                || validity != reportValidity(report))) throw new IOException("invalid passing report");
                        if (!ready && validity != 0) throw new IOException("invalid report validity");
                        if (!row.get("effect").equals(lastEffect)) throw new IOException("report effect mismatch");
                        lockMode = ready ? LockMode.REVIEW : LockMode.NONE;
                        passValidUntilMs = validity; reportValidities.put(report.runId(), validity); lastEffect = row.get("effect");
                    }
                    default -> throw new IOException("unknown journal event");
                }
            }
            quarantined = true;
        } catch (IllegalArgumentException | NullPointerException invalid) { throw new IOException("malformed job journal", invalid); }
    }

    private static void requireFields(Map<String, String> row, String... names) throws IOException {
        if (!row.keySet().equals(Set.of(names))) throw new IOException("journal event fields");
    }

    @Override public void close() throws IOException {
        synchronized (this) { if (closed) return; closed = true; }
        io.shutdown();
        try {
            if (!io.awaitTermination(10, TimeUnit.SECONDS)) throw new IOException("journal worker did not stop");
        } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new IOException(interrupted); }
        journal.close();
    }
}

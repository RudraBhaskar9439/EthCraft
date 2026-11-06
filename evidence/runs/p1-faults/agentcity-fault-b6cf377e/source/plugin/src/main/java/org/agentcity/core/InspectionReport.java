package org.agentcity.core;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/** Context-bound observations supplied by the actual trusted checker, never a model. */
public record InspectionReport(String runId, String serverId, String jobId, long agreementVersion,
                               long revision, String blueprintId, String testManifestId,
                               long startedAtMs, long completedAtMs, List<CaseResult> cases, JobEngine.ObligationMode obligationMode) {
    /** Legacy observations carry no reporting authority without explicit deployment mode. */
    public InspectionReport(String runId, String serverId, String jobId, long agreementVersion,
                            long revision, String blueprintId, String testManifestId,
                            long startedAtMs, long completedAtMs, List<CaseResult> cases) {
        this(runId, serverId, jobId, agreementVersion, revision, blueprintId, testManifestId,
                startedAtMs, completedAtMs, cases, JobEngine.ObligationMode.REPORTING_DISABLED);
    }
    public record CaseResult(int a, int b, int expected, int observed) {
        public CaseResult {
            if (a < 0 || a > 3 || b < 0 || b > 3 || expected != a + b || observed < 0 || observed > 7)
                throw new IllegalArgumentException("inspection case");
        }
        public boolean passed() { return expected == observed; }
    }

    public InspectionReport {
        for (String id : new String[] {runId, serverId, jobId, blueprintId, testManifestId}) {
            if (id == null || !id.matches("[A-Za-z0-9_.:/-]{1,128}")) throw new IllegalArgumentException("report identifier");
        }
        if (obligationMode == null) throw new IllegalArgumentException("explicit report mode required");
        if (agreementVersion < 1 || revision < 0 || startedAtMs < 0 || completedAtMs < startedAtMs
                || cases == null || cases.size() > 16) throw new IllegalArgumentException("report range");
        Set<Integer> pairs = new HashSet<>();
        for (CaseResult result : cases) {
            if (result == null || !pairs.add(result.a() * 4 + result.b())) throw new IllegalArgumentException("duplicate inspection case");
        }
        cases = List.copyOf(cases);
    }

    public boolean complete() { return cases.size() == 16; }
    public boolean passed() { return complete() && cases.stream().allMatch(CaseResult::passed); }
    public String outcome() { return !complete() ? "INCOMPLETE" : passed() ? "PASS" : "FAIL"; }

    public String fingerprint() {
        return Command.sha256(fields().toString().getBytes(StandardCharsets.UTF_8));
    }

    Map<String, String> fields() {
        StringBuilder values = new StringBuilder();
        for (CaseResult c : cases) values.append(c.a()).append(',').append(c.b()).append(',')
                .append(c.expected()).append(',').append(c.observed()).append(';');
        return new TreeMap<>(Map.ofEntries(Map.entry("runId", runId), Map.entry("server", serverId),
                Map.entry("job", jobId), Map.entry("agreement", Long.toString(agreementVersion)),
                Map.entry("revision", Long.toString(revision)), Map.entry("blueprint", blueprintId),
                Map.entry("manifest", testManifestId), Map.entry("started", Long.toString(startedAtMs)),
                Map.entry("completed", Long.toString(completedAtMs)), Map.entry("cases", values.toString()),
                Map.entry("obligationMode", obligationMode.name())));
    }

    static InspectionReport restore(Map<String, String> fields) {
        List<CaseResult> rows = new ArrayList<>();
        for (String line : fields.get("cases").split(";")) {
            if (line.isEmpty()) continue;
            String[] values = line.split(",", -1);
            if (values.length != 4) throw new IllegalArgumentException("report row");
            rows.add(new CaseResult(Integer.parseInt(values[0]), Integer.parseInt(values[1]),
                    Integer.parseInt(values[2]), Integer.parseInt(values[3])));
        }
        return new InspectionReport(fields.get("runId"), fields.get("server"), fields.get("job"),
                Long.parseLong(fields.get("agreement")), Long.parseLong(fields.get("revision")),
                fields.get("blueprint"), fields.get("manifest"), Long.parseLong(fields.get("started")),
                Long.parseLong(fields.get("completed")), rows, JobEngine.ObligationMode.valueOf(fields.get("obligationMode")));
    }
}

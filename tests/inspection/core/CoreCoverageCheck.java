package org.agentcity.core;

import java.math.BigInteger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** Generated coverage support uses supplied effect strings, never Minecraft observations. */
public final class CoreCoverageCheck {
    static final UUID BUILDER=id(1), BOT=id(2), REQUESTER=id(3), INSPECTOR=id(4), OPERATOR=id(5), DELIVERY=id(6);
    static final List<Map<String,Object>> results=new ArrayList<>();
    static int assertions;
    @FunctionalInterface interface Check { void run() throws Exception; }
    static final class TestClock extends Clock {
        long now=1000;
        @Override public ZoneId getZone(){return ZoneOffset.UTC;}
        @Override public Clock withZone(ZoneId zone){return this;}
        @Override public Instant instant(){return Instant.ofEpochMilli(now);}
        @Override public long millis(){return now;}
    }
    static UUID id(int n){return UUID.fromString(String.format("00000000-0000-0000-0000-%012d",n));}
    static Map<String,Object> map(Object... pairs){Map<String,Object> r=new HashMap<>();for(int i=0;i<pairs.length;i+=2)r.put((String)pairs[i],pairs[i+1]);return r;}
    static void check(boolean value,String detail){assertions++;if(!value)throw new AssertionError(detail);}
    static void rejects(Check action,String detail)throws Exception{boolean denied=false;try{action.run();}catch(IllegalArgumentException|java.io.IOException|UnsupportedOperationException expected){denied=true;}check(denied,detail);}
    static JobEngine.Result await(CompletableFuture<JobEngine.Result> f)throws Exception{return f.get(10,TimeUnit.SECONDS);}
    static JobEngine.Config config(){return config(new JobEngine.Bounds(-10,0,-10,32,100,32),JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS);}
    static JobEngine.Config config(JobEngine.Bounds bounds,JobEngine.ObligationMode mode){return new JobEngine.Config("server","job",1,bounds,
        Map.of(BUILDER,JobEngine.Role.BUILDER,BOT,JobEngine.Role.BOT,REQUESTER,JobEngine.Role.REQUESTER,INSPECTOR,JobEngine.Role.INSPECTOR,OPERATOR,JobEngine.Role.OPERATOR,DELIVERY,JobEngine.Role.DELIVERY_WORKER),
        "authority","blueprint","manifest",20_000,30_000,mode,mode==JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS?5000:0);}
    static Map<String,Object> params(Command.Action action){return switch(action){
        case PLACE,REPAIR->map("x",0L,"y",80L,"z",0L,"state","minecraft:stone_bricks");
        case BREAK->map("x",0L,"y",80L,"z",0L);
        case WITHDRAW,RETURN->map("item","minecraft:stone_bricks","count",1L);
        case DELIVER->map("claimId","claim","items",map("minecraft:stone_bricks",1L));
        default->map();};}
    static UUID actor(Command.Action action){return switch(action){case INSPECT,LOCK,UNLOCK->INSPECTOR;case DELIVER->DELIVERY;default->BUILDER;};}
    static Map<String,Object> envelope(Command.Action action,UUID actor){return map("operationId","operation","serverId","server","jobId","job","agreementVersion",1L,"actorId",actor.toString(),"expectedRevision",0L,"authorizationReference","authority","expiresAtMs",6000L,"action",action.name(),"params",params(action));}
    static Command command(String operation,Command.Action action,UUID actor,long revision,TestClock clock){Map<String,Object> p=envelope(action,actor);p.put("operationId",operation);p.put("expectedRevision",revision);p.put("expiresAtMs",clock.now+5000);return Command.parse(p);}
    static void apply(JobEngine e,Command c,UUID actor,String before,String after)throws Exception{check(await(e.prepare(c,actor,before,after)).status()==JobEngine.Status.PREPARED,"durable prepared");check(e.consumePrepared(c.operationId(),actor,before).status()==JobEngine.Status.AUTHORIZED,"consumed once");check(await(e.complete(c.operationId(),after)).status()==JobEngine.Status.APPLIED,"receipt committed");}
    static Path path()throws Exception{return Files.createTempDirectory("agentcity-core-generated-").resolve("journal");}
    static long number(Map<String,Object> p,String key){return ((Number)p.get(key)).longValue();}
    static void run(String id,Check action){int first=assertions;try{action.run();results.add(map("check_id",id,"status","pass","assertions",assertions-first));}catch(Throwable failed){results.add(map("check_id",id,"status","fail","assertions",assertions-first,"error",failed.toString()));}}
    static String json(Object value){if(value instanceof String s)return "\""+s.replace("\\","\\\\").replace("\"","\\\"").replace("\n","\\n").replace("\r","\\r")+"\"";if(value instanceof Map<?,?> m)return "{"+String.join(",",m.entrySet().stream().map(x->json(x.getKey())+":"+json(x.getValue())).toList())+"}";if(value instanceof List<?> l)return "["+String.join(",",l.stream().map(CoreCoverageCheck::json).toList())+"]";return String.valueOf(value);}
    static void finish(Path output)throws Exception{long failed=results.stream().filter(r->r.get("status").equals("fail")).count();Files.writeString(output,json(map("suite","generated-core-coverage","scope","pure typed protocol; synthetic effect strings; no native/world/transport acceptance", "assertions",assertions,"checks",results.size(),"failed",failed,"status",failed==0?"pass":"fail","results",results)));System.out.println(json(map("suite","generated-core-coverage","checks",results.size(),"assertions",assertions,"failed",failed)));if(failed!=0)throw new AssertionError("generated coverage failures retained at "+output);}

    static void actorCase(Map<String,Object> p)throws Exception{
        Command.Action action=Command.Action.valueOf((String)p.get("action"));String kind=(String)p.get("actor_class");UUID subject=actor(action),verified=subject;
        if(kind.equals("unassigned_player")||kind.equals("forged_display_name"))subject=verified=id(99);
        if(kind.equals("wrong_bot_operator"))verified=id(99);
        TestClock clock=new TestClock();try(JobEngine e=new JobEngine(path(),config(),clock)){
            if(kind.equals("revoked_actor"))await(e.revokeActor(OPERATOR,subject));
            JobEngine.Result r=await(e.prepare(Command.parse(envelope(action,subject)),verified,"before","after"));
            check(r.status()==JobEngine.Status.REFUSED&&r.code().equals("ACTOR"),"unauthenticated/revoked subject refused");
            check(e.state().revision()==0&&e.state().pendingOperation()==null,"refusal preserves protocol state");
        }
    }
    static void bounds(Map<String,Object> p)throws Exception{
        Command.Action action=Command.Action.valueOf((String)p.get("action"));Map<String,Object> q=envelope(action,BUILDER);Map<String,Object> coordinates=params(action);
        if(p.containsKey("coordinate")){coordinates.put((String)p.get("axis"),p.get("coordinate"));q.put("params",coordinates);rejects(()->Command.parse(q),"outside int rejected");return;}
        if(p.containsKey("origin_axis")){long n=Math.addExact(number(p,"origin_axis"),number(p,"relative_axis"));coordinates.put((String)p.get("axis"),n);q.put("params",coordinates);rejects(()->Command.parse(q),"unwrapped absolute overflow rejected");return;}
        List<?> origin=(List<?>)p.get("plot_origin"),world=(List<?>)p.get("world_position"),relative=(List<?>)p.get("relative_position");
        int ox=((Number)origin.get(0)).intValue(),oy=((Number)origin.get(1)).intValue(),oz=((Number)origin.get(2)).intValue();
        for(int i=0;i<3;i++)coordinates.put(new String[]{"x","y","z"}[i],((Number)world.get(i)).longValue());q.put("params",coordinates);
        boolean inside=((Number)relative.get(0)).longValue()>=0&&((Number)relative.get(0)).longValue()<=31&&((Number)relative.get(1)).longValue()>=0&&((Number)relative.get(1)).longValue()<=15&&((Number)relative.get(2)).longValue()>=0&&((Number)relative.get(2)).longValue()<=15;
        try(JobEngine e=new JobEngine(path(),config(new JobEngine.Bounds(ox,oy,oz,ox+31,oy+15,oz+15),JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS),new TestClock())){
            JobEngine.Result r=await(e.prepare(Command.parse(q),BUILDER,"before","after"));check(inside?r.status()==JobEngine.Status.PREPARED:r.code().equals("OUT_OF_BOUNDS"),"inclusive translated typed bounds");check(e.state().revision()==0,"prepare/refusal does not mutate revision");}
    }
    @SuppressWarnings("unchecked") static void typed(Map<String,Object> p)throws Exception{
        Command.Action action=p.containsKey("action")?Command.Action.valueOf((String)p.get("action")):Command.Action.PLACE;UUID actor=actor(action);Map<String,Object> q=envelope(action,actor);boolean parseExpected=true;String field=(String)p.get("field"),mutation=(String)p.get("mutation");
        if(field!=null&&mutation!=null){Object old=q.get(field);switch(mutation){case "missing"->q.remove(field);case "null"->q.put(field,null);case "wrong_type"->q.put(field,old instanceof String?17L:"wrong");case "fractional"->q.put(field,new java.math.BigDecimal("1.5"));case "numeric_string"->q.put(field,"1");case "boolean"->q.put(field,true);default->throw new AssertionError(mutation);}parseExpected=false;}
        else if(field!=null&&p.containsKey("utf8_bytes")){int n=(int)number(p,"utf8_bytes");q.put(field,"x".repeat(n));int max=field.equals("operationId")?128:field.equals("authorizationReference")?256:64;parseExpected=n>=1&&n<=max;}
        else if(field!=null&&p.containsKey("value")){Object value=p.get("value");q.put(field,value);BigInteger n=new BigInteger(value.toString());parseExpected=n.compareTo(BigInteger.valueOf(field.equals("expectedRevision")?0:1))>=0&&n.compareTo(BigInteger.valueOf(field.equals("expectedRevision")?Long.MAX_VALUE-1:Long.MAX_VALUE))<=0;}
        else if(field!=null&&p.containsKey("relation_to_authority_now")){String relation=(String)p.get("relation_to_authority_now");q.put(field,relation.equals("now_minus_1_ms")?999L:relation.equals("now_exact")?1000L:1001L);}
        else if(p.containsKey("parameter")){Map<String,Object> values=(Map<String,Object>)q.get("params");values.put((String)p.get("parameter"),p.get("value"));long n=number(p,"value");parseExpected=p.get("parameter").equals("count")?n>=1&&n<=64:n>=Integer.MIN_VALUE&&n<=Integer.MAX_VALUE;}
        else if(p.containsKey("action")&&mutation!=null){Map<String,Object> values=(Map<String,Object>)q.get("params");
            for(String key:values.keySet()){Map<String,Object> altered=new HashMap<>(values);if(mutation.equals("missing_required_or_extra_parameter"))altered.remove(key);else altered.put(key,false);Map<String,Object> alteredEnvelope=new HashMap<>(q);alteredEnvelope.put("params",altered);rejects(()->Command.parse(alteredEnvelope),"every missing/wrong-typed action parameter rejected: "+key);}
            if(mutation.equals("missing_required_or_extra_parameter")){values.put("unexpected",1L);}else q.put("params",false);parseExpected=false;}
        else if(mutation!=null){switch(mutation){
            case "extra_envelope_field"->q.put("role","OPERATOR");case "unknown_action"->q.put("action","MINT");case "noncanonical_uuid"->q.put("actorId","1-1-1-1-1");
            case "cross_server"->q.put("serverId","other");case "cross_job"->q.put("jobId","other");case "wrong_agreement_version"->q.put("agreementVersion",2L);case "stale_revision"->q.put("expectedRevision",0L);case "future_revision"->q.put("expectedRevision",2L);case "wrong_authorization_reference"->q.put("authorizationReference","other");case "actor_session_mismatch","authorization_revoked_after_validation"->{}default->throw new AssertionError(mutation);}
            parseExpected=!Set.of("extra_envelope_field","unknown_action","noncanonical_uuid").contains(mutation);
        }
        if(!parseExpected){rejects(()->Command.parse(q),"strict typed value rejected");return;}
        Command c=Command.parse(q);check(c.fingerprint().length()==64,"canonical fingerprint available");TestClock clock=new TestClock();try(JobEngine e=new JobEngine(path(),config(),clock)){
            UUID verified=mutation!=null&&mutation.equals("actor_session_mismatch")?REQUESTER:actor;
            if("stale_revision".equals(mutation))apply(e,command("seed-revision",Command.Action.PLACE,BUILDER,0,clock),BUILDER,"initial","before");
            if(mutation!=null&&mutation.equals("authorization_revoked_after_validation")){await(e.prepare(c,actor,"before","after"));await(e.revokeActor(OPERATOR,actor));check(e.consumePrepared(c.operationId(),actor,"before").code().equals("ACTOR"),"revocation after preparation denies native consumption");return;}
            JobEngine.Result r=await(e.prepare(c,verified,"before","after"));
            boolean valid=c.serverId().equals("server")&&c.jobId().equals("job")&&c.agreementVersion()==1&&c.authorizationReference().equals("authority")&&c.expectedRevision()==e.state().revision()&&c.expiresAtMs()>1000&&c.expiresAtMs()<=11000&&verified.equals(c.actorId());
            if(c.structural())valid&=config().bounds().contains(c.coordinate("x"),c.coordinate("y"),c.coordinate("z"));
            check(valid?r.status()==JobEngine.Status.PREPARED:r.status()==JobEngine.Status.REFUSED,"parsed value receives context/expiry/bounds check");check(e.state().revision()==("stale_revision".equals(mutation)?1:0),"validation never executes supplied effect");}
    }
    static List<InspectionReport.CaseResult> rows(){List<InspectionReport.CaseResult> rows=new ArrayList<>();for(int a=0;a<4;a++)for(int b=0;b<4;b++)rows.add(new InspectionReport.CaseResult(a,b,a+b,a+b));return rows;}
    static InspectionReport report(String run,long revision,long completion,JobEngine.ObligationMode mode,List<InspectionReport.CaseResult> rows){return new InspectionReport(run,"server","job",1,revision,"blueprint","manifest",completion-100,completion,rows,mode);}
    static void inspect(JobEngine e,TestClock clock)throws Exception{apply(e,command("inspection",Command.Action.INSPECT,INSPECTOR,0,clock),INSPECTOR,"world","world");}
    static void reportCase(Map<String,Object> p)throws Exception{
        List<InspectionReport.CaseResult> observed=rows();boolean parseExpected=true;String tamper=(String)p.get("tamper");
        if(p.containsKey("row")){Map<?,?> row=(Map<?,?>)p.get("row");int index=((Number)row.get("a")).intValue()*4+((Number)row.get("b")).intValue();InspectionReport.CaseResult old=observed.get(index);
            switch(tamper){case "missing_row"->observed.remove(index);case "duplicate_row_replacing_another"->{observed.set((index+1)%16,old);parseExpected=false;}case "alter_expected_value"->{rejects(()->new InspectionReport.CaseResult(old.a(),old.b(),old.expected()+1,old.observed()),"expected arithmetic cannot be changed");return;}case "alter_observed_value"->observed.set(index,new InspectionReport.CaseResult(old.a(),old.b(),old.expected(),(old.observed()+1)%8));default->throw new AssertionError(tamper);}
        }
        if(p.containsKey("source_run_status")){if(p.get("source_run_status").equals("failed"))observed.set(0,new InspectionReport.CaseResult(0,0,0,1));else observed.remove(15);}
        List<InspectionReport.CaseResult> finalRows=observed;
        if(!parseExpected){rejects(()->report("report",0,1000,JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS,finalRows),"duplicate row rejected");return;}
        InspectionReport r=report("report",0,1000,JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS,observed);
        if(p.containsKey("tamper_context_field")){String changed=(String)p.get("tamper_context_field");r=new InspectionReport("report",changed.equals("server_id")?"wrong":"server",changed.equals("job_id")?"wrong":"job",changed.equals("agreement_version")?2:1,changed.equals("structural_revision")?1:0,changed.equals("blueprint_version")?"wrong":"blueprint",changed.startsWith("test_manifest")?"wrong":"manifest",900,1000,observed,JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS);}
        TestClock clock=new TestClock();try(JobEngine e=new JobEngine(path(),config(),clock)){inspect(e,clock);UUID issuer=p.containsKey("pass_request_actor")?switch((String)p.get("pass_request_actor")){case "requester"->REQUESTER;case "builder"->BUILDER;default->id(99);}:INSPECTOR;
            JobEngine.Result result=await(e.finishInspection(r,issuer,"world"));boolean valid=!p.containsKey("tamper_context_field")&&!p.containsKey("pass_request_actor")&&r.passed();check(valid?result.code().equals("READY_FOR_REVIEW"):!e.state().readyForReview(),"only complete verified-context passing evidence gives readiness");
            if(p.containsKey("pass_request_actor"))check(result.code().equals("ACTOR"),"pass authority verified");
            if(p.containsKey("tamper_context_field"))check(result.code().equals("REPORT_CONTEXT"),"report context pinned");
            if(!r.passed())check(e.reports().size()==1&&e.reports().get(0).fingerprint().equals(r.fingerprint()),"failed/incomplete original retained immutably");
        }
    }
    static void expiry(Map<String,Object> p)throws Exception{
        TestClock clock=new TestClock();boolean review="review".equals(p.get("expiry"));JobEngine.ObligationMode mode=review?JobEngine.ObligationMode.EXTERNAL_OBLIGATIONS:JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS;
        try(JobEngine e=new JobEngine(path(),config(config().bounds(),mode),clock)){inspect(e,clock);
            if(p.containsKey("authority_completion_ms_relative_to_work_deadline")){clock.now=20_000+number(p,"authority_completion_ms_relative_to_work_deadline");JobEngine.Result r=await(e.finishInspection(report("report",0,clock.now,mode,rows()),INSPECTOR,"world"));check(number(p,"authority_completion_ms_relative_to_work_deadline")<0?r.code().equals("READY_FOR_REVIEW"):!e.state().readyForReview(),"fixed work-completion half-open boundary");}
            else{await(e.finishInspection(report("report",0,1000,mode,rows()),INSPECTOR,"world"));long deadline=e.state().passValidUntilMs();clock.now=deadline+number(p,"authority_now_relative_to_expiry_ms");check(e.durableState().get(10,TimeUnit.SECONDS).readyForReview()==(number(p,"authority_now_relative_to_expiry_ms")<0),"pass/review equality expires durably");check(e.state().lockMode()==JobEngine.LockMode.REVIEW,"expiry does not silently drop protection");}}
    }
    static void replay(Map<String,Object> p)throws Exception{
        TestClock clock=new TestClock();Path path=path();Command original=command("original",Command.Action.PLACE,BUILDER,0,clock);
        try(JobEngine e=new JobEngine(path,config(),clock)){if("concurrent_identical".equals(p.get("retry_mode"))){CompletableFuture<JobEngine.Result> first=e.prepare(original,BUILDER,"before","after"),second=e.prepare(original,BUILDER,"before","after");check(await(first).status()==JobEngine.Status.PREPARED,"first durable preparation");check(Set.of(JobEngine.Status.PREPARED,JobEngine.Status.REFUSED).contains(await(second).status()),"concurrent retry never applies");check(e.consumePrepared(original.operationId(),BUILDER,"before").status()==JobEngine.Status.AUTHORIZED,"one consumed permit");await(e.complete(original.operationId(),"after"));}else apply(e,original,BUILDER,"before","after");
            if(p.containsKey("change_field")){String field=(String)p.get("change_field");Map<String,Object> changed=envelope(Command.Action.PLACE,BUILDER);changed.put("operationId","original");Object value=switch(field){case "serverId","jobId","authorizationReference"->"other";case "agreementVersion"->2L;case "actorId"->BOT.toString();case "expectedRevision"->1L;case "expiresAtMs"->7000L;case "action"->"REPAIR";case "params"->map("x",1L,"y",80L,"z",0L,"state","minecraft:stone_bricks");default->throw new AssertionError(field);};changed.put(field,value);check(e.lookup(Command.parse(changed),BUILDER).status()==JobEngine.Status.REFUSED,"semantic collision refused");e.durableState().get(10,TimeUnit.SECONDS);check(e.collisionAudits().size()==(field.equals("actorId")?0:1),"safe hash audit only after authenticated owner gate");}
            else{if("identical_after_command_expiry".equals(p.get("retry_mode")))clock.now=10_000;check(e.lookup(original,BUILDER).status()==JobEngine.Status.REPLAY,"identical lookup returns retained evidence");}
            check(e.state().revision()==1,"one total structural revision");}
        if("identical_after_restart".equals(p.get("retry_mode")))try(JobEngine e=new JobEngine(path,config(),clock)){check(e.lookup(original,BUILDER).status()==JobEngine.Status.RECONCILIATION_REQUIRED,"restart refuses before observation");await(e.reconcile("after"));check(e.lookup(original,BUILDER).status()==JobEngine.Status.REPLAY,"reconciled receipt replays after reopen");}
    }
    static void clockCase(Map<String,Object> p)throws Exception{
        TestClock clock=new TestClock();Path path=path();String fault=(String)p.get("fault");
        try(JobEngine e=new JobEngine(path,config(),clock)){
            if(fault.equals("prepared_command_then_wall_rewind")){Command c=command("prepared",Command.Action.PLACE,BUILDER,0,clock);await(e.prepare(c,BUILDER,"world","after"));clock.now--;check(e.consumePrepared(c.operationId(),BUILDER,"world").code().equals("CLOCK_REGRESSION"),"rollback cannot revive permit");}
            else{inspect(e,clock);if(!fault.equals("active_inspection_then_wall_rewind")){await(e.finishInspection(report("pass",0,1000,JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS,rows()),INSPECTOR,"world"));clock.now=6000;e.durableState().get(10,TimeUnit.SECONDS);}clock.now--;check(!e.state().readyForReview(),"rollback never revives readiness");if(fault.equals("active_inspection_then_wall_rewind"))check(await(e.finishInspection(report("after-regression",0,999,JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS,rows()),INSPECTOR,"world")).code().equals("CLOCK_REGRESSION"),"active-inspection rollback refuses evidence");}
            check(e.durableState().get(10,TimeUnit.SECONDS).quarantined(),"clock uncertainty durably quarantined");}
        try(JobEngine e=new JobEngine(path,config(),clock)){check(!e.state().readyForReview(),"restart cannot erase regression");check(await(e.reconcile("world")).code().equals("CLOCK_REGRESSION"),"regression cannot be cleared by effect reconciliation");}
    }
    static void review(Map<String,Object> p)throws Exception{TestClock clock=new TestClock();try(JobEngine e=new JobEngine(path(),config(),clock)){inspect(e,clock);await(e.finishInspection(report("pass",0,1000,JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS,rows()),INSPECTOR,"world"));Command.Action action=Command.Action.valueOf((String)p.get("action"));JobEngine.Result r=await(e.prepare(command("blocked",action,actor(action),0,clock),actor(action),"world","changed"));check(r.status()==JobEngine.Status.REFUSED,"usable pass rejects structural edit/early unlock");check(e.state().revision()==0&&e.state().lockMode()==JobEngine.LockMode.REVIEW,"refusal keeps revision and protection");}}
    static void actorMatrix()throws Exception{
        Map<JobEngine.Role,Set<Command.Action>> allowed=Map.of(JobEngine.Role.BUILDER,Set.of(Command.Action.PLACE,Command.Action.BREAK,Command.Action.REPAIR,Command.Action.WITHDRAW,Command.Action.RETURN,Command.Action.OBSERVE),JobEngine.Role.BOT,Set.of(Command.Action.PLACE,Command.Action.BREAK,Command.Action.REPAIR,Command.Action.WITHDRAW,Command.Action.RETURN,Command.Action.OBSERVE),JobEngine.Role.INSPECTOR,Set.of(Command.Action.LOCK,Command.Action.UNLOCK,Command.Action.INSPECT,Command.Action.OBSERVE),JobEngine.Role.DELIVERY_WORKER,Set.of(Command.Action.DELIVER,Command.Action.OBSERVE),JobEngine.Role.REQUESTER,Set.of(Command.Action.OBSERVE),JobEngine.Role.OPERATOR,Set.of(Command.Action.OBSERVE));
        for(var actor:config().actors().entrySet())for(Command.Action action:Command.Action.values())try(JobEngine e=new JobEngine(path(),config(),new TestClock())){
            if(action==Command.Action.UNLOCK)apply(e,command("setup",Command.Action.LOCK,INSPECTOR,0,new TestClock()),INSPECTOR,"world","world");
            JobEngine.Result r=await(e.prepare(command("matrix",action,actor.getKey(),0,new TestClock()),actor.getKey(),"world","after"));check(allowed.get(actor.getValue()).contains(action)?r.status()==JobEngine.Status.PREPARED:r.code().equals("FORBIDDEN"),"explicit role/action policy "+actor.getValue()+" "+action);}
    }
    static void crash(Map<String,Object> p)throws Exception{
        TestClock clock=new TestClock();Path path=path();Command.Action action=Command.Action.valueOf((String)p.get("action"));Command c=command("crash",action,actor(action),0,clock);String point=(String)p.get("fault_point");
        try(JobEngine e=new JobEngine(path,config(),clock)){
            if(!point.equals("before_durable_intent")){check(await(e.prepare(c,actor(action),"before","after")).status()==JobEngine.Status.PREPARED,"intent durable before simulated world boundary");
                if(!point.equals("after_intent_before_mutation")){check(e.consumePrepared(c.operationId(),actor(action),"before").status()==JobEngine.Status.AUTHORIZED,"native permit consumed before observed effect");
                    if(point.equals("after_receipt_before_acknowledgement"))await(e.complete(c.operationId(),"after"));}}
        }
        boolean partial=point.contains("inventory_change_before_world")||point.contains("world_change_before_inventory");String observed=partial?"partial":point.equals("before_durable_intent")||point.equals("after_intent_before_mutation")?"before":"after";
        try(JobEngine e=new JobEngine(path,config(),clock)){check(e.state().quarantined(),"reopen starts quarantined");JobEngine.Result r=await(e.reconcile(observed));
            if(partial){check(r.status()==JobEngine.Status.RECONCILIATION_REQUIRED&&e.state().revision()==0,"partial abstract observation quarantines without replay");check(e.lookup(c,actor(action)).status()==JobEngine.Status.RECONCILIATION_REQUIRED,"unknown effect cannot authorize retry");}
            else if(point.equals("before_durable_intent")){check(e.lookup(c,actor(action))==null,"never-durable intent is not invented");check(e.state().revision()==0,"no recorded mutation");}
            else if(point.equals("after_intent_before_mutation")){check(r.code().equals("PROVED_NOT_APPLIED"),"before observation proves no effect");check(e.lookup(c,actor(action)).code().equals("RECORDED_NOT_APPLIED"),"same operation stays terminal not-applied");}
            else{check(e.lookup(c,actor(action)).status()==JobEngine.Status.REPLAY,"after observation/recovered receipt replays only");check(e.state().revision()==(c.structural()?1:0),"recovery advances structural revision exactly once");}}
    }
    static void lockRace(Map<String,Object> p)throws Exception{
        TestClock clock=new TestClock();Command.Action first=Command.Action.PLACE,second=Command.Action.PLACE;
        String race=(String)p.get("race");if(race.equals("two_inspections"))first=second=Command.Action.INSPECT;
        else if(race.equals("edit_vs_lock")){if(p.get("deterministic_first").equals("lock"))first=Command.Action.LOCK;else second=Command.Action.LOCK;}
        else if(race.equals("inspection_vs_inflight_building")){if(p.get("first").equals("inspection"))first=Command.Action.INSPECT;else second=Command.Action.INSPECT;}
        Command a=command("first",first,actor(first),0,clock),b=command("second",second,actor(second),0,clock);
        if("different_targets".equals(p.get("target_relation"))){Map<String,Object> q=envelope(second,actor(second));q.put("operationId","second");Map<String,Object> position=params(second);position.put("x",1L);q.put("params",position);b=Command.parse(q);}
        try(JobEngine e=new JobEngine(path(),config(),clock)){check(await(e.prepare(a,actor(first),"world","after")).status()==JobEngine.Status.PREPARED,"first contender owns durable slot");check(await(e.prepare(b,actor(second),"world","other")).code().equals("BUSY"),"competing prepared operation denied");e.consumePrepared(a.operationId(),actor(first),"world");await(e.complete(a.operationId(),"after"));JobEngine.Result r=await(e.prepare(b,actor(second),"after","other"));check(r.code().equals(a.structural()?"STALE_REVISION":"LOCKED"),"serialized second contender rechecks actual revision/lock");check(e.state().revision()==(a.structural()?1:0),"no second revision");}
    }
    static void revision(Map<String,Object> p)throws Exception{
        TestClock clock=new TestClock();Path path=path();String target=(String)p.get("target_class");
        try(JobEngine e=new JobEngine(path,config(),clock)){inspect(e,clock);InspectionReport old=report("old",0,1000,JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS,rows());await(e.finishInspection(old,INSPECTOR,"world"));clock.now=6000;
            apply(e,command("release",Command.Action.UNLOCK,INSPECTOR,0,clock),INSPECTOR,"world","world");apply(e,command("edit",Command.Action.BREAK,BUILDER,0,clock),BUILDER,"world","changed");
            Map<String,Object> q=envelope(Command.Action.PLACE,BUILDER);q.put("operationId","restore");q.put("expectedRevision",1L);q.put("expiresAtMs",11000L);Map<String,Object> block=params(Command.Action.PLACE);block.put("state",target.equals("lever")?"minecraft:lever[face=wall,facing=east,powered=false]":target.equals("circuit")?"minecraft:redstone_wire[power=0]":"minecraft:stone_bricks");q.put("params",block);
            apply(e,Command.parse(q),BUILDER,"changed","world");check(e.state().revision()==2,"restored supplied shape preserves two revisions");check(e.validateReport("old").code().equals("REPORT_REVISION"),"revision rejection independent of expiry");apply(e,command("inspect-restored",Command.Action.INSPECT,INSPECTOR,2,clock),INSPECTOR,"world","world");check(await(e.finishInspection(report("new",2,6000,JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS,rows()),INSPECTOR,"world")).code().equals("READY_FOR_REVIEW"),"new complete supplied observations required");check(e.validateReport("old").code().equals("REPORT_REVISION"),"new readiness never revives original evidence");}
    }
    static void lockRecovery(Map<String,Object> p)throws Exception{
        TestClock clock=new TestClock();Path path=path();boolean review=p.get("lock_phase").equals("review");
        try(JobEngine e=new JobEngine(path,config(),clock)){inspect(e,clock);if(review)await(e.finishInspection(report("pass",0,1000,JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS,rows()),INSPECTOR,"world"));}
        if(p.containsKey("durable_lock_record_fault")){byte[] bytes=Files.readAllBytes(path);if(p.get("durable_lock_record_fault").equals("truncated"))bytes=java.util.Arrays.copyOf(bytes,bytes.length-1);else bytes[bytes.length/2]^=1;Files.write(path,bytes);byte[] expected=bytes;rejects(()->{try(JobEngine e=new JobEngine(path,config(),clock)){e.state();}},"corrupt/truncated lock journal fails closed");check(java.util.Arrays.equals(expected,Files.readAllBytes(path)),"recovery never replaces damaged evidence");}
        else try(JobEngine e=new JobEngine(path,config(),clock)){check(e.state().quarantined(),"restart before enabling authority is quarantined");Command edit=command("edit",Command.Action.BREAK,BUILDER,0,clock);check(e.lookup(edit,BUILDER).status()==JobEngine.Status.RECONCILIATION_REQUIRED,"immediate post-reopen edit denied");await(e.reconcile("world"));check(e.state().lockMode()==(review?JobEngine.LockMode.REVIEW:JobEngine.LockMode.INSPECTION),"durable protection survives replay");check(await(e.prepare(edit,BUILDER,"world","changed")).code().equals("LOCKED"),"reconciled edit still locked");}
    }
    static void retention(Map<String,Object> p)throws Exception{
        TestClock clock=new TestClock();Path path=path();List<InspectionReport.CaseResult> observed=rows();String status=(String)p.get("retained_report_status");if(status.equals("failed"))observed.set(0,new InspectionReport.CaseResult(0,0,0,1));else if(status.equals("incomplete"))observed.remove(15);InspectionReport original=report("retained",0,1000,JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS,observed);
        try(JobEngine e=new JobEngine(path,config(),clock)){inspect(e,clock);await(e.finishInspection(original,INSPECTOR,"world"));}
        try(JobEngine e=new JobEngine(path,config(),clock)){check(e.reports().size()==1,"retained original retrieved after journal reopen");check(e.reports().get(0).fields().equals(original.fields())&&e.reports().get(0).fingerprint().equals(original.fingerprint()),"canonical observation bytes/context digest unchanged");check(!e.state().readyForReview(),"reopen cannot invent readiness before reconciliation");}
    }
    static void schemaEdges()throws Exception{
        for(String field:List.of("agreementVersion","expectedRevision","expiresAtMs"))for(Object value:List.of(Double.NaN,Double.POSITIVE_INFINITY,Double.NEGATIVE_INFINITY,1.0,new java.math.BigDecimal("1.1"),BigInteger.ONE.shiftLeft(64))){Map<String,Object> q=envelope(Command.Action.PLACE,BUILDER);q.put(field,value);rejects(()->Command.parse(q),"non-integral/lossy numeric type "+field);}
        for(int count:new int[]{0,1,128,129}){Map<String,Object> items=map();for(int i=0;i<count;i++)items.put("minecraft:item_"+i,1L);Map<String,Object> q=envelope(Command.Action.DELIVER,DELIVERY);q.put("params",map("claimId","claim","items",items));if(count==0||count>128)rejects(()->Command.parse(q),"delivery item cardinality bound");else check(Command.parse(q).params().size()==2,"positive bounded item cardinality accepted");}
        TestClock maxClock=new TestClock();JobEngine.Config base=config();String maxServer="s".repeat(64),maxJob="j".repeat(64),maxAuth="a".repeat(256);
        JobEngine.Config maxConfig=new JobEngine.Config(maxServer,maxJob,1,base.bounds(),base.actors(),maxAuth,base.blueprintId(),base.testManifestId(),base.workDeadlineMs(),base.reviewDeadlineMs(),base.obligationMode(),base.localPassValidityMs());
        Map<String,Object> maxEnvelope=envelope(Command.Action.PLACE,BUILDER);maxEnvelope.put("operationId","o".repeat(128));maxEnvelope.put("serverId",maxServer);maxEnvelope.put("jobId",maxJob);maxEnvelope.put("authorizationReference",maxAuth);
        try(JobEngine e=new JobEngine(path(),maxConfig,maxClock)){check(await(e.prepare(Command.parse(maxEnvelope),BUILDER,"before","after")).status()==JobEngine.Status.PREPARED,"exact maximum identifiers pass matching receiver context");}
        for(String field:List.of("operationId","serverId","jobId","authorizationReference"))for(String invalid:List.of("with space","line\nfeed","unicode-☃","zero\u0000byte")){Map<String,Object> q=envelope(Command.Action.PLACE,BUILDER);q.put(field,invalid);rejects(()->Command.parse(q),"non-ASCII/control identifier rejected");}
        Map<String,Object> source=envelope(Command.Action.DELIVER,DELIVERY);Command immutable=Command.parse(source);@SuppressWarnings("unchecked") Map<String,Object> sourceParams=(Map<String,Object>)source.get("params");sourceParams.clear();check(immutable.params().size()==2,"caller map mutation cannot change normalized command");rejects(()->immutable.params().put("claimId","evil"),"normalized params immutable");
        for(int axis:new int[]{-1,4})for(boolean changeA:new boolean[]{true,false})rejects(()->new InspectionReport.CaseResult(changeA?axis:0,changeA?0:axis,0,0),"input domain rejects outside two-bit range");for(int out:new int[]{-1,8})rejects(()->new InspectionReport.CaseResult(0,0,0,out),"observed output rejects outside three-bit range");
    }

    static void reportStorage()throws Exception{
        TestClock clock=new TestClock();Path path=path();String marker="unique-report-storage-marker";InspectionReport original=report(marker,0,1000,JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS,rows());
        try(JobEngine e=new JobEngine(path,config(),clock)){inspect(e,clock);await(e.finishInspection(original,INSPECTOR,"world"));check(e.reports().get(0).fingerprint().equals(original.fingerprint()),"original report digest retained before byte corruption");}
        byte[] bytes=Files.readAllBytes(path),needle=marker.getBytes(java.nio.charset.StandardCharsets.UTF_8);int index=-1;
        outer:for(int i=0;i<=bytes.length-needle.length;i++){for(int j=0;j<needle.length;j++)if(bytes[i+j]!=needle[j])continue outer;index=i;break;}
        check(index>=0,"report-specific bytes found in retained durable frame");bytes[index]^=1;Files.write(path,bytes);rejects(()->{try(JobEngine e=new JobEngine(path,config(),clock)){e.state();}},"tampered retained report frame rejected before readiness");check(java.util.Arrays.equals(bytes,Files.readAllBytes(path)),"tampered report evidence never silently replaced");
    }
    static void startupClockWatermark()throws Exception{
        TestClock clock=new TestClock();Path path=path();try(JobEngine e=new JobEngine(path,config(),clock)){inspect(e,clock);await(e.finishInspection(report("pass",0,1000,JobEngine.ObligationMode.LOCAL_NO_EXTERNAL_OBLIGATIONS,rows()),INSPECTOR,"world"));clock.now=6000;check(!e.durableState().get(10,TimeUnit.SECONDS).readyForReview(),"expiry persisted before process closes");}
        clock.now=5999;try(JobEngine e=new JobEngine(path,config(),clock)){check(!e.state().readyForReview(),"lower startup clock cannot resurrect pass");check(await(e.reconcile("world")).code().equals("CLOCK_REGRESSION"),"startup highwater check fails closed before native authorization");check(e.durableState().get(10,TimeUnit.SECONDS).quarantined(),"startup regression itself durably latched");}
    }

}

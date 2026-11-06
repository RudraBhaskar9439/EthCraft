#!/usr/bin/env python3
"""Execute pure-core support for frozen P1 variants; never grants a phase/in-world pass."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import subprocess
import uuid
from datetime import datetime, timezone

ROOT=Path(__file__).resolve().parents[3]
HERE=Path(__file__).resolve().parent
COVERAGE=ROOT/'tests/inspection/coverage.json'
OUTPUT=ROOT/'.local/inspection-core-coverage'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def java(value):
    if value is None: return 'null'
    if isinstance(value,bool): return str(value).lower()
    if isinstance(value,str): return json.dumps(value,ensure_ascii=True)
    if isinstance(value,int):
        return f'{value}L' if -(2**63)<=value<2**63 else f'new java.math.BigInteger("{value}")'
    if isinstance(value,list): return 'java.util.List.of('+','.join(map(java,value))+')'
    if isinstance(value,dict):
        pairs=[]
        for key,item in value.items(): pairs.extend([java(key),java(item)])
        return 'CoreCoverageCheck.map('+','.join(pairs)+')'
    raise TypeError(value)


def category(case_id,p):
    if case_id=='P1-007': return 'actorCase'
    if case_id=='P1-008':
        if 'coordinate' in p or 'origin_axis' in p or p.get('orientation')=='identity' and 'world_position' in p:
            return 'bounds'
    if case_id=='P1-012':
        if p.get('mutation') not in {'duplicate_raw_json_key','trailing_json'} and p.get('layer')!='raw_receiving_boundary':return 'typed'
    if case_id=='P1-013':return 'replay'
    if case_id=='P1-014':return 'crash'
    if case_id=='P1-015':return 'lockRace'
    if case_id=='P1-016' and p.get('race')!='authorized_inspector_unlock_vs_active_checker_then_builder_edit':return 'lockRace'
    if case_id=='P1-019':return 'revision'
    if case_id=='P1-022' and p.get('fault')=='backend_restart':return 'retention'
    if case_id=='P1-018' and p.get('action') in {'BREAK','REPAIR','UNLOCK'}:return 'review'
    if case_id=='P1-020':
        if 'expiry' in p or 'authority_completion_ms_relative_to_work_deadline' in p:return 'expiry'
        if 'fault' in p:return 'clockCase'
        if 'restart' in p or p.get('durable_lock_record_fault') in {'truncated','corrupt'}:return 'lockRecovery'
    if case_id=='P1-021':
        if p.get('tamper')=='report_bytes_after_storage':return 'reportStorage'
        if p.get('source_run_status') not in {'timeout','cancelled'} and p.get('tamper')!='report_bytes_after_storage':return 'reportCase'
    return None


CORE_REMAINING={
'crash':['Real process termination at specified native inventory/world windows; supplied effect strings are not observations'],
'lockRace':['Concurrent network dispatch and actual serialized Paper-thread mutation/checker ownership'],
'revision':['Physical lever/circuit/support edits and full actual lamp observations in the new inspection'],
'lockRecovery':['Actual server/process restart, lock marker recovery and unchanged physical world/inventory'],
'retention':['Actual source report and backend/projected read retrieval; local core reopen is only storage protocol support'],
'actorCase':['Live authenticated player/session assignment, direct Paper refusal and unchanged real world/inventory'],
'bounds':['Native mutation/item consumption at translated target; world min/max height and supported transform enforcement'],
'replay':['Actual item charge/world effect exactly once, authenticated network response and real process fault windows'],
'review':['Physical controls/circuit/support/lamp identity, unchanged native world/inventory and requester toggle observations'],
'expiry':['Real pinned-world lock and edit response at each controlled authority boundary; checker monotonic elapsed timing'],
'clockCase':['Pinned server process recovery and native edit response; monotonic checker timeout under wall-clock reversal'],
'reportStorage':['Physical source report, transport digest/attestation validation; core test flips actual retained journal bytes only'],
'reportCase':['Original report from an actual complete/incomplete/faulted Minecraft inspection; attestation/publication boundary'],
}


def main():
    global OUTPUT
    OUTPUT=OUTPUT/'runs'/(datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')+'-'+uuid.uuid4().hex[:8])
    coverage=json.loads(COVERAGE.read_text());variants=[];calls=[]
    for case in coverage['cases']:
        for variant in case['variants']:
            kind=category(case['case_id'],variant['parameters'])
            entry={'variant_id':variant['variant_id'],'case_id':case['case_id'],'case_digest':case['case_digest'],
                   'canonical_phase_result':'NOT_CLAIMED_BY_PURE_CORE',
                   'core_support':{'status':'NOT_APPLICABLE_OR_OUTSIDE_CORE' if kind is None else 'NOT_EXECUTED',
                                   'check_method':None if kind is None else 'CoreCoverageCheck.'+kind},
                   'remaining_evidence':CORE_REMAINING.get(kind,['Native world/stock/control observations, transport/checker/projection behavior or external lifecycle evidence required by the frozen variant'])}
            if kind=='typed':entry['remaining_evidence']=['Raw JSON decoding, duplicate keys/size limits and physical receiving-boundary evidence remain outside typed core']
            if case['case_id']=='P1-013' and variant['parameters'].get('change_field')=='actorId':entry['remaining_evidence'].append('Generic nondisclosing transport rejection audit required; core deliberately emits no owner-linked collision audit for actor mismatch')
            if kind:
                calls.append('CoreCoverageCheck.run('+java(variant['variant_id'])+', '+('CoreCoverageCheck::reportStorage' if kind=='reportStorage' else '() -> CoreCoverageCheck.'+kind+'('+java(variant['parameters'])+')')+');')
            variants.append(entry)
    calls.append('CoreCoverageCheck.run("supplemental/full-actor-action-matrix", CoreCoverageCheck::actorMatrix);')
    calls.append('CoreCoverageCheck.run("supplemental/strict-schema-edges", CoreCoverageCheck::schemaEdges);')
    calls.append('CoreCoverageCheck.run("supplemental/startup-clock-watermark", CoreCoverageCheck::startupClockWatermark);')
    OUTPUT.mkdir(parents=True,exist_ok=True)
    generated=OUTPUT/'GeneratedCoreCoverage.java'
    generated.write_text('package org.agentcity.core;\npublic final class GeneratedCoreCoverage { public static void main(String[] args) throws Exception {\n'+ '\n'.join(calls)+'\nCoreCoverageCheck.finish(java.nio.file.Path.of(args[0]));\n}}\n')
    version=json.loads((ROOT/'tests/compatibility/versions.json').read_text())
    base=['docker','run','--rm','--network','none','--user',f'{os.getuid()}:{os.getgid()}',
          '--mount',f'type=bind,src={ROOT},dst=/repo,readonly','--mount',f'type=bind,src={OUTPUT},dst=/output',version['java_image']]
    sources=[*sorted((ROOT/'plugin/src/main/java/org/agentcity/core').glob('*.java')),
             *sorted(HERE.glob('*.java'))]
    compile_result=subprocess.run(base+['javac','--release','21','-Xlint:all','-d','/output/classes']+
                                  ['/repo/'+str(p.relative_to(ROOT)) for p in sources]+['/output/GeneratedCoreCoverage.java'],capture_output=True,text=True)
    (OUTPUT/'compile.log').write_text(compile_result.stdout+compile_result.stderr)
    if compile_result.returncode:
        raise RuntimeError('Core compile failed; '+str(OUTPUT/'compile.log')+'\n'+compile_result.stderr)
    baseline=subprocess.run(base+['java','-cp','/output/classes','org.agentcity.core.CoreSelfCheck'],capture_output=True,text=True)
    (OUTPUT/'baseline.log').write_text(baseline.stdout+baseline.stderr)
    executed=subprocess.run(base+['java','-cp','/output/classes','org.agentcity.core.GeneratedCoreCoverage','/output/results.json'],capture_output=True,text=True)
    (OUTPUT/'execution.log').write_text(executed.stdout+executed.stderr)
    report=json.loads((OUTPUT/'results.json').read_text()) if (OUTPUT/'results.json').exists() else {'status':'fail','results':[]}
    by_id={r['check_id']:r for r in report['results']}
    for entry in variants:
        result=by_id.get(entry['variant_id'])
        if result:entry['core_support'].update({'status':result['status'].upper(),'assertions':result['assertions']})
    files=[COVERAGE,*sources,HERE/'run_coverage.py',generated,ROOT/'tests/compatibility/versions.json']
    hashes={str(p.relative_to(ROOT)):sha(p) for p in files}
    meta={'recorded_at':datetime.now(timezone.utc).isoformat(),'java_image':version['java_image'],
          'compiler_release':21,'run_directory':str(OUTPUT.relative_to(ROOT)),'invocation':'python3 tests/inspection/core/run_coverage.py','network':'none','source_bind':'readonly','compile_exit':compile_result.returncode,
          'compiler_output_bytes':len(compile_result.stdout+compile_result.stderr),
          'baseline_exit':baseline.returncode,'generated_exit':executed.returncode,'input_sha256':hashes,
          'scope':'PURE CORE SUPPORT ONLY. Synthetic observed effects. No Minecraft/native/HTTP/chain/participant proof. No phase case is passed by these checks.'}
    mapping={'schema':'agentcity-p1-core-coverage-v1','frozen_variant_total':len(variants),'frozen_coverage_sha256':sha(COVERAGE),
             'executed_support_variants':sum(x['core_support']['status']=='PASS' for x in variants),
             'unexecuted_or_outside_core':sum(x['core_support']['status']!='PASS' for x in variants),
             'canonical_variants_passed_by_this_mapping':0,'execution':meta,'variants':variants}
    (HERE/'coverage-mapping.json').write_text(json.dumps(mapping,indent=2)+'\n')
    evidence={'schema':'agentcity-p1-core-execution-v1','status':'pass' if baseline.returncode==0 and executed.returncode==0 else 'fail',
              'execution':meta,'baseline_output':baseline.stdout.strip(),'generated':report,
              'unmet_pure_core_domains':['Raw JSON duplicate/trailing/byte checks are owned by HTTP transport, outside Command.parse(Map)',
                  'Coordinate transformations and pinned world-height enforcement are Paper adapter responsibilities',
                  'Core has no active-checker cancellation ownership; Paper must refuse/abort inspection before UNLOCK',
                  'InspectionReport records row results but cannot establish their physical source or distinguish checker timeout/cancellation origins',
                  'Core knows no live auth session/name, physical stock provenance, actual block effects, publication projection, or external settlement finality',
                  'Entire journal deletion is not detectable by standalone core; Paper initialized-job marker must prevent a fresh authority reset',
                  'A durable append failure after native consumption is fail-closed in implementation but has no dedicated injected receipt-write failure in these pure suites'],
              'supplemental_suite_domains':['All 60 role/action pairs','Disk reserve threshold minus1/exact/plus1 and failing space probe',
                  'Local-only pass lifetime/release/edit-restore/new inspection versus external obligations',
                  'Config drift, journal corruption/truncation/semantic audit corruption and exclusive writer',
                  'Report obligation-mode binding and per-report validity independent from newer reports']}
    (HERE/'coverage-results.json').write_text(json.dumps(evidence,indent=2)+'\n')
    (OUTPUT/'evidence.json').write_text(json.dumps(evidence,indent=2)+'\n')
    (OUTPUT/'coverage-mapping.json').write_text(json.dumps(mapping,indent=2)+'\n')
    print(json.dumps({'status':evidence['status'],'frozen_variants':len(variants),'pure_support_variants_passed':mapping['executed_support_variants'],
                      'canonical_phase_cases_passed':0,'checks':report.get('checks'),'assertions':report.get('assertions')}))
    if evidence['status']!='pass':
        for row in report['results']:
            if row['status']=='fail':print(json.dumps(row))
        raise SystemExit(1)

if __name__=='__main__':main()

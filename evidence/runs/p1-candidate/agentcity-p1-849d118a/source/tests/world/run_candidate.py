"""Run actual Paper candidate observations; never promote a blueprint or phase gate."""

import argparse
import hashlib
import importlib.util
import json
import os
import random
from pathlib import Path
import shutil
import socket
import time
from datetime import datetime, timezone
import uuid

ROOT = Path(__file__).resolve().parents[2]
HERE = ROOT / 'tests/world'
spec = importlib.util.spec_from_file_location('p0_runtime', ROOT / 'tests/compatibility/run.py')
p0 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p0)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def plan(adapter, suite='normal'):
    source = ROOT / 'fixtures/candidates/redstone-compiler'
    blueprint = json.loads((source / 'calculator-candidate-v1.json').read_text())
    tests = json.loads((source / 'calculator-tests-candidate-v1.json').read_text())
    cases = tests['cases']
    assert len(cases) == 16 and {(c['a'], c['b']) for c in cases} == {(a,b) for a in range(4) for b in range(4)}
    assert all(c['expected'] == c['a'] + c['b'] for c in cases)
    assert len(blueprint['placements']) == 144
    for placement in blueprint['placements']:
        x,y,z = placement['position']
        assert 0 <= x <= 13 and 0 <= y <= 9 and -1 <= z <= 2
    carry = next(p for p in blueprint['placements'] if p['position'] == next(o['source_position'] for o in blueprint['outputs'] if o['weight'] == 4))
    assert adapter in ['native_click','native_engine','bukkit_setter']
    suites = [{'name':'normal','mutation':'none','cases':cases,'expected_pass_count':16}]
    if suite == 'fault-repair':
        suites += [{'name':'carry_fault','mutation':'remove_carry','cases':cases,'expected_pass_count':10},
                   {'name':'restored','mutation':'restore_carry','cases':cases,'expected_pass_count':16}]
    elif suite == 'transitions':
        suites = []
        for from_a in range(4):
            for from_b in range(4):
                batch = [dict(c, from_a=from_a, from_b=from_b) for c in cases]
                suites.append({'name':f'transitions-from-{from_a}-{from_b}','mutation':'none','cases':batch,'expected_pass_count':16})
    elif suite == 'orders':
        shuffled = [dict(c) for c in cases]
        random.Random(20261029).shuffle(shuffled)
        alternating = [c for pair in zip(cases[:8], reversed(cases[8:])) for c in pair]
        suites += [{'name':'descending','mutation':'none','cases':list(reversed(cases)),'expected_pass_count':16},
                   {'name':'alternating','mutation':'none','cases':alternating,'expected_pass_count':16},
                   {'name':'seeded-20261029','mutation':'none','cases':shuffled,'expected_pass_count':16}]
    else:
        assert suite == 'normal'
    return {'purpose':'isolated_physical_candidate_test', 'input_adapter':adapter,'placements':blueprint['placements'],
            'inputs':blueprint['inputs'],'outputs':blueprint['outputs'],'carry_source':carry,
            'reset_ticks':40,'settle_ticks':40,'stable_ticks':5,
            'sources':{str(p.relative_to(ROOT)):sha(p) for p in [source/'calculator-candidate-v1.json',source/'calculator-tests-candidate-v1.json',HERE/'plugin/CandidatePlugin.java',HERE/'plugin/plugin.yml',HERE/'observe.cjs',HERE/'run_candidate.py',ROOT/'tests/compatibility/versions.json']},
            'suites':suites}


def run(adapter, suite='normal'):
    lock = json.loads((ROOT/'tests/compatibility/versions.json').read_text())
    p0.validate_versions(lock)
    name = 'agentcity-p1-'+uuid.uuid4().hex[:8]
    server = ROOT/'.local/world'/name
    server.mkdir(parents=True)
    evidence = ROOT/'evidence/runs/p1-candidate'/name
    evidence.mkdir(parents=True)
    config = plan(adapter, suite)
    config_bytes = (json.dumps(config,indent=2)+'\n').encode()
    (server/'candidate-run.json').write_bytes(config_bytes)
    (evidence/'candidate-run.json').write_bytes(config_bytes)
    for filename in config['sources']:
        snapshot = evidence/'source'/filename
        snapshot.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(ROOT/filename,snapshot)
    result = {'schema':'agentcity.p1.candidate-run.v1','status':'fail','name':name,'started_at':datetime.now(timezone.utc).isoformat(),
              'manifest_sha256':hashlib.sha256(config_bytes).hexdigest(),'sources':config['sources'],'runtime_lock':lock,
              'independent_humans':0,'full_phase_gate_passed':False}
    attempted = False
    try:
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            probe.bind(('127.0.0.1',25577))
        cache = ROOT/'.local/compatibility/server'
        if sha(cache/'paper.jar') != lock['paper']['sha256']:
            raise ValueError('Cached Paper hash differs from reviewed artifact.')
        for directory in ['libraries','versions','cache']:
            shutil.copytree(cache/directory,server/directory)
        shutil.copyfile(cache/'paper.jar',server/'paper.jar')
        (server/'plugins').mkdir()
        classes = server/'candidate-classes'
        classes.mkdir()
        classpath = ':'.join('/server/'+str(p.relative_to(server)) for p in sorted([*server.glob('libraries/**/*.jar'),*server.glob('versions/**/*.jar')]))
        base = ['docker','run','--rm','--network','none','--user',f'{os.getuid()}:{os.getgid()}',
                '--mount',f'type=bind,src={server},dst=/server','--mount',f'type=bind,src={HERE / "plugin"},dst=/source,readonly',lock['java_image']]
        p0.command(base+['javac','--release','21','-cp',classpath,'-d','/server/candidate-classes','/source/CandidatePlugin.java'],timeout=60,log_path=evidence/'compile.log')
        shutil.copyfile(HERE/'plugin/plugin.yml',classes/'plugin.yml')
        (server/'candidate-manifest.mf').write_text('Manifest-Version: 1.0\npaperweight-mappings-namespace: mojang\n\n')
        p0.command(base+['jar','--create','--manifest','/server/candidate-manifest.mf','--file','/server/plugins/AgentCityCandidateFixture.jar','-C','/server/candidate-classes','.'],timeout=30,log_path=evidence/'package.log')
        result['plugin_sha256']=sha(server/'plugins/AgentCityCandidateFixture.jar')
        (server/'eula.txt').write_text('# Owner-requested isolated local development.\neula=true\n')
        (server/'server.properties').write_text(p0.server_properties().replace('level-name=compatibility-world',f'level-name={name}'))
        attempted = True
        p0.command(['docker','run','--detach','--name',name,'--label','agentcity.candidate=true','--publish','127.0.0.1:25577:25565',
                    '--mount',f'type=bind,src={server},dst=/server','--workdir','/server','--user',f'{os.getuid()}:{os.getgid()}',
                    '--memory','2g','--cpus','2',lock['java_image'],'java','-Xms512M','-Xmx1536M','-Dagentcity.candidate.fixture=true','-jar','paper.jar','--nogui'],
                   timeout=90,log_path=evidence/'start.log')
        deadline = time.monotonic()+180
        while time.monotonic() < deadline:
            logs=p0.command(['docker','logs',name],check=False,timeout=10,log_path=evidence/'server.log')
            state=p0.command(['docker','inspect','--format','{{.State.Running}}',name],check=False,timeout=10,log_path=evidence/'state.log')
            if state.stdout.strip() != 'true': raise RuntimeError('Candidate Paper server stopped: '+logs.stdout[-2000:])
            if 'Done (' in logs.stdout: break
            time.sleep(1)
        else: raise TimeoutError('Candidate Paper startup exceeded 180 seconds.')
        run_seconds = 180 * len(config['suites'])
        env=dict(os.environ,AC_WORLD_PORT='25577',AC_WORLD_REPORT=str(evidence/'client-result.json'),AC_WORLD_TIMEOUT_SECONDS=str(run_seconds))
        p0.command(['node',str(HERE/'observe.cjs')],timeout=run_seconds+15,env=env,log_path=evidence/'observer.log')
        shutil.copyfile(server/'candidate-result.json',evidence/'server-result.json')
        physical=json.loads((evidence/'server-result.json').read_text())
        client=json.loads((evidence/'client-result.json').read_text())
        assert physical['status'] == client['status'] == 'pass'
        assert len(client['observations']) == sum(len(s['cases']) for s in config['suites'])
        assert all(actual['passed_count'] == expected['expected_pass_count'] for actual,expected in zip(physical['suites'],config['suites'],strict=True))
        result['status']='pass'
    except Exception as error:
        result['error']=str(error)
        raise
    finally:
        for source, target in [('candidate-result.json','server-result.json'),('candidate-cases.jsonl','server-cases.jsonl')]:
            if (server/source).is_file():
                try:
                    shutil.copyfile(server/source,evidence/target)
                except OSError as error:
                    result['status']='fail'
                    result.setdefault('evidence_errors',[]).append(str(error))
        if attempted:
            errors,removed=p0.cleanup_container(name,evidence,'final-server')
            if errors or not removed:
                result['status']='fail'
                result['cleanup_errors']=errors or ['Owned candidate container removal not established.']
        result['finished_at']=datetime.now(timezone.utc).isoformat()
        (evidence/'run-report.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps({'status':result['status'],'evidence':str(evidence.relative_to(ROOT)),'error':result.get('error')}),flush=True)
    if result['status'] != 'pass': raise RuntimeError('Candidate cleanup failed.')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--adapter',choices=['native_click','native_engine','bukkit_setter'],default='native_engine')
    parser.add_argument('--suite',choices=['normal','fault-repair','transitions','orders'],default='normal')
    args=parser.parse_args()
    run(args.adapter,args.suite)

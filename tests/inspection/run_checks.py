"""Run core/parser/mapping checks in the exact P0 Java environment; not a world gate."""
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import uuid

ROOT=Path(__file__).resolve().parents[2]

def main():
    spec=importlib.util.spec_from_file_location('inspection_build',ROOT/'tests/inspection/build.py')
    builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
    run=ROOT/'evidence/runs/p1-core'/('run-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:6])
    run.mkdir(parents=True)
    sources=sorted([*ROOT.glob('plugin/src/**/*'),*ROOT.glob('tests/inspection/paper/*'),*ROOT.glob('tests/inspection/core/*'),ROOT/'tests/inspection/build.py',Path(__file__).resolve(),ROOT/'tests/compatibility/versions.json'])
    hashes={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sources if p.is_file()}
    result={'status':'fail','scope':'Java core/parser/mapping checks only; no live world, full phase approval or bot construction claimed','source_sha256':hashes,'checks':[]}
    try:
        _,base,cp=builder.build()
        for label,command in [('java-version',['java','-version']),('core',['java','-ea','-cp',cp+':/output/classes:/output/checks','org.agentcity.core.CoreSelfCheck']),('strict-json',['java','-ea','-cp',cp+':/output/classes:/output/checks','org.agentcity.paper.StrictJsonCheck']),('mapping',['java','-ea','-cp',cp+':/output/classes:/output/checks','org.agentcity.paper.InspectorMappingCheck'])]:
            completed=subprocess.run(base+command,capture_output=True,text=True,timeout=90)
            (run/(label+'.log')).write_text(completed.stdout+completed.stderr)
            result['checks'].append({'name':label,'exit_code':completed.returncode,'output':completed.stdout+completed.stderr})
            if completed.returncode:raise RuntimeError(label+' failed')
        if any(hashlib.sha256((ROOT/p).read_bytes()).hexdigest()!=h for p,h in hashes.items()):raise RuntimeError('Source changed during run; repeat after edits settle.')
        result['status']='pass'
    except Exception as error:
        result['error']=str(error)
        raise
    finally:
        for label in ['compile.log','compile-checks.log','package.log']:
            if (builder.OUTPUT/label).exists():shutil.copyfile(builder.OUTPUT/label,run/label)
        (run/'report.json').write_text(json.dumps(result,indent=2)+'\n')
        print(str(run.relative_to(ROOT)),result['status'])
        for check in result['checks']:print(check['name'],check['exit_code'],check['output'].strip())

if __name__=='__main__':main()

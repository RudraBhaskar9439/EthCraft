import copy
import hashlib
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from check_phase import artifact_errors, case_digest, phase_errors, release_errors


class PhaseGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.phase = {'id':'P0','dependencies':[],'implementation_paths':['plugin/']}
        self.case = {'id':'P0-001','phase':'P0','expected':'real observed result','minimum_subcases':16}
        self.write('planning/phases.json',[self.phase])
        self.write('planning/scope.json',{'shared_implementation_paths':['backend/package.json','backend/src/shared/']})
        self.write('planning/verification.json',[self.case])
        (self.root/'result.json').write_text('{"fixture":"unit test only"}')
        artifact = {'path':'result.json','sha256':hashlib.sha256((self.root/'result.json').read_bytes()).hexdigest()}
        self.record = {'phase':'P0','release':'a'*40,'environment':'isolated test fixture','open_defects':[],
                       'review':{'status':'approved','reviewer':'test reviewer','release':'a'*40,'evidence':[artifact]},
                       'cases':{'P0-001':{'status':'pass','case_digest':case_digest(self.case),'evidence':[artifact],
                                          'subcases':{'required':16,'passed':16,'failed':0,'blocked':0}}}}

    def write(self,path,data):
        target=self.root/path
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text(json.dumps(data))

    def errors(self):
        self.write('evidence/P0.json',self.record)
        return phase_errors(self.root,'P0',revision_check=lambda *args: [])

    def test_complete_record_passes(self):
        self.assertEqual([],self.errors())

    def test_nonpassing_statuses_block(self):
        for status in ['not_run','fail','blocked','PASS','']:
            with self.subTest(status=status):
                self.record['cases']['P0-001']['status']=status
                self.assertTrue(self.errors())

    def test_missing_or_unknown_cases_block(self):
        self.record['cases']['extra']=copy.deepcopy(self.record['cases']['P0-001'])
        self.assertTrue(self.errors())
        self.record['cases']={}
        self.assertTrue(self.errors())

    def test_changed_case_invalidates_evidence(self):
        self.case['expected']='different behavior'
        self.write('planning/verification.json',[self.case])
        self.assertTrue(self.errors())

    def test_evidence_required_and_hash_checked(self):
        self.record['cases']['P0-001']['evidence']=[]
        self.assertTrue(self.errors())
        self.record['cases']['P0-001']['evidence']=[{'path':'result.json','sha256':'0'*64}]
        self.assertTrue(self.errors())

    def test_empty_missing_and_escaping_artifact_block(self):
        (self.root/'empty').touch()
        for path in ['empty','missing','../outside','/tmp/absolute']:
            with self.subTest(path=path):
                self.assertTrue(artifact_errors(self.root,[{'path':path,'sha256':'0'*64}],'case'))

    def test_subcase_counts_must_complete_declared_domain(self):
        for coverage in [{'required':15,'passed':15,'failed':0,'blocked':0},
                         {'required':16,'passed':15,'failed':1,'blocked':0},
                         {'required':16,'passed':16,'failed':0,'blocked':1},
                         {'required':16,'passed':16,'failed':False,'blocked':0},
                         {'required':True,'passed':True,'failed':0,'blocked':0},
                         {'required':None,'passed':0,'failed':0,'blocked':0}]:
            with self.subTest(coverage=coverage):
                self.record['cases']['P0-001']['subcases']=coverage
                self.assertTrue(self.errors())

    def test_review_and_release_must_match(self):
        self.record['review']['release']='b'*40
        self.assertTrue(self.errors())
        self.record['review']['release']=self.record['release']
        self.record['review']['status']='pending'
        self.assertTrue(self.errors())
        self.record['review']['status']='approved'
        self.record['review']['reviewer']=' '
        self.assertTrue(self.errors())

    def test_open_defect_blocks(self):
        self.record['open_defects']=['unsafe delivery']
        self.assertTrue(self.errors())

    def test_missing_environment_blocks(self):
        self.record['environment']=None
        self.assertTrue(self.errors())

    def test_predecessor_blocks_even_when_current_passes(self):
        self.write('evidence/P0.json',self.record)
        phase1={'id':'P1','dependencies':['P0'],'implementation_paths':['bot/']}
        case1={'id':'P1-001','phase':'P1','expected':'bot result','minimum_subcases':16}
        self.write('planning/phases.json',[self.phase,phase1])
        self.write('planning/verification.json',[self.case,case1])
        record1=copy.deepcopy(self.record)
        record1['phase']='P1'
        record1['cases']={'P1-001':record1['cases'].pop('P0-001')}
        record1['cases']['P1-001']['case_digest']=case_digest(case1)
        self.write('evidence/P1.json',record1)
        self.assertEqual([],phase_errors(self.root,'P1',revision_check=lambda *args: []))
        self.record['cases']['P0-001']['status']='fail'
        self.write('evidence/P0.json',self.record)
        self.assertIn('P0 is not ready',phase_errors(self.root,'P1',revision_check=lambda *args: []))

    def test_unknown_phase_and_cycle_fail_closed(self):
        self.assertTrue(phase_errors(self.root,'P99',revision_check=lambda *args: []))
        self.phase['dependencies']=['P0']
        self.write('planning/phases.json',[self.phase])
        self.assertTrue(self.errors())

    def test_invalid_release_is_refused(self):
        for release in [None,'main','a'*39,'G'*40]:
            self.assertTrue(release_errors(self.root,self.phase,release))

    def test_release_history_and_changed_scope(self):
        def git(*args):
            return subprocess.run(['git',*args],cwd=self.root,check=True,capture_output=True,text=True).stdout.strip()
        def commit():
            git('add','.')
            git('-c','user.name=Phase Gate Test','-c','user.email=test@example.invalid','commit','-m','Isolated test fixture')
            return git('rev-parse','HEAD')
        git('init','-b','main')
        (self.root/'plugin').mkdir()
        (self.root/'plugin/world.txt').write_text('approved fixture')
        approved=commit()
        self.assertEqual([],release_errors(self.root,self.phase,approved))
        (self.root/'unrelated.txt').write_text('outside approved phase scope')
        commit()
        self.assertEqual([],release_errors(self.root,self.phase,approved))
        (self.root/'backend').mkdir()
        (self.root/'backend/package.json').write_text('{"dependency":"changed"}')
        self.assertTrue(release_errors(self.root,self.phase,approved),'Untracked shared dependency must reopen evidence')
        commit()
        self.assertTrue(release_errors(self.root,self.phase,approved),'Committed dependency must reopen evidence')
        approved=git('rev-parse','HEAD')
        self.assertEqual([],release_errors(self.root,self.phase,approved))
        (self.root/'plugin/world.txt').write_text('uncommitted changed implementation')
        self.assertTrue(release_errors(self.root,self.phase,approved))
        commit()
        self.assertTrue(release_errors(self.root,self.phase,approved))
        self.assertTrue(release_errors(self.root,self.phase,'f'*40))


if __name__=='__main__':
    unittest.main()

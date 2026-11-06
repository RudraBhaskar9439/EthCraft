import copy
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
SPEC=importlib.util.spec_from_file_location('compatibility',ROOT/'tests/compatibility/run.py')
compatibility=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compatibility)


class CompatibilitySafetyTests(unittest.TestCase):
    def setUp(self):
        self.lock=json.loads((ROOT/'tests/compatibility/versions.json').read_text())

    def test_reviewed_isolated_lock(self):
        compatibility.validate_versions(self.lock)

    def test_nonlocal_or_economic_fixture_is_refused(self):
        for field,value in [('bind','0.0.0.0'),('authentication','microsoft'),('token_integration',True),
                            ('production_supported',True),('independent_human_participants',2),('purpose','production')]:
            with self.subTest(field=field):
                lock=copy.deepcopy(self.lock)
                lock[field]=value
                with self.assertRaises(ValueError):compatibility.validate_versions(lock)

    def test_artifact_must_be_exact_official_https_object(self):
        for url in ['http://fill-data.papermc.io/anything','https://example.com/paper.jar',self.lock['paper']['url']+'?override=true']:
            with self.subTest(url=url):
                lock=copy.deepcopy(self.lock)
                lock['paper']['url']=url
                with self.assertRaises(ValueError):compatibility.validate_versions(lock)

    def test_unreviewed_version_and_mutable_runtime_refused(self):
        for field,value in [('minecraft','26.3'),('mineflayer','latest'),('java_image','eclipse-temurin:21-jdk')]:
            lock=copy.deepcopy(self.lock)
            lock[field]=value
            with self.assertRaises(ValueError):compatibility.validate_versions(lock)

    def test_offline_fixture_exposes_no_remote_admin(self):
        properties=compatibility.server_properties()
        self.assertIn('online-mode=false',properties)
        self.assertIn('enable-rcon=false',properties)
        self.assertIn('enable-query=false',properties)
        self.assertIn('enable-command-block=false',properties)

    def test_failed_command_retains_full_output_before_raising(self):
        output='complete stdout '+('x'*9000)
        error='complete stderr'
        result=subprocess.CompletedProcess(['fixture'],23,output,error)
        with tempfile.TemporaryDirectory() as temporary:
            log=Path(temporary)/'failed.log'
            with mock.patch.object(compatibility.subprocess,'run',return_value=result):
                with self.assertRaisesRegex(RuntimeError,'failed \\(23\\)'):
                    compatibility.command(['fixture'],log_path=log)
            self.assertEqual(output+error,log.read_text())

    def test_command_timeout_retains_partial_byte_output(self):
        timeout=subprocess.TimeoutExpired(['fixture'],3,output=b'partial stdout',stderr=b'partial stderr')
        with tempfile.TemporaryDirectory() as temporary:
            log=Path(temporary)/'timeout.log'
            with mock.patch.object(compatibility.subprocess,'run',side_effect=timeout):
                with self.assertRaises(subprocess.TimeoutExpired) as caught:
                    compatibility.command(['fixture'],timeout=3,log_path=log)
            self.assertIs(timeout,caught.exception)
            self.assertEqual('partial stdoutpartial stderr',log.read_text())

    def test_cleanup_attempts_removal_after_stop_and_log_failures(self):
        responses=[subprocess.TimeoutExpired(['docker','stop'],45),RuntimeError('logs unavailable'),
                   subprocess.CompletedProcess(['docker','rm'],0,'removed','')]
        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.object(compatibility,'command',side_effect=responses) as command:
                errors,removed=compatibility.cleanup_container('agentcity-p0-fixture',Path(temporary),'cleanup')
        self.assertTrue(removed)
        self.assertEqual(2,len(errors))
        self.assertEqual(['stop','logs','rm'],[call.args[0][1] for call in command.call_args_list])
        self.assertEqual(['docker','rm','--force','agentcity-p0-fixture'],command.call_args_list[-1].args[0])

    def test_missing_container_is_already_clean(self):
        missing=subprocess.CompletedProcess(['docker'],1,'','Error response from daemon: No such container: fixture')
        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.object(compatibility,'command',return_value=missing):
                errors,removed=compatibility.cleanup_container('agentcity-p0-fixture',Path(temporary),'cleanup')
        self.assertEqual([],errors)
        self.assertTrue(removed)

    def fake_spike(self, failure):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            fixture=root/'fixture'
            fixture.mkdir()
            (fixture/'versions.json').write_text(json.dumps(self.lock))
            (fixture/'package.json').write_text(json.dumps({'dependencies':{
                'mineflayer':self.lock['mineflayer'],'mineflayer-pathfinder':self.lock['pathfinder']}}))
            (fixture/'package-lock.json').write_text('{}')
            (fixture/'probe.cjs').write_text('// Mocked process; never executed.\n')
            (fixture/'plugin').mkdir()
            (fixture/'plugin/plugin.yml').write_text('name: MockFixture\n')
            cache=root/'cache'
            stop_count=0
            start_error=subprocess.TimeoutExpired(['docker','run'],90)
            def download(lock,target):
                target.write_bytes(b'mocked Paper, never executed')
                (target.parent/'libraries').mkdir()
                (target.parent/'libraries/fixture.jar').write_bytes(b'mocked classpath')
            def command(args,**kwargs):
                nonlocal stop_count
                if args[:3]==['docker','run','--detach']:
                    if failure=='start_timeout':
                        raise start_error
                    return subprocess.CompletedProcess(args,0,'mock-container-id','')
                if args[:2]==['docker','stop']:
                    stop_count+=1
                if args[0]=='docker' and args[1] in {'stop','logs','rm'}:
                    if failure=='start_timeout' or (failure=='final_cleanup' and stop_count==2):
                        raise RuntimeError('cleanup '+args[1]+' unavailable')
                    return subprocess.CompletedProcess(args,0,'Done (0.01s)!' if args[1]=='logs' else '', '')
                if args[:2]==['docker','inspect']:
                    return subprocess.CompletedProcess(args,0,'true','')
                if 'jar' in args:
                    (cache/'server/plugins/AgentCityCompatibility.jar').write_bytes(b'mock plugin')
                if args[0]=='node' and args[1]!='--version':
                    Path(kwargs['env']['AC_COMPAT_REPORT']).write_text(json.dumps({'status':'passed'}))
                return subprocess.CompletedProcess(args,0,'mock process output','')
            caught=None
            with mock.patch.multiple(compatibility,ROOT=root,FIXTURE=fixture,CACHE=cache), \
                    mock.patch.object(compatibility,'download_paper',side_effect=download), \
                    mock.patch.object(compatibility,'command',side_effect=command) as commands, \
                    mock.patch.object(compatibility.socket,'socket'), redirect_stdout(io.StringIO()):
                try:
                    compatibility.run_spike()
                except Exception as exc:
                    caught=exc
            records=list((cache/'runs').glob('*/run-report.json'))
            self.assertEqual(1,len(records),'Every attempted run must retain its report after cleanup failure')
            return json.loads(records[0].read_text()),caught,start_error,commands.call_args_list

    def test_timed_out_start_is_cleaned_and_original_error_survives(self):
        report,caught,start_error,calls=self.fake_spike('start_timeout')
        self.assertIs(start_error,caught)
        self.assertEqual('fail',report['status'])
        self.assertIn('timed out',report['error'])
        self.assertEqual(3,len(report['cleanup_errors']))
        self.assertTrue(any(call.args[0][:3]==['docker','rm','--force'] for call in calls))

    def test_cleanup_failure_cannot_report_successful_run(self):
        report,caught,_,_=self.fake_spike('final_cleanup')
        self.assertIsInstance(caught,RuntimeError)
        self.assertEqual('passed',report['probe']['status'])
        self.assertEqual('fail',report['status'])
        self.assertEqual(3,len(report['cleanup_errors']))
        self.assertIn('cleanup',report['error'].lower())


if __name__=='__main__':unittest.main()

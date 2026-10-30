"""실제 CLI JSON 형태를 쓰는 격리 시험. 실제 Orca나 에이전트는 호출하지 않는다."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

TOOL = Path(__file__).with_name('bmad-orca-control.py')
SPEC = importlib.util.spec_from_file_location('orca_control', TOOL)
MODULE = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(MODULE)
T = 1_800_000_000_000
FAKE = r'''#!/usr/bin/env python3
import json,os,sys
p=os.environ['FAKE_DATA'];data=json.load(open(p));a=sys.argv[1:-1]
with open(p+'.calls','a') as f:f.write(json.dumps(a)+'\n')
kind=a[1] if a[0] in ('orchestration','terminal') else a[0]
def option(k):return a[a.index(k)+1] if k in a else None
ok=True;result={};lost=False
if kind=='status':result={'caller': data.get('caller',{'live':True,'orcaSessionId':'caller'})}
elif kind=='run-current':result={'run':{'id':data.get('run','run'),'coordinator_handle':data.get('coordinator_handle')}}
elif kind=='show':result={'terminal':{'handle':option('--terminal'),'connected':True,'writable':True,'orphaned':False,'executionHostId':'local','incarnationId':data.get('incarnation','inc-1')}}
elif kind=='worker-list':
 pages=data.get('fleet_pages',{});cursor=option('--cursor') or 'first'
 result=pages.get(cursor,{'workers':data.get('workers',[]),'scope':{'run':'run'},'page':{'hasMore':False}})
elif kind=='worker-show':
 shows=data.get('shows')
 if shows:
  n=data.get('show_count',0);result=shows[min(n,len(shows)-1)];data['show_count']=n+1
 else:result=data['show']
elif kind=='worker-read':
 reads=data.get('reads')
 if reads:
  n=data.get('read_count',0);result=reads[min(n,len(reads)-1)];data['read_count']=n+1
 else:result=data['read']
elif kind in ('send','worker-start'):
 rid=option('--retry-request');receipts=data.setdefault('receipts',{})
 if rid in receipts:result=receipts[rid]
 else:
  data[kind+'_applied']=data.get(kind+'_applied',0)+1
  if kind=='send':result={'message':{'id':'msg-1'},'mutation':{'requestId':rid}}
  else:
   result={'runId':'run','taskId':'t','dispatchId':'d','state':'ready','effects':[{'kind':'terminal','role':'agent','id':'h'}],
           'launch':{'requested':{'agent':'codex','model':'gpt-6.1-terra','effort':'medium'},'effective':{'agent':'codex','model':'gpt-6.1-terra','effort':'medium'}}}
   data['workers']=[{'taskId':'t','dispatchId':'d','dispatchStatus':'dispatched'}]
  receipts[rid]=result
  if data.pop('lose_'+kind,False):lost=True
elif kind=='request-show':result={'state':'completed' if option('--request') in data.get('receipts',{}) else 'absent'}
elif kind=='check':
 if '--ack' in a:result=data.get('after_ack',{'runId':'run','deliveryId':None,'count':0,'messages':[]});result['acknowledged']=option('--ack')
 else:result=data.get('delivery',{'runId':'run','deliveryId':None,'count':0,'messages':[],'timedOut':True})
json.dump(data,open(p,'w'))
if lost:print('{lost');sys.exit(1)
print(json.dumps({'ok':ok,'result':result}))
'''


def message(mid='err', at=T, role='assistant', blocks=None):
    return {'id':mid,'timestamp':at,'role':role,'blocks':blocks or [{'type':'error','code':'server_overloaded'}]}


def transcript(messages=None, source='source', limited=False, cursor='eof', warnings=None):
    return {'dispatchId':'d','source':'transcript','sourceIdentity':source,'provider':'codex','cursor':cursor,
            'transcript':{'messages':messages if messages is not None else [message()], 'limited':limited,'nextCursor':cursor},
            'warnings':warnings or []}


def payload_message(mid='native', kind='status', subject='implementation-ready', extra=None):
    payload={'taskId':'t','dispatchId':'d',**(extra or {})}
    return {'id':mid,'type':kind,'subject':subject,'from_handle':'h','body':'내용',
            'payload':json.dumps(payload),'created_at':'2027-01-15T08:00:00Z'}


class ControlTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        root=Path(self.tmp.name);self.state=root/'state.json';self.fixture=root/'data.json';self.fake=root/'orca'
        self.fake.write_text(FAKE);self.fake.chmod(0o755)
        self.data={'workers':[], 'show':{'dispatch':{'id':'d','runId':'run','taskId':'t','assigneeHandle':'h','status':'dispatched'},
                   'observation':{'exactWorker':True,'status':'live','addressable':True},
                   'projection':{'liveness':{'verdict':'live'}}},'read':transcript()}
        self.write_data();self.run_tool('init','--plan','plan.md','--baseline','abc','--run','run','--caller','caller')

    def write_data(self):self.fixture.write_text(json.dumps(self.data))
    def refresh(self):self.data=json.loads(self.fixture.read_text())
    def snapshot(self):return json.loads(self.state.read_text())
    def env(self,**extra):
        env=dict(os.environ,FAKE_DATA=str(self.fixture),PYTHONDONTWRITEBYTECODE='1')
        env.pop('ORCA_AGENT_SESSION_ID',None);env.pop('ORCA_TERMINAL_HANDLE',None);env.update(extra)
        return env
    def argv(self,*args):return [sys.executable,'-B',str(TOOL),'--state',str(self.state),'--orca',str(self.fake),*args]
    def run_tool(self,*args,success=True,env=None):
        r=subprocess.run(self.argv(*args),env=env or self.env(),text=True,capture_output=True)
        self.assertEqual(r.returncode==0,success,r.stdout+r.stderr)
        return json.loads(r.stdout if success else r.stderr)
    def register(self):
        s=self.snapshot();s['workers']['implementer']={'task':'t','dispatch':'d','handle':'h'};self.state.write_text(json.dumps(s))
        self.data['workers']=[{'dispatchId':'d','taskId':'t','dispatchStatus':'dispatched'}];self.write_data()
    def calls(self):return [json.loads(x) for x in Path(str(self.fixture)+'.calls').read_text().splitlines()]
    def start(self,success=True):
        return self.run_tool('start','--role','implementer','--args',json.dumps(['--spec','task','--worktree','path:/repo','--agent','codex','--model','gpt-6.1-terra','--effort','medium']),success=success)

    def test_atomic_checkpoint_and_restore_contains_required_context(self):
        s=self.snapshot()
        self.run_tool('checkpoint','--revision',str(s['revision']),'--data',json.dumps({'stage':'review','next_action':'read findings','verification':{'unit':'passed'},'decisions':['keep same model'],'reports':{'review':'/tmp/report.md'}}))
        r=self.run_tool('restore');self.assertEqual(r['stage'],'review');self.assertEqual(r['plan'],'plan.md')
        self.assertEqual(r['verification'],{'unit':'passed'});self.assertEqual(r['decisions'],['keep same model'])
        self.assertEqual(self.state.stat().st_mode & 0o777,0o600)

    def test_shell_identity_accepts_bound_own_live_terminal(self):
        s=self.snapshot();s['caller']='own-terminal';self.state.write_text(json.dumps(s))
        self.data.update(caller=None,coordinator_handle='own-terminal');self.write_data()
        self.run_tool('restore',env=self.env(ORCA_TERMINAL_HANDLE='own-terminal'))
        self.assertEqual(self.snapshot()['caller_incarnation'],'inc-1')
        self.run_tool('restore',success=False,env=self.env(ORCA_TERMINAL_HANDLE='borrowed'))
        self.refresh();self.data['incarnation']='inc-2';self.write_data()
        self.run_tool('restore',success=False,env=self.env(ORCA_TERMINAL_HANDLE='own-terminal'))

    def test_wrong_run_and_unknown_worker_prevent_restore_and_start(self):
        self.data['run']='other';self.write_data();self.run_tool('restore',success=False)
        self.data['run']='run';self.data['workers']=[{'dispatchId':'other','dispatchStatus':'dispatched'}];self.write_data()
        self.start(success=False);self.assertFalse(any(a[1:2]==['worker-start'] for a in self.calls()))

    def test_corrupt_and_stale_checkpoint_are_not_overwritten(self):
        self.run_tool('checkpoint','--revision','0','--data','{}',success=False)
        self.state.write_text('{bad');self.run_tool('restore',success=False);self.assertEqual(self.state.read_text(),'{bad')

    def test_two_processes_cannot_overwrite_same_revision(self):
        revision=self.snapshot()['revision'];args=self.argv('checkpoint','--revision',str(revision),'--data','{"stage":"verify"}')
        ps=[subprocess.Popen(args,env=self.env(),text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE) for _ in range(2)]
        for p in ps:p.communicate(timeout=15)
        self.assertEqual(sorted(p.returncode for p in ps),[0,1]);self.assertEqual(self.snapshot()['revision'],revision+1)

    def test_valid_json_with_invalid_state_is_preserved_before_api_calls(self):
        s=self.snapshot();s['last_capacity_scan']='corrupt';raw=json.dumps(s);self.state.write_text(raw)
        before=len(self.calls());self.run_tool('restore',success=False)
        self.assertEqual(self.state.read_text(),raw);self.assertEqual(len(self.calls()),before)

    def test_raw_json_is_saved_separately_and_event_index_bounded(self):
        self.data['caller']={'live':True,'orcaSessionId':'caller','details':'x'*50000};self.write_data()
        for _ in range(18):self.run_tool('restore')
        s=self.snapshot();self.assertLessEqual(len(s['events']),32);self.assertLess(self.state.stat().st_size,20000)
        raw=Path(s['events'][-1]['file']);self.assertTrue(raw.exists());self.assertEqual(raw.stat().st_mode & 0o777,0o600)

    def test_start_response_loss_replays_same_request_without_second_worker(self):
        self.data['lose_worker-start']=True;self.write_data();self.start(success=False)
        first=self.snapshot()['requests']['start:implementer']['id']
        r=self.start();self.refresh();self.assertEqual(self.data['worker-start_applied'],1)
        self.assertEqual(self.snapshot()['requests']['start:implementer']['id'],first)
        self.assertEqual(r['workers']['implementer']['dispatch'],'d')

    def test_absent_receipt_preserves_unknown_instead_of_new_start(self):
        self.data['lose_worker-start']=True;self.write_data();self.start(success=False)
        self.refresh();self.data['receipts']={};self.write_data();self.start(success=False)
        self.refresh();self.assertEqual(self.data['worker-start_applied'],1)

    def test_model_override_and_duplicate_flags_are_refused(self):
        for options in [ ['--spec','x','--from','borrowed'],['--spec','x','--model','other'],['--spec','x','--worktree','path:/repo','--model','gpt-6.1-terra','--model','other'] ]:
            self.run_tool('start','--role','implementer','--args',json.dumps(options),success=False)
        self.assertFalse(any(a[1:2]==['worker-start'] for a in self.calls()))

    def test_capacity_is_enqueued_once_and_real_provider_progress_confirms(self):
        self.register();self.assertEqual(self.run_tool('recover','--role','implementer')['state'],'enqueued')
        self.run_tool('recover','--role','implementer');self.refresh();self.assertEqual(self.data['send_applied'],1)
        self.data['read']=transcript([message(),message('codex:session:newturn:1',T+1000,blocks=[{'type':'text','text':'working'}])]);self.write_data()
        self.assertEqual(self.run_tool('recover','--role','implementer')['state'],'recovered')

    def test_sending_or_user_pointer_is_not_claimed_as_provider_recovery(self):
        self.register();self.run_tool('recover','--role','implementer');self.refresh()
        self.data['read']=transcript([message(),message('orca:pointer',T+1000,role='user',blocks=[{'type':'text','text':'read inbox'}])]);self.write_data()
        self.assertEqual(self.run_tool('recover','--role','implementer')['state'],'enqueued')

    def test_response_loss_does_not_generate_second_resume_message(self):
        self.register();self.data['lose_send']=True;self.write_data();self.run_tool('recover','--role','implementer',success=False)
        self.run_tool('recover','--role','implementer');self.refresh();self.assertEqual(self.data['send_applied'],1)
        ids=[a[a.index('--retry-request')+1] for a in self.calls() if a[1:2]==['send']]
        self.assertEqual(len(set(ids)),1)

    def test_concurrent_recovery_sends_once(self):
        self.register();args=self.argv('recover','--role','implementer')
        ps=[subprocess.Popen(args,env=self.env(),text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE) for _ in range(2)]
        for p in ps:
            p.communicate(timeout=20);self.assertEqual(p.returncode,0)
        self.refresh();self.assertEqual(self.data['send_applied'],1)

    def test_new_capacity_turns_have_no_cumulative_retry_cap(self):
        self.register()
        for i in range(5):
            self.refresh();self.data['read']=transcript([message('error-'+str(i),T+i*1000)]);self.write_data()
            self.assertEqual(self.run_tool('recover','--role','implementer')['state'],'enqueued')
        self.refresh();self.assertEqual(self.data['send_applied'],5)

    def test_user_tool_and_plain_text_capacity_quotes_do_not_send(self):
        self.register()
        cases=[message(role='user'),message(blocks=[{'type':'tool-result','output':'server_overloaded'}]),message(blocks=[{'type':'text','text':'Selected model is at capacity. Please try a different model.'}])]
        for m in cases:
            self.data['read']=transcript([m]);self.write_data()
            self.assertEqual(self.run_tool('recover','--role','implementer')['state'],'healthy-or-already-resumed')
        self.assertFalse(any(a[1:2]==['send'] for a in self.calls()))

    def test_actual_capacity_text_is_recognized_but_usage_limit_is_not(self):
        self.register();self.data['read']=transcript([message(blocks=[{'type':'error','text':'Selected model is at capacity. Please try a different model.'}])]);self.write_data()
        self.assertEqual(self.run_tool('recover','--role','implementer')['state'],'enqueued')
        self.refresh();self.data['read']=transcript([message('limit',T+1000,blocks=[{'type':'error','code':'usage_limit_reached','text':'usage limit'}])]);self.write_data()
        self.run_tool('recover','--role','implementer');self.refresh();self.assertEqual(self.data['send_applied'],1)

    def test_incidental_clipping_does_not_hide_complete_latest_error(self):
        self.register();self.data['read']=transcript(warnings=['Oversized transcript text was clipped.']);self.write_data()
        self.assertEqual(self.run_tool('recover','--role','implementer')['state'],'enqueued')

    def test_clipped_error_itself_is_not_enough(self):
        self.register();self.data['read']=transcript([message(blocks=[{'type':'error','text':'Selected model is at capacity… (truncated)'}])]);self.write_data()
        self.assertEqual(self.run_tool('recover','--role','implementer')['state'],'unknown')

    def test_structured_error_with_clipping_metadata_is_not_used(self):
        self.register();self.data['read']=transcript([message(blocks=[{'type':'error','code':'server_overloaded','truncated':True}])]);self.write_data()
        self.assertEqual(self.run_tool('recover','--role','implementer')['state'],'unknown')

    def test_host_disappearing_before_send_prevents_input(self):
        self.register()
        other=json.loads(json.dumps(self.data['show']));other['observation']['addressable']=None
        self.data['shows']=[self.data['show'],other];self.write_data()
        self.run_tool('recover','--role','implementer',success=False)
        self.assertFalse(any(a[1:2]==['send'] for a in self.calls()))

    def test_old_native_event_does_not_hide_new_transcript_capacity(self):
        self.register();s=self.snapshot();s['workers']['implementer']['native_capacity']={'id':'old-native','at':T-1000,'request':'old','session':'session'}
        self.state.write_text(json.dumps(s))
        self.assertEqual(self.run_tool('recover','--role','implementer')['error'],'err')

    def test_settled_archived_wrong_owner_and_unknown_host_do_not_resume(self):
        self.register()
        self.data['show']['dispatch']['status']='completed';self.write_data()
        self.assertEqual(self.run_tool('recover','--role','implementer')['state'],'settled')
        self.data['show']['dispatch']['status']='dispatched';self.data['show']['dispatch']['runId']='other';self.write_data()
        self.run_tool('recover','--role','implementer',success=False)
        self.data['show']['dispatch']['runId']='run';self.data['show']['projection']['liveness']={'verdict':'unverifiable','reason':'host_unavailable'};self.write_data()
        self.run_tool('recover','--role','implementer',success=False)
        self.data['show']['projection']['liveness']={'verdict':'live'};self.data['read']['archived']=True;self.write_data()
        self.run_tool('recover','--role','implementer',success=False)
        self.assertFalse(any(a[1:2]==['send'] for a in self.calls()))

    def test_exact_local_observation_can_fill_missing_status_projection(self):
        self.register();self.data['show']['projection']['liveness']={'verdict':'unverifiable','reason':'missing_status'};self.write_data()
        self.assertEqual(self.run_tool('recover','--role','implementer')['state'],'enqueued')

    def test_newer_dispatch_for_task_prevents_resume(self):
        self.register();self.data['workers'].insert(0,{'taskId':'t','dispatchId':'new','dispatchStatus':'dispatched'});self.write_data()
        self.run_tool('recover','--role','implementer',success=False)
        self.assertFalse(any(a[1:2]==['send'] for a in self.calls()))

    def test_race_new_provider_turn_before_send_prevents_resume(self):
        self.register();self.data['reads']=[transcript(),transcript([message(),message('codex:s:new:1',T+1000,blocks=[{'type':'text','text':'working'}])])];self.write_data()
        self.assertEqual(self.run_tool('recover','--role','implementer')['state'],'already-resumed')
        self.assertFalse(any(a[1:2]==['send'] for a in self.calls()))

    def test_transcript_cursor_and_source_change_are_checkpointed(self):
        self.register();self.data['reads']=[transcript([message(role='user')],limited=True,cursor='page-2'),transcript([message()],cursor='end')];self.write_data()
        self.assertEqual(self.run_tool('recover','--role','implementer')['state'],'enqueued')
        self.assertTrue(any('--cursor' in a and 'page-2' in a for a in self.calls()))
        self.refresh();self.data.pop('reads');self.data['read']=transcript(source='different');self.write_data()
        self.run_tool('recover','--role','implementer',success=False)
        self.assertIsNone(self.snapshot()['workers']['implementer']['cursor'])

    def test_actual_clipping_limited_flag_at_eof_is_not_pagination_failure(self):
        self.register();self.data['reads']=[transcript(limited=True,cursor='end'),transcript([],limited=True,cursor='end')];self.write_data()
        self.assertEqual(self.run_tool('recover','--role','implementer')['state'],'enqueued')
        self.assertEqual(self.snapshot()['workers']['implementer']['cursor'],'end')

    def test_fleet_pagination_does_not_miss_active_writer(self):
        self.data['fleet_pages']={'first':{'workers':[],'scope':{'run':'run'},'page':{'hasMore':True,'nextCursor':'next'}},
                                  'next':{'workers':[{'dispatchId':'other','taskId':'other','dispatchStatus':'dispatched'}],'scope':{'run':'run'},'page':{'hasMore':False}}};self.write_data()
        self.start(success=False);self.assertFalse(any(a[1:2]==['worker-start'] for a in self.calls()))

    def test_delivery_phase_and_report_saved_without_auto_ack(self):
        self.register();self.data['read']=transcript([])
        self.data['delivery']={'runId':'run','deliveryId':'delivery','count':1,'messages':[payload_message(extra={'reportPath':'/tmp/report'})]};self.write_data()
        r=self.run_tool('check','--timeout-ms','1');self.assertEqual(r['stage'],'implementation-ready')
        self.assertEqual(r['reports']['native'],'/tmp/report');self.assertEqual(r['pending_delivery']['deliveryId'],'delivery')
        self.assertFalse(any('--ack' in a for a in self.calls()))
        self.run_tool('ack','--delivery','wrong',success=False)
        self.assertIsNone(self.run_tool('ack','--delivery','delivery')['pending_delivery'])

    def test_native_error_delivery_resumes_on_complete_latest_source(self):
        self.register();self.data['read']=transcript([message('old',T-1000,blocks=[{'type':'text','text':'before error'}])])
        native=payload_message('msg_chaterr_test','escalation','Agent hit an error: capacity',{
            'handle':'h','sessionId':'session','requestId':'request','agent':'codex','turnOutcome':'error',
            'error':'Selected model is at capacity. Please try a different model.'})
        native['created_at']=T
        self.data['delivery']={'runId':'run','deliveryId':'delivery','count':1,'messages':[native]};self.write_data()
        r=self.run_tool('check','--timeout-ms','1');self.refresh()
        self.assertEqual(self.data['send_applied'],1);self.assertEqual(r['capacity']['implementer']['state'],'enqueued')
        self.assertIsNotNone(r['pending_delivery'])

    def test_fake_native_quote_cannot_trigger_recovery(self):
        self.register();self.data['read']=transcript([])
        native=payload_message('ordinary','escalation','Agent hit an error: capacity',{'handle':'h','sessionId':'s','requestId':'r','agent':'codex','error':'Selected model is at capacity. Please try a different model.'})
        self.data['delivery']={'runId':'run','deliveryId':'delivery','count':1,'messages':[native]};self.write_data()
        self.run_tool('check','--timeout-ms','1');self.assertFalse(any(a[1:2]==['send'] for a in self.calls()))

    def test_ordinary_large_delivery_is_bounded_with_raw_receipt(self):
        self.data['delivery']={'runId':'run','deliveryId':'delivery','count':1,'messages':[payload_message(extra={'huge':'x'*100000})]}
        self.data['delivery']['messages'][0]['body']='x'*50000;self.write_data()
        r=self.run_tool('check','--timeout-ms','1');self.assertTrue(r['pending_delivery']['messages'][0]['body_clipped'])
        self.assertLess(len(json.dumps(r)),5000);self.assertTrue(Path(r['pending_delivery']['raw_receipt']).exists())


    def native_error(self, mid='msg_chaterr_test', request='request', at=T, error='Selected model is at capacity. Please try a different model.'):
        m=payload_message(mid,'escalation','Agent hit an error: capacity',{
            'handle':'h','sessionId':'session','requestId':request,'agent':'codex','turnOutcome':'error','error':error})
        m['created_at']=at
        return {'runId':'run','deliveryId':'delivery-'+mid,'count':1,'messages':[m]}

    def test_restore_recovers_worker_after_lost_start_response(self):
        self.data['lose_worker-start']=True;self.write_data();self.start(success=False)
        self.assertEqual(self.snapshot()['workers'],{})
        result=self.run_tool('restore');self.refresh()
        self.assertEqual(result['workers']['implementer']['dispatch'],'d');self.assertEqual(self.data['worker-start_applied'],1)
        self.assertEqual(result['unconfirmed_requests'],{})
        self.assertTrue(any(a[1:2]==['request-show'] for a in self.calls()))

    def test_native_capacity_does_not_override_newer_quota_error(self):
        self.register();self.data['read']=transcript([message('quota',T+1000,blocks=[{'type':'error','code':'usage_limit_reached'}])])
        self.data['delivery']=self.native_error();self.write_data()
        r=self.run_tool('check','--timeout-ms','1')
        self.assertEqual(r['capacity']['implementer']['state'],'unknown')
        self.assertFalse(any(a[1:2]==['send'] for a in self.calls()))

    def test_new_native_capacity_can_supersede_old_quota_error(self):
        self.register();self.data['read']=transcript([message('old-quota',T-1000,blocks=[{'type':'error','code':'usage_limit_reached'}])])
        self.data['delivery']=self.native_error();self.write_data()
        r=self.run_tool('check','--timeout-ms','1');self.refresh()
        self.assertEqual(r['capacity']['implementer']['state'],'enqueued');self.assertEqual(self.data['send_applied'],1)

    def test_new_native_non_capacity_error_invalidates_old_capacity(self):
        self.register();s=self.snapshot();s['workers']['implementer']['native_capacity']={'id':'old','at':T-1000,'request':'old','session':'session'}
        self.state.write_text(json.dumps(s));self.data['read']=transcript([])
        self.data['delivery']=self.native_error(error='usage limit');self.write_data()
        r=self.run_tool('check','--timeout-ms','1')
        self.assertEqual(r['capacity']['implementer']['state'],'unknown')
        self.assertNotIn('native_capacity',self.snapshot()['workers']['implementer'])
        self.assertFalse(any(a[1:2]==['send'] for a in self.calls()))

    def test_real_provider_tool_call_confirms_progress_but_result_alone_does_not(self):
        self.register();self.run_tool('recover','--role','implementer');self.refresh()
        self.data['read']=transcript([message(),message('orca:codex-item%3Anew',T+1000,blocks=[{'type':'tool-result'}])]);self.write_data()
        self.assertEqual(self.run_tool('recover','--role','implementer')['state'],'enqueued')
        self.refresh();self.data['read']=transcript([message(),message('orca:codex-item%3Anew-call',T+2000,blocks=[{'type':'tool-call'},{'type':'tool-result'}])]);self.write_data()
        self.assertEqual(self.run_tool('recover','--role','implementer')['state'],'recovered')

    def test_same_error_transcript_then_native_is_one_resume_request(self):
        self.register();self.data['delivery']=self.native_error(at=T+1);self.write_data()
        self.run_tool('check','--timeout-ms','1');self.refresh()
        self.assertEqual(self.data['send_applied'],1);self.assertEqual(len(self.snapshot()['capacity']),1)
        self.assertEqual(next(iter(self.snapshot()['capacity'].values()))['native_request'],'request')

    def test_native_then_transcript_is_one_request_and_next_request_can_retry(self):
        self.register();self.data['read']=transcript([]);self.data['delivery']=self.native_error();self.write_data()
        self.run_tool('check','--timeout-ms','1');self.run_tool('ack','--delivery','delivery-msg_chaterr_test')
        self.refresh();self.data['read']=transcript([message('error-later',T+1)]);self.write_data()
        self.run_tool('recover','--role','implementer');self.refresh();self.assertEqual(self.data['send_applied'],1)
        self.data['delivery']=self.native_error('msg_chaterr_second','request-2',T+1000);self.write_data()
        self.run_tool('check','--timeout-ms','1');self.refresh();self.assertEqual(self.data['send_applied'],2)
        self.data['read']=transcript([message('error-second',T+1001)]);self.write_data()
        self.run_tool('recover','--role','implementer');self.refresh();self.assertEqual(self.data['send_applied'],2)

    def test_source_refresh_does_not_resend_same_error(self):
        self.register();self.run_tool('recover','--role','implementer');self.refresh()
        self.data['read']=transcript(source='refreshed');self.write_data()
        self.run_tool('recover','--role','implementer',success=False)
        self.run_tool('recover','--role','implementer');self.refresh();self.assertEqual(self.data['send_applied'],1)

    def test_cached_ack_restores_exact_delivery_raw_receipt_after_restart(self):
        self.register();self.data['read']=transcript([])
        self.data['delivery']={'runId':'run','deliveryId':'first','messages':[payload_message()]}
        self.data['after_ack']={'runId':'run','deliveryId':'second','messages':[payload_message('second-message')]};self.write_data()
        self.run_tool('check','--timeout-ms','1');old_pending=self.snapshot()['pending_delivery']
        first=self.run_tool('ack','--delivery','first');receipt=first['pending_delivery']['raw_receipt']
        state=self.snapshot();state['pending_delivery']=old_pending;self.state.write_text(json.dumps(state))
        replay=self.run_tool('ack','--delivery','first')
        self.assertEqual(replay['pending_delivery']['raw_receipt'],receipt)
        raw=json.loads(Path(receipt).read_text());self.assertEqual(json.loads(raw['stdout'])['result']['deliveryId'],'second')

    def test_error_classifier_handles_nested_non_capacity_error(self):
        self.assertFalse(MODULE.capacity_error({'error':{'code':'usage_limit_reached'}}))
        self.assertTrue(MODULE.capacity_error({'error':{'codex_error_info':'server_overloaded'}}))


if __name__=='__main__':unittest.main()

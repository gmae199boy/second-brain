"""격리 supervisor 시험 전용 synthetic 보호 worker. 배송 manifest는 참조하지 않는다."""
import json
import os
from pathlib import Path
import socket
import sys
import time
from datetime import datetime, timezone
import psycopg

sys.dont_write_bytecode = True
sys.path.insert(0,str(Path(__file__).resolve().parent / 'src'))
from collect_fixture import checked_fixture
from protection import supervised_validator
from http_guard import ProtectionAdmission


def main():
    try:
        home, marker = checked_fixture()
        original_connect = socket.socket.connect
        def guarded_connect(sock,address):
            if sock.family in (socket.AF_INET,socket.AF_INET6) and address[0] not in ('127.0.0.1','::1'):
                raise OSError('outbound denied')
            return original_connect(sock,address)
        socket.socket.connect=guarded_connect
        env=os.environ
        target=json.loads(env['BRAIN_SETTINGS_SNAPSHOT'])['values']['garmin.tokenstore']
        work, token, run=env['BRAIN_WORK_ID'],env['BRAIN_ATTEMPT_TOKEN'],int(env['BRAIN_RUN_GENERATION'])
        with psycopg.connect(env['BRAIN_DATABASE_URL'],autocommit=True) as conn:
            generation=conn.execute('select generation from garmin.account_binding where target=%s',(target,)).fetchone()[0]
            validate=supervised_validator(work,token,run,target,generation)
            clock=lambda: datetime.now(timezone.utc)
            admission=ProtectionAdmission(conn,target,generation,work,token,run,clock,validate)
            if marker['protection_mode']=='three_403':
                for _ in range(3):
                    intent=admission.begin('data','user_summary')
                    with (home/'protection-calls').open('a') as output: output.write('call\n')
                    admission.finish(intent,'403')
                    time.sleep(1.05)
                try: admission.begin('data','user_summary')
                except Exception: pass
                else: raise ValueError('fourth call admitted')
                print(json.dumps({'abi':1,'type':'result','summary':'fixture complete'}),flush=True)
                return 0
            intent=admission.begin('data','user_summary')
            if marker['protection_mode'] in ('after_429','deny_after'):
                with (home/'protection-calls').open('a') as output: output.write('call\n')
                admission.finish(intent,'429')
            (home/'protection-reached').write_text(json.dumps({'pid':os.getpid(),'token':token}))
            deadline=time.monotonic()+30
            while not (home/'protection-release').exists():
                if time.monotonic()>=deadline: raise ValueError('fixture timeout')
                time.sleep(.02)
        print(json.dumps({'abi':1,'type':'error','code':'COLLECT_STOPPED','retryable':False}),flush=True)
    except Exception:
        print(json.dumps({'abi':1,'type':'error','code':'COLLECT_INVALID','retryable':False}),flush=True)
    return 1

if __name__=='__main__': sys.exit(main())

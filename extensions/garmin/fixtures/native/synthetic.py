"""Synthetic, disposable schema-16 capture shared by Garmin integration tests."""
import json
import sqlite3
from pathlib import Path

ORACLE = Path(__file__).resolve().parents[2] / 'tests/oracle/src/garmin_pipeline/store/migrations'
PROFILE = '12345'
DAY = '2026-01-02'
CUTOFF = 1767355200000
ROLES = {'D1':'development','D2':'production','D3':'development-before-change',
         'D4':'production-pre-epic5','D5':'production-before-history-start'}


def make_capture(root):
    root=Path(root); root.mkdir(parents=True,exist_ok=True)
    for role in ROLES:
        with sqlite3.connect(root/(role+'.db')) as db:
            for path in sorted(ORACLE.glob('*.sql')): db.executescript(path.read_text())
            db.execute('pragma user_version=16')
            # All five snapshots have identical account evidence and overlapping natural
            # keys; D2 wins without changing local IDs, rowids or foreign keys.
            db.execute('insert into auth_event values (?,?,?)',(7,'2026-01-01',CUTOFF-200000))
            db.executemany('insert into run values (?,?,?,?,?,?)',[
                (11,'2026-01-01',CUTOFF-86400000,CUTOFF-86399000,'success','yesterday'),
                (12,DAY,CUTOFF-50000,CUTOFF-49000,'partial','older'),
                (13,DAY,CUTOFF,CUTOFF+1000,'success','selected'),
                (14,DAY,CUTOFF+5000,None,'skipped_blocked','ignored')])
            db.execute('insert into fetch_error values (?,?,?,?,?,?,?,?,?)',
                (21,12,'day',DAY,'stress_data','transient',DAY,CUTOFF-48000,'synthetic_error'))
            db.execute('insert into meta values (?,?)',('history_start','2025-11-25'))
            db.execute('insert into notification values (?,?,?,?)',('2026-01-01','error','synthetic',CUTOFF-1000))
            db.execute('insert into delivery values (?,?,?,?,?,?,?)',(31,DAY,'notify','error',0,'network',CUTOFF-500))
            raw_rows=[
                ('day','2025-11-25','user_summary',{'userProfileId':12345,'steps':0}),
                ('day','2026-01-01','user_summary',{'userProfileId':12345,'steps':10,'nested':None}),
                ('day',DAY,'heart_rates',{'heartRateValues':[[CUTOFF-1,61],[CUTOFF,62],[CUTOFF+1,63]]}),
                ('day',DAY,'stress_data',{'stressValuesArray':[[CUTOFF-1,15],[CUTOFF,16]],'bodyBatteryValuesArray':[[CUTOFF-2,45],[CUTOFF+1,44]]}),
                ('day',DAY,'user_summary',{'userProfileId':12345,'steps':999}),
                ('day',DAY,'body_battery',[{'date':DAY,'bodyBatteryValuesArray':[[CUTOFF-1,42]]}]),
                ('activity','42','activity',{'activityId':42,'synthetic':'completed'}),
                ('activity','43','activity',{'activityId':43,'synthetic':'ongoing'}),
                ('activity','44','activity',{'activityId':44,'synthetic':'overflow_positive'}),
                ('activity','45','activity',{'activityId':45,'synthetic':'overflow_negative'}),
                ('activity','46','activity',{'activityId':46,'synthetic':'near_boundary'}),
                ('activity','47','activity',{'activityId':47,'synthetic':'addition_overflow'}),
                ('activity','48','activity',{'activityId':48,'synthetic':'null_start'}),
                ('activity','49','activity',{'activityId':49,'synthetic':'before_previous_run'}),
                ('activity','50','activity',{'activityId':50,'synthetic':'overflow_cancellation'}),
            ]
            for scope,key,endpoint,value in raw_rows:
                db.execute('insert into raw_response values (?,?,?,?,?,?,?)',
                    (scope,key,endpoint,json.dumps(value),CUTOFF-10000,CUTOFF-9000,'synthetic'))
            db.executemany('insert into normalize_result values (?,?,?,?,?,?,?)',[
                ('day',DAY,'stress_data',1,None,CUTOFF-10000,CUTOFF-9000),
                ('activity','43','activity',0,'parse_error',CUTOFF-10000,CUTOFF-9000)])
            db.executemany('insert into daily_metric(day_key,steps,resting_hr,bb_low) values (?,?,?,?)',[
                ('2026-01-01',10,None,0),(DAY,0,60,None)])
            for table,value in [('body_battery_sample',0),('hr_sample',None),('stress_bb_sample',25)]:
                db.execute('insert into '+table+' values (?,?,?)',(DAY,CUTOFF-1000,value))
            db.executemany('insert into activity(activity_id,day_key,type_key,start_ms,duration_s,avg_hr) values (?,?,?,?,?,?)',[
                (42,DAY,'running',CUTOFF-180000,60,0),
                (43,DAY,'cycling',CUTOFF-30000,60,None),
                (44,DAY,'running',CUTOFF-20000,9223372036854775807,None),
                (45,DAY,'running',0,-9223372036854775808,None),
                (46,DAY,'running',-9223372036854775808,9223372036854775,None),
                (47,DAY,'running',9223372036854775807,1,None),
                (48,DAY,'running',None,None,None),
                (49,'2026-01-01','running',CUTOFF-100000000,60,None),
                (50,DAY,'running',-9223370269499575908,9223372036854776,None)])
            db.executemany('insert into activity_hr_sample values (?,?,?,?)',[
                (42,CUTOFF-120000,120,0),(42,CUTOFF-60000,None,None)])
            db.executemany('insert into exercise_set values (?,?,?,?,?,?,?,?)',[
                (42,0,'STRENGTH','squat',0,0,0,0),(42,1,None,None,None,None,None,1)])
            db.executemany('insert into day_summary(date,steps,sleep_score,drinks_json) values (?,?,?,?)',[
                ('2025-11-25',0,None,'[]'),('2025-12-15',30,0,None),('2025-12-31',100,70,'[]'),
                ('2026-01-01',10,None,None),(DAY,0,80,'[]')])
            db.executemany('insert into workout(activity_id,date,type,start_ms,duration_s,session_no) values (?,?,?,?,?,?)',[
                (40,'2025-11-25','running',None,0,1),(41,'2025-12-15','strength',CUTOFF-90000000,1800,1),
                (42,'2026-01-01','running',CUTOFF-180000,60,1),(43,'2026-01-01','strength',CUTOFF-180000,90,2),
                (44,DAY,'strength',None,None,1)])
            db.executemany('insert into exercise_log(rowid,activity_id,exercise,sets,reps,max_kg,volume_kg) values (?,?,?,?,?,?,?)',[
                (17,40,'walk',0,None,None,0),(18,41,'squat',2,5,20,200),
                (19,42,'bench',2,0,0,0),(20,42,'squat',3,5,30,450),
                (21,43,'bench',1,5,10,50),(22,44,'row',0,None,None,None)])
            db.executemany('insert into evaluation values (?,?,?,?,?,?,?,?,?)',[
                (day,scope,'synthetic '+scope,'[]','[]','[]','# synthetic '+day+' '+scope,'fake',index)
                for index,(day,scope) in enumerate([
                    ('2025-11-30','30d'),('2025-12-20','7d'),('2025-12-30','30d'),
                    ('2025-12-31','day'),('2025-12-31','7d'),('2026-01-01','day'),
                    ('2026-01-01','7d'),('2026-01-01','30d'),('2026-01-01','all')],1)])
    files=[]
    for name,category,content in [('report.md','report',b'# synthetic\n'),('facts.json','facts',b'{"synthetic":true}\n'),('graph.png','image',b'\x89PNG\r\n\x1a\nsynthetic')]:
        (root/name).write_bytes(content)
        item={'dataset':'synthetic-D2','artifact_key':name,'source':name,'snapshot':name,'bytes':len(content),'category':category}
        if category=='report': item.update(report_date='2026-01-01',scope='day')
        else: item['relations']=[{'analysis_key':'report.md','role':'image' if category=='image' else 'input'}]
        files.append(item)
    manifest={'version':2,'capture_id':'native-synthetic-v1','datasets':[{'dataset':'synthetic-'+role,'source':source,'snapshot':role+'.db'} for role,source in ROLES.items()],'files':files,'inventory':[]}
    (root/'manifest.json').write_text(json.dumps(manifest),encoding='utf-8')
    return root/'manifest.json'


class FakeGarmin:
    """No network; conforms to collect's session and day/activity call shape."""
    def __init__(self): self.calls=[]
    def blocked_today(self): return None
    def open_session(self, **_kwargs): return self
    def __enter__(self): return self
    def __exit__(self, *_args): return False
    def fetch_day(self, endpoint, day):
        from types import SimpleNamespace
        self.calls.append(('day',endpoint,day))
        return SimpleNamespace(payload={'synthetic':True},library_version='fake')
    def fetch_activity(self, endpoint, activity_id):
        from types import SimpleNamespace
        self.calls.append(('activity',endpoint,activity_id))
        return SimpleNamespace(payload={'synthetic':True},library_version='fake')

class FakeModel:
    def _result(self):
        from types import SimpleNamespace
        return SimpleNamespace(status='ok',summary='synthetic',report_md='# synthetic',
                               judgments=[],evidence=[],next_checks=[],usage=None)
    def write(self,*_args): return self._result()
    def period(self,*_args): return self._result()

class FakeTelegram:
    def __init__(self): self.calls=[]
    def send(self,*args,**kwargs): self.calls.append((args,kwargs)); return None
    def send_message(self,*args,**kwargs): return self.send(*args,**kwargs)
    def send_photo(self,*args,**kwargs): return self.send(*args,**kwargs)
    def send_media_group(self,*args,**kwargs): return self.send(*args,**kwargs)
    def send_document(self,*args,**kwargs): return self.send(*args,**kwargs)

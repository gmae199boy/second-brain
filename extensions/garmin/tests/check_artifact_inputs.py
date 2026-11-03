"""Verify the local digest window, history, and exact cutoff."""
from datetime import date, datetime, timezone
import json
from pathlib import Path
import sys
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[1] / 'src'))
import artifact_inputs

def stamp(s): return int(datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp()*1000)
def item(scope,key,endpoint,data): return {'scope':scope,'key':key,'endpoint':endpoint,'body':json.dumps(data)}
def act(start,duration): return {'summaryDTO':{'startTimeGMT':start,'duration':duration}}
cut=stamp('2026-10-27T11:00:00')
raw=[item('activity','1','activity',act('2026-10-26T10:59:00',30)),
     item('activity','2','activity',act('2026-10-26T11:00:00',30)),
     item('activity','3','activity',act('2026-10-27T10:59:30',30)),
     item('activity','4','activity',act('2026-10-27T10:59:40',30)),
     item('activity','5','activity',act('2026-09-01T00:00:00',30)),
     item('day','2026-10-27','heart_rates',{'heartRateValues':[[cut-1,80],[cut,90]]}),
     item('day','2026-10-27','user_summary',{'totalSteps':3})]
days,acts,workouts,starts,notes=artifact_inputs.prepare(raw,date(2026,10,27),cut,'UTC')
assert list(acts)==['1','2'] and workouts==['2']
assert starts==[stamp('2026-10-26T10:59:00'),stamp('2026-10-26T11:00:00'),stamp('2026-10-27T10:59:30'),stamp('2026-10-27T10:59:40')]
assert days['2026-10-27']['heart_rates']['heartRateValues']==[[cut-1,80]] and 'user_summary' not in days['2026-10-27']
assert artifact_inputs.prepare(raw,date(2026,10,27),cut,'UTC',stamp('2026-10-26T10:58:00'))[2]==['1','2']
print('artifact input cutoff: ok')
old_bad={'scope':'day','key':'2026-01-01','endpoint':'sleep_data','body':'{'}
invalid_id=item('activity','not-a-number','activity',act('2026-10-26T12:00:00',60))
assert artifact_inputs.prepare(raw+[old_bad,invalid_id],date(2026,10,27),cut,'UTC')[4] == []

for malformed in (None, [], 'text', 42):
    bad=item('activity','99','activity',{'summaryDTO':malformed})
    _,valid,_,_,_=artifact_inputs.prepare(raw+[bad],date(2026,10,27),cut,'UTC')
    assert '99' not in valid and '2' in valid

# Local calendar and default previous-day 11:00 window across DST changes.
for day,cutoff,lower,outside,inside in [
    (date(2026,3,8),'2026-03-08T15:00:00','2026-03-07T16:00:00','2026-03-07T15:59:59','2026-03-07T16:00:00'),
    (date(2026,11,1),'2026-11-01T16:00:00','2026-10-31T15:00:00','2026-10-31T14:59:59','2026-10-31T15:00:00'),
]:
    rows=[item('activity','10','activity',act(outside,30)),item('activity','11','activity',act(inside,30))]
    _,activities,window,_,_=artifact_inputs.prepare(rows,day,stamp(cutoff),'America/New_York')
    assert list(activities)==['10','11'] and window==['11']
    assert (stamp(cutoff)-stamp(lower))//3600000 in (23,25)
# A UTC date can differ from the local activity date.
rows=[item('activity','12','activity',act('2026-01-02T01:00:00',60))]
_,activities,window,_,_=artifact_inputs.prepare(rows,date(2026,1,1),stamp('2026-01-02T03:00:00'),'America/New_York')
assert list(activities)==['12'] and window==['12']

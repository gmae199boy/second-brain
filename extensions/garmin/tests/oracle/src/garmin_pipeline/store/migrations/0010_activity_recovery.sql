-- 심박 회복(HRR) 계산(FR14, AD-13). 쓰는 곳은 normalize.run뿐이다(쓰기 락 안).
-- 원문이 아니라 파생 테이블(activity·activity_hr_sample·hr_sample)만으로 계산한다. normalize.run이 매 실행 끝에
-- 트랜잭션 하나에서 모든 행을 지우고 다시 쓴다(normalize.recovery.recompute). 그래서 언제나 현재 파생 테이블의
-- 순수 함수다. hr_sample·activity_hr_sample·activity의 열·내용은 바꾸지 않는다.

-- 활동 회복: activity 행이나 activity_hr_sample 행이 하나라도 있는 activityId마다 한 행이다. 값 열은 모두 NULL을
-- 허용하고 NULL은 "계산 불가"다. 종료 샘플(bpm이 있는 마지막 활동 샘플)이 없으면 값 열이 모두 NULL이다.
-- 오프셋(60 s·120 s)마다 목표 시각 end_ms + 오프셋에서 허용 거리(30 s) 안의 가장 가까운 일일 샘플
-- (bpm IS NOT NULL, ts_ms > end_ms, 이 활동보다 늦게 시작한 가장 이른 다른 활동의 시작 시각 전)을 고른다.
-- 동률이면 이른 ts_ms, 그다음 작은 day_key다. 후보가 없으면 그 오프셋의 세 열(ts·bpm·hrr)이 NULL이다.
CREATE TABLE activity_recovery (
    activity_id INTEGER PRIMARY KEY, -- activity.activity_id 또는 activity_hr_sample.activity_id
    end_ms INTEGER,                  -- activity_hr_sample: bpm IS NOT NULL인 마지막(최대 ts_ms) 샘플의 ts_ms (UTC epoch ms)
    end_bpm INTEGER,                 -- activity_hr_sample: 그 샘플의 bpm
    ts_1min_ms INTEGER,              -- hr_sample: 목표 end_ms + 60 000 ms에 고른 샘플의 ts_ms (UTC epoch ms)
    bpm_1min INTEGER,                -- hr_sample: 그 샘플의 bpm
    ts_2min_ms INTEGER,              -- hr_sample: 목표 end_ms + 120 000 ms에 고른 샘플의 ts_ms (UTC epoch ms)
    bpm_2min INTEGER,                -- hr_sample: 그 샘플의 bpm
    hrr1 INTEGER,                    -- end_bpm - bpm_1min (음수도 그대로 저장)
    hrr2 INTEGER                     -- end_bpm - bpm_2min (음수도 그대로 저장)
);

-- 시각 창 조회용 인덱스(일 키를 따지지 않고 ts_ms 범위로 일일 샘플을 찾는다). hr_sample의 열·PK는 바꾸지 않는다.
CREATE INDEX hr_sample_ts_ms ON hr_sample (ts_ms);

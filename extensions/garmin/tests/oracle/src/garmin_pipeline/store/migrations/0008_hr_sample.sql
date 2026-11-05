-- 일일 심박 시계열 정규화(FR11, AD-13). 쓰는 곳은 normalize.run뿐이다(쓰기 락 안).
-- heart_rates는 daily_metric 열을 소유하지 않는다(최소·최대 심박은 user_summary, 안정 심박은 rhr_day가 맡는다).

-- 심박 샘플: heart_rates 원문의 heartRateValues 한 샘플에 한 행이다. 위치는 heartRateValueDescriptors의
-- key(timestamp·heartrate)와 index로 찾는다. 일 키 범위 밖 시각도 거르지 않고 원문 그대로 저장한다.
-- 정규화는 그 일 키의 행을 통째로 지우고 현재 원문의 샘플로 다시 넣는다(null 원문·실패면 지우기만 한다).
-- 결측 샘플도 bpm NULL 행으로 남는다. 읽는 쪽(HRR)은 bpm IS NOT NULL로 거른다.
CREATE TABLE hr_sample (
    day_key TEXT NOT NULL,  -- 원문의 일 키(raw_response.key)
    ts_ms INTEGER NOT NULL, -- heartRateValues[i][timestamp 위치] (UTC epoch ms)
    bpm INTEGER,            -- heartRateValues[i][heartrate 위치] (round. null·음수거나 반올림 결과가 0이면 NULL)
    PRIMARY KEY (day_key, ts_ms)
);

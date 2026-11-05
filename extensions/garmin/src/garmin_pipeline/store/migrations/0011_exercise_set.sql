-- 근력 세트 정규화(Epic 5, 5.4). 쓰는 곳은 normalize.run뿐이다(쓰기 락 안).
-- activity-scope 원문 activity_exercise_sets(세트 상세)를 정규화한다. activity 행은 만들거나 바꾸지 않는다.
-- 파생 테이블 사이에는 FK가 없다.

-- 세트: exerciseSets 한 원소(REST 포함)에 한 행이다. 정규화는 그 활동의 행을 통째로 지우고 현재 원문의 세트로
-- 다시 넣는다(한 활동 = 항목 트랜잭션 하나. null 원문·exerciseSets null·실패면 지우기만 한다).
-- 값 열의 NULL은 결측이나 음수 센티넬(무게 -1.0 등)이다. 무게 0과 반복 0은 0으로 남는다.
-- startTime·messageIndex·wktStepIndex·속도·파워·ROM 키와 후보 확률은 저장하지 않는다.
CREATE TABLE exercise_set (
    activity_id INTEGER NOT NULL, -- 원문의 activityId(raw_response.key)
    set_index INTEGER NOT NULL,   -- exerciseSets 안 위치(0부터, REST 포함. messageIndex·startTime은 쓰지 않는다)
    category TEXT,                -- exercises 중 probability가 가장 큰 후보의 category (후보가 없으면 NULL)
    exercise_name TEXT,           -- 같은 후보의 name (후보가 없거나 name이 null이면 NULL)
    reps INTEGER,                 -- repetitionCount (round. null·음수면 NULL)
    weight_g INTEGER,             -- weight (원문 단위 g, round. null·음수(-1.0 센티넬)면 NULL)
    duration_s INTEGER,           -- duration (초, round. null·음수면 NULL)
    is_rest INTEGER NOT NULL CHECK (is_rest IN (0, 1)), -- setType: "REST"면 1, "ACTIVE"면 0
    PRIMARY KEY (activity_id, set_index)
);

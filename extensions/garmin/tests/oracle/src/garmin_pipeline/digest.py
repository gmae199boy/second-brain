"""Pure measurements for the daily report, ported from the trial digest.

Input dictionaries are never modified. Each build owns its notes and timezone;
no filesystem, SQLite, network, model, or narrative rendering is involved.
"""

import itertools
import json
import math
import statistics
from datetime import UTC, datetime, timedelta
from datetime import date as date_type
from zoneinfo import ZoneInfo

SESSION_GAP_S = 600
"""Adjacent activities within 600 seconds form one session."""
BB_DROP = 15
"""A drop of at least 15 within 60 minutes is a large drain."""
BB_DROP_WINDOW_S = 3600
"""Large Body Battery drain window, 60 minutes."""
STRESS_HIGH = 76
"""Garmin high stress starts at 76."""
STRESS_EPOCH_S = 180
"""Stress samples represent 180 seconds."""
SPO2_DIP = 90
"""Oxygen saturation dips below 90."""
HISTORY_DAYS = 30
"""Compare with the preceding 30 calendar days."""
SET_PEAK_LAG_S = 60
"""Peak window ends 60 seconds after a set, before the next set."""
STAGES = {0: "깊은", 1: "얕은", 2: "렘", 3: "깸"}
WHOLE = {
    "steps",
    "active_kcal",
    "moderate_min",
    "vigorous_min",
    "stress_high_s",
    "total_s",
    "deep_s",
    "light_s",
    "rem_s",
    "awake_s",
}


def _raw_shape(default):
    """Keep a malformed endpoint local to its measurement, and report its shape."""

    def decorate(fn):
        def guarded(self, *args, **kwargs):
            try:
                return fn(self, *args, **kwargs)
            except (
                TypeError,
                ValueError,
                KeyError,
                IndexError,
                AttributeError,
                OverflowError,
            ):
                self._note(f"{fn.__name__}: 원본 모양이 다르다")
                return default.copy() if isinstance(default, (dict, list)) else default

        return guarded

    return decorate


class _Digest:
    def __init__(self, manifest, days, activities, labels, body):
        self.manifest = manifest
        self.days = days
        self.activities = {str(k): v for k, v in activities.items()}
        self.labels = labels
        self.body = body
        self.notes = list(manifest.get("notes") or [])
        self.timezone = ZoneInfo(manifest.get("timezone", "Asia/Seoul"))

    def _note(self, message):
        if message not in self.notes:
            self.notes.append(message)

    def _number(self, value, context):
        """Accept only finite nonnegative measurements; never coerce text/bools."""
        if value is None:
            return None
        if not self.valid(value):
            self._note(f"{context}: 측정값이 유효한 숫자가 아니다")
            return None
        return value

    def _numbers(self, raw, keys, context):
        """Sanitize selected numeric fields in a copy, preserving the raw input."""
        return {
            **raw,
            **{key: self._number(raw.get(key), f"{context}.{key}") for key in keys},
        }

    def day(self, day, endpoint):
        endpoints = self.days.get(day) or {}
        if not isinstance(endpoints, dict):
            self._note(f"{day}: 하루 원본 모양이 다르다")
            return None
        value = endpoints.get(endpoint)
        optional_empty = endpoint in ("activities_by_date", "training_readiness")
        if value is None:
            if not optional_empty:
                self._note(f"{day} {endpoint}: 원본이 없다")
            return None
        if not isinstance(value, dict) and not (
            optional_empty and isinstance(value, list)
        ):
            self._note(f"{day} {endpoint}: 원본 모양이 다르다")
            return None
        return value

    def activity(self, activity_id, endpoint):
        return (self.activities.get(str(activity_id)) or {}).get(endpoint)

    def activity_ids(self):
        return sorted(self.activities)

    def label(self, category, name):
        if category == "UNKNOWN" or not category:
            return "종목 미상"
        return (self.labels.get("exercises") or {}).get(f"{category}_{name}") or (
            self.labels.get("categories") or {}
        ).get(category, name or category)

    def to_utc(self, value):
        """epoch ms 또는 'YYYY-MM-DDTHH:MM:SS(.f)' (GMT, Z 없음) → aware datetime."""
        if value is None:
            return None
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value / 1000, UTC)
        moment = datetime.fromisoformat(str(value))
        return (
            moment.replace(tzinfo=UTC)
            if moment.tzinfo is None
            else moment.astimezone(UTC)
        )

    def local_datetime(self, value):
        moment = datetime.fromisoformat(value)
        return moment.replace(tzinfo=self.timezone) if moment.tzinfo is None else moment

    def clock(self, dt):
        return dt.astimezone(self.timezone).strftime("%H:%M") if dt else None

    def hm(self, seconds):
        if seconds is None:
            return None
        sign = "-" if seconds < 0 else ""
        minutes = round(abs(seconds) / 60)
        return f"{sign}{minutes // 60}:{minutes % 60:02d}"

    def valid(self, v):
        return (
            isinstance(v, (int, float))
            and not isinstance(v, bool)
            and math.isfinite(v)
            and v >= 0
        )

    def mean(self, values, digits=1):
        values = [v for v in values if self.valid(v)]
        return round(statistics.mean(values), digits) if values else None

    def column(self, descriptors, wanted, index_key="index", name_key="key"):
        for d in descriptors or []:
            if d.get(name_key) == wanted:
                return d.get(index_key)
        return None

    def nearest(self, points, when, within_s=15):
        """(dt, value) 목록에서 when에 가장 가까운 값. within_s 안에 없으면 None."""
        best = None
        for t, v in points:
            gap = abs((t - when).total_seconds())
            if gap <= within_s and (best is None or gap < best[0]):
                best = (gap, v)
        return best[1] if best else None

    def peak(self, points, start, end):
        vals = [(t, v) for (t, v) in points if start <= t <= end]
        if not vals:
            return (None, None)
        (t, v) = max(vals, key=lambda x: x[1])
        return (v, t)

    def low(self, points, start, end):
        vals = [(t, v) for (t, v) in points if start <= t <= end]
        if not vals:
            return (None, None)
        (t, v) = min(vals, key=lambda x: x[1])
        return (v, t)

    def clock_mean(self, dts):
        """자정을 사이에 둔 시각 평균. 정오 이후는 전날 쪽(음수 분)으로 본다."""
        mins = []
        for dt in dts:
            if dt is None:
                continue
            local = dt.astimezone(self.timezone)
            m = local.hour * 60 + local.minute
            if m >= 12 * 60:
                m -= 24 * 60
            mins.append(m)
        if not mins:
            return None
        m = round(statistics.mean(mins)) % (24 * 60)
        return f"{m // 60:02d}:{m % 60:02d}"

    @_raw_shape([])
    def samples(self, items, time_key="startGMT", value_key="value"):
        out = []
        for x in items or []:
            v = x.get(value_key)
            if self.valid(v):
                out.append((self.to_utc(x.get(time_key)), v))
        return out

    @_raw_shape(None)
    def sleep_for(self, inp, date, detail=False):
        raw = inp.day(date, "sleep_data")
        dto = (raw or {}).get("dailySleepDTO") or {}
        dto = self._numbers(
            dto,
            (
                "sleepTimeSeconds",
                "deepSleepSeconds",
                "lightSleepSeconds",
                "remSleepSeconds",
                "awakeSleepSeconds",
                "awakeCount",
                "averageSpO2Value",
                "lowestSpO2Value",
                "averageRespirationValue",
                "lowestRespirationValue",
                "highestRespirationValue",
            ),
            f"{date} dailySleepDTO",
        )
        total = dto.get("sleepTimeSeconds")
        if not self.valid(total) or total == 0:
            return None
        (start, end) = (
            self.to_utc(dto.get("sleepStartTimestampGMT")),
            self.to_utc(dto.get("sleepEndTimestampGMT")),
        )
        hr = self.samples(raw.get("sleepHeartRate"))
        hrv = self.samples(raw.get("hrvData"))
        stress = self.samples(raw.get("sleepStress"))
        bb = self.samples(raw.get("sleepBodyBattery"))
        spo2 = self.samples(
            raw.get("wellnessEpochSPO2DataDTOList"), "epochTimestamp", "spo2Reading"
        )
        self.samples(
            raw.get("wellnessEpochRespirationDataDTOList"),
            "startTimeGMT",
            "respirationValue",
        )
        (hr_min, hr_min_t) = (
            (min(hr, key=lambda x: x[1])[1], min(hr, key=lambda x: x[1])[0])
            if hr
            else (None, None)
        )
        spo2_min_t = min(spo2, key=lambda x: x[1])[0] if spo2 else None
        out = {
            "date": date,
            "sleep_start": self.clock(start),
            "sleep_end": self.clock(end),
            "_start": start,
            "_end": end,
            "total": self.hm(total),
            "total_s": total,
            "deep": self.hm(dto.get("deepSleepSeconds")),
            "deep_s": dto.get("deepSleepSeconds"),
            "light": self.hm(dto.get("lightSleepSeconds")),
            "light_s": dto.get("lightSleepSeconds"),
            "rem": self.hm(dto.get("remSleepSeconds")),
            "rem_s": dto.get("remSleepSeconds"),
            "awake": self.hm(dto.get("awakeSleepSeconds")),
            "awake_s": dto.get("awakeSleepSeconds"),
            "score": self._number(
                ((dto.get("sleepScores") or {}).get("overall") or {}).get("value"),
                f"{date} sleep_score",
            ),
            "awake_count_summary": dto.get("awakeCount"),
            "hr_min": hr_min,
            "hr_min_time": self.clock(hr_min_t),
            "hr_min_after_sleep_start": self.hm((hr_min_t - start).total_seconds())
            if hr_min_t and start
            else None,
            "_hr_min_t": hr_min_t,
            "hr_avg": self.mean([v for (_, v) in hr]),
            "hrv_avg": raw.get("avgOvernightHrv")
            if self.valid(raw.get("avgOvernightHrv"))
            else self.mean([v for (_, v) in hrv]),
            "stress_avg": self.mean([v for (_, v) in stress]),
            "bb_start": bb[0][1] if bb else None,
            "bb_end": bb[-1][1] if bb else None,
            "spo2_avg": dto.get("averageSpO2Value"),
            "spo2_min": dto.get("lowestSpO2Value"),
            "spo2_min_time": self.clock(spo2_min_t),
            "resp_avg": dto.get("averageRespirationValue"),
            "resp_min": dto.get("lowestRespirationValue"),
            "resp_max": dto.get("highestRespirationValue"),
            "breathing_disruption": dto.get("breathingDisruptionSeverity"),
        }
        if not detail:
            return out
        levels = []
        for x in raw.get("sleepLevels") or []:
            (a, b) = (self.to_utc(x.get("startGMT")), self.to_utc(x.get("endGMT")))
            levels.append(
                {
                    "from": self.clock(a),
                    "to": self.clock(b),
                    "stage": STAGES.get(int(x.get("activityLevel", -1)), "미상"),
                    "minutes": round((b - a).total_seconds() / 60),
                    "_a": a,
                    "_b": b,
                }
            )
        awake = []
        for x in levels:
            if x["stage"] != "깸":
                continue
            (a, b) = (x["_a"] - timedelta(minutes=3), x["_b"] + timedelta(minutes=3))
            before = [
                v for (t, v) in hr if x["_a"] - timedelta(minutes=10) <= t < x["_a"]
            ]
            trace = [
                f"{self.clock(t)} {v}"
                for (t, v) in hr
                if x["_a"] - timedelta(minutes=6) <= t <= x["_b"] + timedelta(minutes=6)
            ]
            awake.append(
                {
                    "from": x["from"],
                    "to": x["to"],
                    "minutes": x["minutes"],
                    "hr_before": before[-1] if before else None,
                    "hr_trace": trace,
                    "hr_peak": self.peak(hr, a, b)[0],
                    "stress_peak": self.peak(stress, a, b)[0],
                    "spo2_low": self.low(spo2, a, b)[0],
                }
            )
        half = start + (end - start) / 2 if start and end else None
        out.update(
            {
                "stages": [
                    {k: v for (k, v) in x.items() if not k.startswith("_")}
                    for x in levels
                ],
                "awake_segments": awake,
                "hrv_first_half": self.mean([v for (t, v) in hrv if half and t < half]),
                "hrv_second_half": self.mean(
                    [v for (t, v) in hrv if half and t >= half]
                ),
                "bb_charged_in_sleep": bb[-1][1] - bb[0][1] if bb else None,
                "spo2_dips": [
                    {"time": self.clock(t), "value": v}
                    for (t, v) in spo2
                    if v < SPO2_DIP
                ],
                "restless_count": len(raw.get("sleepRestlessMoments") or []),
            }
        )
        return out

    def public(self, d):
        return {k: v for (k, v) in d.items() if not k.startswith("_")} if d else None

    @_raw_shape(([], []))
    def stress_points(self, raw):
        if not isinstance(raw, dict):
            return ([], [])
        si = (
            self.column(raw.get("stressValueDescriptorsDTOList"), "timestamp"),
            self.column(raw.get("stressValueDescriptorsDTOList"), "stressLevel"),
        )
        bd = raw.get("bodyBatteryValueDescriptorsDTOList")
        bi = (
            self.column(
                bd,
                "timestamp",
                "bodyBatteryValueDescriptorIndex",
                "bodyBatteryValueDescriptorKey",
            ),
            self.column(
                bd,
                "bodyBatteryLevel",
                "bodyBatteryValueDescriptorIndex",
                "bodyBatteryValueDescriptorKey",
            ),
        )
        (stress, bb) = ([], [])
        if None not in si:
            stress = [
                (self.to_utc(r[si[0]]), r[si[1]])
                for r in raw.get("stressValuesArray") or []
                if self.valid(r[si[1]])
            ]
        if None not in bi:
            bb = [
                (self.to_utc(r[bi[0]]), r[bi[1]])
                for r in raw.get("bodyBatteryValuesArray") or []
                if self.valid(r[bi[1]])
            ]
        return (stress, bb)

    def bb_drops(self, bb):
        """60분 안에 15 이상 떨어진 구간. 겹치는 구간은 합친다."""
        spans = []
        for i, (ta, va) in enumerate(bb):
            for tb, vb in bb[i + 1 :]:
                if (tb - ta).total_seconds() > BB_DROP_WINDOW_S:
                    break
                if va - vb >= BB_DROP:
                    spans.append([ta, tb])
                    break
        merged = []
        for a, b in spans:
            if merged and a <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        out = []
        for a, b in merged:
            va = self.nearest(bb, a, 1)
            vb = self.nearest(bb, b, 1)
            out.append(
                {"from": self.clock(a), "to": self.clock(b), "bb_from": va, "bb_to": vb}
            )
        return out

    @_raw_shape(None)
    def full_day(self, inp, date):
        u = inp.day(date, "user_summary")
        if not isinstance(u, dict):
            return None
        u = self._numbers(
            u,
            (
                "bodyBatteryHighestValue",
                "bodyBatteryLowestValue",
                "bodyBatteryChargedValue",
                "bodyBatteryDrainedValue",
                "averageStressLevel",
                "highStressDuration",
                "mediumStressDuration",
                "stressDuration",
                "totalSteps",
                "activeKilocalories",
                "moderateIntensityMinutes",
                "vigorousIntensityMinutes",
            ),
            f"{date} user_summary",
        )
        (_stress, bb) = self.stress_points(inp.day(date, "stress_data"))
        bb_max = max(bb, key=lambda x: x[1]) if bb else None
        bb_min = min(bb, key=lambda x: x[1]) if bb else None
        return {
            "date": date,
            "bb_wake": self.wake_bb(inp, date),
            "bb_high": u.get("bodyBatteryHighestValue"),
            "bb_high_time": self.clock(bb_max[0])
            if bb_max and bb_max[1] == u.get("bodyBatteryHighestValue")
            else None,
            "bb_low": u.get("bodyBatteryLowestValue"),
            "bb_low_time": self.clock(bb_min[0])
            if bb_min and bb_min[1] == u.get("bodyBatteryLowestValue")
            else None,
            "bb_charged": u.get("bodyBatteryChargedValue"),
            "bb_drained": u.get("bodyBatteryDrainedValue"),
            "bb_drops": self.bb_drops(bb),
            "stress_avg": u.get("averageStressLevel")
            if self.valid(u.get("averageStressLevel"))
            else None,
            "stress_high": self.hm(u.get("highStressDuration")),
            "stress_high_s": u.get("highStressDuration"),
            "stress_medium": self.hm(u.get("mediumStressDuration")),
            "stress_measured": self.hm(u.get("stressDuration")),
            "steps": u.get("totalSteps"),
            "active_kcal": u.get("activeKilocalories"),
            "moderate_min": u.get("moderateIntensityMinutes"),
            "vigorous_min": u.get("vigorousIntensityMinutes"),
            "resting_hr": self.resting_hr(inp, date),
        }

    def wake_bb(self, inp, date):
        """기상 Body Battery. 오늘과 직전 7일 모두 같은 방법: 수면 원본의 마지막 값, 없으면 하루 요약의 기상 값."""
        sl = self.sleep_for(inp, date)
        if sl and self.valid(sl.get("bb_end")):
            return sl["bb_end"]
        u = inp.day(date, "user_summary")
        v = u.get("bodyBatteryAtWakeTime") if isinstance(u, dict) else None
        return self._number(v, f"{date} bodyBatteryAtWakeTime")

    @_raw_shape(None)
    def resting_hr(self, inp, date):
        raw = inp.day(date, "rhr_day")
        try:
            rows = raw["allMetrics"]["metricsMap"]["WELLNESS_RESTING_HEART_RATE"]
        except (TypeError, KeyError):
            return None
        for r in rows or []:
            if r.get("calendarDate") == date and self.valid(r.get("value")):
                return round(r["value"])
        return None

    def morning(self, inp, date, cutoff):
        """기상 뒤부터 data_cutoff까지. 수면 기록이 없으면 자정부터."""
        (stress, bb) = self.stress_points(inp.day(date, "stress_data"))
        sl = self.sleep_for(inp, date)
        wake = sl["_end"] if sl and sl.get("_end") else None
        cutoff_dt = self.local_datetime(cutoff)
        stress = [(t, v) for t, v in stress if t < cutoff_dt]
        bb = [(t, v) for t, v in bb if t < cutoff_dt]
        if wake:
            stress = [(t, v) for (t, v) in stress if t >= wake]
            bb = [(t, v) for (t, v) in bb if t >= wake]
        after_wake = bb
        last = bb[-1] if bb else None
        high = sum(1 for (_, v) in stress if v >= STRESS_HIGH)
        return {
            "date": date,
            "from": self.clock(wake) if wake else "00:00",
            "until": cutoff,
            "bb_wake": self.wake_bb(inp, date),
            "bb_high_after_wake": max(v for (_, v) in after_wake)
            if after_wake
            else None,
            "bb_last": last[1] if last else None,
            "bb_last_time": self.clock(last[0]) if last else None,
            "bb_drops": self.bb_drops(bb),
            "stress_avg_samples": self.mean([v for (_, v) in stress]),
            "stress_high_samples": self.hm(high * STRESS_EPOCH_S) if stress else None,
            "stress_measured_samples": self.hm(len(stress) * STRESS_EPOCH_S),
            "resting_hr": self.resting_hr(inp, date),
        }

    @_raw_shape(None)
    def activity_record(self, inp, activity_id):
        a = inp.activity(activity_id, "activity") or {}
        s = a.get("summaryDTO") or {}
        start = self.to_utc(s.get("startTimeGMT"))
        s = self._numbers(s, ("duration", "averageHR", "maxHR"), f"운동 {activity_id}")
        duration = s.get("duration")
        if start is None or not self.valid(duration):
            self._note(f"운동 {activity_id}: 시작 시각이나 길이가 없다")
            return None
        det = inp.activity(activity_id, "activity_details") or {}
        idx = {
            m.get("key"): m.get("metricsIndex")
            for m in det.get("metricDescriptors") or []
        }
        (hr, bb) = ([], [])
        (ti, hi, bi) = (
            idx.get("directTimestamp"),
            idx.get("directHeartRate"),
            idx.get("directBodyBattery"),
        )
        if ti is None or hi is None:
            self._note(f"운동 {activity_id}: 운동 원본에서 시각·심박 칸을 찾지 못했다")
        for row in det.get("activityDetailMetrics") or []:
            m = row.get("metrics") or []
            if ti is None or ti >= len(m) or m[ti] is None:
                continue
            t = self.to_utc(m[ti])
            if hi is not None and hi < len(m) and self.valid(m[hi]) and (m[hi] > 0):
                hr.append((t, m[hi]))
            if bi is not None and bi < len(m) and self.valid(m[bi]):
                bb.append((t, m[bi]))
        zones = {}
        for z in inp.activity(activity_id, "activity_hr_in_timezones") or []:
            if self.valid(z.get("secsInZone")):
                zones[z.get("zoneNumber")] = {
                    "time": self.hm(z["secsInZone"]),
                    "s": round(z["secsInZone"]),
                    "low_bpm": self._number(
                        z.get("zoneLowBoundary"), f"운동 {activity_id} zoneLowBoundary"
                    ),
                }
        hr_max = max(hr, key=lambda x: x[1]) if hr else None
        return {
            "id": str(activity_id),
            "type": (a.get("activityTypeDTO") or {}).get("typeKey"),
            "_start": start,
            "_end": start + timedelta(seconds=duration),
            "start": self.clock(start),
            "end": self.clock(start + timedelta(seconds=duration)),
            "date": start.astimezone(self.timezone).strftime("%Y-%m-%d"),
            "duration": self.hm(duration),
            "duration_s": round(duration),
            "hr_avg": s.get("averageHR"),
            "hr_max": s.get("maxHR"),
            "hr_max_time": self.clock(hr_max[0]) if hr_max else None,
            "hr_first": hr[0][1] if hr else None,
            "hr_last": hr[-1][1] if hr else None,
            "zones": zones,
            "bb_start": bb[0][1] if bb else None,
            "bb_end": bb[-1][1] if bb else None,
            "_hr": hr,
        }

    @_raw_shape([])
    def sets_for(self, inp, rec, counter=None, quiet=False):
        raw = inp.activity(rec["id"], "activity_exercise_sets")
        if raw is None:
            if not quiet:
                self._note(
                    f"운동 {rec['id']} ({rec['date']} {rec['start']}): 세트 원본이 없다"
                )
            raw = {}
        rows = raw.get("exerciseSets") or []
        hr = rec["_hr"]
        actives = [i for (i, r) in enumerate(rows) if r.get("setType") == "ACTIVE"]
        out = []
        counter = {} if counter is None else counter
        for n, i in enumerate(actives):
            r = rows[i]
            ex = (r.get("exercises") or [{}])[0]
            key = (ex.get("category"), ex.get("name"))
            label = inp.label(*key)
            counter[label] = counter.get(label, 0) + 1
            start = self.to_utc(r.get("startTime"))
            dur = self._number(
                r.get("duration"), f"운동 {rec['id']} 세트 {n + 1}.duration"
            )
            end = start + timedelta(seconds=dur) if start and dur is not None else None
            rest = (
                rows[i + 1].get("duration")
                if i + 1 < len(rows) and rows[i + 1].get("setType") == "REST"
                else None
            )
            nxt = (
                self.to_utc(rows[actives[n + 1]].get("startTime"))
                if n + 1 < len(actives)
                else None
            )
            rest = self._number(rest, f"운동 {rec['id']} 세트 {n + 1}.rest")
            w = r.get("weight")
            if w != -1:
                w = self._number(w, f"운동 {rec['id']} 세트 {n + 1}.weight")
            if self.valid(w) and w > 0:
                (weight, kg) = (f"{w / 1000:.1f} kg", round(w / 1000, 1))
            elif w == -1:
                (weight, kg) = ("맨몸", None)
            else:
                (weight, kg) = ("무게 기록 없음", None)
            window_end = end + timedelta(seconds=SET_PEAK_LAG_S) if end else None
            if window_end and nxt:
                window_end = min(window_end, nxt)
            (set_peak, set_peak_t) = (
                self.peak(
                    [(t, v) for t, v in hr if nxt is None or t < nxt], start, window_end
                )
                if start and window_end
                else (None, None)
            )
            rest_low = self.low(hr, set_peak_t, nxt)[0] if set_peak_t and nxt else None
            out.append(
                {
                    "exercise": label,
                    "exercise_key": "_".join(k for k in key if k),
                    "set_no": counter[label],
                    "order": n + 1,
                    "start": self.clock(start),
                    "duration_s": round(dur) if dur is not None else None,
                    "rest_s": round(rest) if self.valid(rest) else None,
                    "reps": self._number(
                        r.get("repetitionCount"),
                        f"운동 {rec['id']} 세트 {n + 1}.repetitionCount",
                    ),
                    "weight": weight,
                    "weight_kg": kg,
                    "set_peak_hr": set_peak,
                    "set_peak_after_end_s": max(
                        0, round((set_peak_t - end).total_seconds())
                    )
                    if set_peak_t and end
                    else None,
                    "rest_low_hr": rest_low,
                    "next_start_hr": self.nearest(hr, nxt) if nxt else None,
                    "drop_in_rest": set_peak - rest_low
                    if set_peak and rest_low
                    else None,
                }
            )
        return out

    def exercise_totals(self, sets):
        totals = {}
        for s in sets:
            t = totals.setdefault(
                s["exercise"],
                {
                    "exercise": s["exercise"],
                    "sets": 0,
                    "reps": 0,
                    "max_kg": None,
                    "volume_kg": 0.0,
                    "weighted_sets": 0,
                    "bodyweight_sets": 0,
                    "no_weight_sets": 0,
                    "set_peaks": [],
                },
            )
            t["sets"] += 1
            t["reps"] = (
                t["reps"] + s["reps"]
                if t["reps"] is not None and s["reps"] is not None
                else None
            )
            t["set_peaks"].append(s["set_peak_hr"])
            if s["weight_kg"]:
                t["max_kg"] = max(t["max_kg"] or 0, s["weight_kg"])
                t["volume_kg"] = (
                    round(t["volume_kg"] + s["reps"] * s["weight_kg"], 1)
                    if t["volume_kg"] is not None and s["reps"] is not None
                    else None
                )
                t["weighted_sets"] += 1
            elif s["weight"] == "맨몸":
                t["bodyweight_sets"] += 1
            else:
                t["no_weight_sets"] += 1
        return totals

    def sessions(self, records):
        grouped = []
        for r in sorted(records, key=lambda x: x["_start"]):
            if (
                grouped
                and (r["_start"] - grouped[-1][-1]["_end"]).total_seconds()
                <= SESSION_GAP_S
            ):
                grouped[-1].append(r)
            else:
                grouped.append([r])
        return grouped

    def kind(self, rec):
        return (
            "HIIT"
            if rec["type"] == "hiit"
            else "근력"
            if rec["type"] == "strength_training"
            else rec["type"]
        )

    def workouts(self, inp, manifest, cutoff_dt):
        today_ids = manifest.get("workouts") or []
        records = [r for r in (self.activity_record(inp, i) for i in today_ids) if r]
        history = [
            r
            for r in (
                self.activity_record(inp, i)
                for i in inp.activity_ids()
                if i not in today_ids
            )
            if r
        ]
        out = []
        for n, group in enumerate(self.sessions(records), 1):
            (parts, all_hr) = ([], [])
            counters = {}
            for rec in group:
                st = self.sets_for(inp, rec, counters.setdefault(self.kind(rec), {}))
                totals = self.exercise_totals(st)
                part = {k: v for (k, v) in rec.items() if not k.startswith("_")}
                part["kind"] = self.kind(rec)
                part["sets"] = st
                part["exercise_totals"] = list(totals.values())
                part["previous"] = self.previous_same(inp, rec, totals, history)
                parts.append(part)
                all_hr += rec["_hr"]
            (first, last) = (group[0], group[-1])
            top = max(all_hr, key=lambda x: x[1]) if all_hr else None
            nxt = None
            later = [r["_start"] for r in records if r["_start"] > last["_end"]]
            later.extend(
                self.to_utc(ts)
                for ts in manifest.get("_workout_starts_ms", [])
                if self.valid(ts) and self.to_utc(ts) > last["_end"]
            )
            if later:
                nxt = min(later)
            out.append(
                {
                    "session": n,
                    "date": first["date"],
                    "start": first["start"],
                    "end": last["end"],
                    "after": self.after_workout(
                        inp, last["_end"], min(cutoff_dt, nxt) if nxt else cutoff_dt
                    ),
                    "duration": self.hm(
                        (last["_end"] - first["_start"]).total_seconds()
                    ),
                    "parts": [p["kind"] for p in parts],
                    "hr_max": top[1] if top else None,
                    "hr_max_time": self.clock(top[0]) if top else None,
                    "bb_start": first.get("bb_start"),
                    "bb_end": last.get("bb_end"),
                    "detail": parts,
                }
            )
        return (out, records)

    def previous_same(self, inp, rec, totals, history):
        """오늘 종목마다 최근 30일 안에서 마지막으로 한 기록. HIIT는 마지막 HIIT."""
        before = [
            h
            for h in history
            if h["_start"] < rec["_start"]
            and (rec["_start"] - h["_start"]).days <= HISTORY_DAYS
        ]
        before.sort(key=lambda h: h["_start"], reverse=True)
        out = []
        if rec["type"] == "hiit":
            for h in before:
                if h["type"] == "hiit":
                    st = self.sets_for(inp, h, quiet=True)
                    out.append(
                        {
                            "date": h["date"],
                            "start": h["start"],
                            "duration": h["duration"],
                            "hr_avg": h["hr_avg"],
                            "hr_max": h["hr_max"],
                            "rounds": [
                                {
                                    k: s[k]
                                    for k in (
                                        "exercise",
                                        "duration_s",
                                        "rest_s",
                                        "reps",
                                        "weight",
                                        "set_peak_hr",
                                        "drop_in_rest",
                                    )
                                }
                                for s in st
                            ],
                        }
                    )
                    break
            return out
        cache = {}
        for name in totals:
            for h in before:
                if h["type"] == "hiit":
                    continue
                if h["id"] not in cache:
                    cache[h["id"]] = self.sets_for(inp, h, quiet=True)
                mine = [s for s in cache[h["id"]] if s["exercise"] == name]
                if mine:
                    t = self.exercise_totals(mine)[name]
                    t.update(
                        {
                            "date": h["date"],
                            "sets_detail": [
                                {
                                    k: s[k]
                                    for k in ("reps", "weight", "set_peak_hr", "rest_s")
                                }
                                for s in mine
                            ],
                        }
                    )
                    out.append(t)
                    break
            else:
                out.append({"exercise": name, "date": None})
        return out

    def recent_training(self, inp, report_date):
        """최근 30일 운동 요약. 운동이 없는 날에도 다음 운동을 제안할 근거가 되도록 매일 낸다."""
        recs = sorted(
            (
                r
                for r in (self.activity_record(inp, i) for i in inp.activity_ids())
                if r
            ),
            key=lambda r: r["_start"],
        )
        (out_sessions, latest) = ([], {})
        for group in self.sessions(recs):
            parts = []
            for rec in group:
                st = self.sets_for(inp, rec, quiet=True)
                totals = self.exercise_totals(st)
                parts.append(
                    {
                        "kind": self.kind(rec),
                        "duration": rec["duration"],
                        "hr_avg": rec["hr_avg"],
                        "sets_recorded": bool(st),
                        "exercises": [
                            {
                                "exercise": t["exercise"],
                                "sets": t["sets"],
                                "reps": t["reps"],
                                "max_kg": t["max_kg"],
                            }
                            for t in totals.values()
                        ],
                    }
                )
                for t in totals.values():
                    top = max(
                        (x for x in st if x["exercise"] == t["exercise"]),
                        key=lambda x: (x["weight_kg"] or 0, x["reps"] or 0),
                    )
                    latest[t["exercise"]] = {
                        "exercise": t["exercise"],
                        "date": rec["date"],
                        "kind": self.kind(rec),
                        "sets": t["sets"],
                        "reps": t["reps"],
                        "max_kg": t["max_kg"],
                        "top_set": f"{top['reps']} × {top['weight']}",
                    }
            out_sessions.append(
                {
                    "date": group[0]["date"],
                    "start": group[0]["start"],
                    "duration": self.hm(
                        (group[-1]["_end"] - group[0]["_start"]).total_seconds()
                    ),
                    "parts": parts,
                }
            )
        last = out_sessions[-1]["date"] if out_sessions else None
        since = (
            (date_type.fromisoformat(report_date) - date_type.fromisoformat(last)).days
            if last
            else None
        )
        return {
            "last_workout_date": last,
            "days_since_last_workout": since,
            "sessions_30d": out_sessions,
            "latest_by_exercise": sorted(
                latest.values(), key=lambda x: x["date"], reverse=True
            ),
        }

    def body_and_goal(self, inp, report_date):
        """Validated sidecar measurements, without profile goals."""
        rows = sorted(
            (r for r in self.body if r.get("measured_on", "") <= report_date),
            key=lambda r: r["measured_on"],
        )
        latest = rows[-1] if rows else None
        prev = rows[-2] if len(rows) > 1 else None
        change = None
        if latest and prev:
            change = {
                k: round(v - prev["values"][k], 1)
                for k, v in latest["values"].items()
                if self.valid(v) and self.valid(prev["values"].get(k))
            }
            change["days"] = (
                date_type.fromisoformat(latest["measured_on"])
                - date_type.fromisoformat(prev["measured_on"])
            ).days
        return {
            "latest": latest,
            "previous": prev,
            "change_from_previous": change,
            "days_since_latest": (
                date_type.fromisoformat(report_date)
                - date_type.fromisoformat(latest["measured_on"])
            ).days
            if latest
            else None,
            "new_today": bool(latest and latest["measured_on"] == report_date),
            "history": rows,
        }

    @_raw_shape(None)
    def weight_for(self, day):
        """Last valid weight that day, grams converted to kilograms."""
        raw = self.day(day, "daily_weigh_ins")
        if raw is None:
            return None
        rows = raw.get("dateWeightList")
        if rows is None:
            rows = []
        if not isinstance(rows, list):
            raise TypeError("dateWeightList")
        measured = []
        for row in rows:
            if not isinstance(row, dict):
                self._note("weight_for: 원본 모양이 다르다")
                continue
            weight = self._number(row.get("weight"), "daily_weigh_ins.weight")
            stamp = row.get("timestampGMT")
            if stamp is None:
                stamp = row.get("date")
            if weight is not None and stamp is not None:
                try:
                    moment = self.to_utc(stamp)
                except (TypeError, ValueError, OverflowError, OSError):
                    self._note("weight_for: 원본 모양이 다르다")
                    continue
                measured.append((moment, weight))
        return (
            round(max(measured, key=lambda row: row[0])[1] / 1000, 1)
            if measured
            else None
        )

    @_raw_shape([])
    def drinks_for(self, day):
        """Keep YES/QUANTITY details with an amount, without interpreting units."""
        raw = self.day(day, "lifestyle_logging_data")
        if not isinstance(raw, dict):
            return None
        logged = []
        for entry in raw.get("dailyLogsReport") or []:
            if (
                entry.get("logStatus") != "YES"
                or entry.get("measurementType") != "QUANTITY"
            ):
                continue
            for detail in entry.get("details") or []:
                if detail.get("amount") is not None:
                    logged.append(
                        {
                            "item": entry.get("name"),
                            "kind": detail.get("subTypeName"),
                            "amount": detail["amount"],
                        }
                    )
        return logged

    def drinks(self, inp, days):
        out = []
        for day in days:
            logged = self.drinks_for(day)
            row = {"date": day, "fetched": logged is not None}
            if logged is not None:
                row["logged"] = logged
            out.append(row)
        return out

    def weight(self, days, report_date):
        rows = [
            {
                "date": day,
                "fetched": isinstance(self.day(day, "daily_weigh_ins"), dict),
                "weight_kg": self.weight_for(day),
            }
            for day in days
        ]
        start = (date_type.fromisoformat(report_date) - timedelta(days=6)).isoformat()
        values = [
            row["weight_kg"]
            for row in rows
            if start <= row["date"] <= report_date and row["weight_kg"] is not None
        ]
        return {
            "days": rows,
            "avg_7d_kg": round(statistics.mean(values), 1) if values else None,
            "avg_7d_days": len(values),
        }

    @_raw_shape([])
    def day_hr(self, inp, date):
        raw = inp.day(date, "heart_rates")
        if not isinstance(raw, dict):
            return []
        d = raw.get("heartRateValueDescriptors")
        (ti, hi) = (self.column(d, "timestamp"), self.column(d, "heartrate"))
        if ti is None or hi is None:
            self._note(f"{date} 하루 심박에서 시각·심박 칸을 찾지 못했다")
            return []
        return [
            (self.to_utc(r[ti]), r[hi])
            for r in raw.get("heartRateValues") or []
            if self.valid(r[hi]) and r[hi] > 0
        ]

    def after_workout(self, inp, end, until):
        """운동이 끝난 뒤부터 until(다음 운동 시작 또는 data_cutoff)까지의 하루 심박. 운동 끝 날짜와 다음 날 파일을 함께 본다."""
        d0 = end.astimezone(self.timezone).date()
        pts = self.day_hr(inp, d0.isoformat()) + self.day_hr(
            inp, (d0 + timedelta(days=1)).isoformat()
        )
        after = sorted((t, v) for (t, v) in pts if end <= t < until)
        if not after:
            return {"workout_end": self.clock(end), "samples": 0}
        gaps = [
            (a[0], b[0])
            for (a, b) in itertools.pairwise(after)
            if (b[0] - a[0]).total_seconds() > 600
        ]

        def pick(m):
            return self.nearest(after, end + timedelta(minutes=m), 180)

        lo = min(after, key=lambda x: x[1])
        return {
            "workout_end": self.clock(end),
            "samples": len(after),
            "first": {"time": self.clock(after[0][0]), "bpm": after[0][1]},
            "at_15m": pick(15),
            "at_30m": pick(30),
            "at_60m": pick(60),
            "lowest": {"time": self.clock(lo[0]), "bpm": lo[1]},
            "gaps_over_10m": [
                {"from": self.clock(a), "to": self.clock(b)} for (a, b) in gaps
            ],
        }

    def baseline_mean(self, rows, keys):
        out = {}
        for k in keys:
            vals = [r.get(k) for r in rows if r and self.valid(r.get(k))]
            digits = 0 if k in WHOLE else 1
            m = round(statistics.mean(vals), digits) if vals else None
            out[k] = {
                "mean": int(m) if m is not None and digits == 0 else m,
                "days": len(vals),
            }
        return out

    def tidy(self, value):
        """155.0 같은 값은 155로 쓴다."""
        if isinstance(value, dict):
            return {k: self.tidy(v) for (k, v) in value.items()}
        if isinstance(value, list):
            return [self.tidy(v) for v in value]
        if isinstance(value, float) and value.is_integer():
            return int(value)
        return value

    def build(self):
        inp = self
        m = self.manifest
        (date, yday) = (m["report_date"], m["yesterday"])
        cutoff_dt = self.local_datetime(m["data_cutoff"])
        night = self.sleep_for(inp, date, detail=True)
        if night is None:
            self._note(f"{date} 수면 원본이 없거나 수면 시간이 0이다")
        base_sleep = [self.sleep_for(inp, d) for d in m["baseline_days"]]
        no_sleep = [d for (d, s) in zip(m["baseline_days"], base_sleep) if s is None]
        if no_sleep:
            self._note("직전 7일 중 수면 기록이 없는 날: " + ", ".join(no_sleep))
        sleep_keys = [
            "total_s",
            "deep_s",
            "light_s",
            "rem_s",
            "awake_s",
            "score",
            "awake_count_summary",
            "hr_min",
            "hrv_avg",
            "spo2_min",
            "spo2_avg",
            "resp_avg",
        ]
        sb = self.baseline_mean(base_sleep, sleep_keys)
        for k in ("total_s", "deep_s", "light_s", "rem_s", "awake_s"):
            sb[k]["mean_hm"] = self.hm(sb[k]["mean"])
        sb["sleep_start_mean"] = self.clock_mean([s["_start"] for s in base_sleep if s])
        sb["sleep_end_mean"] = self.clock_mean([s["_end"] for s in base_sleep if s])
        sb["hr_min_time_mean"] = self.clock_mean(
            [s["_hr_min_t"] for s in base_sleep if s]
        )
        yesterday = self.full_day(inp, yday)
        base_days = [self.full_day(inp, d) for d in m["baseline_days"]]
        day_keys = [
            "bb_wake",
            "bb_high",
            "bb_low",
            "bb_charged",
            "bb_drained",
            "stress_avg",
            "stress_high_s",
            "steps",
            "active_kcal",
            "moderate_min",
            "vigorous_min",
            "resting_hr",
        ]
        db = self.baseline_mean(base_days, day_keys)
        db["stress_high_s"]["mean_hm"] = self.hm(db["stress_high_s"]["mean"])
        (sess, _records) = self.workouts(inp, m, cutoff_dt)
        hrv = (inp.day(date, "hrv_data") or {}).get("hrvSummary") or {}
        if not isinstance(hrv, dict):
            self._note(f"{date} hrvSummary: 원본 모양이 다르다")
            hrv = {}
        hrv = self._numbers(hrv, ("lastNightAvg", "weeklyAvg"), f"{date} hrvSummary")
        week = [
            {
                "date": d,
                **{
                    k: (s or {}).get(k)
                    for k in ("total", "score", "hrv_avg", "hr_min", "spo2_min")
                },
                "resting_hr": self.resting_hr(inp, d),
                "bb_wake": self.wake_bb(inp, d),
            }
            for (d, s) in [
                (d, self.sleep_for(inp, d)) for d in m["baseline_days"] + [date]
            ]
        ]
        digest = {
            "about": "측정값만 담는다. 판단은 리포트를 쓰는 쪽이 한다. 시각은 manifest timezone 기준이다.",
            "report_date": date,
            "weekday": m.get("weekday"),
            "yesterday": yday,
            "data_cutoff": m["data_cutoff"],
            "baseline_days": m["baseline_days"],
            "collect": m.get("collect"),
            "sleep": {"last_night": self.public(night), "baseline": sb},
            "day": {
                "yesterday": yesterday,
                "baseline": db,
                "today_morning": self.morning(inp, date, m["data_cutoff"]),
            },
            "workouts": sess,
            "recent_training": self.recent_training(inp, date),
            "body": self.body_and_goal(inp, date),
            "drinks_last_8_days": self.drinks(inp, m["baseline_days"] + [date]),
            "weight": self.weight(m["baseline_days"] + [date], date),
            "recovery": {
                "hrv_last_night": hrv.get("lastNightAvg"),
                "hrv_weekly_avg": hrv.get("weeklyAvg"),
                "hrv_baseline": hrv.get("baseline"),
                "hrv_status": hrv.get("status"),
                "hrv_baseline_7d": sb["hrv_avg"],
                "resting_hr_today": self.resting_hr(inp, date),
                "resting_hr_7d": db["resting_hr"],
            },
            "last_8_days": week,
            "notes": self.notes,
        }
        return self.tidy(digest)


def build(
    manifest: dict, days: dict, activities: dict, labels: dict, body: list
) -> dict:
    """Return fixed measurements from raw dictionaries and validated body sidecars."""
    return _Digest(manifest, days, activities, labels, body).build()


def day_values(date, day_raw, activities, labels, timezone):
    """Return one day's stored measurements using the digest measurement functions."""
    key = str(date)
    engine = _Digest({"timezone": timezone}, {key: day_raw}, activities, labels, [])
    sleep = engine.sleep_for(engine, key) or {}
    full = engine.full_day(engine, key) or {}
    summary = {"date": key}
    for column, source in (
        ("sleep_total_s", "total_s"),
        ("sleep_deep_s", "deep_s"),
        ("sleep_light_s", "light_s"),
        ("sleep_rem_s", "rem_s"),
        ("sleep_awake_s", "awake_s"),
        ("sleep_score", "score"),
        ("sleep_hr_min", "hr_min"),
        ("sleep_hr_min_time", "hr_min_time"),
        ("hrv_avg", "hrv_avg"),
        ("spo2_avg", "spo2_avg"),
        ("spo2_min", "spo2_min"),
        ("resp_avg", "resp_avg"),
    ):
        summary[column] = sleep.get(source)
    for column in (
        "bb_high",
        "bb_low",
        "bb_charged",
        "bb_drained",
        "stress_avg",
        "stress_high_s",
        "steps",
        "active_kcal",
        "moderate_min",
        "vigorous_min",
    ):
        summary[column] = full.get(column)
    summary.update(
        wake_bb=engine.wake_bb(engine, key),
        resting_hr=engine.resting_hr(engine, key),
        weight_kg=engine.weight_for(key),
        drinks_json=(
            json.dumps(logged, ensure_ascii=False)
            if (logged := engine.drinks_for(key)) is not None
            else None
        ),
    )
    records = [
        r
        for i in activities
        if (r := engine.activity_record(engine, i)) and r["date"] == key
    ]
    workouts, exercises = [], []
    for session_no, group in enumerate(engine.sessions(records), 1):
        for rec in group:
            row = {
                c: rec.get(c)
                for c in ("date", "type", "duration_s", "hr_avg", "hr_max")
            }
            row.update(
                activity_id=int(rec["id"]),
                start_ms=int(rec["_start"].timestamp() * 1000),
                session_no=session_no,
                bb_change=rec["bb_end"] - rec["bb_start"]
                if rec["bb_end"] is not None and rec["bb_start"] is not None
                else None,
            )
            row.update(
                {f"zone{i}_s": rec["zones"].get(i, {}).get("s") for i in range(1, 6)}
            )
            workouts.append(row)
            sets = engine.sets_for(engine, rec)
            for name, total in engine.exercise_totals(sets).items():
                selected = [s for s in sets if s["exercise"] == name]
                exercises.append(
                    {
                        "activity_id": int(rec["id"]),
                        **{
                            c: total[c]
                            for c in ("exercise", "sets", "reps", "max_kg", "volume_kg")
                        },
                        "set_peak_hr_avg": engine.mean(
                            [s["set_peak_hr"] for s in selected]
                        ),
                        "rest_drop_avg": engine.mean(
                            [s["drop_in_rest"] for s in selected]
                        ),
                    }
                )
    return {
        "day_summary": summary,
        "workouts": workouts,
        "exercise_logs": exercises,
        "notes": engine.notes,
    }

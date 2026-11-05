[
  {
    "location": "extensions/garmin/src/garmin_pipeline/report.py:220-230",
    "trigger_condition": "intake 또는 scope timeout에서 모델이 후손을 남기면 직접 자식만 종료하고 다음 scope로 진행한다.",
    "guard_snippet": "_end_child_tree(proc)  # 후손 종료까지 확인한 뒤 run_supervised의 후속 scope로 진행",
    "potential_consequence": "감독 정리 전까지 후손이 같은 attempt로 body_runtime을 실행해 입력 생성·후속 분석과 경합할 수 있다."
  }
]

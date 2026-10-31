"""capture 반입과 기존 tracer 경로를 분기한다."""
import json
import os

settings = json.loads(os.environ['BRAIN_SETTINGS_SNAPSHOT'])
if settings.get('values', {}).get('garmin.capture_manifest'):
    from batch_import import run
    run()
else:
    import tracer_import

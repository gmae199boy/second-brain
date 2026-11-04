#!/usr/bin/env python3
import os
from pathlib import Path
import sys
import tempfile
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import charts

with tempfile.TemporaryDirectory() as home:
    version, face = charts.prepare(home)
    from matplotlib import font_manager, ft2font
    font = ft2font.FT2Font(face)
    chars = set('어제 하루 운동 세션 근력 진행 수면 시간 점수 심박 스트레스 평균 바디 배터리 볼륨 날짜 전체 인바디 추이 체중 골격근량 체지방률 종류 미상 기록 못 받음') - {' '}
    missing = sorted(c for c in chars if font.get_char_index(ord(c)) == 0)
    print('face:', face, 'name:', font.family_name, 'matplotlib:',version)
    print('glyphs:', len(chars), 'missing:', ''.join(missing) or 'none')
    assert 'Apple SD Gothic Neo' in font.family_name, 'Apple SD Gothic Neo is unavailable'
    assert not missing
    caught = []
    def draw(fig):
        ax = fig.subplots(); ax.set_title('어제 하루 운동 세션 근력 진행 수면 심박 인바디 추이'); ax.plot([1,2],[3,4],label='체지방률'); ax.legend(); return True
    result = charts.render_one(home,'font.png',(12,6),draw, warning_records=caught)
    assert result and result[0].stat().st_mode & 0o777 == 0o600
    missing_warnings = [w for w in caught if 'Glyph' in str(w.message) and 'missing' in str(w.message)]
    print('missing glyph warnings:',len(missing_warnings))
    assert not missing_warnings
    assert (Path(home)/'.matplotlib').stat().st_mode & 0o777 == 0o700

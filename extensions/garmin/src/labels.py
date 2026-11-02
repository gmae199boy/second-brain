"""Load the shared Korean exercise labels."""
import json
from pathlib import Path

def load():
    return json.loads((Path(__file__).parent / "labels" / "exercise_types_ko.json").read_text(encoding="utf-8"))

"""Load the shared Korean exercise labels."""
import json
from pathlib import Path

def load_bytes():
    """Read one exact resource snapshot for both parsing and revision hashing."""
    return (Path(__file__).parent / "labels" / "exercise_types_ko.json").read_bytes()


def load(data=None):
    return json.loads(load_bytes() if data is None else data)

"""The legacy standalone entry point cannot bypass the extension supervisor."""


def main(argv=None):
    del argv
    raise RuntimeError("Standalone Garmin CLI is disabled; use supervised extension work")

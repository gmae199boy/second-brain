"""프로젝트의 실제 티켓 CLI로 에픽 built 의존조건을 검증한다."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[3]
CLI = REPO / "_bmad/method/scripts/tickets.py"


class EpicBuiltTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "initiative-test"
        (self.root / "tickets").mkdir(parents=True)
        (self.root / "tickets/tickets.toml").write_text(
            '[[epic]]\nid = 1\nslug = "epic-first"\n'
            '[[epic]]\nid = 2\nslug = "epic-second"\n'
        )
        for name in ("epic-first", "epic-second"):
            folder = self.root / "tickets" / name
            (folder / "tickets").mkdir(parents=True)
            (folder / "tickets/tickets.toml").write_text(
                '[[entry]]\nid = 1\ntype = "story"\ntitle = "시험"\n'
            )
        self.epic("in-progress")

    def epic(self, status, after='["epic-first"]', blocked=""):
        first = self.root / "tickets/epic-first"
        (first / "epic-first.md").write_text(
            f'---\ntype: epic\nstatus: {status}\n{blocked}---\n'
        )
        second = self.root / "tickets/epic-second"
        (second / "epic-second.md").write_text(
            f'---\ntype: epic\nstatus: in-progress\nafter: {after}\n---\n'
        )

    def run_cli(self, command="next"):
        result = subprocess.run(
            [sys.executable, str(CLI), command, str(self.root)],
            capture_output=True, text=True, cwd=REPO,
        )
        return result, json.loads(result.stdout) if result.stdout.strip() else {"error": result.stderr}

    def test_built_and_done_epics_unlock_next_epic_without_becoming_done(self):
        for status in ("built", "done"):
            with self.subTest(status=status):
                self.epic(status)
                result, data = self.run_cli()
                self.assertEqual(result.returncode, 0, data)
                self.assertIn("2.1", [t["ref"] for t in data["ready_to_start"]])
                result, data = self.run_cli("status")
                self.assertEqual(data["epics"][0]["status"], status)
                self.assertFalse(data.get("problems"))

    def test_incomplete_or_dropped_epic_does_not_unlock(self):
        for status in ("in-progress", "dropped", ""):
            with self.subTest(status=status):
                self.epic(status)
                result, data = self.run_cli()
                self.assertEqual(result.returncode, 0, data)
                row = next(t for t in data["blocked"] if t["ref"] == "2.1")
                self.assertIn("epic-first", row["waiting_on"])

    def test_in_review_and_blocked_are_not_valid_epic_statuses(self):
        for status in ("in-review", "blocked"):
            with self.subTest(status=status):
                self.epic(status)
                result, data = self.run_cli()
                self.assertNotEqual(result.returncode, 0, data)

    def test_unresolved_blocked_fields_override_built_or_done(self):
        for status in ("built", "done"):
            for field in ("blocked_at: 2026-11-02\n", "blocked_reason: 미해결\n"):
                with self.subTest(status=status, field=field):
                    self.epic(status, blocked=field)
                    result, data = self.run_cli()
                    self.assertEqual(result.returncode, 0, data)
                    self.assertIn("2.1", [t["ref"] for t in data["blocked"]])

    def test_epic_gate_on_leaf_requires_built_or_done(self):
        plan = self.root / "tickets/epic-first/tickets/story-test-plan.md"
        for status in ("built", "done", "in-review", "blocked", "dropped"):
            with self.subTest(status=status):
                self.epic("in-progress", after='["1.1"]')
                plan.write_text(f'---\nticket: 1\nstatus: {status}\n---\n')
                result, data = self.run_cli()
                self.assertEqual(result.returncode, 0, data)
                ready = [t["ref"] for t in data["ready_to_start"]]
                self.assertEqual("2.1" in ready, status in ("built", "done"))

    def test_explicit_leaf_after_built_epic_is_satisfied(self):
        self.epic("built", after="[]")
        breakdown = self.root / "tickets/epic-second/tickets/tickets.toml"
        with breakdown.open("a") as stream:
            stream.write('after = ["epic-first"]\n')
        result, data = self.run_cli()
        self.assertEqual(result.returncode, 0, data)
        self.assertIn("2.1", [t["ref"] for t in data["ready_to_start"]])

    def test_normal_leaf_after_still_accepts_review(self):
        self.epic("in-progress", after="[]")
        (self.root / "tickets/epic-first/tickets/story-test-plan.md").write_text(
            '---\nticket: 1\nstatus: in-review\n---\n'
        )
        breakdown = self.root / "tickets/epic-second/tickets/tickets.toml"
        with breakdown.open("a") as stream:
            stream.write('after = ["1.1"]\n')
        result, data = self.run_cli()
        self.assertEqual(result.returncode, 0, data)
        self.assertIn("2.1", [t["ref"] for t in data["ready_to_start"]])

    def test_initiative_built_is_not_introduced(self):
        first = self.root / "tickets/epic-first/epic-first.md"
        first.write_text('---\ntype: initiative\nstatus: built\n---\n')
        result, data = self.run_cli()
        self.assertNotEqual(result.returncode, 0, data)


if __name__ == "__main__":
    unittest.main()

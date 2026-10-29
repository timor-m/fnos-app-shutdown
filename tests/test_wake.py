import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import stat
from types import SimpleNamespace
from contextlib import ExitStack
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('wake', ROOT / 'scripts/wake-runtime.py')
wake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wake)


def config(**extra):
    value = dict(version=1, enabled=True, device='auto', alarm_policy='preserve', plans=[dict(id='morning', enabled=True, time='08:00', weekdays=list(range(7)), note='早上')])
    value.update(extra)
    return value


class ScheduleTests(unittest.TestCase):
    def setUp(self):
        self.previous = os.environ.get('TZ')
        os.environ['TZ'] = 'Asia/Shanghai'
        time.tzset()
        self.addCleanup(self.restore)

    def restore(self):
        if self.previous is None:
            os.environ.pop('TZ', None)
        else:
            os.environ['TZ'] = self.previous
        time.tzset()

    def test_weekdays_and_week_boundary(self):
        c = config()
        c['plans'][0]['weekdays'] = [1]
        now = dt.datetime(2026, 10, 26, 8).timestamp()  # Monday exactly at time
        self.assertEqual(wake.events(c, now)[0]['at'][:16], '2026-11-02T08:00')

    def test_disabled_and_earliest(self):
        c = config()
        c['plans'].append(dict(id='earlier', enabled=True, time='06:00', weekdays=list(range(7)), note=''))
        now = dt.datetime(2026, 10, 29, 5).timestamp()
        self.assertEqual(wake.events(c, now)[0]['id'], 'earlier')
        c['plans'][1]['enabled'] = False
        self.assertEqual(wake.events(c, now)[0]['id'], 'morning')

    def test_conflict(self):
        c = config()
        c['plans'].append(dict(c['plans'][0], id='duplicate'))
        with self.assertRaisesRegex(ValueError, '重复'):
            wake.validate(c)
        c['plans'][1]['enabled'] = False
        wake.validate(c)

    def test_strict_types_and_paths(self):
        for change in (dict(enabled='false'), dict(device='../rtc0'), dict(version=True), dict(alarm_policy='exec'), dict(plans={})):
            with self.subTest(change=change), self.assertRaises(ValueError):
                wake.validate(config(**change))
        for change in (dict(weekdays=[True]), dict(weekdays=[]), dict(weekdays=[1, 1]), dict(time='24:00'), dict(note='x\ny'), dict(id='$(cmd)')):
            c = config(); c['plans'][0].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                wake.validate(c)

    def test_dst_gap_and_fold(self):
        os.environ['TZ'] = 'America/New_York'; time.tzset()
        c = config(); c['plans'][0]['time'] = '02:30'
        result = wake.events(c, dt.datetime(2026, 3, 8, 0).timestamp())
        self.assertEqual(result[0]['at'][:10], '2026-03-09')
        c['plans'][0]['time'] = '01:30'
        result = wake.events(c, dt.datetime(2026, 11, 1, 0).timestamp())
        self.assertEqual(sum(e['at'].startswith('2026-11-01') for e in result), 1)
        # After the first fold we do not execute a second alarm at the same wall time.
        result = wake.events(c, dt.datetime(2026, 11, 1, 1, 45, fold=0).timestamp())
        self.assertEqual(result[0]['at'][:10], '2026-11-02')


    def test_weekly_dst_gap_keeps_next_wake_beyond_preview(self):
        os.environ['TZ'] = 'America/New_York'; time.tzset()
        c = config(); c['plans'][0].update(time='02:30', weekdays=[0])
        now = dt.datetime(2026, 3, 2, 12).timestamp()
        expected = int(dt.datetime(2026, 3, 15, 2, 30).timestamp())
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'status.json'
            rtc = unittest.mock.Mock()
            rtc.devices.return_value = [dict(id='rtc0', available=True)]
            rtc.offset.return_value = 0
            rtc.alarm.return_value = 0
            scheduler = wake.Scheduler(rtc, state)
            scheduler.sync(c, now=now, preparing=True)
            rtc.set.assert_called_once_with('rtc0', expected)
            with patch.object(wake.time, 'time', return_value=now), patch.object(wake, 'STATE', state), patch.object(wake, 'Rtc', return_value=rtc):
                result = wake.inspect(c)
            self.assertEqual(result['preview'], [])
            self.assertEqual(result['next_wake']['timestamp'], expected)


class RtcTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.rtc = wake.Rtc(self.root)
        self.now = 1793203200
        self.clock = patch.object(wake.time, 'time', return_value=self.now)
        self.clock.start(); self.addCleanup(self.clock.stop)
        self.device('rtc0')
        self.state = self.root / 'state.json'
        self.scheduler = wake.Scheduler(self.rtc, self.state)

    def device(self, name, offset=0):
        path = self.root / name; path.mkdir()
        (path / 'name').write_text('mock RTC')
        (path / 'since_epoch').write_text(str(self.now + offset))
        (path / 'wakealarm').write_text('0')

    def test_offset_and_missing_clock(self):
        (self.root / 'rtc0/since_epoch').write_text(str(self.now + 28800))
        self.assertEqual(self.rtc.offset('rtc0'), 28800)
        (self.root / 'rtc0/since_epoch').unlink()
        with self.assertRaises(OSError): self.rtc.offset('rtc0')
        self.assertFalse(self.rtc.devices()[0]['available'])

    def test_abnormal_clock_rejected(self):
        for delta in (300, 90000):
            (self.root / 'rtc0/since_epoch').write_text(str(self.now + delta))
            with self.assertRaises(ValueError): self.rtc.offset('rtc0')

    def test_arm_readback_and_no_redundant_writes(self):
        with patch.object(self.rtc, 'set', wraps=self.rtc.set) as setter:
            self.scheduler.sync(config(), now=self.now)
            self.scheduler.sync(config(), now=self.now)
            self.assertEqual(setter.call_count, 1)
        self.assertEqual(self.rtc.alarm('rtc0'), self.scheduler.state['owned']['alarm'])
        self.assertEqual(json.loads(self.state.read_text())['result'], 'armed')

    def test_foreign_alarm_preserved_and_explicit_takeover(self):
        foreign = self.now + 3600
        self.rtc.write('rtc0', foreign)
        with self.assertRaisesRegex(ValueError, '其他程序'):
            self.scheduler.sync(config(), now=self.now)
        self.assertEqual(self.rtc.alarm('rtc0'), foreign)
        self.scheduler.sync(config(alarm_policy='replace'), now=self.now)
        self.assertNotEqual(self.rtc.alarm('rtc0'), foreign)

    def test_external_change_after_ownership(self):
        self.scheduler.sync(config(), now=self.now)
        self.rtc.write('rtc0', self.now + 60)
        with self.assertRaisesRegex(ValueError, '其他程序'):
            self.scheduler.sync(config(), now=self.now)
        self.scheduler.sync(config(enabled=False), now=self.now)
        self.assertEqual(self.rtc.alarm('rtc0'), self.now + 60)
        self.assertNotIn('owned', self.scheduler.state)

    def test_disable_clears_only_own_alarm(self):
        self.scheduler.sync(config(), now=self.now)
        self.scheduler.sync(config(enabled=False), now=self.now)
        self.assertEqual(self.rtc.alarm('rtc0'), 0)
        self.assertEqual(self.scheduler.state['result'], 'disabled')

    def test_empty_plans_clear(self):
        self.scheduler.sync(config(), now=self.now)
        self.scheduler.sync(config(plans=[]), now=self.now)
        self.assertEqual(self.rtc.alarm('rtc0'), 0)

    def test_multiple_devices_require_choice_and_switch_cleans_old(self):
        self.device('rtc1')
        with self.assertRaisesRegex(ValueError, '多个'):
            self.scheduler.sync(config(), now=self.now)
        self.scheduler.sync(config(device='rtc0'), now=self.now)
        self.scheduler.sync(config(device='rtc1'), now=self.now)
        self.assertEqual(self.rtc.alarm('rtc0'), 0)
        self.assertGreater(self.rtc.alarm('rtc1'), self.now)

    def test_switch_conflict_preserves_old_alarm(self):
        self.device('rtc1')
        self.scheduler.sync(config(device='rtc0'), now=self.now)
        owned = self.scheduler.state['owned'].copy()
        self.rtc.write('rtc1', self.now + 3600)
        with self.assertRaisesRegex(ValueError, '其他程序'):
            self.scheduler.sync(config(device='rtc1'), now=self.now)
        self.assertEqual(self.rtc.alarm('rtc0'), owned['alarm'])
        self.assertEqual(self.rtc.alarm('rtc1'), self.now + 3600)
        self.assertEqual(self.scheduler.state['owned'], owned)

    def test_switch_write_failure_preserves_old_alarm(self):
        self.device('rtc1')
        self.scheduler.sync(config(device='rtc0'), now=self.now)
        owned = self.scheduler.state['owned'].copy()
        original = self.rtc.write
        def fail_new(device, value):
            if device == 'rtc1' and value: raise OSError('write failed')
            original(device, value)
        with patch.object(self.rtc, 'write', side_effect=fail_new):
            with self.assertRaises(OSError):
                self.scheduler.sync(config(device='rtc1'), now=self.now)
        self.assertEqual(self.rtc.alarm('rtc0'), owned['alarm'])
        self.assertEqual(self.rtc.alarm('rtc1'), 0)
        self.assertEqual(self.scheduler.state['owned'], owned)

    def test_switch_cleanup_failure_rolls_back_new_device(self):
        self.device('rtc1')
        self.scheduler.sync(config(device='rtc0'), now=self.now)
        owned = self.scheduler.state['owned'].copy()
        foreign = self.now + 3600
        self.rtc.write('rtc1', foreign)
        original = self.rtc.write
        def fail_clear(device, value):
            if device == 'rtc0' and value == 0: raise OSError('clear failed')
            original(device, value)
        with patch.object(self.rtc, 'write', side_effect=fail_clear):
            with self.assertRaisesRegex(ValueError, '恢复失败'):
                self.scheduler.sync(config(device='rtc1', alarm_policy='replace'), now=self.now)
        self.assertEqual(self.rtc.alarm('rtc0'), owned['alarm'])
        self.assertEqual(self.rtc.alarm('rtc1'), foreign)
        self.assertEqual(self.scheduler.state['owned'], owned)

    def test_failed_write_restores_previous_alarm(self):
        self.rtc.write('rtc0', self.now + 600)
        original = self.rtc.write
        def fail_new(device, value):
            if value == self.now + 800: raise OSError('write failed')
            return original(device, value)
        with patch.object(self.rtc, 'write', side_effect=fail_new):
            with self.assertRaises(OSError): self.rtc.set('rtc0', self.now + 800)
        self.assertEqual(self.rtc.alarm('rtc0'), self.now + 600)

    def test_readback_mismatch_restores(self):
        self.rtc.write('rtc0', self.now + 600)
        original = self.rtc.write
        def ignore_new(device, value):
            if value != self.now + 800: original(device, value)
        with patch.object(self.rtc, 'write', side_effect=ignore_new):
            with self.assertRaisesRegex(ValueError, '读回'):
                self.rtc.set('rtc0', self.now + 800)
        self.assertEqual(self.rtc.alarm('rtc0'), self.now + 600)

    def test_prepare_near_alarm_blocks_shutdown(self):
        near = [dict(timestamp=self.now + 30, at='soon', id='x', note='')]
        with patch.object(wake, 'events', return_value=near):
            with self.assertRaisesRegex(ValueError, '不足 2 分钟'):
                self.scheduler.sync(config(), now=self.now, preparing=True)
        self.assertEqual(self.rtc.alarm('rtc0'), self.now + 30)

    def test_json_rejects_symlinks_fifo_and_large_file(self):
        target = self.root / 'config.json'; target.write_text('{}')
        link = self.root / 'link'; link.symlink_to(target)
        with self.assertRaises(OSError): wake.read_json(link)
        fifo = self.root / 'fifo'; os.mkfifo(fifo)
        with self.assertRaises(ValueError): wake.read_json(fifo)
        target.write_text(' ' * 65537)
        with self.assertRaises(ValueError): wake.read_json(target)

    def test_failed_restore_is_reported(self):
        with patch.object(self.rtc, 'write', side_effect=OSError('read only')):
            with self.assertRaisesRegex(ValueError, '恢复失败'):
                self.rtc.set('rtc0', self.now + 800)



class LifecycleTests(unittest.TestCase):
    setUp = RtcTests.setUp
    device = RtcTests.device

    def invoke(self, mode, data_dir):
        original_open = os.open
        original_lstat = Path.lstat
        def open_file(path, flags, *args, **kwargs):
            if str(path) == '/run/fnos-shutdown-wake.lock':
                path = self.root / 'wake.lock'
            return original_open(path, flags, *args, **kwargs)
        def metadata(path, *args, **kwargs):
            if path == self.root:
                return SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0)
            return original_lstat(path, *args, **kwargs)
        with ExitStack() as stack:
            for replacement in (
                patch.object(wake, 'STATE', self.state),
                patch.object(wake, 'anchored_data', return_value=data_dir),
                patch.object(wake, 'Scheduler', return_value=self.scheduler),
                patch.object(wake, 'Rtc', return_value=self.rtc),
                patch.object(wake.os, 'geteuid', return_value=0),
                patch.object(wake.os, 'open', side_effect=open_file),
                patch.object(Path, 'lstat', metadata),
            ): stack.enter_context(replacement)
            wake.main(mode)

    def test_missing_data_directory_releases_alarm(self):
        self.scheduler.sync(config(), now=self.now)
        self.invoke('tick', self.root / 'removed-volume')
        self.assertEqual(self.rtc.alarm('rtc0'), 0)

    def test_corrupt_configuration_releases_alarm_and_reports_error(self):
        self.scheduler.sync(config(), now=self.now)
        (self.root / 'wake.json').write_text('{broken')
        with self.assertRaises(ValueError): self.invoke('tick', self.root)
        self.assertEqual(self.rtc.alarm('rtc0'), 0)
        self.assertEqual(json.loads(self.state.read_text())['result'], 'error')

    def test_queued_tick_cannot_rearm_after_uninstall(self):
        (self.root / 'wake.json').write_text(json.dumps(config()))
        self.invoke('tick', self.root)
        self.invoke('clear', self.root)
        with self.assertRaisesRegex(ValueError, '卸载或暂停'):
            self.invoke('tick', self.root)
        self.assertEqual(self.rtc.alarm('rtc0'), 0)
        self.invoke('resume', self.root)
        self.invoke('tick', self.root)
        self.assertGreater(self.rtc.alarm('rtc0'), self.now)

    def test_prepare_failure_persists_visible_error(self):
        (self.root / 'wake.json').write_text(json.dumps(config()))
        self.rtc.write('rtc0', self.now + 100)
        with self.assertRaisesRegex(ValueError, '其他程序'):
            self.invoke('prepare', self.root)
        self.assertEqual(json.loads(self.state.read_text())['result'], 'error')
        self.assertEqual(self.rtc.alarm('rtc0'), self.now + 100)


class EmbeddedTests(unittest.TestCase):
    def test_signed_shell_contains_same_runtime_and_validates_stdin(self):
        subprocess.run(['node', 'scripts/embed-wake.mjs', '--check'], cwd=ROOT, check=True)
        result = subprocess.run(['/bin/bash', str(ROOT / 'packages/server/assets/fnos-shutdown-executor.sh'), '--wake-validate'], input=json.dumps(config()), text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), wake.validate(config()))

    def test_rejects_extra_arguments(self):
        result = subprocess.run(['/bin/bash', str(ROOT / 'packages/server/assets/fnos-shutdown-executor.sh'), '--wake-tick', '/tmp/evil'], capture_output=True)
        self.assertEqual(result.returncode, 3)


if __name__ == '__main__': unittest.main()

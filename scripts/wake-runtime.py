"""RTC scheduling runtime. Embedded in the signed executor; no third-party imports.
All privileged paths are fixed. Test doubles are constructor arguments, never environment flags.
"""
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time

VERSION = "1.1.0"
LIMIT = 65536
STATE = Path('/var/lib/fnos-shutdown-wake/status.json')
ANCHOR = Path('/etc/fnos-shutdown-data-dir')
DEFAULT = dict(version=1, enabled=False, device='auto', alarm_policy='preserve', plans=[])


def validate(value):
    def need(ok, message):
        if not ok:
            raise ValueError(message)
    need(isinstance(value, dict), '开机配置必须为对象')
    need(type(value.get('version')) is int and value['version'] == 1, '不支持的开机配置版本')
    need(type(value.get('enabled')) is bool, '总开关必须为布尔值')
    device = value.get('device')
    need(isinstance(device, str) and (device == 'auto' or re.fullmatch(r'rtc[0-9]{1,3}', device)), 'RTC 设备无效')
    need(value.get('alarm_policy') in ('preserve', 'replace'), '闹钟冲突策略无效')
    plans = value.get('plans')
    need(isinstance(plans, list) and len(plans) <= 64, '最多配置 64 个开机计划')
    ids, slots, cleaned = set(), {}, []
    for p in plans:
        need(isinstance(p, dict), '计划必须为对象')
        ident = p.get('id')
        need(isinstance(ident, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,64}', ident) and ident not in ids, '计划 ID 无效或重复')
        ids.add(ident)
        need(type(p.get('enabled')) is bool, '计划开关必须为布尔值')
        clock = p.get('time')
        need(isinstance(clock, str) and re.fullmatch(r'(?:[01][0-9]|2[0-3]):[0-5][0-9]', clock), '请输入合法的开机时间')
        days = p.get('weekdays')
        need(isinstance(days, list) and 1 <= len(days) <= 7 and all(type(d) is int and 0 <= d <= 6 for d in days) and len(set(days)) == len(days), '请选择不重复的星期（0–6）')
        note = p.get('note', '')
        need(isinstance(note, str) and len(note) <= 120 and not any(ord(c) < 32 for c in note), '备注最多 120 字，不能包含控制字符')
        if p['enabled']:
            for day in days:
                slot = (day, clock)
                need(slot not in slots, '启用计划在同一星期和时间重复，请调整或停用其中一条')
                slots[slot] = ident
        cleaned.append(dict(id=ident, enabled=p['enabled'], time=clock, weekdays=sorted(days), note=note))
    return dict(version=1, enabled=value['enabled'], device=device, alarm_policy=value['alarm_policy'], plans=cleaned)


def events(config, now=None, days=7):
    """Local wall times use libc timezone rules per date, including DST.
    Nonexistent DST times are skipped; ambiguous times execute once (earliest future fold).
    """
    now = time.time() if now is None else now
    start = dt.datetime.fromtimestamp(now).date()
    result = []
    for offset in range(days + 1):
        day = start + dt.timedelta(days=offset)
        for plan in config['plans']:
            if not plan['enabled'] or (day.weekday() + 1) % 7 not in plan['weekdays']:
                continue
            hour, minute = map(int, plan['time'].split(':'))
            wall = dt.datetime(day.year, day.month, day.day, hour, minute)
            candidates = {wall.replace(fold=f).timestamp() for f in (0, 1)}
            candidates = [t for t in candidates if dt.datetime.fromtimestamp(t) == wall]
            # Pick the first fold even if it has passed: no double execution that day.
            timestamp = min(candidates) if candidates else 0
            if timestamp > now:
                result.append(dict(id=plan['id'], note=plan['note'], timestamp=int(timestamp), at=dt.datetime.fromtimestamp(timestamp).astimezone().isoformat()))
    return sorted(result, key=lambda item: (item['timestamp'], item['id']))


def read_json(path, default=None):
    try:
        fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        if default is not None:
            return default
        raise
    with os.fdopen(fd, 'rb') as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError('配置或状态必须为普通文件')
        data = handle.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError('配置或状态超过 64 KiB')
    return json.loads(data)


def atomic_json(path, value):
    fd, name = tempfile.mkstemp(prefix='.wake-', dir=str(path.parent))
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump(value, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(name, 0o644)
        os.replace(name, path)
        directory = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class Rtc:
    def __init__(self, root=Path('/sys/class/rtc')):
        self.root = root

    def path(self, device, name):
        if not re.fullmatch(r'rtc[0-9]{1,3}', device):
            raise ValueError('RTC 设备名无效')
        return self.root / device / name

    def alarm(self, device):
        return int(self.path(device, 'wakealarm').read_text().strip() or '0')

    def offset(self, device):
        before = time.time()
        raw = int(self.path(device, 'since_epoch').read_text().strip())
        delta = raw - (before + time.time()) / 2
        rounded = round(delta / 900) * 900
        if abs(rounded) > 14 * 3600 or abs(delta - rounded) > 120:
            raise ValueError('RTC 与系统时钟偏差异常，请先校准系统时间和硬件时钟')
        return rounded

    def write(self, device, value):
        self.path(device, 'wakealarm').write_text(str(value) + '\n')

    def set(self, device, value):
        old = self.alarm(device)
        try:
            self.write(device, 0)
            if value:
                self.write(device, value)
            if self.alarm(device) != value:
                raise ValueError('RTC 闹钟写入后的读回值不一致')
        except Exception as exc:
            try:
                self.write(device, 0)
                if old:
                    self.write(device, old)
            except Exception as restore:
                raise ValueError('RTC 写入失败且旧闹钟恢复失败：%s；%s' % (exc, restore)) from exc
            raise

    def devices(self):
        result = []
        for path in sorted(self.root.glob('rtc*')):
            if not re.fullmatch(r'rtc[0-9]{1,3}', path.name):
                continue
            entry = dict(id=path.name, name=path.name, available=False, alarm=None, offset=None, error=None)
            try:
                entry['name'] = (path / 'name').read_text().strip()
            except OSError:
                pass
            try:
                entry['alarm'] = self.alarm(path.name)
                entry['offset'] = self.offset(path.name)
                entry['available'] = True
            except (OSError, ValueError) as exc:
                entry['error'] = str(exc)
            result.append(entry)
        return result


class Scheduler:
    def __init__(self, rtc, state_path=STATE):
        self.rtc = rtc
        self.path = state_path
        self.state = read_json(state_path, {})
        if not isinstance(self.state, dict):
            raise ValueError('开机执行器状态损坏；请检查 root 状态文件')

    def save(self):
        self.state['version'] = VERSION
        self.state['checked_at'] = dt.datetime.now().astimezone().isoformat()
        atomic_json(self.path, self.state)

    def record(self, message):
        history = self.state.get('history', [])
        if not isinstance(history, list):
            history = []
        if not history or history[0].get('message') != message:
            history.insert(0, dict(at=dt.datetime.now().astimezone().isoformat(), message=message))
        self.state['history'] = history[:30]

    def release(self):
        owned = self.state.get('owned')
        if owned:
            # Never erase another program's alarm, even when disabled or uninstalled.
            if self.rtc.alarm(owned['device']) == owned['alarm']:
                self.rtc.set(owned['device'], 0)
            self.state.pop('owned', None)
        self.state['next_wake'] = None

    def sync(self, config, now=None, preparing=False):
        now = time.time() if now is None else now
        self.state['applied_config'] = config
        if not config['enabled'] or not any(p['enabled'] for p in config['plans']):
            self.release()
            self.state['result'] = 'disabled'
            self.state['error'] = None
            self.record('开机计划已停用，已释放本应用持有的闹钟')
            self.save()
            return
        # A weekly occurrence can disappear in a DST gap; include the next week.
        candidates = events(config, now, days=14)
        if not candidates:
            raise ValueError('无法计算下一次开机时间')
        target = candidates[0]['timestamp']
        devices = self.rtc.devices()
        available = [d['id'] for d in devices if d['available']]
        selected = config['device']
        if selected == 'auto':
            if len(available) != 1:
                raise ValueError('未发现可用 RTC' if not available else '发现多个 RTC，请手动选择唤醒设备')
            selected = available[0]
        if selected not in available:
            raise ValueError('所选 RTC 不可用，请检查接口、权限和时钟偏差')
        offset = self.rtc.offset(selected)
        raw_target = target + offset
        owned = self.state.get('owned')
        switching = owned and owned['device'] != selected
        current = self.rtc.alarm(selected)
        own_current = owned and owned['device'] == selected and owned['alarm'] == current
        # Ignore already-expired alarms; kernel drivers may keep their old value.
        foreign = current > now + offset and not own_current
        if foreign and config['alarm_policy'] != 'replace':
            raise ValueError('RTC 已有其他程序的闹钟；已保留，请取消外部计划或明确选择接管')
        if current != raw_target or not own_current:
            self.rtc.set(selected, raw_target)
        if switching:
            # Keep the working alarm until the replacement has passed readback.
            try:
                self.release()
            except Exception as exc:
                try:
                    # Do not overwrite an alarm changed by another program.
                    if self.rtc.alarm(selected) == raw_target:
                        self.rtc.set(selected, current)
                except Exception as restore:
                    raise ValueError('RTC 切换失败且新设备闹钟恢复失败：%s；%s' % (exc, restore)) from exc
                raise
        self.state.update(owned=dict(device=selected, alarm=raw_target), next_wake=target, offset=offset, result='armed', error=None)
        self.record('闹钟已写入并读回校验：%s · %s' % (selected, candidates[0]['at']))
        self.save()
        if preparing and target - now < 120:
            raise ValueError('距离开机时间不足 2 分钟，本次自动关机已阻止，请稍后重试')


def anchored_data():
    meta = ANCHOR.lstat()
    if not stat.S_ISREG(meta.st_mode) or meta.st_uid != 0 or meta.st_gid != 0 or stat.S_IMODE(meta.st_mode) != 0o600:
        raise ValueError('请重新部署：数据目录锚点必须为 root:root 600 普通文件')
    raw = ANCHOR.read_text().strip()
    path = Path(raw)
    if not path.is_absolute() or str(path) == '/' or '\n' in raw or '\r' in raw:
        raise ValueError('数据目录锚点无效')
    return path


def inspect(config):
    state, status_error = None, None
    try:
        state = read_json(STATE, {})
    except (OSError, ValueError) as exc:
        status_error = str(exc)
    now = time.time()
    # Next wake may lie beyond the preview when this week's wall time is skipped.
    future = events(config, now, days=14)
    end = (dt.datetime.fromtimestamp(now) + dt.timedelta(days=7)).timestamp()
    return dict(config=config, devices=Rtc().devices(), preview=[e for e in future if e['timestamp'] < end], next_wake=future[0] if future else None,
                state=state, status_error=status_error, timezone=dt.datetime.now().astimezone().tzname(),
                server_time=dt.datetime.now().astimezone().isoformat(),
                installed=Path('/etc/cron.d/fnos-shutdown-wake').is_file() and Path('/etc/systemd/system/fnos-shutdown-wake.service').is_file())


def main(mode):
    if mode in ('inspect', 'validate'):
        raw = sys.stdin.buffer.read(LIMIT + 1)
        if len(raw) > LIMIT:
            raise ValueError('配置超过 64 KiB')
        config = validate(json.loads(raw))
        print(json.dumps(inspect(config) if mode == 'inspect' else config, ensure_ascii=False))
        return
    if mode not in ('tick', 'prepare', 'clear', 'resume') or os.geteuid() != 0:
        raise ValueError('非法调用或没有 root 权限')
    import signal
    def timeout(_signum, _frame):
        raise TimeoutError('等待 RTC 同步锁超时')
    signal.signal(signal.SIGALRM, timeout)
    # O_NOFOLLOW avoids following a pre-created lock symlink.
    fd = os.open('/run/fnos-shutdown-wake.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lock:
        signal.alarm(15)
        fcntl.flock(lock, fcntl.LOCK_EX)
        signal.alarm(0)
        STATE.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        meta = STATE.parent.lstat()
        if not stat.S_ISDIR(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o022:
            raise ValueError('RTC 状态目录必须为 root 所有且不可被其他用户写入')
        scheduler = Scheduler(Rtc())
        try:
            if mode == 'resume':
                scheduler.state['suspended'] = False
                scheduler.save()
                return
            if mode == 'clear':
                scheduler.state['suspended'] = True
                scheduler.release()
                scheduler.state.update(result='disabled', error=None)
                scheduler.save()
                return
            if scheduler.state.get('suspended'):
                raise ValueError('开机执行器已卸载或暂停，请重新部署')
            try:
                data_dir = anchored_data()
                config = validate(read_json(data_dir / 'wake.json', DEFAULT.copy()))
            except Exception:
                scheduler.release()
                raise
            scheduler.sync(config, preparing=mode == 'prepare')
        except Exception as exc:
            scheduler.state.update(result='error', error=str(exc))
            scheduler.record(str(exc))
            scheduler.save()
            raise


if __name__ == '__main__':
    try:
        main(sys.argv[1])
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)

#!/bin/bash
# fnos-shutdown-executor.sh — fnOS「智能关机」root 执行器
#
# 实现依据：fnos-app-shutdown 执行器 ↔ 应用 协作契约 v0.11
#   §3.0–§3.4 文件接口 / §4.1–§4.6 行为规约 / §6 错误处理矩阵
#
# 测试钩子（未列入契约，仅供本机开发联调；默认值与契约 §3.0 一致）：
#   FNOS_SHUTDOWN_DATA_DIR   必填的数据目录（由部署命令写入 cron）
#   FNOS_SHUTDOWN_LOCK_FILE  覆盖锁文件路径（默认 /run/fnos-shutdown.lock），便于非 root 测试

# shellcheck disable=SC2317
# SC2317 豁免理由：check_cpu/check_load/.../net_byte_sum 等函数经 run_all_checks 与 dry_run 中的
# 动态调用（"check_$c"）间接执行，shellcheck 无法跟踪动态分派，误报 unreachable；
# num_le/num_lt 仅被这些检查函数调用，故被级联误报。以上均为 info 级，无真实问题。

set -u

SCRIPT_VERSION="1.0.4"

DATA_DIR="${FNOS_SHUTDOWN_DATA_DIR:-}"
EXEC_DIR=""
CONFIG_FILE=""
SKIP_FILE=""
STATUS_FILE=""
LOCK_FILE="${FNOS_SHUTDOWN_LOCK_FILE:-/run/fnos-shutdown.lock}"

# §3.6 签名自更新：cron root 触发时对比包内脚本版本，验签通过才原子替换自身。
# 信任锚 = 首次 sudo 部署时锚定的内嵌公钥；包内脚本+签名应用用户可写，无私钥无法伪造。
APP_SRC_SCRIPT="${FNOS_SHUTDOWN_SOURCE_SCRIPT:-/var/apps/fnos-app-shutdown/target/server/assets/fnos-shutdown-executor.sh}"
SELF_UPDATE_PUBKEY='-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAz0OpkCGIAh2WNtA0Hg/K
ThPzqdREVLq6IbQZc3pHZZUcRnE0kWg4X3IORhVPzbr6hHmlPtgTGmM9aVX+2buk
yEhJKQx4T84zp6lraH+Eh07q631+ZDrgh700/b7t5hCky+N6lT9lY7jGs+rN6O/Q
Crx91DGU6ilfFR3Me3a8wDs6etoH2ovXTp79W/MOGRSh2wjH5qqcgYJTmy6D7E8p
/4sztnWED2brRCsFiQsq6DCP/ZKjd9ybQm3HLHdxXH7yBCOPLO+cwRCBzmnAv0jA
c+9ovrGXfIlXhf62el2RzDDKqWvehVAfFNIWv//zgoyepu5GjAemIhxWvPkl91F8
7GPERNiZsywc0hQsvZkslsq+BTRaMKq+YON5Oyx+iDRiPp8zlN8iGKSy0riYoHer
pF7AighYSbtMxEurzkA5H1q7zfJhglgdFqeA9GmoMUwJ/t7Q6Q3oVHu2MLzbFUF8
/3H6oLIa3xWCg+jaxRxxTt6VDIjbJI2LEtjsKLLTJVyZAgMBAAE=
-----END PUBLIC KEY-----'

umask 022
DRY_RUN=0
CONFIG_FALLBACK=false

# ---------- 内置默认配置（契约 §3.1：示例值即默认值） ----------
DEF_ENABLED=true
DEF_WIN_START="23:00"
DEF_WIN_END="08:00"
DEF_INTERVAL=60
DEF_MAX_CHECKS=60
DEF_CPU_EN=true;  DEF_CPU_MAX=10
DEF_LOAD_EN=true; DEF_LOAD_MAX=0.5
DEF_USERS_EN=true; DEF_USERS_MAX=0
DEF_SSH_EN=true;  DEF_SSH_PORTS="8975"
DEF_DISK_EN=true; DEF_DISK_MAX=30
DEF_NET_EN=true;  DEF_NET_MAX=10
DEF_NET_MAX_TX=0
DEF_NET_EXCLUDE="lo docker* br-* veth* ovs*"
DEF_UPTIME_EN=false; DEF_UPTIME_MIN=1800
DEF_SMB_EN=false
DEF_TCP_EN=true;   DEF_TCP_PORTS="8005 5666 5667 443 80"
DEF_DL_EN=false;   DEF_DL_PORTS=""; DEF_DL_MAXCONN=0
DEF_VM_EN=false
DEF_PROC_EN=false; DEF_PROC_NAMES=""
DEF_SCRUB_EN=false
DEF_HOST_EN=false; DEF_HOSTS=""
DEF_CAL_EN=false;  DEF_CAL_WEEKDAYS=""; DEF_CAL_DATES=""

NET_SAMPLE_SEC=1   # network 检查两次采样间隔（秒）
# 单位说明：契约 v0.5 §4.5 已明确速率为 KiB/s，与字段名 kbps(kilo-bytes/s) 语义一致，
# 即 rate = (sum2-sum1)/NET_SAMPLE_SEC/1024；max_tx_kbps=0 时不启用 TX 判定。

# ================================================================
# 基础工具
# ================================================================

now_iso() {
    # 本地时区 ISO 8601 带偏移，如 2026-08-11T23:30:01+08:00
    local ts
    ts=$(date +%Y-%m-%dT%H:%M:%S%:z 2>/dev/null) || \
        ts=$(date +%Y-%m-%dT%H:%M:%S%z | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/')
    printf '%s' "$ts"
}

log_raw() {
    # 日志：§3.4 [YYYY-MM-DD HH:MM:SS] <消息>，按月滚动，append
    local line
    line="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
    if [ "$DRY_RUN" = "1" ] || [ -z "$EXEC_DIR" ]; then
        printf '%s\n' "$line" >&2
    else
        printf '%s\n' "$line" >> "$EXEC_DIR/$(date '+%Y-%m').log" 2>/dev/null \
            || printf '%s\n' "$line" >&2
    fi
}

log_info() { log_raw "$*"; }
log_warn() { log_raw "警告: $*"; }

init_data_paths() {
    local resolved
    if [ -z "$DATA_DIR" ] || [[ "$DATA_DIR" != /* ]] || [ ! -d "$DATA_DIR" ]; then
        printf 'FNOS_SHUTDOWN_DATA_DIR 未配置或不是已存在的绝对目录；请在应用部署页重新执行一键部署命令\n' >&2
        return 1
    fi
    resolved=$(cd -- "$DATA_DIR" 2>/dev/null && pwd -P) || resolved=""
    if [ -z "$resolved" ] || [ "$resolved" = "/" ]; then
        printf 'FNOS_SHUTDOWN_DATA_DIR 不得指向根目录；请在应用部署页重新执行一键部署命令\n' >&2
        return 1
    fi
    DATA_DIR="$resolved"
    EXEC_DIR="$DATA_DIR/executor"
    CONFIG_FILE="$DATA_DIR/config.json"
    SKIP_FILE="$DATA_DIR/skip.json"
    STATUS_FILE="$EXEC_DIR/status.json"
}

is_int() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

is_num() { # 非负小数
    case "$1" in ''|*[!0-9.]*) return 1 ;; esac
    awk -v v="$1" 'BEGIN{ exit !(v ~ /^[0-9]+(\.[0-9]+)?$/) }'
}

in_range() { awk -v v="$1" -v lo="$2" -v hi="$3" 'BEGIN{ exit !(v>=lo && v<=hi) }'; }
num_le()   { awk -v a="$1" -v b="$2" 'BEGIN{ exit !(a<=b) }'; }
num_lt()   { awk -v a="$1" -v b="$2" 'BEGIN{ exit !(a<b) }'; }

is_hhmm() { printf '%s' "$1" | grep -qE '^([01][0-9]|2[0-3]):[0-5][0-9]$'; }

hhmm_to_min() { # "HH:MM" -> 0..1439
    local h=${1%%:*} m=${1##*:}
    printf '%s' "$(( 10#$h * 60 + 10#$m ))"
}

# ================================================================
# 白名单 JSON 字段提取（契约 §2 硬边界 5：禁止 source/eval，仅 grep/sed 正则）
# 输入一律为「已拍平」（换行替换为空格）的 JSON 文本
# ================================================================

has_key() { # $1=json文本 $2=键名
    printf '%s' "$1" | grep -q "\"$2\"[[:space:]]*:"
}

json_raw() { # $1=json文本 $2=键名 -> 首个标量值（字符串去引号）；不存在则空
    printf '%s\n' "$1" \
        | grep -o -m1 "\"$2\"[[:space:]]*:[[:space:]]*\(\"[^\"]*\"\|[-0-9a-zA-Z.+]\+\)" \
        | sed 's/^"[^"]*"[[:space:]]*:[[:space:]]*//; s/^"//; s/"$//'
}

json_section() { # $1=json文本 $2=键名 -> 扁平对象 {…} 的内部文本（检查项对象无嵌套）
    printf '%s\n' "$1" \
        | grep -o -m1 "\"$2\"[[:space:]]*:[[:space:]]*{[^{}]*}" \
        | sed 's/^"[^"]*"[[:space:]]*:[[:space:]]*{//; s/}[[:space:]]*$//'
}

json_array() { # $1=json文本 $2=键名 -> 数组 […] 的内部文本
    printf '%s\n' "$1" \
        | grep -o -m1 "\"$2\"[[:space:]]*:[[:space:]]*\[[^]]*\]" \
        | sed 's/^"[^"]*"[[:space:]]*:[[:space:]]*\[//; s/\][[:space:]]*$//'
}

# 字段级取值：缺失 -> 默认（静默）；非法 -> 默认 + 警告（§3.1 读取规则）
fld_bool() { # $1=scope $2=key $3=default
    local v
    if has_key "$1" "$2"; then
        v=$(json_raw "$1" "$2")
        case "$v" in
            true|false) printf '%s' "$v"; return 0 ;;
            *) log_warn "config 字段 $2 非法（'$v'），回退默认 $3" ;;
        esac
    fi
    printf '%s' "$3"
}

fld_int() { # $1=scope $2=key $3=default $4=lo $5=hi
    local v
    if has_key "$1" "$2"; then
        v=$(json_raw "$1" "$2")
        if is_int "$v" && [ "$v" -ge "$4" ] && [ "$v" -le "$5" ]; then
            printf '%s' "$v"; return 0
        fi
        log_warn "config 字段 $2 非法（'$v'，合法范围 $4-$5），回退默认 $3"
    fi
    printf '%s' "$3"
}

fld_num() { # $1=scope $2=key $3=default $4=lo $5=hi（浮点）
    local v
    if has_key "$1" "$2"; then
        v=$(json_raw "$1" "$2")
        if is_num "$v" && in_range "$v" "$4" "$5"; then
            printf '%s' "$v"; return 0
        fi
        log_warn "config 字段 $2 非法（'$v'，合法范围 $4-$5），回退默认 $3"
    fi
    printf '%s' "$3"
}

fld_intlist() { # $1=scope $2=key $3=default（空格分隔整数，可空串表空数组）$4=下界 $5=上界
    local arr parsed
    if ! has_key "$1" "$2"; then
        printf '%s' "$3"; return 0
    fi
    if ! printf '%s' "$1" | grep -q "\"$2\"[[:space:]]*:[[:space:]]*\["; then
        log_warn "config 字段 $2 非法（非数组），回退默认 [$3]"
        printf '%s' "$3"; return 0
    fi
    arr=$(json_array "$1" "$2")
    if parsed=$(parse_intlist "$arr" "$4" "$5"); then
        printf '%s' "$parsed"
    else
        log_warn "config 字段 $2 非法（合法范围 $4-$5），回退默认 [$3]"
        printf '%s' "$3"
    fi
}

parse_intlist() { # $1=数组内部文本 $2=下界 $3=上界 -> 空格分隔整数；任一非法返回 1
    local inner tok out=""
    inner=$(printf '%s' "$1" | sed 's/[[:space:]]//g')
    [ -z "$inner" ] && { printf '%s' ""; return 0; }  # 契约允许空数组
    local oldifs=$IFS
    IFS=','
    for tok in $inner; do
        IFS=$oldifs
        if ! is_int "$tok" || [ "$tok" -lt "$2" ] || [ "$tok" -gt "$3" ]; then
            return 1
        fi
        out="$out $tok"
    done
    IFS=$oldifs
    printf '%s' "${out# }"
}

fld_strlist() { # $1=scope $2=key $3=default（空格分隔字符串，可空串表空数组）$4=单项合法正则
    local arr parsed
    if ! has_key "$1" "$2"; then
        printf '%s' "$3"; return 0
    fi
    if ! printf '%s' "$1" | grep -q "\"$2\"[[:space:]]*:[[:space:]]*\["; then
        log_warn "config 字段 $2 非法（非数组），回退默认 [$3]"
        printf '%s' "$3"; return 0
    fi
    arr=$(json_array "$1" "$2")
    if parsed=$(parse_strlist "$arr" "$4"); then
        printf '%s' "$parsed"
    else
        log_warn "config 字段 $2 非法，回退默认 [$3]"
        printf '%s' "$3"
    fi
}

parse_strlist() { # $1=数组内部文本 $2=单项合法正则（不含首尾锚点）-> 空格分隔；任一非法返回 1
    local toks t out=""
    toks=$(printf '%s' "$1" | grep -o '"[^"]*"' | sed 's/^"//; s/"$//')
    if [ -z "$toks" ]; then
        # 空数组合法；非空却提取不到字符串 -> 非法
        [ -z "$(printf '%s' "$1" | sed 's/[[:space:]]//g')" ] && return 0
        return 1
    fi
    for t in $toks; do
        printf '%s' "$t" | grep -qE "^($2)\$" || return 1
        out="$out $t"
    done
    printf '%s' "${out# }"
}

parse_excludes() { # $1=数组内部文本 -> 空格分隔 glob；任一非法返回 1
    local toks t out=""
    toks=$(printf '%s' "$1" | grep -o '"[^"]*"' | sed 's/^"//; s/"$//')
    if [ -z "$toks" ]; then
        # 空数组合法；非空却提取不到字符串 -> 非法
        [ -z "$(printf '%s' "$1" | sed 's/[[:space:]]//g')" ] && return 0
        return 1
    fi
    for t in $toks; do
        printf '%s' "$t" | grep -qE '^[a-zA-Z0-9_*?-]{1,32}$' || return 1
        out="$out $t"
    done
    printf '%s' "${out# }"
}

# ================================================================
# 配置读取（入口一次 + 监控循环每轮重读，§3.1）
# ================================================================

read_config() {
    # 先全部置内置默认
    CFG_ENABLED=$DEF_ENABLED
    CFG_WIN_START_STR=$DEF_WIN_START; CFG_WIN_END_STR=$DEF_WIN_END
    CFG_INTERVAL=$DEF_INTERVAL;       CFG_MAX_CHECKS=$DEF_MAX_CHECKS
    CFG_CPU_EN=$DEF_CPU_EN;           CFG_CPU_MAX=$DEF_CPU_MAX
    CFG_LOAD_EN=$DEF_LOAD_EN;         CFG_LOAD_MAX=$DEF_LOAD_MAX
    CFG_USERS_EN=$DEF_USERS_EN;       CFG_USERS_MAX=$DEF_USERS_MAX
    CFG_SSH_EN=$DEF_SSH_EN;           CFG_SSH_PORTS=$DEF_SSH_PORTS
    CFG_DISK_EN=$DEF_DISK_EN;         CFG_DISK_MAX=$DEF_DISK_MAX
    CFG_NET_EN=$DEF_NET_EN;           CFG_NET_MAX=$DEF_NET_MAX
    CFG_NET_MAX_TX=$DEF_NET_MAX_TX
    CFG_NET_EXCLUDE=$DEF_NET_EXCLUDE
    CFG_UPTIME_EN=$DEF_UPTIME_EN;     CFG_UPTIME_MIN=$DEF_UPTIME_MIN
    CFG_SMB_EN=$DEF_SMB_EN
    CFG_TCP_EN=$DEF_TCP_EN;           CFG_TCP_PORTS=$DEF_TCP_PORTS
    CFG_DL_EN=$DEF_DL_EN;             CFG_DL_PORTS=$DEF_DL_PORTS
    CFG_DL_MAXCONN=$DEF_DL_MAXCONN
    CFG_VM_EN=$DEF_VM_EN
    CFG_PROC_EN=$DEF_PROC_EN;         CFG_PROC_NAMES=$DEF_PROC_NAMES
    CFG_SCRUB_EN=$DEF_SCRUB_EN
    CFG_HOST_EN=$DEF_HOST_EN;         CFG_HOSTS=$DEF_HOSTS
    CFG_CAL_EN=$DEF_CAL_EN;           CFG_CAL_WEEKDAYS=$DEF_CAL_WEEKDAYS
    CFG_CAL_DATES=$DEF_CAL_DATES
    CONFIG_FALLBACK=false

    local flat trim g checks sec arr parsed

    if [ ! -e "$CONFIG_FILE" ]; then
        CONFIG_FALLBACK=true
        log_warn "config.json 缺失，全部使用内置默认值"
        finalize_window; return 0
    fi
    if ! flat=$(cat "$CONFIG_FILE" 2>/dev/null); then
        # §6：读 config 权限错误 -> 视为缺失（兜底）
        CONFIG_FALLBACK=true
        log_warn "config.json 读取失败（权限？），全部使用内置默认值"
        finalize_window; return 0
    fi
    flat=${flat//$'\n'/ }
    trim=$(printf '%s' "$flat" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    case "$trim" in
        "{"*"}") : ;;
        *)
            CONFIG_FALLBACK=true
            log_warn "config.json 损坏（非完整 JSON 对象），全部使用内置默认值"
            finalize_window; return 0 ;;
    esac

    # checks 段之前为全局区（schema 顺序固定，checks 为最后一个键）
    g=${flat%%\"checks\"*}
    checks=${flat#"$g"}

    CFG_ENABLED=$(fld_bool "$g" enabled "$DEF_ENABLED")
    CFG_INTERVAL=$(fld_int "$g" check_interval_sec "$DEF_INTERVAL" 10 3600)
    CFG_MAX_CHECKS=$(fld_int "$g" max_checks "$DEF_MAX_CHECKS" 1 720)

    if has_key "$g" window; then
        sec=$(json_section "$g" window)
        local ws we
        ws=$(json_raw "$sec" start)
        we=$(json_raw "$sec" end)
        # §4.4：start==end 为配置非法，回退默认
        if is_hhmm "$ws" && is_hhmm "$we" && [ "$ws" != "$we" ]; then
            CFG_WIN_START_STR=$ws; CFG_WIN_END_STR=$we
        else
            log_warn "config 字段 window 非法（start='$ws' end='$we'），回退默认 $DEF_WIN_START-$DEF_WIN_END"
        fi
    fi

    # 逐检查项：缺失 -> 默认；结构非法 -> 该项默认 + 警告；未知检查项名天然忽略
    if has_key "$checks" cpu; then
        sec=$(json_section "$checks" cpu)
        if [ -n "$sec" ]; then
            CFG_CPU_EN=$(fld_bool "$sec" enabled "$CFG_CPU_EN")
            CFG_CPU_MAX=$(fld_num "$sec" max_percent "$CFG_CPU_MAX" 0 100)
        else log_warn "checks.cpu 结构非法，该项使用默认配置"; fi
    fi
    if has_key "$checks" load; then
        sec=$(json_section "$checks" load)
        if [ -n "$sec" ]; then
            CFG_LOAD_EN=$(fld_bool "$sec" enabled "$CFG_LOAD_EN")
            CFG_LOAD_MAX=$(fld_num "$sec" max_per_core "$CFG_LOAD_MAX" 0 64)
        else log_warn "checks.load 结构非法，该项使用默认配置"; fi
    fi
    if has_key "$checks" users; then
        sec=$(json_section "$checks" users)
        if [ -n "$sec" ]; then
            CFG_USERS_EN=$(fld_bool "$sec" enabled "$CFG_USERS_EN")
            CFG_USERS_MAX=$(fld_int "$sec" max_active "$CFG_USERS_MAX" 0 100)
        else log_warn "checks.users 结构非法，该项使用默认配置"; fi
    fi
    if has_key "$checks" ssh; then
        sec=$(json_section "$checks" ssh)
        if [ -n "$sec" ]; then
            CFG_SSH_EN=$(fld_bool "$sec" enabled "$CFG_SSH_EN")
            CFG_SSH_PORTS=$(fld_intlist "$sec" ports "$CFG_SSH_PORTS" 1 65535)
        else log_warn "checks.ssh 结构非法，该项使用默认配置"; fi
    fi
    if has_key "$checks" disk_io; then
        sec=$(json_section "$checks" disk_io)
        if [ -n "$sec" ]; then
            CFG_DISK_EN=$(fld_bool "$sec" enabled "$CFG_DISK_EN")
            CFG_DISK_MAX=$(fld_int "$sec" max_iowait_percent "$CFG_DISK_MAX" 0 100)
        else log_warn "checks.disk_io 结构非法，该项使用默认配置"; fi
    fi
    if has_key "$checks" network; then
        sec=$(json_section "$checks" network)
        if [ -n "$sec" ]; then
            CFG_NET_EN=$(fld_bool "$sec" enabled "$CFG_NET_EN")
            CFG_NET_MAX=$(fld_int "$sec" max_rx_kbps "$CFG_NET_MAX" 0 1048576)
            CFG_NET_MAX_TX=$(fld_int "$sec" max_tx_kbps "$CFG_NET_MAX_TX" 0 1048576)
            if has_key "$sec" exclude_interfaces; then
                arr=$(json_array "$sec" exclude_interfaces)
                if parsed=$(parse_excludes "$arr"); then
                    CFG_NET_EXCLUDE=$parsed
                else
                    log_warn "config 字段 network.exclude_interfaces 非法，回退默认"
                fi
            fi
        else log_warn "checks.network 结构非法，该项使用默认配置"; fi
    fi
    if has_key "$checks" min_uptime; then
        sec=$(json_section "$checks" min_uptime)
        if [ -n "$sec" ]; then
            CFG_UPTIME_EN=$(fld_bool "$sec" enabled "$CFG_UPTIME_EN")
            CFG_UPTIME_MIN=$(fld_int "$sec" min_sec "$CFG_UPTIME_MIN" 0 86400)
        else log_warn "checks.min_uptime 结构非法，该项使用默认配置"; fi
    fi
    if has_key "$checks" smb_sessions; then
        sec=$(json_section "$checks" smb_sessions)
        if [ -n "$sec" ]; then
            CFG_SMB_EN=$(fld_bool "$sec" enabled "$CFG_SMB_EN")
        else log_warn "checks.smb_sessions 结构非法，该项使用默认配置"; fi
    fi
    if has_key "$checks" tcp_sessions; then
        sec=$(json_section "$checks" tcp_sessions)
        if [ -n "$sec" ]; then
            CFG_TCP_EN=$(fld_bool "$sec" enabled "$CFG_TCP_EN")
            CFG_TCP_PORTS=$(fld_intlist "$sec" ports "$CFG_TCP_PORTS" 1 65535)
        else log_warn "checks.tcp_sessions 结构非法，该项使用默认配置"; fi
    fi
    if has_key "$checks" download_active; then
        sec=$(json_section "$checks" download_active)
        if [ -n "$sec" ]; then
            CFG_DL_EN=$(fld_bool "$sec" enabled "$CFG_DL_EN")
            CFG_DL_MAXCONN=$(fld_int "$sec" max_connections "$CFG_DL_MAXCONN" 0 65535)
            CFG_DL_PORTS=$(fld_intlist "$sec" ports "$CFG_DL_PORTS" 1 65535)
        else log_warn "checks.download_active 结构非法，该项使用默认配置"; fi
    fi
    if has_key "$checks" vm_running; then
        sec=$(json_section "$checks" vm_running)
        if [ -n "$sec" ]; then
            CFG_VM_EN=$(fld_bool "$sec" enabled "$CFG_VM_EN")
        else log_warn "checks.vm_running 结构非法，该项使用默认配置"; fi
    fi
    if has_key "$checks" process_running; then
        sec=$(json_section "$checks" process_running)
        if [ -n "$sec" ]; then
            CFG_PROC_EN=$(fld_bool "$sec" enabled "$CFG_PROC_EN")
            CFG_PROC_NAMES=$(fld_strlist "$sec" names "$CFG_PROC_NAMES" '[a-zA-Z0-9_.+-]{1,64}')
        else log_warn "checks.process_running 结构非法，该项使用默认配置"; fi
    fi
    if has_key "$checks" disk_scrub; then
        sec=$(json_section "$checks" disk_scrub)
        if [ -n "$sec" ]; then
            CFG_SCRUB_EN=$(fld_bool "$sec" enabled "$CFG_SCRUB_EN")
        else log_warn "checks.disk_scrub 结构非法，该项使用默认配置"; fi
    fi
    if has_key "$checks" host_online; then
        sec=$(json_section "$checks" host_online)
        if [ -n "$sec" ]; then
            CFG_HOST_EN=$(fld_bool "$sec" enabled "$CFG_HOST_EN")
            CFG_HOSTS=$(fld_strlist "$sec" hosts "$CFG_HOSTS" '[a-zA-Z0-9.-]{1,64}')
        else log_warn "checks.host_online 结构非法，该项使用默认配置"; fi
    fi
    if has_key "$checks" calendar_rules; then
        sec=$(json_section "$checks" calendar_rules)
        if [ -n "$sec" ]; then
            CFG_CAL_EN=$(fld_bool "$sec" enabled "$CFG_CAL_EN")
            CFG_CAL_WEEKDAYS=$(fld_intlist "$sec" skip_weekdays "$CFG_CAL_WEEKDAYS" 0 6)
            CFG_CAL_DATES=$(fld_strlist "$sec" skip_dates "$CFG_CAL_DATES" '((0[13578]|1[02])-(0[1-9]|[12][0-9]|3[01])|(0[469]|11)-(0[1-9]|[12][0-9]|30)|02-(0[1-9]|1[0-9]|2[0-9]))')
        else log_warn "checks.calendar_rules 结构非法，该项使用默认配置"; fi
    fi

    finalize_window
}

finalize_window() {
    CFG_WIN_S=$(hhmm_to_min "$CFG_WIN_START_STR")
    CFG_WIN_E=$(hhmm_to_min "$CFG_WIN_END_STR")
}

# ================================================================
# skip.json（§3.2）：不存在/过期 -> 无跳过；解析失败 -> 视为跳过（fail-safe）
# ================================================================

skip_active() {
    [ -e "$SKIP_FILE" ] || return 1
    local flat s epoch now
    if ! flat=$(cat "$SKIP_FILE" 2>/dev/null); then
        log_warn "skip.json 读取失败，fail-safe 视为跳过生效"
        return 0
    fi
    flat=${flat//$'\n'/ }
    s=$(json_raw "$flat" skip_until)
    if ! printf '%s' "$s" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(Z|[+-][0-9]{2}:[0-9]{2})$'; then
        log_warn "skip.json 解析失败（skip_until='$s'），fail-safe 视为跳过生效"
        return 0
    fi
    if ! epoch=$(date -d "$s" +%s 2>/dev/null); then
        log_warn "skip.json 时间无法解析（skip_until='$s'），fail-safe 视为跳过生效"
        return 0
    fi
    now=$(date +%s)
    if [ "$now" -lt "$epoch" ]; then
        return 0
    fi
    return 1
}

# ================================================================
# 窗口判定（§4.4）：分钟粒度、左闭右开、跨零点
# ================================================================

in_window() {
    local cur
    cur=$(( 10#$(date +%H) * 60 + 10#$(date +%M) ))
    if [ "$CFG_WIN_S" -lt "$CFG_WIN_E" ]; then
        [ "$cur" -ge "$CFG_WIN_S" ] && [ "$cur" -lt "$CFG_WIN_E" ]
    else
        [ "$cur" -ge "$CFG_WIN_S" ] || [ "$cur" -lt "$CFG_WIN_E" ]
    fi
}

# ================================================================
# status.json（§3.3）：原子写（同目录 .tmp + fsync + rename），644
# ================================================================

write_status() { # $1=last_action $2=monitoring(true/false)
    local action=$1 monitoring=${2:-false} tmp
    tmp="$STATUS_FILE.tmp"
    if ! {
        printf '{\n'
        printf '  "script_version": "%s",\n' "$SCRIPT_VERSION"
        printf '  "last_trigger": "%s",\n' "$(now_iso)"
        printf '  "last_action": "%s",\n' "$action"
        printf '  "config_fallback": %s,\n' "$CONFIG_FALLBACK"
        printf '  "monitoring": %s\n' "$monitoring"
        printf '}\n'
    } > "$tmp" 2>/dev/null; then
        # §6：写 status 失败 -> 记 stderr，不阻塞主流程
        printf '写入 status.json 失败（%s），继续主流程\n' "$tmp" >&2
        rm -f "$tmp" 2>/dev/null
        return 1
    fi
    chmod 644 "$tmp" 2>/dev/null
    sync -f "$tmp" 2>/dev/null || sync "$tmp" 2>/dev/null || sync
    if ! mv -f "$tmp" "$STATUS_FILE" 2>/dev/null; then
        printf 'rename status.json 失败，继续主流程\n' >&2
        rm -f "$tmp" 2>/dev/null
        return 1
    fi
    sync -f "$STATUS_FILE" 2>/dev/null || sync
    return 0
}

prev_action() { # 入口首次写状态时保留上次结局；无法辨认则空
    [ -r "$STATUS_FILE" ] || return 0
    local flat a
    flat=$(cat "$STATUS_FILE" 2>/dev/null) || return 0
    flat=${flat//$'\n'/ }
    a=$(json_raw "$flat" last_action)
    case "$a" in
        disabled|skipped|out_of_window|monitoring|window_end|max_rounds_reached|poweroff)
            printf '%s' "$a" ;;
    esac
}

# ================================================================
# 检查项（§4.5：v1 六项 + v2 九项）
# 约定：函数返回 0=通过；非 0 时 R_STATUS=BUSY（实测超阈值）或 FAIL（无法测量，fail-safe 不通过）
# R_DETAIL 为实测值描述，供 dry-run 与日志使用
# ================================================================

check_enabled() {
    case "$1" in
        cpu)     [ "$CFG_CPU_EN" = true ] ;;
        load)    [ "$CFG_LOAD_EN" = true ] ;;
        users)   [ "$CFG_USERS_EN" = true ] ;;
        ssh)     [ "$CFG_SSH_EN" = true ] ;;
        disk_io) [ "$CFG_DISK_EN" = true ] ;;
        network) [ "$CFG_NET_EN" = true ] ;;
        min_uptime)      [ "$CFG_UPTIME_EN" = true ] ;;
        smb_sessions)    [ "$CFG_SMB_EN" = true ] ;;
        tcp_sessions)    [ "$CFG_TCP_EN" = true ] ;;
        download_active) [ "$CFG_DL_EN" = true ] ;;
        vm_running)      [ "$CFG_VM_EN" = true ] ;;
        process_running) [ "$CFG_PROC_EN" = true ] ;;
        disk_scrub)      [ "$CFG_SCRUB_EN" = true ] ;;
        host_online)     [ "$CFG_HOST_EN" = true ] ;;
        calendar_rules)  [ "$CFG_CAL_EN" = true ] ;;
        *) return 1 ;;
    esac
}

get_cores() {
    local c
    c=$(nproc 2>/dev/null)
    is_int "$c" && [ "$c" -ge 1 ] || c=1
    printf '%s' "$c"
}

check_cpu() {
    local cores load5 pct
    cores=$(get_cores)
    load5=$(awk '{print $2; exit}' /proc/loadavg 2>/dev/null)
    if [ -z "$load5" ]; then
        R_STATUS=FAIL; R_DETAIL="无法读取 /proc/loadavg"; return 1
    fi
    pct=$(awk -v l="$load5" -v c="$cores" 'BEGIN{printf "%.1f", l/c*100}')
    R_DETAIL="load5=$load5 核数=$cores 折算=${pct}%（阈值 max_percent<=$CFG_CPU_MAX）"
    if num_le "$pct" "$CFG_CPU_MAX"; then return 0; fi
    R_STATUS=BUSY; return 1
}

check_load() {
    local cores l1 l5 limit
    cores=$(get_cores)
    l1=$(awk '{print $1; exit}' /proc/loadavg 2>/dev/null)
    l5=$(awk '{print $2; exit}' /proc/loadavg 2>/dev/null)
    if [ -z "$l1" ] || [ -z "$l5" ]; then
        R_STATUS=FAIL; R_DETAIL="无法读取 /proc/loadavg"; return 1
    fi
    limit=$(awk -v c="$cores" -v m="$CFG_LOAD_MAX" 'BEGIN{printf "%.2f", c*m}')
    R_DETAIL="load1=$l1 load5=$l5 上限=${limit}（核数${cores}x max_per_core=$CFG_LOAD_MAX，需双双严格小于）"
    if num_lt "$l1" "$limit" && num_lt "$l5" "$limit"; then return 0; fi
    R_STATUS=BUSY; return 1
}

check_users() {
    local n
    n=$(who 2>/dev/null | awk '$1!="root"{n++} END{print n+0}')
    R_DETAIL="非 root 活跃会话=$n（阈值 max_active<=$CFG_USERS_MAX）"
    if [ "$n" -le "$CFG_USERS_MAX" ]; then return 0; fi
    R_STATUS=BUSY; return 1
}

detect_sshd_ports() { # ssh.ports 空数组语义（§3.1）：解析 sshd_config Port 指令，探测失败回退 22
    local main=/etc/ssh/sshd_config files="" g f ports="" p
    [ -r "$main" ] && files=$main
    if [ -n "$files" ]; then
        # Include 指令（如 /etc/ssh/sshd_config.d/*.conf）：展开可读文件一并解析
        for g in $(sed -n 's/^[[:space:]]*[Ii][Nn][Cc][Ll][Uu][Dd][Ee][[:space:]]\+\([^#[:space:]]\+\).*$/\1/p' "$main" 2>/dev/null); do
            for f in $g; do
                [ -r "$f" ] && files="$files $f"
            done
        done
    fi
    for f in $files; do
        for p in $(sed -n 's/^[[:space:]]*[Pp][Oo][Rr][Tt][[:space:]]\+\([0-9][0-9]*\)[[:space:]]*.*$/\1/p' "$f" 2>/dev/null); do
            if [ "$p" -ge 1 ] && [ "$p" -le 65535 ]; then
                ports="$ports $p"
            fi
        done
    done
    # 去重排序；一个都探测不到回退 22
    if [ -n "${ports# }" ]; then
        ports=$(printf '%s\n' $ports | sort -un | tr '\n' ' ')
        ports=${ports% }
    fi
    if [ -z "$ports" ]; then
        log_warn "sshd 端口自动检测失败（无有效 Port 指令），回退默认端口 22"
        ports=22
    fi
    printf '%s' "$ports"
}

# ssh 与 tcp_sessions 共用实现（§4.5）：ss -tnH 逐端口统计 ESTABLISHED，全 0 通过
check_estab_ports() { # $1=空格分隔端口列表
    local out p cnt detail="" busy=0
    if ! command -v ss >/dev/null 2>&1; then
        R_STATUS=FAIL; R_DETAIL="ss 命令不可用"; return 1
    fi
    if ! out=$(ss -tnH 2>/dev/null); then
        R_STATUS=FAIL; R_DETAIL="ss -tnH 执行失败"; return 1
    fi
    for p in $1; do
        cnt=$(printf '%s\n' "$out" | awk -v p="$p" \
            '$1 ~ /^ESTAB/ { n=split($4,a,":"); if (a[n]==p) c++ } END{print c+0}')
        detail="$detail 端口$p:ESTABLISHED=$cnt"
        [ "$cnt" -eq 0 ] || busy=1
    done
    R_DETAIL="$detail（全部端口需为 0）"
    [ "$busy" -eq 0 ] && return 0
    R_STATUS=BUSY; return 1
}

check_ssh() {
    local ports=$CFG_SSH_PORTS note="" rc
    if [ -z "$ports" ]; then
        # §3.1：空数组 = 自动检测 sshd 端口
        ports=$(detect_sshd_ports)
        note="；ports 空数组，自动检测 sshd 端口=[$ports]"
    fi
    check_estab_ports "$ports"
    rc=$?
    R_DETAIL="$R_DETAIL$note"
    return "$rc"
}

check_disk_io() {
    local wa
    wa=$(vmstat 1 2 2>/dev/null | awk '
        $1=="r" && $2=="b" { for (i=1;i<=NF;i++) if ($i=="wa") wcol=i }
        NF>2 { last=$0 }
        END { if (wcol && split(last,a," ")) print a[wcol] }')
    if [ -z "$wa" ]; then
        R_STATUS=FAIL; R_DETAIL="vmstat 1 2 无法取得 wa 列"; return 1
    fi
    R_DETAIL="wa=${wa}%（阈值 max_iowait_percent<$CFG_DISK_MAX，vmstat 1 2 末行）"
    if num_lt "$wa" "$CFG_DISK_MAX"; then return 0; fi
    R_STATUS=BUSY; return 1
}

net_byte_sum() { # $1=rx|tx：排除 glob 命中接口后的字节计数总和
    local dir=$1 f base ifn pat total=0 v
    for f in /sys/class/net/*/statistics/"$dir"_bytes; do
        [ -r "$f" ] || continue
        base=${f%/statistics/"$dir"_bytes}
        ifn=${base##*/}
        for pat in $CFG_NET_EXCLUDE; do
            # shellcheck disable=SC2254
            case "$ifn" in $pat) continue 2 ;; esac
        done
        v=$(cat "$f" 2>/dev/null) || continue
        is_int "$v" || continue
        total=$(( total + v ))
    done
    printf '%s' "$total"
}

check_network() {
    local r1 r2 t1 t2 rate rate_tx detail tx_ok
    r1=$(net_byte_sum rx)
    t1=$(net_byte_sum tx)
    sleep "$NET_SAMPLE_SEC"
    r2=$(net_byte_sum rx)
    t2=$(net_byte_sum tx)
    if [ -z "$r1" ] || [ -z "$r2" ] || [ -z "$t1" ] || [ -z "$t2" ]; then
        R_STATUS=FAIL; R_DETAIL="无法读取 /sys/class/net/*/statistics/{rx,tx}_bytes"; return 1
    fi
    rate=$(awk -v d="$(( r2 - r1 ))" -v t="$NET_SAMPLE_SEC" 'BEGIN{printf "%.1f", d/t/1024}')
    detail="rx=${rate}KiB/s（阈值 max_rx_kbps<$CFG_NET_MAX）"
    if [ "$CFG_NET_MAX_TX" -gt 0 ]; then
        # max_tx_kbps>0 时启用 TX 判定（§3.1：0 = 不启用）
        rate_tx=$(awk -v d="$(( t2 - t1 ))" -v t="$NET_SAMPLE_SEC" 'BEGIN{printf "%.1f", d/t/1024}')
        detail="$detail；tx=${rate_tx}KiB/s（阈值 max_tx_kbps<$CFG_NET_MAX_TX）"
        num_lt "$rate_tx" "$CFG_NET_MAX_TX" && tx_ok=1 || tx_ok=0
    else
        tx_ok=1
    fi
    R_DETAIL="$detail（排除接口: ${CFG_NET_EXCLUDE:-无}，采样${NET_SAMPLE_SEC}s）"
    if num_lt "$rate" "$CFG_NET_MAX" && [ "$tx_ok" -eq 1 ]; then return 0; fi
    R_STATUS=BUSY; return 1
}

check_min_uptime() {
    local up
    up=$(awk '{print $1; exit}' /proc/uptime 2>/dev/null)
    if [ -z "$up" ]; then
        R_STATUS=FAIL; R_DETAIL="无法读取 /proc/uptime"; return 1
    fi
    R_DETAIL="uptime=${up}s（阈值 min_sec>=$CFG_UPTIME_MIN）"
    if num_le "$CFG_UPTIME_MIN" "$up"; then return 0; fi
    R_STATUS=BUSY; return 1
}

check_smb_sessions() {
    local out n
    if ! command -v smbstatus >/dev/null 2>&1; then
        R_STATUS=FAIL; R_DETAIL="smbstatus 命令不可用"; return 1
    fi
    if ! out=$(smbstatus --processes 2>/dev/null); then
        R_STATUS=FAIL; R_DETAIL="smbstatus --processes 执行失败（非 root 运行为预期失败）"; return 1
    fi
    # 表体行首字段为数字 PID 即一条活跃会话
    n=$(printf '%s\n' "$out" | awk '$1 ~ /^[0-9]+$/ && NF>=4 {c++} END{print c+0}')
    R_DETAIL="活跃 SMB 会话=$n（需 =0，smbstatus --processes）"
    if [ "$n" -eq 0 ]; then return 0; fi
    R_STATUS=BUSY; return 1
}

check_tcp_sessions() {
    if [ -z "$CFG_TCP_PORTS" ]; then
        R_DETAIL="ports 为空数组，无待检端口，视为通过"
        return 0
    fi
    check_estab_ports "$CFG_TCP_PORTS"
}

check_download_active() {
    local out total
    if [ -z "$CFG_DL_PORTS" ]; then
        R_DETAIL="ports 为空数组，无待检端口，视为通过"
        return 0
    fi
    if ! command -v ss >/dev/null 2>&1; then
        R_STATUS=FAIL; R_DETAIL="ss 命令不可用"; return 1
    fi
    if ! out=$(ss -tanH 2>/dev/null); then
        R_STATUS=FAIL; R_DETAIL="ss -tanH 执行失败"; return 1
    fi
    # 对 ports 统计非 LISTEN 连接总数（按本地端口匹配，覆盖 BT peer 连接）
    total=$(printf '%s\n' "$out" | awk -v ports="$CFG_DL_PORTS" '
        BEGIN { n=split(ports,a," "); for (i=1;i<=n;i++) pset[a[i]]=1 }
        $1 != "LISTEN" { m=split($4,b,":"); if (b[m] in pset) c++ }
        END { print c+0 }')
    R_DETAIL="非LISTEN连接=$total（阈值 max_connections<=$CFG_DL_MAXCONN，端口: $CFG_DL_PORTS，ss -tanH 按本地端口匹配）"
    if [ "$total" -le "$CFG_DL_MAXCONN" ]; then return 0; fi
    R_STATUS=BUSY; return 1
}

check_vm_running() {
    local out n
    if ! command -v virsh >/dev/null 2>&1; then
        R_STATUS=FAIL; R_DETAIL="virsh 命令不可用"; return 1
    fi
    if ! out=$(virsh list --state-running 2>/dev/null); then
        R_STATUS=FAIL; R_DETAIL="virsh list --state-running 执行失败（libvirtd 未运行？）"; return 1
    fi
    # 表体行首字段为数字 Id 即一台运行中 VM
    n=$(printf '%s\n' "$out" | awk '$1 ~ /^[0-9]+$/ {c++} END{print c+0}')
    R_DETAIL="运行中 VM=$n（需 =0，virsh list --state-running）"
    if [ "$n" -eq 0 ]; then return 0; fi
    R_STATUS=BUSY; return 1
}

check_process_running() {
    local n hit="" pid
    if [ -z "$CFG_PROC_NAMES" ]; then
        R_DETAIL="names 为空数组，无待检进程，视为通过"
        return 0
    fi
    if ! command -v pgrep >/dev/null 2>&1; then
        R_STATUS=FAIL; R_DETAIL="pgrep 命令不可用"; return 1
    fi
    for n in $CFG_PROC_NAMES; do
        # 精确匹配进程名（-x，非 -f 全文），§4.5
        if pid=$(pgrep -x "$n" 2>/dev/null); then
            hit="$hit $n(pid=$(printf '%s' "$pid" | tr '\n' ',' | sed 's/,$//'))"
        fi
    done
    if [ -z "$hit" ]; then
        R_DETAIL="names 全部无匹配（$CFG_PROC_NAMES，pgrep -x 精确匹配）"
        return 0
    fi
    R_DETAIL="命中进程:${hit}（需全部无匹配）"
    R_STATUS=BUSY; return 1
}

check_disk_scrub() {
    local md mp out detail_md detail_btrfs="" busy=0
    # ① /proc/mdstat：含进度条 [===>...] 且带 resync/recovery/reshape/check 关键字 = 进行中
    if [ ! -r /proc/mdstat ]; then
        R_STATUS=FAIL; R_DETAIL="无法读取 /proc/mdstat"; return 1
    fi
    md=$(grep -E '\[[^]]*>' /proc/mdstat 2>/dev/null | grep -Ei 'resync|recovery|reshape|check' | head -1)
    if [ -n "$md" ]; then
        detail_md="mdstat 有阵列操作进行中: $(printf '%s' "$md" | sed 's/^[[:space:]]*//')"
        busy=1
    else
        detail_md="mdstat 无 resync/recovery/reshape/check 进行中"
    fi
    # ② 每个 btrfs 挂载点 btrfs scrub status（ioctl 读内核态，不唤醒机械盘）
    if command -v btrfs >/dev/null 2>&1; then
        for mp in $(awk '$3=="btrfs"{print $2}' /proc/mounts 2>/dev/null); do
            if ! out=$(btrfs scrub status "$mp" 2>/dev/null); then
                R_STATUS=FAIL
                R_DETAIL="btrfs scrub status $mp 执行失败（非 root？）；$detail_md"
                return 1
            fi
            if printf '%s\n' "$out" | grep -qi 'Status:.*running'; then
                detail_btrfs="$detail_btrfs $mp:scrub运行中"
                busy=1
            else
                detail_btrfs="$detail_btrfs $mp:无scrub运行"
            fi
        done
        [ -n "$detail_btrfs" ] || detail_btrfs=" 无 btrfs 挂载点"
    else
        # 无 btrfs 工具即无 btrfs scrub 可能：跳过该部分记警告，不算测量失败
        log_warn "btrfs 命令不可用，disk_scrub 跳过 btrfs scrub 检测（mdstat 检测仍生效）"
        detail_btrfs=" btrfs 命令不可用，已跳过（记警告）"
    fi
    R_DETAIL="$detail_md；$detail_btrfs"
    [ "$busy" -eq 0 ] && return 0
    R_STATUS=BUSY; return 1
}

check_host_online() {
    local h up="" rc
    if [ -z "$CFG_HOSTS" ]; then
        R_DETAIL="hosts 为空数组，无待检主机，视为通过"
        return 0
    fi
    if ! command -v ping >/dev/null 2>&1; then
        R_STATUS=FAIL; R_DETAIL="ping 命令不可用"; return 1
    fi
    for h in $CFG_HOSTS; do
        ping -c 1 -W 1 "$h" >/dev/null 2>&1
        rc=$?
        case $rc in
            0) up="$up $h" ;;
            1) : ;;   # 不可达
            *) # rc>=2：socket 权限不足等执行错误，测量失败 fail-safe（防误判全部离线而误关机）
               R_STATUS=FAIL; R_DETAIL="ping $h 执行错误（rc=$rc，缺 cap_net_raw/setuid？请重跑部署命令）"; return 1 ;;
        esac
    done
    if [ -z "$up" ]; then
        R_DETAIL="hosts 全部不可达（$CFG_HOSTS，ping -c 1 -W 1）"
        return 0
    fi
    R_DETAIL="在线主机:${up}（需全部不可达）"
    R_STATUS=BUSY; return 1
}

check_calendar_rules() {
    local w d x
    if [ -z "$CFG_CAL_WEEKDAYS" ] && [ -z "$CFG_CAL_DATES" ]; then
        R_DETAIL="skip_weekdays/skip_dates 均为空数组，无跳过规则，视为通过"
        return 0
    fi
    w=$(date +%w)   # 0=周日
    d=$(date +%m-%d)
    for x in $CFG_CAL_WEEKDAYS; do
        if [ "$x" = "$w" ]; then
            R_DETAIL="今天周$w 命中 skip_weekdays=[$CFG_CAL_WEEKDAYS]，今日跳过"
            R_STATUS=BUSY; return 1
        fi
    done
    for x in $CFG_CAL_DATES; do
        if [ "$x" = "$d" ]; then
            R_DETAIL="今天 $d 命中 skip_dates=[$CFG_CAL_DATES]，今日跳过"
            R_STATUS=BUSY; return 1
        fi
    done
    R_DETAIL="今天 周$w $d 不在跳过列表（skip_weekdays=[${CFG_CAL_WEEKDAYS}] skip_dates=[${CFG_CAL_DATES}]）"
    return 0
}

# 主流程用：启用项任一不通过即短路返回 1（§4.3 run_all_enabled_checks）
run_all_checks() {
    local c
    for c in cpu load users ssh disk_io network min_uptime smb_sessions tcp_sessions download_active vm_running process_running disk_scrub host_online calendar_rules; do
        check_enabled "$c" || continue
        if ! "check_$c"; then
            if [ "$R_STATUS" = FAIL ]; then
                log_warn "检查测量失败（fail-safe 视为不通过）: $c — $R_DETAIL"
            else
                log_info "检查未通过: $c — $R_DETAIL"
            fi
            return 1
        fi
    done
    return 0
}

# ================================================================
# --dry-run（§4.1）：完整检查逻辑逐项打印，不取锁、不写文件、绝不关机
# ================================================================

dry_run() {
    DRY_RUN=1
    local c st all_pass=1
    init_data_paths || exit 1
    printf 'fnos-shutdown-executor --dry-run（SCRIPT_VERSION=%s）\n' "$SCRIPT_VERSION"
    printf 'DATA_DIR=%s\n' "$DATA_DIR"
    read_config
    printf 'config: fallback=%s enabled=%s window=%s-%s interval=%ss max_checks=%s\n' \
        "$CONFIG_FALLBACK" "$CFG_ENABLED" "$CFG_WIN_START_STR" "$CFG_WIN_END_STR" \
        "$CFG_INTERVAL" "$CFG_MAX_CHECKS"
    if skip_active; then
        printf 'skip: 生效中（未到期或解析失败 fail-safe）\n'
    else
        printf 'skip: 无\n'
    fi
    if in_window; then
        printf '工作时段: 当前在工作时段内（%s-%s，左闭右开）\n' "$CFG_WIN_START_STR" "$CFG_WIN_END_STR"
    else
        printf '工作时段: 当前不在工作时段内（%s-%s，左闭右开）\n' "$CFG_WIN_START_STR" "$CFG_WIN_END_STR"
    fi
    printf '检查项:\n'
    for c in cpu load users ssh disk_io network min_uptime smb_sessions tcp_sessions download_active vm_running process_running disk_scrub host_online calendar_rules; do
        if ! check_enabled "$c"; then
            printf '  [%-8s] SKIP disabled（视为通过，未采样）\n' "$c"
            continue
        fi
        if "check_$c"; then
            st=PASS
        else
            st=$R_STATUS
            all_pass=0
        fi
        printf '  [%-8s] %-4s %s\n' "$c" "$st" "$R_DETAIL"
    done
    if [ "$all_pass" -eq 1 ]; then
        printf '总体: 全部启用检查通过（真实运行此时会写 status=poweroff 并关机；dry-run 绝不关机）\n'
    else
        printf '总体: 存在未通过项（真实运行不会关机）\n'
    fi
}

# ================================================================
# 主流程（§4.3 伪代码即规约）
# ================================================================

usage() {
    cat >&2 <<'EOF'
用法: fnos-shutdown-executor.sh [--version|--dry-run|--verify]
  （无参数）  主流程：root 由 cron 触发，持锁后按 config.json 窗口与检查项决定关机
  --version   输出 SCRIPT_VERSION 并退出（零副作用，任意用户）
  --dry-run   逐项打印十五项检查结果与实测值（不取锁、不写文件、绝不关机）
  --verify    执行无副作用检查并立即写入部署心跳（绝不关机）
EOF
}

# ---------- §3.6 签名自更新 ----------
# 包内脚本版本与自身不同 → 验签 → 通过则原子替换 $0 并 exec 新版；任何失败都记日志后继续旧版。
self_update() {
    [ -f "$APP_SRC_SCRIPT" ] || return 0
    # 从包内位置直接运行（开发联调）时不自我替换
    [ "$APP_SRC_SCRIPT" -ef "$0" ] && return 0
    local src_ver
    src_ver=$(sed -n 's/^SCRIPT_VERSION="\([^"]*\)"$/\1/p' "$APP_SRC_SCRIPT" | head -n 1)
    [ -n "$src_ver" ] || return 0
    [ "$src_ver" = "$SCRIPT_VERSION" ] && return 0

    local sig="$APP_SRC_SCRIPT.sig" pub_file
    if [ ! -f "$sig" ]; then
        log_info "自更新跳过：包内脚本 v$src_ver 缺少签名文件（当前 v$SCRIPT_VERSION）"
        return 0
    fi
    pub_file=$(mktemp) || return 0
    printf '%s\n' "$SELF_UPDATE_PUBKEY" > "$pub_file"
    if ! openssl dgst -sha256 -verify "$pub_file" -signature "$sig" "$APP_SRC_SCRIPT" >/dev/null 2>&1; then
        rm -f "$pub_file"
        log_info "警告: 自更新验签失败（包内 v$src_ver，当前 v$SCRIPT_VERSION），继续以旧版运行"
        return 0
    fi
    rm -f "$pub_file"

    local self="$0" self_dir tmp
    self_dir=$(dirname "$self")
    tmp="$self_dir/.fnos-shutdown-executor.tmp.$$"
    if ! cat "$APP_SRC_SCRIPT" > "$tmp" 2>/dev/null; then
        log_info "警告: 自更新写入临时文件失败，继续以旧版运行"
        rm -f "$tmp"
        return 0
    fi
    chmod 700 "$tmp" 2>/dev/null
    if ! mv -f "$tmp" "$self" 2>/dev/null; then
        log_info "警告: 自更新替换 $self 失败（权限不足？），继续以旧版运行"
        rm -f "$tmp"
        return 0
    fi
    log_info "自更新完成：v$SCRIPT_VERSION → v$src_ver，重新执行"
    exec "$self" "$@"
}

# Verify the installation and register a successful deployment immediately.
# The dry-run checks never enter the poweroff path.
verify() {
    dry_run || exit 1
    if ! init_data_paths; then
        exit 1
    fi
    mkdir -p "$EXEC_DIR" || exit 1
    chmod 755 "$EXEC_DIR" 2>/dev/null || true
    local preserved
    preserved=$(prev_action)
    write_status "${preserved:-out_of_window}" false || exit 1
    printf 'verified and deployed (SCRIPT_VERSION=%s)\n' "$SCRIPT_VERSION"
}

# ---------- §3.4 日志保留：仅保留最近 6 个月（含当月），每次触发清理 ----------
prune_logs() {
    local cutoff f ym
    cutoff=$(date -d '-5 months' '+%Y-%m')
    for f in "$EXEC_DIR"/????-??.log; do
        [ -e "$f" ] || continue
        ym=$(basename "$f" .log)
        # YYYY-MM 字典序即时间序
        if [[ "$ym" < "$cutoff" ]]; then
            rm -f "$f"
            log_info "清理过期日志：$ym.log（保留最近 6 个月）"
        fi
    done
}

main() {
    # 持锁（§4.3）：另一实例持有则 exit 2
    if ! exec 9>"$LOCK_FILE"; then
        printf '无法打开锁文件 %s\n' "$LOCK_FILE" >&2
        exit 2
    fi
    if ! flock -n 9; then
        printf '另一实例持有锁 %s，退出\n' "$LOCK_FILE" >&2
        exit 2
    fi

    # §3.6：取锁后先自更新（成功则 exec 新版，由新版写标记行）；--version/--dry-run 不经此路径
    self_update "$@"
    # DATA_DIR 不允许猜测。旧 cron 未传变量时先完成自更新，再 fail-safe 退出，等待用户重跑部署命令。
    init_data_paths || exit 0
    mkdir -p "$EXEC_DIR"
    # The directory is created by the root cron process on first run.  Make it
    # traversable by the app user so the app can read status.json/logs even when
    # cron inherits a restrictive umask or the directory came from an older run.
    chmod 755 "$EXEC_DIR" 2>/dev/null || true
    # §3.4 会话分隔标记：每次触发的首条日志，消息体以 "=== " 开头、" ===" 结尾（应用可按此分组）
    log_info "=== 触发执行（v$SCRIPT_VERSION）==="

    prune_logs

    read_config
    # 入口首次写状态：更新 last_trigger；last_action 暂保留上次结局（枚举无 triggered 值）
    local preserved
    preserved=$(prev_action)
    write_status "${preserved:-out_of_window}" false

    if [ "$CFG_ENABLED" != "true" ]; then
        log_info "enabled=false，退出"
        write_status disabled false
        exit 0
    fi
    if skip_active; then
        log_info "skip.json 生效，退出"
        write_status skipped false
        exit 0
    fi
    if ! in_window; then
        log_info "不在工作时段内（工作时段 $CFG_WIN_START_STR-$CFG_WIN_END_STR），退出"
        write_status out_of_window false
        exit 0
    fi

    log_info "进入监控循环：max_checks=$CFG_MAX_CHECKS interval=${CFG_INTERVAL}s"
    write_status monitoring true

    local round=0
    while [ "$round" -lt "$CFG_MAX_CHECKS" ]; do
        round=$(( round + 1 ))
        read_config   # 每轮重读（§3.1 读取时机）
        if [ "$CFG_ENABLED" != "true" ]; then
            log_info "第 $round 轮：enabled=false，退出"
            write_status disabled false
            exit 0
        fi
        if skip_active; then
            log_info "第 $round 轮：skip.json 生效，退出"
            write_status skipped false
            exit 0
        fi
        if ! in_window; then
            log_info "第 $round 轮：离开工作时段，正常结束"
            write_status window_end false
            exit 0
        fi
        write_status monitoring true   # 每轮刷新 last_trigger（§3.3）
        if run_all_checks; then
            log_info "第 $round 轮：全部启用检查通过，执行关机"
            write_status poweroff false   # 先落状态再动作（§4.3）
            exec /sbin/poweroff
        fi
        sleep "$CFG_INTERVAL"
    done

    log_info "达到 max_checks=$CFG_MAX_CHECKS 未关机，退出"
    write_status max_rounds_reached false
    exit 0
}

# ================================================================
# 命令行（§4.1）
# ================================================================

if [ $# -gt 1 ]; then
    usage
    exit 3
fi

case "${1:-}" in
    "")
        main ;;
    --version)
        # 零副作用：不取锁、不读写任何文件、不检查系统
        printf '%s\n' "$SCRIPT_VERSION"
        exit 0 ;;
    --dry-run)
        dry_run ;;
    --verify)
        verify ;;
    *)
        usage
        exit 3 ;;
esac

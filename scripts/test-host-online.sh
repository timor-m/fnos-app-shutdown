#!/bin/bash
# 在隔离数据目录中用模拟 ping 验证关机检查，不进入实际关机路径。
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "$0")/.." && pwd)
EXECUTOR="$ROOT_DIR/packages/server/assets/fnos-shutdown-executor.sh"
TMP_DIR=$(mktemp -d)
trap 'rm -rf -- "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/bin" "$TMP_DIR/data"

cat > "$TMP_DIR/bin/ping" <<'EOF'
#!/bin/bash
case "${@: -1}" in
    online) exit 0 ;;
esac
printf '%s\n' "$PING_ERROR" >&2
exit "$PING_RC"
EOF
chmod +x "$TMP_DIR/bin/ping"

run_case() {
    local name=$1 option=$2 hosts=$3 rc=$4 error=$5 expected=$6 output
    cat > "$TMP_DIR/data/config.json" <<EOF
{"checks":{"host_online":{"enabled":true,"hosts":$hosts,"route_unreachable_as_offline":$option}}}
EOF
    output=$(PATH="$TMP_DIR/bin:$PATH" PING_RC="$rc" PING_ERROR="$error" \
        FNOS_SHUTDOWN_DATA_DIR="$TMP_DIR/data" bash "$EXECUTOR" --dry-run 2>&1)
    if ! printf '%s\n' "$output" | grep -Eq "\\[host_online\\][[:space:]]+$expected"; then
        printf 'FAIL %s: expected %s\n%s\n' "$name" "$expected" "$output" >&2
        return 1
    fi
    printf 'PASS %s\n' "$name"
}

run_case 'default timeout' false '["offline"]' 1 '' PASS
run_case 'route error default remains failure' false '["offline"]' 2 'ping: connect: Network is unreachable' FAIL
run_case 'invalid option falls back to disabled' '"yes"' '["offline"]' 2 'ping: connect: Network is unreachable' FAIL
run_case 'network unreachable opt-in' true '["offline"]' 2 'ping: connect: Network is unreachable' PASS
run_case 'no route opt-in' true '["offline"]' 2 'ping: sendmsg: No route to host' PASS
run_case 'DNS error remains failure' true '["offline"]' 2 'ping: offline: Name or service not known' FAIL
run_case 'permission error remains failure' true '["offline"]' 2 'ping: socket: Operation not permitted' FAIL
run_case 'online host remains busy' true '["online"]' 0 '' BUSY
run_case 'one online host remains busy' true '["offline","online"]' 2 'ping: connect: Network is unreachable' BUSY

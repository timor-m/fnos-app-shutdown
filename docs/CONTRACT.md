# fnos-app-shutdown 执行器 ↔ 应用 协作契约（接口规范）

> 版本：v0.8 · 2026-08-24（§9 部署命令为应用用户配置非特权 ICMP Echo socket，修复低权限 `host_online` dry-run 的 ping rc=2）
>
> 历史：v0.7 · 2026-08-12（§3.6 新增执行器签名自更新：cron root 触发时验签同步包内新版脚本；§9 一键命令降为首次部署/修复用途）
>
> 历史：v0.6 · 2026-08-12（v2 第二批检查项纳入：`vm_running`、`process_running`、`disk_scrub`、`host_online`、`calendar_rules`；§3.4 新增日志会话分隔标记契约）
> 读者：实现「智能关机」飞牛应用的桌面端 Agent
> 文档定位：本文件是**跨进程对接的唯一权威契约**。凡 §3–§7 定义的文件格式、路径、字段、语义、时序，两侧必须严格遵守；应用内部的框架选型、UI 形态、API 响应封装不属于契约范围，可自由实现。

---

## 1. 架构总览

系统由两个**完全解耦**的进程组成，只通过文件系统通信：

```
┌─ 应用 fnos-app-shutdown（应用用户 fnos-app-shutdown，无特权）──┐
│  Web UI + node 后端（unix socket，网关前缀 /app/fnos-app-shutdown）│
│  写：config.json、skip.json（原子写）                          │
│  读：executor/status.json、executor/*.log（只读）              │
│  分发：GET /api/executor/script 提供执行器脚本下载              │
└───────────────────────┬───────────────────────────────────────┘
                        │ 文件系统单向通信：配置下行，状态/日志上行
┌───────────────────────▼───────────────────────────────────────┐
│  执行器 executor（root，/usr/local/sbin/fnos-shutdown-executor.sh）│
│  cron 触发：/etc/cron.d/fnos-shutdown，*/10 * * * *           │
│  读：config.json、skip.json（入口读一次 + 监控循环每轮重读）    │
│  写：executor/status.json、executor/YYYY-MM.log（原子写，644） │
│  动作：全部启用检查通过 → /sbin/poweroff（能力为封闭集合，§4.6）│
└───────────────────────────────────────────────────────────────┘
```

核心原则：

- **cron 是哑闹钟**：`*/10 * * * *` 固定频率触发，一次部署后永不修改；所有时间语义在 config.json
- **每轮重读**：executor 在监控循环的每一轮开头重读 config.json 与 skip.json，应用改配置最迟一个检查周期生效，无需重启任何进程
- **双向原子写**：两侧写任何契约文件都必须 `tmp + rename`（§3.0），对端永远只读到完整文件
- **失败兜底**：契约文件缺失/损坏时，executor 回退内置默认值继续工作，绝不崩溃、绝不盲目关机（§6 矩阵）
- **能力封闭**：executor 只会执行 §4.6 列出的预设检查与预设动作；配置只能调参，不能让它做任何集合之外的事（§12-D1）

## 2. 角色与职责边界

| 资源 | 应用（app 用户） | 执行器（root） | cron |
|---|---|---|---|
| `data/config.json` | **写**（原子）+ 读 | 只读 | — |
| `data/skip.json` | **写**（原子）+ 删 | 只读 | — |
| `data/executor/`（整个目录） | **只读，禁止写入/删除/改名其中任何文件** | **写**（mkdir -p 自建） | — |
| `/usr/local/sbin/fnos-shutdown-executor.sh` | 不得修改（仅经 HTTP 分发包内副本） | — | 每 10 分钟执行 |
| `/etc/cron.d/fnos-shutdown` | 不得修改 | — | — |
| `data/` 下应用私有文件（db 等） | 自由 | **禁止触碰** | — |

硬边界（违反即对接失败）：

1. executor **永不写** `config.json`、`skip.json`；应用**永不写** `data/executor/` 内任何文件
2. 应用**不得解析日志内容**（§3.4），只做原文展示；结构化状态一律走 `status.json`
3. 应用不得尝试 `sudo`、写 crontab、调 polkit——部署执行器只能引导用户手动完成（§9）
4. executor 不得访问 `/vol2`、`/vol3` 下任何路径（机械盘休眠保护）
5. executor 解析配置**禁止** `source`/eval 任何契约文件内容，必须白名单字段解析（§3.1 校验列）
6. executor **不得执行任何外部脚本/钩子/命令拼接**——能力集合封闭（§4.6、§12-D1）

## 3. 文件接口契约

### 3.0 通用规则

- 所有契约文件：UTF-8、JSON（日志除外）、Unix 换行
- **写入协议**：写到同目录 `<目标名>.tmp`，`fsync` 后 `rename` 覆盖目标；同目录 rename 保证原子性。读取侧忽略所有 `*.tmp`
- 时间戳：一律本地时区 ISO 8601 带偏移，如 `2026-08-11T23:30:01+08:00`；时刻字段（HH:MM）为本地时间
- 数据根目录：`DATA_DIR=/vol1/@appdata/fnos-app-shutdown/data`（应用内即 `${TRIM_PKGVAR}/data`）；executor 输出目录：`EXEC_DIR=$DATA_DIR/executor`（executor 启动时 `mkdir -p`，不存在即建）

### 3.1 `config.json`（应用写 → executor 读）

完整 schema（示例值即默认值）。结构为「全局参数 + 逐检查项开关与阈值」：

```json
{
  "enabled": true,
  "window": { "start": "23:00", "end": "08:00" },
  "check_interval_sec": 60,
  "max_checks": 60,
  "checks": {
    "cpu":     { "enabled": true,  "max_percent": 10 },
    "load":    { "enabled": true,  "max_per_core": 0.5 },
    "users":   { "enabled": true,  "max_active": 0 },
    "ssh":     { "enabled": true,  "ports": [8975] },
    "disk_io": { "enabled": true,  "max_iowait_percent": 30 },
    "network": { "enabled": true,  "max_rx_kbps": 10, "max_tx_kbps": 0,
                 "exclude_interfaces": ["lo", "docker*", "br-*", "veth*", "ovs*"] },
    "min_uptime":      { "enabled": false, "min_sec": 1800 },
    "smb_sessions":    { "enabled": false },
    "tcp_sessions":    { "enabled": false, "ports": [] },
    "download_active": { "enabled": false, "ports": [], "max_connections": 0 },
    "vm_running":      { "enabled": false },
    "process_running": { "enabled": false, "names": [] },
    "disk_scrub":      { "enabled": false },
    "host_online":     { "enabled": false, "hosts": [] },
    "calendar_rules":  { "enabled": false, "skip_weekdays": [], "skip_dates": [] }
  }
}
```

全局字段：

| 字段 | 类型 | 合法范围 | 默认 | 说明 |
|---|---|---|---|---|
| enabled | bool | true/false | true | 总开关；false 时 executor 触发即退 |
| window.start / end | string | `^([01]\d\|2[0-3]):[0-5]\d$`，且 start≠end | 23:00 / 08:00 | 关机窗口，**左闭右开**；start>end 表示跨零点 |
| check_interval_sec | int | 10–3600 | 60 | 监控循环每轮间隔（秒） |
| max_checks | int | 1–720 | 60 | 最大检查轮次 |

`checks.<name>` 通用规则：

- 每个检查项必有 `enabled`（bool，默认 true）；`enabled=false` 时该检查**整体跳过**（视为通过）
- `checks` 中缺失某个检查项 → 该项按默认（启用 + 默认参数）处理
- 出现 §4.6 之外的未知检查项名 → executor 忽略（向前兼容）

各检查项参数：

| 检查项 | 参数 | 类型 | 合法范围 | 默认 |
|---|---|---|---|---|
| cpu | max_percent | number | 0–100 | 10 |
| load | max_per_core | number | 0–64 | 0.5 |
| users | max_active | int | 0–100 | 0 |
| ssh | ports | int[] | 每项 1–65535，可空数组；**空数组 = 自动检测 sshd 端口**（解析 /etc/ssh/sshd_config 及其 Include 的 Port 指令，探测失败回退 [22]） | [8975] |
| disk_io | max_iowait_percent | int | 0–100 | 30 |
| network | max_rx_kbps | int | 0–1048576 | 10 |
| network | max_tx_kbps | int | 0–1048576；**0 = 不启用 TX 判定**（v0.5 新增，旧 executor 读到忽略即保持只判 RX） | 0 |
| network | exclude_interfaces | string[] | 每项仅含 `[a-zA-Z0-9_*?-]`，≤32 字符 | 见示例 |
| min_uptime | min_sec | int | 0–86400 | 1800 |
| smb_sessions | （无参数） | — | — | — |
| tcp_sessions | ports | int[] | 每项 1–65535，可空数组 | [] |
| download_active | ports | int[] | 每项 1–65535，可空数组 | [] |
| download_active | max_connections | int | 0–65535 | 0 |
| vm_running | （无参数） | — | — | — |
| process_running | names | string[] | 每项仅含 `[a-zA-Z0-9_.+-]`，≤64 字符，可空数组 | [] |
| disk_scrub | （无参数） | — | — | — |
| host_online | hosts | string[] | 每项为 IPv4 或主机名，仅含 `[a-zA-Z0-9.-]`，≤64 字符，可空数组 | [] |
| calendar_rules | skip_weekdays | int[] | 每项 0–6（0=周日，`date +%w` 语义），可空数组 | [] |
| calendar_rules | skip_dates | string[] | 每项 `MM-DD`（合法月日），可空数组 | [] |

> v2 检查项（第一、二批）默认 `enabled=false`，符合 §7「新增只能为可选 + 有默认」；旧 executor 读到未知检查项名忽略，行为不变。

**读取规则（executor）**：

- 文件缺失 / JSON 解析失败 → 全部字段用默认值，记警告日志，status.json 置 `config_fallback=true`
- 单字段非法 → 该字段回退默认并记警告，其余字段正常采用
- 未知字段 → 忽略（向前兼容，见 §7）
- 读取时机：进程入口一次 + 监控循环每轮开头各一次

**写入规则（应用）**：

- 必须原子写；写入前按上表做完整校验，非法输入拒绝并提示，不得把非法值落盘
- 不得写入 schema 之外的必填语义；新增可选字段前确认 executor 忽略策略（§7）

### 3.2 `skip.json`（应用写 → executor 读）

```json
{ "skip_until": "2026-08-12T08:00:00+08:00", "reason": "manual", "created": "2026-08-11T21:30:00+08:00" }
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| skip_until | string（ISO 8601 带偏移） | 是 | 跳过截止时刻；`now < skip_until` 视为跳过生效 |
| reason | string | 否 | 展示用，executor 忽略 |
| created | string | 否 | 展示用，executor 忽略 |

**语义**：

- 文件不存在 → 无跳过
- 文件存在且 `now ≥ skip_until` → 无跳过（自然过期，应用可删可不删）
- 文件存在但**解析失败** → **视为跳过生效**（fail-safe：宁可不关机），executor 记警告
- 生效时 executor 在入口与每轮检查中均直接退出（status `skipped`）
- 应用"取消跳过" = 删除该文件；executor 下一轮（≤ check_interval_sec）恢复

### 3.3 `executor/status.json`（executor 写 → 应用读）

```json
{
  "script_version": "0.1.0",
  "last_trigger": "2026-08-11T23:30:01+08:00",
  "last_action": "out_of_window",
  "config_fallback": false,
  "monitoring": false
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| script_version | string | executor 顶部 `SCRIPT_VERSION` 常量，语义化版本 |
| last_trigger | string（ISO 8601） | 本次 cron 触发时刻；**每次触发必更新，含快速退出路径** |
| last_action | string（枚举，见下） | 本次触发/最近一次的结局 |
| config_fallback | bool | 本次读取 config.json 是否触发了默认值兜底 |
| monitoring | bool | 当前是否处于监控循环中 |

`last_action` 枚举（应用可依赖此集合做展示，新增值只会追加，不会改名/删除）：

| 值 | 含义 |
|---|---|
| `disabled` | enabled=false，未进入监控 |
| `skipped` | skip.json 生效 |
| `out_of_window` | 触发时不在窗口内 |
| `monitoring` | 进入监控循环（每轮刷新 last_trigger） |
| `window_end` | 监控中离开窗口，正常结束 |
| `max_rounds_reached` | 达到 max_checks 未关机 |
| `poweroff` | 条件满足，已发起关机（写完该状态后立即执行 poweroff） |

**写入规则（executor）**：原子写；644 root:root；每次触发至少写一次。
**应用派生状态**（部署页三态，判定谓词必须按下表实现）：

| 状态 | 谓词 |
|---|---|
| 🔴 未部署 | `status.json` 不存在 |
| 🟢 正常 | 存在 且 `script_version == 应用包内版本` 且 `now - last_trigger ≤ 20 分钟` |
| 🟡 版本过旧 | 存在 且 `script_version != 应用包内版本` |
| 🟠 运行异常 | 存在 且 版本一致 但 `now - last_trigger > 20 分钟`（cron 可能失效） |

### 3.4 `executor/YYYY-MM.log`（executor 写 → 应用读）

- 自由文本日志，行格式 `[YYYY-MM-DD HH:MM:SS] <消息>`；按自然月滚动
- **保留策略**：仅保留最近 6 个月（含当月）；executor 每次触发时删除更旧的 `YYYY-MM.log` 并记一行清理日志。应用侧无删除权（§2 目录归属）
- **会话分隔标记（契约格式，应用可依赖）**：每次触发的首条日志，消息体以 `=== ` 开头、以 ` ===` 结尾（如 `[2026-08-12 23:30:01] === 触发执行（v0.3.2）===`）。应用可按此标记把日志按「次」分组展示
- **除分隔标记外，应用只读原文展示，禁止做结构化解析、禁止依赖任何消息文案**；文案可随时变化，不属于契约
- 应用按文件名（月份）列举、分页读取即可

### 3.5 执行器脚本分发

- 包内路径：`app/server/assets/fnos-shutdown-executor.sh`，644，应用用户可读
- 签名文件：`app/server/assets/fnos-shutdown-executor.sh.sig`，随包分发（RSA-3072/SHA-256，打包时用离线私钥生成；应用用户可写不影响安全，没有私钥无法伪造有效签名）
- 应用通过 `GET /api/executor/script` 返回该文件**原始字节**（Content-Type: text/plain; charset=utf-8，不得转码/裁剪）
- **版本同步规则**：脚本内 `SCRIPT_VERSION` 必须与应用 manifest `version` 保持一致（打包时校验）；三态检测（§3.3）依赖这一致性
- 网关鉴权注意：SSH 中 curl 无登录 cookie。实现时验证网关行为；若强制鉴权导致一键命令失败，则该端点需允许匿名访问（脚本无密钥，风险可接受），否则部署页降级为"复制全文 + 手动保存"（§9 备选）
### 3.6 执行器签名自更新（v0.7 新增）

- 动机：应用/执行器版本强制一致（§3.5），每次应用升级后执行器需同步；包内脚本目录为应用用户可写，**直接自更新会使应用漏洞塌缩为 root（§12-D1），故必须验签**
- 信任锚：执行器脚本内嵌 RSA-3072 公钥常量 `SELF_UPDATE_PUBKEY`，经管理员交互式 sudo 首次部署（§9）后锚定
- 无参数主流程在取锁后、首条日志前执行 `self_update`：
  1. 读取包内脚本（默认 `/var/apps/fnos-app-shutdown/target/server/assets/fnos-shutdown-executor.sh`，测试钩子 `FNOS_SHUTDOWN_SOURCE_SCRIPT` 可覆盖）的 `SCRIPT_VERSION`，与自身一致则退出本流程；包内脚本与 `$0` 为同一文件（开发联调直跑）时跳过
  2. 版本不同：用内嵌公钥对 `<脚本>.sig` 做 `openssl dgst -sha256 -verify`；**验签失败：记日志、继续以旧版运行，绝不替换**
  3. 验签通过：同目录 `tmp + mv` 原子替换自身路径（`$0`），`exec` 新版以原始参数重新执行
- `--version` / `--dry-run` 保持零副作用，不触发自更新；持锁失败（退出码 2）路径不触发
- 签名私钥离线保管（不入库）；私钥丢失不影响已部署设备运行，仅失去自动升级能力（回退 §9 手动命令）

## 4. executor 行为规约

### 4.1 命令行接口

| 调用 | 行为 | 权限 |
|---|---|---|
| （无参数） | 正常执行主流程 | root（cron） |
| `--version` | 输出 SCRIPT_VERSION 并退出。**零副作用**：不取锁、不读写任何文件、不检查系统 | 任意用户 |
| `--dry-run` | 跑一遍完整检查逻辑并把每项检查结果打印到 stdout，**绝不写 status/log、绝不关机** | 任意用户（联调用） |
| 其他参数 | 打印用法，退出码 3 | — |

### 4.2 退出码

`0` 正常路径（含 disabled/skipped/out_of_window/完成监控）；`2` 另一实例持有锁；`3` 参数错误。poweroff 路径不返回。

### 4.3 主流程（伪代码即规约）

```bash
[ "$1" = "--version" ] && { echo "$SCRIPT_VERSION"; exit 0; }
exec 9>/run/fnos-shutdown.lock; flock -n 9 || exit 2

read_config; write_status(triggered)      # triggered 仅表"入口写"语义：刷新 last_trigger 与
                                          # config_fallback，last_action 保留上次值（非枚举新增值，
                                          # 随后各分支立即覆盖）
enabled      || { write_status(disabled);      exit 0; }
skip_active  && { write_status(skipped);       exit 0; }
in_window    || { write_status(out_of_window); exit 0; }

write_status(monitoring); round=0
while [ $round -lt $max_checks ]; do
    round=$((round+1))
    read_config                              # 每轮重读，含 enabled/skip/window/全部检查配置
    enabled     || { write_status(disabled);    exit 0; }
    skip_active && { write_status(skipped);     exit 0; }
    in_window   || { write_status(window_end);  exit 0; }

    if run_all_enabled_checks; then          # §4.6：全部启用项通过
        write_status(poweroff)               # 先落状态再动作
        exec /sbin/poweroff
    fi
    sleep $check_interval_sec
done
write_status(max_rounds_reached); exit 0
```

### 4.4 窗口判定精确语义

- 时刻比较粒度为分钟：`cur = HH*60+MM`，`s`、`e` 同理
- `s < e`：窗口 = `[s, e)`；`s > e`（跨零点）：窗口 = `[s, 1440) ∪ [0, e)`；`s == e`：配置非法，回退默认
- **左闭右开**：整点到达 end 分钟即视为窗口外

### 4.5 检查项实现（修复历史缺陷，逐项验收）

| 检查项 | 实现 | 通过条件 |
|---|---|---|
| cpu | `/proc/loadavg` 第 2 字段 ÷ 核数 × 100 | ≤ max_percent |
| load | load1、load5 均 < 核数 × max_per_core | 同时满足 |
| users | `who` 去除 root 后计数 | ≤ max_active |
| ssh | `ss -tnH`，对 ports 每端口统计 ESTABLISHED | 全部为 0 |
| disk_io | `vmstat 1 2` 末行 wa 列 | < max_iowait_percent |
| network | `/sys/class/net/*/statistics/{rx,tx}_bytes` 两次采样差 ÷ 间隔，**单位 KiB/s**（跳过 exclude_interfaces glob 命中的接口）；max_tx_kbps=0 时只判 RX | rx < max_rx_kbps 且（启用时）tx < max_tx_kbps |
| min_uptime | `/proc/uptime` 第 1 字段（秒） | ≥ min_sec |
| smb_sessions | `smbstatus --processes` 活跃会话计数 | = 0 |
| tcp_sessions | `ss -tnH`，对 ports 每端口统计 ESTABLISHED（ssh 的泛化，两者实现共用） | 全部为 0 |
| download_active | `ss -tanH`，对 ports 统计非 LISTEN 状态连接总数（覆盖 BT  peer 连接） | ≤ max_connections |
| vm_running | `virsh list --state-running` 运行中 VM 计数 | = 0 |
| process_running | `pgrep` 逐一精确匹配 names（进程名，非 -f 全文） | 全部无匹配 |
| disk_scrub | `/proc/mdstat` 无 resync/recovery/reshape/check 进行中；且每个 btrfs 挂载点 `btrfs scrub status` 无 scrub 运行中（ioctl 读内核态，不唤醒机械盘） | 同时满足 |
| host_online | `ping -c 1 -W 1` 逐一探测 hosts | 全部不可达 |
| calendar_rules | 当天 `date +%w` ∉ skip_weekdays 且当天 `date +%m-%d` ∉ skip_dates | 不在任何跳过列表 |

- `enabled=false` 的检查项直接视为通过，不执行任何采样
- **测量失败视为不通过（fail-safe）**：如 smbstatus 不存在、`/proc/uptime` 不可读等，该检查项按不通过处理并记警告，绝不因测量失败而误关机
- 历史缺陷对应：禁用 `netstat` 改用 `ss`（原脚本 grep `:22` 永远匹配不到 8975）；网络统计排除 lo/容器网桥（原本机服务互访误判有活动）；executor 文件 `root:root 700`（原脚本可被普通用户改写，属提权路径）

### 4.6 预设动作清单（能力封闭集合）

executor 的能力**仅限下表，不会增加任何动态脚本/钩子机制**（决策依据 §12-D1）：

**v1 检查项**：`cpu`、`load`、`users`、`ssh`、`disk_io`、`network`
**v2 检查项**（默认 `enabled=false`）：
- 第一批（v0.5）：`min_uptime`、`smb_sessions`、`tcp_sessions`、`download_active`；`network` 增加 `max_tx_kbps`
- 第二批（v0.6）：`vm_running`、`process_running`、`disk_scrub`、`host_online`、`calendar_rules`

**动作**：`/sbin/poweroff`（全部启用检查通过时）

**候选扩展目录**（仅占位，未实现；届时以「新增可选 checks 字段、默认 disabled」方式加入，遵守 §7 兼容规则。目标机器实测：upsd 未运行、无 NFS 服务）：

A. 连接/会话类

| 候选检查项 | 数据来源 | 说明 |
|---|---|---|
| `nfs_clients` | `ss` 2049 端口 | 有 NFS 客户端挂载活动时不关机（目标机器当前无 NFS 服务，暂缓） |

B. 电源类（本机已装 NUT，但 upsd 当前未运行，`upsc` 连接被拒——启用前需先配置 NUT）

| 候选检查/动作 | 数据来源 | 说明 |
|---|---|---|
| `ups_status` | `upsc <name>` | 语义需单独设计：市电正常时作为普通阻断条件；on-battery 时通常应**反向触发立即关机**（UPS 低电保护），与"空闲才关机"逻辑正交 |

C. 动作类

| 候选动作 | 说明 |
|---|---|
| `pre_shutdown_notify` | poweroff 前经飞牛通知 / wall 广播，宽限 N 分钟（可配），宽限期内复查条件 |

**新增检查项的设计约束**（v2+ 一律遵守）：

1. 数据源优先内存态：`/proc`、`/sys`、`ss`、`pgrep`、读取 NVMe 上的状态文件
2. **禁止**会唤醒 `/vol2`、`/vol3` 机械盘的检测方式（如 `smartctl -a` 轮询、读取数据盘挂载点内容）
3. 避免依赖需要凭证/令牌的内部 API（qBittorrent WebUI、飞牛 trim 内部 RPC），优先无认证的系统态信号
4. 一律以「新增可选 `checks.*` 字段、默认 `enabled=false`」加入，遵守 §7 兼容规则；语义特殊的（如 ups_status 的反向触发）需在契约中单独定义行为后方可实现

## 5. 协作时序

**A. 配置下发**：UI 保存 → 应用校验 → 原子写 config.json → executor 在「下一次 cron 触发」（窗口外，≤10 分钟）或「下一轮检查」（监控中，≤ check_interval_sec）采用。应用无需也无法通知 executor。

**B. 今晚跳过**：UI 点击 → 应用计算当前窗口结束时刻 → 原子写 skip.json → executor 入口/下一轮退出。取消 = 删除文件。跨夜语义：skip_until 取**当前或下一窗口的 end**，由应用负责算对（executor 只做 `now < skip_until` 判断）。

**C. 关机执行**：全部启用检查通过 → executor 先写 status `poweroff` → `exec /sbin/poweroff`。应用事后从 status.json 读到该状态用于展示（机器已关，无实时反馈）。

**D. 部署/升级**：用户在部署页复制一键命令（§9）→ SSH 粘贴执行（幂等）→ 下一脚 cron（≤10 分钟）写出 status.json → 部署页三态转绿/转黄逻辑见 §3.3。应用升级导致包内 SCRIPT_VERSION 高于 status.json 中的版本 → 显示 🟡 引导重跑同一命令。

**E. 应用卸载**：应用与 `data/` 可能被清除 → config.json/skip.json 缺失 → executor 以默认值继续工作（兜底）；executor 本体的卸载只能由用户手动执行（§9），应用不得尝试。

## 6. 错误处理矩阵

| 场景 | executor 行为 | 应用行为 |
|---|---|---|
| config.json 缺失 | 全默认值 + `config_fallback=true` + 警告日志 | 显示默认值，首次保存时创建 |
| config.json 损坏 | 同上 | 提示损坏并提供「重置为默认」 |
| config.json 单字段非法 | 该字段默认，其余采用，记警告 | 写入前拦截，不允许落盘 |
| skip.json 缺失/过期 | 正常流程 | 显示未跳过 |
| skip.json 损坏 | **视为跳过生效**（fail-safe）+ 警告 | 提示并允许删除重写 |
| status.json 缺失 | （自身写入方，不涉及） | 判定 🔴 未部署 |
| status.json 损坏 | 下次触发覆盖重写 | 判定 🔴 未部署（提示核查） |
| data/ 整体缺失 | mkdir -p 自建 EXEC_DIR，配置用默认 | 应用启动时自建 data 结构 |
| 读 config 时权限错误 | 视为缺失（兜底） | 提示异常 |
| 写 status 时磁盘满等 I/O 错误 | 记 stderr，继续主流程（状态上报失败不阻塞关机逻辑） | — |

## 7. 版本与兼容规则

- SCRIPT_VERSION 采用语义化版本，随应用版本同步递增
- **向前兼容**：executor 必须忽略 config.json/skip.json 中的未知字段与未知检查项名；应用新增字段/检查项只能为「可选 + 有默认」，旧 executor 读到新配置不得行为异常
- **向后兼容**：应用展示 status.json 时容忍缺失字段（按 §3.3 谓词降级判定）；last_action 枚举只增不改
- 任何破坏性变更（改字段语义/路径）必须 SCRIPT_VERSION 主版本 +1，且 executor 与应用在同次发布中一起更新

## 8. 应用侧实现要求（能力清单）

以下能力必须提供，API 路径建议如下（响应封装格式不限，字段名与契约一致即可）：

| 方法 | 路径 | 能力 |
|---|---|---|
| GET | `/api/config` | 读 config.json，与默认值合并后返回 |
| PUT | `/api/config` | 全字段校验（§3.1）→ 原子写 |
| GET | `/api/status` | 综合 status.json + skip.json + config.json 返回：部署三态、今晚窗口、当前是否监控中、skip 状态 |
| POST | `/api/skip` | 计算窗口结束时刻，原子写 skip.json |
| DELETE | `/api/skip` | 删除 skip.json |
| GET | `/api/logs?month=YYYY-MM` | 列举/读取 EXEC_DIR 日志，原文返回，分页 |
| GET | `/api/executor/script` | 返回包内脚本原始字节（§3.5） |
| GET | `/api/executor/status` | §3.3 三态/四态判定结果 + status.json 原文 |

UI 三页：

1. **状态页**：部署徽标、今晚计划、决策日志展示、"今晚跳过"开关
2. **设置页**：全局区（总开关、窗口、间隔、轮次）+ **检查项区——每项一张卡片：启用开关 + 该项参数表单**（对应 §3.1 checks 结构，带范围校验）
3. **部署向导页**：三态卡片 + §9 命令的复制按钮 + 备选复制脚本全文

## 9. 部署命令规约（UI 一字不差展示）

**v0.7 起**：本命令用于**首次部署与手动修复**；完成首次部署后，应用升级时执行器经 §3.6 签名自更新自动同步，无需再跑命令。

一键部署/修复（幂等，可重复执行）：

```bash
curl -fsSL "http://127.0.0.1:<直连端口>/app/fnos-app-shutdown/api/executor/script" -o /tmp/fnos-shutdown-executor.sh \
  && sudo install -m 700 -o root -g root /tmp/fnos-shutdown-executor.sh /usr/local/sbin/ \
  && printf '*/10 * * * * root /usr/local/sbin/fnos-shutdown-executor.sh\n' | sudo tee /etc/cron.d/fnos-shutdown \
  && APP_GID="$(id -g fnos-app-shutdown)" \
  && PING_GID_RANGE="$(awk -v gid="$APP_GID" '{ min=$1; max=$2; if (gid < min) min=gid; if (gid > max) max=gid; print min, max }' /proc/sys/net/ipv4/ping_group_range)" \
  && sudo install -d -m 755 -o root -g root /etc/sysctl.d /var/lib/fnos-shutdown \
  && { sudo test -f /var/lib/fnos-shutdown/ping-group-range.original || cat /proc/sys/net/ipv4/ping_group_range | sudo tee /var/lib/fnos-shutdown/ping-group-range.original >/dev/null; } \
  && printf 'net.ipv4.ping_group_range = %s\n' "$PING_GID_RANGE" | sudo tee /etc/sysctl.d/99-fnos-shutdown-ping.conf >/dev/null \
  && sudo sysctl -w "net.ipv4.ping_group_range=$PING_GID_RANGE" \
  && sudo -u fnos-app-shutdown ping -c 1 -W 1 127.0.0.1 >/dev/null \
  && rm -f /tmp/fnos-shutdown-executor.sh
```

部署命令先保存系统原始 `ping_group_range`，再把应用用户 GID 合并进现有范围；重复部署不会覆盖原始值。它只开放内核的非特权 ICMP Echo socket，不修改共享 `ping`/BusyBox 文件能力，不授予应用 root。

验证：

```bash
sudo -u fnos-app-shutdown ping -c 1 -W 1 127.0.0.1 \
  && sudo /usr/local/sbin/fnos-shutdown-executor.sh --version
```

说明：命令经 SSH 在 NAS 本机执行，使用 127.0.0.1 + 应用直连端口（安装/设置向导配置，默认 8366；0=未启用时需先配置或使用备选方式）；经网关的 URL 有会话鉴权，curl 会返回 invalid token，不可用于本命令。

备选（直连端口未启用时）：UI 复制脚本全文 → 存为 `/tmp/fnos-shutdown-executor.sh` → 执行上面 `sudo install` 起的后半段。

卸载执行器（应用卸载不自动执行，仅供用户手动）：

```bash
PING_GID_RANGE="$(sudo cat /var/lib/fnos-shutdown/ping-group-range.original 2>/dev/null || true)" \
  && sudo rm -f /usr/local/sbin/fnos-shutdown-executor.sh /etc/cron.d/fnos-shutdown /etc/sysctl.d/99-fnos-shutdown-ping.conf \
  && { [ -z "$PING_GID_RANGE" ] || sudo sysctl -w "net.ipv4.ping_group_range=$PING_GID_RANGE"; } \
  && sudo rm -f /var/lib/fnos-shutdown/ping-group-range.original \
  && { sudo rmdir /var/lib/fnos-shutdown 2>/dev/null || true; }
```

## 10. 联调与自测（两侧可独立验证）

**应用侧（无 executor 环境）**：
- 手工在 `data/` 放置样本 config.json/skip.json（§3.1/§3.2 示例），验证读写与校验
- 手工伪造 `data/executor/status.json`（逐一构造四种判定谓词场景）+ 假日志文件，验证三态页与日志页

**executor 侧（无应用环境）**：
- `fnos-shutdown-executor.sh --version` / `--dry-run`：任意用户直接验证版本与检查逻辑，零副作用
- 手动放 config.json 后 `sudo bash -x` 跑主流程，观察每轮重读：运行中改配置（含关闭某个检查项），下一轮行为即变

**端到端**：部署后改窗口为「当前时间 ±3 分钟」验证 ≤10 分钟进入监控；监控中写 skip.json 验证下一轮退出；逐项关闭/开启检查验证 §4.5 行为；`--dry-run` 全绿后等待自然关机或手动触发窗口内全条件满足。

## 11. 遗留决策点（不影响契约）

- [x] v2 候选扩展的排期（首批已定稿：§4.6 v2 检查项，v0.5；剩余候选仍按「新增可选检查项」方式排期）
- [ ] `/api/executor/script` 匿名访问 vs 仅复制全文（实现时验证网关后定）
- [ ] 旧脚本 `/timor/smart_shutdown.sh` 的保留期限

## 12. 设计决策记录

**D1 · 拒绝"UI 生成脚本、executor 动态执行"**（2026-08-11 定）
讨论中曾考虑让 executor 成为通用高权限脚本执行器、由 UI 配置生成脚本。否决理由：低权限应用若能导致 root 执行任意代码，则应用后端任一漏洞、或任何被授权打开该应用 UI 的家庭成员，都等价于 NAS root 权限——安全模型从"应用被攻破 = 乱关机"塌缩为"应用被攻破 = 整机失陷"。结论：executor 能力为封闭预设集合（§4.6），UI 只能配置开关与阈值参数；可执行内容过界必须经管理员交互式 sudo（即 executor 自身的部署流程）。未来新需求一律走「新增预设检查项 + 可选配置字段」的扩展路径。

**D1 补充（2026-08-12，v0.7）**：曾评估两条免手动升级路径——① 执行器从包内脚本目录直接自更新：否决，该目录为应用用户可写，应用被攻破即可替换脚本获 root；② 应用 run-as=root + 生命周期回调部署：可行但第三方 root 包无法上架商店。采纳③ **签名自更新（§3.6）**：信任锚为 sudo 首次部署时锚定的内嵌公钥，应用可写的脚本+签名文件无私钥无法伪造，安全模型不塌缩，升级全自动。

**D2 · v2 检查项选型与 network 语义修订**（2026-08-12 定）
结合目标机器实测（smbd 常驻、md127 RAID1、btrfs、qBittorrent/aria2/frpc 运行中、libvirtd 无 VM、upsd 未运行），从 §4.6 候选目录升格首批 v2 检查项：`smb_sessions`（家人拷贝文件场景）、`tcp_sessions`（ssh 泛化，覆盖媒体 8005/网关 5666 等）、`download_active`（ss 连接计数，刻意避开需凭证的 WebUI API）、`min_uptime`（防 WoL/定时唤醒后立即被关机的抖动场景，`/proc/uptime` 零成本）。同时修订两处 v1 遗留：`network` 速率单位明确为 **KiB/s**（字段名 max_*_kbps 语义，v1 实现已按此执行，契约原文未写明）；§4.3 伪代码 `write_status(triggered)` 的 `triggered` 非 last_action 枚举值，仅表"入口写"语义（v1 实现已按此执行）。`network.max_tx_kbps` 以「可选字段、默认 0=不启用」加入，旧 executor 忽略后行为不变，满足 §7。

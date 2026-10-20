#!/usr/bin/env bash
# deploy/start-linux.sh — Debian 12 无头服务器上以 Xvfb + 有头 Chromium 常驻运行 AIChat桥接 (MV3)。
#
# 用法:
#   ./deploy/start-linux.sh            # 启动 (后台, 幂等: 已在跑则直接返回 0)
#   ./deploy/start-linux.sh stop       # 停止 (只停自己 pidfile 里且 cmdline 校验通过的进程)
#   ./deploy/start-linux.sh status     # 查看状态
#   ./deploy/start-linux.sh restart    # stop + start
#   ./deploy/start-linux.sh run        # 前台运行 chromium (给 systemd 用, exec 后 MainPID 即 chromium)
#
# 所有路径/端口都能用环境变量覆盖, 见下方默认值。
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)

# ---- 可配置项 (环境变量 > 默认值) ----------------------------------------
EXT_DIR=${AICHAT_EXT_DIR:-$REPO_DIR/extension}
DISPLAY_NUM=${AICHAT_DISPLAY:-:99}
SCREEN_SPEC=${AICHAT_SCREEN:-1920x1080x24}          # Xvfb -screen 0 WxHxD
WINDOW_SIZE=${AICHAT_WINDOW_SIZE:-1920,1080}        # chromium --window-size
DEBUG_PORT=${AICHAT_DEBUG_PORT:-9222}
BASE_DIR=${AICHAT_BASE_DIR:-$HOME/.local/share/aichat-bridge}
USER_DATA_DIR=${AICHAT_USER_DATA_DIR:-$BASE_DIR/profile}
RUN_DIR=${AICHAT_RUN_DIR:-$BASE_DIR/run}
LOG_DIR=${AICHAT_LOG_DIR:-$BASE_DIR/logs}
CHROME_BIN=${AICHAT_CHROME_BIN:-}
XVFB_BIN=${AICHAT_XVFB_BIN:-}
# 额外传给 chromium 的参数, 空格分隔 (排错时可覆盖)
EXTRA_FLAGS=${AICHAT_EXTRA_FLAGS:-}

CHROME_PIDFILE="$RUN_DIR/chromium.pid"
XVFB_PIDFILE="$RUN_DIR/xvfb.pid"

log()  { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die()  { printf '[%s] ERROR: %s\n' "$(date '+%F %T')" "$*" >&2; exit 1; }

# ---- 工具函数 -------------------------------------------------------------
pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# 校验 /proc/<pid>/cmdline 里确实含有指定标记, 防止 pid 复用误杀别人的进程。
# cmdline 是 NUL 分隔的 argv，转成逐行后做子串匹配（个别参数会被 /usr/bin/chromium
# wrapper 改写，所以不用整行 -x 精确匹配）。
cmdline_has() { # $1=pid $2=必须出现的字面量
  local pid="$1" needle="$2"
  [ -r "/proc/$pid/cmdline" ] || return 1
  tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF -- "$needle"
}

# 需要多个标记同时命中时用这个（Xvfb 的显示号是独立 argv，不能拼成一个字符串匹配）。
cmdline_has_all() { # $1=pid, 其余=必须全部出现的字面量
  local pid="$1"; shift
  local needle
  [ -r "/proc/$pid/cmdline" ] || return 1
  for needle in "$@"; do
    cmdline_has "$pid" "$needle" || return 1
  done
  return 0
}

read_pidfile() { # $1=pidfile
  local f="$1" pid=""
  [ -f "$f" ] || { printf ''; return 0; }
  pid=$(head -n1 "$f" 2>/dev/null | tr -dc '0-9')
  printf '%s' "$pid"
}

write_pidfile() { printf '%s\n' "$1" > "$2"; }

resolve_bins() {
  if [ -z "$CHROME_BIN" ]; then
    CHROME_BIN=$(command -v chromium || command -v chromium-browser || true)
  fi
  [ -n "$CHROME_BIN" ] && [ -x "$CHROME_BIN" ] || die "找不到 chromium, 请安装: apt-get install -y chromium (或用 AICHAT_CHROME_BIN 指定)"
  if [ -z "$XVFB_BIN" ]; then
    XVFB_BIN=$(command -v Xvfb || true)
  fi
  [ -n "$XVFB_BIN" ] && [ -x "$XVFB_BIN" ] || die "找不到 Xvfb, 请安装: apt-get install -y xvfb"
}

prepare_dirs() {
  mkdir -p "$USER_DATA_DIR" "$RUN_DIR" "$LOG_DIR"
  chmod 700 "$BASE_DIR" "$USER_DATA_DIR" 2>/dev/null || true
}

xvfb_socket() { printf '/tmp/.X11-unix/X%s' "${DISPLAY_NUM#:}"; }

# 启动 Xvfb (幂等): 若我们的 Xvfb 已在跑则复用; 若该显示号被别的 X server 占用则报错退出。
start_xvfb() {
  local pid
  pid=$(read_pidfile "$XVFB_PIDFILE")
  if pid_alive "$pid" && cmdline_has_all "$pid" "Xvfb" "$DISPLAY_NUM"; then
    log "Xvfb 已在运行 (pid=$pid, display=$DISPLAY_NUM), 复用"
    return 0
  fi
  if [ -S "$(xvfb_socket)" ]; then
    die "display $DISPLAY_NUM 已被其它 X server 占用且不是本脚本启动的 (没有匹配的 pidfile)。请换显示号: AICHAT_DISPLAY=:98 $0 start"
  fi
  log "启动 Xvfb $DISPLAY_NUM -screen 0 $SCREEN_SPEC"
  nohup "$XVFB_BIN" "$DISPLAY_NUM" "${XVFB_ARGS[@]}" \
    >"$LOG_DIR/xvfb.log" 2>&1 &
  pid=$!
  write_pidfile "$pid" "$XVFB_PIDFILE"
  local i
  for i in $(seq 1 50); do
    [ -S "$(xvfb_socket)" ] && { log "Xvfb 就绪 (pid=$pid)"; return 0; }
    pid_alive "$pid" || die "Xvfb 启动失败, 见 $LOG_DIR/xvfb.log"
    sleep 0.1
  done
  die "Xvfb 超时未就绪, 见 $LOG_DIR/xvfb.log"
}

build_chromium_args() {
  CHROME_ARGS=(
    "--user-data-dir=$USER_DATA_DIR"
    "--load-extension=$EXT_DIR"
    "--disable-extensions-except=$EXT_DIR"
    "--remote-debugging-port=$DEBUG_PORT"
    "--remote-debugging-address=127.0.0.1"
    "--window-size=$WINDOW_SIZE"
    "--password-store=basic"
    "--no-first-run"
    "--no-default-browser-check"
    "--noerrdialogs"
    "--disable-popup-blocking"
    "--disable-infobars"
    "--disable-component-update"
    "--disable-session-crashed-bubble"
    "--disable-dev-shm-usage"
    "--disable-gpu"
    "--disable-background-timer-throttling"
    "--disable-backgrounding-occluded-windows"
    "--disable-renderer-backgrounding"
    "--disable-features=CalculateNativeWinOcclusion,Translate,MediaRouter,OptimizationHints"
    "--enable-features=NetworkServiceInProcess2"
    "--disable-ipc-flooding-protection"
    "--autoplay-policy=no-user-gesture-required"
    "--class=AIChatBridge"
    "about:blank"
  )
  if [ "$(id -u)" = "0" ]; then
    # root 下 chromium 必须关掉沙箱, 否则直接退出。生产环境请改用普通用户 + systemd --user。
    CHROME_ARGS=("--no-sandbox" "${CHROME_ARGS[@]}")
  fi
  if [ -n "$EXTRA_FLAGS" ]; then
    # shellcheck disable=SC2206
    local extra=( $EXTRA_FLAGS )
    CHROME_ARGS=("${extra[@]}" "${CHROME_ARGS[@]}")
  fi
}

# 幂等启动检查: pidfile 存在 + 进程活着 + cmdline 含本 user-data-dir
chromium_running_pid() {
  local pid
  pid=$(read_pidfile "$CHROME_PIDFILE")
  if pid_alive "$pid" && cmdline_has "$pid" "--user-data-dir=$USER_DATA_DIR"; then
    printf '%s' "$pid"; return 0
  fi
  return 1
}

wait_for_devtools() { # $1=timeout 秒
  local timeout="${1:-30}" i
  for i in $(seq 1 "$((timeout * 10))"); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$DEBUG_PORT/json/version" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

cmd_status() {
  local cpid xpid
  cpid=$(read_pidfile "$CHROME_PIDFILE")
  xpid=$(read_pidfile "$XVFB_PIDFILE")
  if pid_alive "$cpid" && cmdline_has "$cpid" "--user-data-dir=$USER_DATA_DIR"; then
    log "chromium: running pid=$cpid user-data-dir=$USER_DATA_DIR"
  else
    log "chromium: stopped"
  fi
  if pid_alive "$xpid" && cmdline_has_all "$xpid" "Xvfb" "$DISPLAY_NUM"; then
    log "xvfb: running pid=$xpid display=$DISPLAY_NUM"
  else
    log "xvfb: stopped"
  fi
  if curl -fsS --max-time 2 "http://127.0.0.1:$DEBUG_PORT/json/version" 2>/dev/null; then
    printf '\n'
  fi
}

stop_one() { # $1=pidfile $2=cmdline 校验标记(空格分隔多个) $3=名字 [4]=额外必需标记
  local pidfile="$1" markers="$2" name="$3" extra="${4:-}" pid
  pid=$(read_pidfile "$pidfile")
  if ! pid_alive "$pid"; then
    log "$name: 未在运行, 清理 pidfile"
    : > "$pidfile"
    return 0
  fi
  # 关键保护: 只杀 cmdline 里确实带我们标记的进程, 绝不按进程名批量杀。
  # shellcheck disable=SC2086
  if ! cmdline_has_all "$pid" $markers; then
    log "$name: pid=$pid 的 cmdline 不含 '$markers', 判定为无关进程, 跳过"
    : > "$pidfile"
    return 0
  fi
  # 额外归属校验：例如 Xvfb 还必须是本脚本数据目录内的 lock 文件 (Xvfb 会把 lock 写在 /tmp,
  # 所以这里用 pidfile 存在性 + 显示号双重确认已经足够, extra 预留给需要更严格判定的场景)。
  if [ -n "$extra" ] && ! cmdline_has "$pid" "$extra"; then
    log "$name: pid=$pid 缺少归属标记 '$extra', 跳过"
    : > "$pidfile"
    return 0
  fi
  log "$name: 发送 TERM 到 pid=$pid"
  kill -TERM "$pid" 2>/dev/null || true
  local i
  for i in $(seq 1 50); do
    pid_alive "$pid" || { log "$name: 已退出 (TERM 生效)"; : > "$pidfile"; return 0; }
    sleep 0.2
  done
  log "$name: 10s 内未退出, 发送 KILL"
  kill -KILL "$pid" 2>/dev/null || true
  for i in $(seq 1 25); do
    pid_alive "$pid" || { log "$name: 已退出 (KILL 生效)"; : > "$pidfile"; return 0; }
    sleep 0.2
  done
  log "$name: 仍然存活 pid=$pid (可能已被 systemd 接管)"
  return 1
}

cmd_stop() {
  # 先停 chromium (会让 Xvfb 客户端消失), 再停 Xvfb。
  local rc=0
  stop_one "$CHROME_PIDFILE" "--user-data-dir=$USER_DATA_DIR" chromium || rc=1
  stop_one "$XVFB_PIDFILE" "Xvfb $DISPLAY_NUM" xvfb || rc=1
  return $rc
}

cmd_start() {
  resolve_bins
  prepare_dirs
  local existing
  if existing=$(chromium_running_pid); then
    log "chromium 已在运行 (pid=$existing), 无需重复启动 (幂等)"
    if wait_for_devtools 5; then
      log "DevTools 可用: http://127.0.0.1:$DEBUG_PORT/json/version"
    fi
    return 0
  fi
  # pidfile 丢失但 DevTools 端口已经有人应答：说明上一实例还在跑。
  # 此时不重复拉起（否则会撞 user-data-dir 锁），提示调用方手工 stop 收敛。
  if wait_for_devtools 2; then
    log "WARN: 端口 $DEBUG_PORT 上已有 DevTools 在应答, 但 $CHROME_PIDFILE 缺失或与进程不匹配。"
    log "WARN: 可能是上次异常退出留下的实例。确认后执行: $0 stop; $0 start"
    return 0
  fi
  start_xvfb
  build_chromium_args
  log "启动 chromium ($CHROME_BIN) display=$DISPLAY_NUM ext=$EXT_DIR"
  DISPLAY="$DISPLAY_NUM" nohup "$CHROME_BIN" "${CHROME_ARGS[@]}" \
    >>"$LOG_DIR/chromium.log" 2>&1 &
  local pid=$!
  write_pidfile "$pid" "$CHROME_PIDFILE"
  if wait_for_devtools 60; then
    log "chromium 就绪 (pid=$pid), DevTools: http://127.0.0.1:$DEBUG_PORT"
  else
    log "WARN: 60s 内 DevTools 未就绪, 见 $LOG_DIR/chromium.log"
    tail -n 20 "$LOG_DIR/chromium.log" >&2 || true
    return 1
  fi
  return 0
}

# 前台模式: 给 systemd 用。先起 Xvfb, 然后 exec chromium => systemd MainPID 就是 chromium。
cmd_run() {
  resolve_bins
  prepare_dirs
  start_xvfb
  build_chromium_args
  # exec 之后 pid 不变, 所以先把自己的 pid 写进 chromium.pid 仍然有效。
  write_pidfile "$$" "$CHROME_PIDFILE"
  log "exec chromium (前台模式, systemd MainPID=$$)"
  export DISPLAY="$DISPLAY_NUM"
  exec "$CHROME_BIN" "${CHROME_ARGS[@]}"
}

main() {
  XVFB_ARGS=(-screen 0 "$SCREEN_SPEC")
  case "${1:-start}" in
    start)   cmd_start ;;
    run)     cmd_run ;;
    stop)    cmd_stop ;;
    restart) cmd_stop || true; sleep 0.5; cmd_start ;;
    status)  cmd_status ;;
    *)       die "未知子命令: $1 (可用: start|stop|restart|status|run)" ;;
  esac
}

main "$@"

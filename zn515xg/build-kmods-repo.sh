#!/bin/sh
#
# 把编译好的 kmod apk 收进固件，形成设备本机离线源：
#     /www/kmods/*.apk  +  /www/kmods/packages.adb
# 设备上 /etc/apk/repositories.d/customfeeds.list 已经指向
#     http://127.0.0.1/kmods/packages.adb
#
# 用法（在宿主机上跑）：
#     ./zn515xg/build-kmods-repo.sh [编译树路径]
#
# 生成物写进 <编译树>/files/www/kmods/，之后 make world 会把它
# 通过 files 覆盖层整包拷进 rootfs（不额外打 apk 包）。
#
# 裁剪不做在这里，交给 kmod-filter.py：它按板载硬件画像挑出本板用得上的
# 包，再做依赖闭包。全量 1204 个是 57.4 MiB，会撑爆 64.3 MiB 的 fit 分区；
# 筛完 614 个 14.3 MiB，固件 rootfs 约 25 MiB。
#
set -e

P=${1:-$(cd "$(dirname "$0")/.." && pwd)}
A=$P/staging_dir/host/bin/apk
SRC=$P/bin/targets/airoha/an7581/packages
OUT=$P/files/www/kmods
SEC=$P/private-key.pem
BUILTIN=$P/zn515xg/kmods-builtin-ko.txt
FILTER=$P/zn515xg/kmod-filter.py

[ -x "$A" ]   || { echo "找不到 apk 工具: $A" >&2; exit 1; }
[ -f "$SEC" ] || { echo "找不到签名私钥: $SEC" >&2; exit 1; }
[ -d "$SRC" ] || { echo "找不到编译产物: $SRC" >&2; exit 1; }
[ -f "$FILTER" ] || { echo "找不到裁剪脚本: $FILTER" >&2; exit 1; }

N=$(ls "$SRC"/kmod-*.apk 2>/dev/null | wc -l)
[ "$N" -gt 0 ] || { echo "没有 kmod-*.apk，先跑 make package/compile" >&2; exit 1; }

PY=$(command -v python3 || echo /home/wen/.workbuddy/binaries/python/versions/3.13.12/bin/python3)

echo "== 收集 kmod：源 $N 个 =="
LIST=$("$PY" "$FILTER" --src "$SRC" --apk "$A" \
	--builtin "$BUILTIN" --stats)

rm -rf "$OUT"
mkdir -p "$OUT"
echo "$LIST" | while read -r f; do
	[ -n "$f" ] && cp "$SRC/$f" "$OUT"/
done

KEPT=$(ls "$OUT"/*.apk 2>/dev/null | wc -l)
echo "  收录 $KEPT 个（剔除 $((N - KEPT)) 个）"

echo "== 生成并签名索引 =="
cd "$OUT"
# 包本身不签名（adbsign 会把 v3 包的 data 块写坏），只签索引。
# --allow-untrusted 让未签名包能进索引；--keys-dir 少不得，
# 否则签名会静默丢失（退出码照样是 0，索引里却没有 # sig 块）。
"$A" mkndx \
	--allow-untrusted \
	--keys-dir "$P" \
	--sign-key "$SEC" \
	--output packages.adb \
	*.apk

echo "== 验签 =="
if "$A" adbdump packages.adb 2>/dev/null | grep -q '^# sig'; then
	echo "  packages.adb 签名 OK"
else
	echo "  !! packages.adb 没有签名块" >&2
	exit 1
fi

SZ=$(du -sb "$OUT" | cut -f1)
CNT=$(ls "$OUT"/*.apk | wc -l)
IDX=$(stat -c%s "$OUT/packages.adb")

echo
echo "== 完成 =="
echo "  目录   : $OUT"
echo "  包数   : $CNT"
echo "  索引   : $IDX 字节"
echo "  总体积 : $((SZ / 1048576)).$(( (SZ % 1048576) * 10 / 1048576 )) MiB"

#!/bin/sh
#
# 把编译好的 kmod apk 收进固件，形成设备本机离线源：
#     /www/kmods/*.apk  +  /www/kmods/packages.adb
# 设备上 /etc/apk/repositories.d/customfeeds.list 已经指向
#     http://127.0.0.1/kmods/packages.adb
#
# 用法（在宿主机上跑）：
#     tools/build-kmods-repo.sh [编译树路径]
#
# 生成物写进 <编译树>/files/www/kmods/，之后 make world 会把它
# 通过 files 覆盖层整包拷进 rootfs（不额外打 apk 包）。
#
set -e

P=${1:-$(cd "$(dirname "$0")/.." && pwd)}
A=$P/staging_dir/host/bin/apk
SRC=$P/bin/targets/airoha/an7581/packages
OUT=$P/files/www/kmods
SEC=$P/private-key.pem

[ -x "$A" ]  || { echo "找不到 apk 工具: $A" >&2; exit 1; }
[ -f "$SEC" ] || { echo "找不到签名私钥: $SEC" >&2; exit 1; }
[ -d "$SRC" ] || { echo "找不到编译产物: $SRC" >&2; exit 1; }

N=$(ls "$SRC"/kmod-*.apk 2>/dev/null | wc -l)
[ "$N" -gt 0 ] || { echo "没有 kmod-*.apk，先跑 make package/compile" >&2; exit 1; }

# 板子上根本不可能出现的硬件驱动：fit 分区放不下全量 57 MiB，这些剔掉最划算。
# 只按"芯片不在本板"排除，能外接的 USB 网卡驱动（rtl/ath）一律保留。
#   mt7990/mt7992/mt7996/mt7925/mt7922   Wi-Fi 6E/7 芯片固件，本板是 mt7915+PCIe
#   iwlwifi / mlx5                         Intel 无线、Mellanox 以太网
#   oaf                                   Shortcut FE 加速，仅 x86
EXCLUDE=${EXCLUDE:-'^kmod-(mt7990|mt7992|mt7996|mt7925|mt7922|iwlwifi|mlx5|oaf)'}

echo "== 收集 kmod：源 $N 个 =="
rm -rf "$OUT"
mkdir -p "$OUT"

KEPT=0
DROPPED=0
for f in "$SRC"/kmod-*.apk; do
	if [ -n "$EXCLUDE" ] && echo "$(basename "$f")" | grep -Eq "$EXCLUDE"; then
		DROPPED=$((DROPPED + 1))
		continue
	fi
	cp "$f" "$OUT"/
	KEPT=$((KEPT + 1))
done
echo "  收录 $KEPT 个，按排除规则略过 $DROPPED 个"

echo "== 生成并签名索引 =="
cd "$OUT"
"$A" mkndx \
	--root "$P" \
	--keys-dir "$P" \
	--allow-untrusted \
	--sign "$SEC" \
	--output packages.adb \
	*.apk

echo "== 验签 =="
"$A" verify --keys-dir "$P" packages.adb

SZ=$(du -sb "$OUT" | cut -f1)
CNT=$(ls "$OUT"/*.apk | wc -l)
IDX=$(stat -c%s "$OUT/packages.adb")

echo
echo "== 完成 =="
echo "  目录   : $OUT"
echo "  包数   : $CNT"
echo "  索引   : $IDX 字节"
echo "  总体积 : $((SZ / 1048576)).$(( (SZ % 1048576) * 10 / 1048576 )) MiB"

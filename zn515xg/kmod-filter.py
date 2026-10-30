#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
kmod-filter.py —— 从全量 kmod apk 中筛出「本板用得上」的子集。

给 build-kmods-repo.sh 用：读 packages/ 下的 kmod-*.apk，解析每个包的
依赖与 .ko 清单，按「板载硬件画像」做白名单裁剪，再做依赖闭包，
最后把保留的文件名逐行打到 stdout。

为什么要过滤：全量 1204 个 kmod 是 57.4 MiB，而 fit 分区只有 64.3 MiB。
本板（ZNXT ZN515XG-D / Airoha AN7581）实际只需要 614 个、14.3 MiB。

裁剪依据（都在设备上实测过，别凭感觉改）：
  SoC    airoha an7581 / en7581
  Wi-Fi  MT7915E (14c3:790a) + MT7916 (14c3:7906) —— 跑 mt7915e / mt76
  USB    xhci-mtk，已使用 usb-storage + uas
  PON    airoha-pon-*
  内置   /rom/lib/modules/<ver>/ 下实际存在的 .ko（见 kmods-builtin-ko.txt）

用法：
  ./kmod-filter.py --src <packages 目录> --apk <host apk 工具>
                   [--builtin <ko 清单>] [--stats]
"""
import argparse
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

# 板子上物理不可能出现的驱动 —— 优先级高于白名单
DROP_RE = re.compile(r"""^(
    # 本板没有的 Wi-Fi 芯片（板载是 mt7915/mt7916，见白名单）
    mt7601u|mt7603|mt7610|mt7615|mt7628|mt7630|mt7663.*|mt76x0|mt76x2|
    mt7921.*|mt7922.*|mt7925.*|mt7990.*|mt7992.*|mt7996.*|
    ath.*|b43.*|brcm.*|rtl.*|rt2x00.*|rt2800.*|rt2500.*|rt61.*|rt73.*|
    iwl.*|mwl8k|cw1200.*|aic8800.*|libertas.*|zd1211rw|p54.*|ar5523|at76c50x.*|
    rtw.*|wl12xx|wil6210|mt76-usb|
    # 光猫没有 ATA/SATA 控制器
    ata.*|pata.*|sata-.*|
    # 其它厂商的有线网卡（PCI 侧不存在）
    3c59x|8139.*|8390|acenic|amd8111|atl1.*|atl2|atlantic|b44|bnx2.*|bnxt.*|
    dl2k|dmfe|e100|e1000.*|epic100|fealnx|forcedeth|hamachi|i40e|ice|igb.*|ixgb.*|
    jme|mlx.*|natsemi|ne2k.*|ns83820|pcnet.*|qlcnic|r6040|r8169|r8168|s2io|sb1250|
    sfc|sis900|skge|sk98lin|sky2|starfire|sundance|sungem|tg3|tlan|tulip|typhoon|
    via-rhine|via-velocity|vxge|winbond-840|yellowfin|8139cp|8139too
  )$""", re.X)

# 本板真实可用的能力
KEEP_RE = [
    # 平台与板载无线
    r"^airoha.*",
    r"^mt76$", r"^mt76-connac-lib$", r"^mt7915e$", r"^mt7915-firmware$",
    r"^mt7916-firmware$", r"^mt76-firmware$",
    r"^cfg80211$", r"^mac80211$", r"^compat$",
    # 流控 / QoS / BPF（DAED 的硬依赖）
    r"^(sch[_-].*|sched.*|act[_-].*|cls[_-].*|em[_-].*|netem|ifb|teql|sfb|fq.*|cake|htb|hfsc)$",
    r"^(bpf.*|xdp.*|test-run|bpf-test)$",
    r"^(veth|macvlan|ipvlan|vxlan|bridge|vlan|8021q|bond|dummy|vrf|nlmon)$",
    r"^(tun|wireguard|ppp.*|pppoe.*|l2tp.*|pptp|gre|gre6|ipip|sit|ip6.*|sctp|dccp|llc|stp)$",
    # netfilter / 防火墙
    r"^(nf.*|nft.*|iptables.*|ipt-.*|ebtables.*|ebt-.*|ipset.*|xt-.*|arptables.*|netfilter.*)$",
    r"^(br-netfilter|ipt-core|ip6t.*)$",
    # 网络基础设施
    r"^(mii|mdio.*|phy.*|netlink.*|diag|inet-diag|tcp-bbr|tcp-hybla|tcp-scalable|tcp-vegas|tcp-westwood|tcp-illinois|tcp-cubic)$",
    # 存储与文件系统
    r"^(usb-storage.*|uas|scsi.*|sd-mod|sg|libsas|libata.*)$",
    r"^(fs-.*|nls-.*|loop|dm-.*|md|md-.*|raid.*|ubi.*|mtd.*|nand.*|mmc.*|mtk-sd)$",
    r"^(f2fs|ext4|vfat|exfat.*|ntfs.*|cifs|nfs.*|overlay|squashfs|xfs|btrfs|autofs|fuse|isofs|udf|hfs.*|jfs|reiserfs|zonefs|erofs)$",
    # 基础子系统
    r"^(gpio.*|i2c.*|iio.*|spi.*|leds.*|ledtrig.*|hwmon.*|thermal.*|watchdog.*|regmap.*|reset.*|pwm.*|rtc.*|nvmem.*|pps|ptp|clk.*|soc.*|cpufreq.*|devfreq.*|edac.*|extcon.*|pmic.*|mfd.*)$",
    r"^(gpio-button-hotplug|button-hotplug|input-core|evdev|uinput|input-polldev)$",
    # 加密 / 压缩（wireguard、文件系统、DAED 都要）
    r"^(crypto-.*|af-alg|echainiv|seqiv|authenc|pcbc|xcb|chacha.*|poly1305|ghash|lzo.*|lz4|lz4hc|zstd|xz|zlib.*|xxhash|libchacha.*|libpoly1305|libblake2s|libcurve25519.*)$",
    # USB 总线与串口
    r"^(usb|usbcore|usb-common|xhci.*|ehci.*|ohci.*|uhci.*|usb-serial.*|usb-net.*|usb-hid.*|hid.*|hid-generic|usbip.*)$",
    # 杂项
    r"^(kernel|kexec|random-trust|cpu.*|arm.*|firmware.*|dm-crypt|dm-mod|dm-integrity|dm-verity|nbd|zram|zsmalloc|cleancache|frontswap|ramoops|pstore.*|pktgen|openvswitch.*)$",
]
KEEP_RE = [re.compile(p) for p in KEEP_RE]


def short(name):
    return name[5:] if name.startswith("kmod-") else name


def dump(apk, path):
    """解析 adbdump 输出：包名、kmod 依赖、提供的 .ko"""
    try:
        out = subprocess.run([apk, "adbdump", path], capture_output=True,
                             text=True, timeout=60).stdout
    except Exception:
        return None
    name, mode, deps, kos = None, None, [], []
    for line in out.splitlines():
        s = line.strip()
        if s.startswith("name:"):
            name = s.split(":", 1)[1].strip()
        elif s.startswith("depends:"):
            mode = "dep"
            continue
        elif s.startswith(("provides:", "paths:", "tags:", "installed-size:")):
            mode = None
        if mode == "dep" and s.startswith("- "):
            dep = re.split(r"[=<>~]", s[2:].strip())[0]
            if dep.startswith("kmod-"):
                deps.append(dep)
        if s.endswith(".ko"):
            m = re.search(r"([A-Za-z0-9_.\-]+\.ko)$", s)
            if m:
                kos.append(m.group(1))
    if not name:
        return None
    return {"file": path, "name": name, "deps": deps,
            "kos": sorted(set(kos)), "size": os.path.getsize(path)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="packages 目录")
    ap.add_argument("--apk", required=True, help="host apk 工具路径")
    ap.add_argument("--builtin", default="", help="板子固件内置 .ko 清单")
    ap.add_argument("--stats", action="store_true", help="只打印统计到 stderr")
    a = ap.parse_args()

    files = sorted(f for f in os.listdir(a.src)
                   if f.startswith("kmod-") and f.endswith(".apk"))
    if not files:
        sys.exit("没有 kmod-*.apk，先跑 make package/compile")

    with ThreadPoolExecutor(max_workers=16) as ex:
        metas = [m for m in ex.map(lambda f: dump(a.apk, os.path.join(a.src, f)), files) if m]

    builtin = set()
    if a.builtin and os.path.exists(a.builtin):
        builtin = {l.strip() for l in open(a.builtin) if l.strip()}

    byname = {m["name"]: m for m in metas}
    seed = set()
    for m in metas:
        n = m["name"]
        if any(ko in builtin for ko in m["kos"]):
            seed.add(n)                     # 固件里已在跑，必留
        elif DROP_RE.match(short(n)):
            continue                        # 硬删优先
        elif any(r.match(short(n)) for r in KEEP_RE):
            seed.add(n)

    # 依赖闭包：避免索引里出现断链
    keep, stack = set(), list(seed)
    while stack:
        n = stack.pop()
        if n in keep or n not in byname:
            continue
        keep.add(n)
        stack.extend(d for d in byname[n]["deps"] if d not in keep)

    keep_files = sorted(byname[n]["file"] for n in keep)
    for f in keep_files:
        print(os.path.basename(f))

    if a.stats:
        tot = sum(m["size"] for m in metas)
        ks = sum(os.path.getsize(f) for f in keep_files)
        print(f"[kmod-filter] {len(files)} → {len(keep_files)} 个，"
              f"{tot/1048576:.1f} → {ks/1048576:.1f} MiB", file=sys.stderr)


if __name__ == "__main__":
    main()

# NOTES —— 排障记录与判据

这里记的是「下次会再遇到、当时花了时间才想明白」的东西。改动本身见 `README.md`。

---

## 1. 别拿 `/rom` 的使用量当分区上限

2026-10-30 犯过一次：看到设备 `df` 里 `/rom` 只有 11.0M 且 100% 占满，
就断言「57 MiB 的 kmod 仓库塞不进固件，只能放 overlay」。

错。`/rom` 是**当前这版镜像**的 squashfs 大小，不是容量上限。判据应该是：

| 看什么 | 在哪看 |
|---|---|
| 镜像里 rootfs 实际多大 | `./zn515xg/fitls.py xxx.itb` 的 `rootfs-1` 行 |
| 分区能装多大 | 设备 `cat /proc/mtd`（本机 ubi 0x0ffe0000 ≈ 255 MiB）、`df -h /overlay` |

同一台机器上历史固件的 rootfs-1 就有 53,526,528 B（51 MiB），里面塞了 1189 个 kmod。
**先翻一翻手上有没有旧固件可以 `fitls.py` 对一下，比推理快。**

---

## 2. apk v3 的签名：只签索引，别签包

- 包格式 magic 是 `ADBd`，不是 gzip tar，`tar tzf` 打不开是正常的。
  看内容要在设备上用 `apk info -L <pkg>`，或 `apk adbdump <file>`。
- **`apk adbsign` 会写坏 OpenWrt 打出来的包**：`kmod-veth` 15102 B → 1040 B，
  data 块丢失，装上报 `ADB block error`。所以别想着「把包也签了」。
- 正确姿势是只签索引（索引里含每个包的哈希，这就是信任链，包本身可以不签名）：

  ```sh
  apk mkndx --allow-untrusted --keys-dir <树根> \
            --sign-key private-key.pem -o packages.adb *.apk
  ```

  - `--allow-untrusted`：让未签名的包能进索引
  - `--keys-dir`：**少不得**。少了签名会静默丢弃，退出码照样 0
  - 校验：`apk adbdump packages.adb | grep '^# sig'`，必须有一行
- 密钥必须是 **EC P-256**（`openssl ecparam -name prime256v1`），RSA 会被判 UNTRUSTED。
  设备 `/etc/apk/keys/*.pem` 都是 178 字节的 EC 公钥，照着对。
- 宿主机上 `apk verify --keys-dir` **永远报 UNTRUSTED**（写不了 `/etc/apk/keys`），
  别拿它当判据。要么传到设备上用设备的 `apk verify` 验，要么看 `# sig` 块在不在。

---

## 3. kmod 必须和内核版本严格对齐

设备上是 `6.18.52`，包就只能是 `6.18.52-rX`。`bin/targets/<target>/packages/` 里
的产物本来就是同一构建树编出来的，只要内核没换，直接拿来推就行，不用重编。

推完要验的不只是 `apk info -e`，还要 `modprobe` 真的能加载：

```sh
modprobe veth && ip link add tv0 type veth peer name tv1 && ip link del tv0
```

注意包名和模块名不一定同名：`kmod-xdp-sockets-diag` 给的是 **`xsk_diag.ko`**，
`modprobe xdp_diag` 会返回 255。

---

## 4. 增量编译很快，别怕重跑

改了 `files/` 或 `.config` 之后 `make world` 是增量，本机实测 1.5～2 分钟：

```sh
export PATH=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v 'shim/safe-bin' | paste -sd:)
make world -j$(nproc)
```

**PATH 里必须踢掉 `shim/safe-bin`**，否则会串到别的工具链。

编完用两条判据收尾：

```sh
ls -l build_dir/target-*/linux-*/Image        # 应约 16.8～20 MiB
./zn515xg/fitls.py bin/targets/airoha/an7581/*sysupgrade.itb   # kernel-1 应约 7～8 MiB
```

`Image` 上百 MiB 说明 initramfs 版内核把正常的内核覆盖了（本分支已关
`CONFIG_TARGET_ROOTFS_INITRAMFS`，正常不会遇到）。

---

## 5. 本板硬件画像（裁剪/排障都用得上）

```
model      ZNXT ZN515XG-D
compatible znxt,zn515xg-d / airoha,an7581 / airoha,en7581
Wi-Fi      MT7915E  pci 0000:01:00.0  14c3:790a
           MT7916  pci 0001:01:00.0  14c3:7906
           驱动 mt7915e + mt76 + mt76-connac-lib
USB        xhci-mtk，usb-storage + uas 已加载
PON        airoha-pon-*、airoha-en7572、airoha-xpon
存储       ubi0 255 MiB，overlay 201.3 MiB
```

查证命令：

```sh
ls /sys/class/ieee80211                       # phy0 phy1
lsmod | grep -E 'mt7|t76'
for d in /sys/bus/pci/devices/*; do echo -n "$d "; cat $d/vendor $d/device; done
tr -d '\0' < /proc/device-tree/compatible
```

---

## 6. 改构建行为之前，先搜一下树里有没有现成脚本

`zn515xg/` 下已经有 `apply-patches.sh`、`build-kmods-repo.sh`、`fitls.py`。
这次花了半天从头写 kmod 收集逻辑，最后发现前人早就写好了一个能跑的版本，
只是排除规则比较粗。**先 `grep`/`ls`，再动手。**

# zn515xg —— 本分支相对上游的改动

面向 **ZNXT ZN515XG-D**（Airoha AN7581 / EN7581 光猫）的一组改动，主题是
「QDMA 转发缓冲池做成可切换的三档，并把它接到 LuCI 页面上」。

编译产物不是必需品：`.config`、`files/`、`feeds/`、`build_dir/` 都在 `.gitignore` 里，
仓库只放源码。

---

## 1. QDMA 转发池三档（核心）

`airoha_eth` 的硬件转发描述符池大小只有两个来源：编译期宏 `HW_DSCP_NUM`
（默认 2048）或设备树 `reserved-memory` 的尺寸（`div_u64(size, buf_size)`）。
驱动在 probe 时一次性写进 `REG_LMGR_INIT_CFG`，之后没有运行期调整入口，
所以「切档」只能靠**换设备树 + 重启**。

做法是往 FIT 里放三份完整的 dtb，每份一个完整 configuration（不是 overlay）：

| FIT 配置 | `bootconf` 取值 | qdma0 | qdma1 | 静态预留 | 槽数 |
|---|---|---|---|---|---|
| `config-1`（默认） | `config-1` | 8 MiB @`0x87000000` | 4 MiB @`0x89000000` | 12 MiB | 4096 / 4096 |
| `mem8192` | `mem8192` | 16 MiB @`0x87000000` | 8 MiB @`0x89000000` | 24 MiB | 8192 / 8192 |
| `mem16384` | `mem16384` | 32 MiB @`0x87000000` | 16 MiB @`0x89000000` | 48 MiB | 16384 / 16384 |

两个基址三档共用。**qdma1 不能放 `0x88000000`**：16384 档的 qdma0 会占满
`0x87000000`–`0x89000000`，正好压住它。16384 档的 qdma0 结尾与 qdma1 无缝衔接，
整段结束于 `0x8A000000`，正好等于内核加载地址。

切换靠 U-Boot 环境变量 `bootconf`，启动脚本里是 `bootm $loadaddr#$bootconf`：

```sh
fw_setenv bootconf mem8192 && reboot
```

### 相关文件

| 文件 | 作用 |
|---|---|
| `target/linux/airoha/dts/an7581-znxt-zn515xg-d.dtsi` | 该机型的公共部分（从原 dts 抽出） |
| `target/linux/airoha/dts/an7581-znxt-zn515xg-d.dts` | 4096 档（默认），带 qdma 预留 |
| `target/linux/airoha/dts/mem8192.dts`、`mem16384.dts` | 另两档，各自完整 |
| `target/linux/airoha/image/an7581.mk` | `DEVICE_DTS_EXTRA := mem8192 mem16384` |
| `scripts/mkits.sh` | 新增 `-E name:dtb`：生成**自带 kernel + loadables** 的 configuration |
| `include/image-commands.mk` | `Build/fit-its` 把 `DEVICE_DTS_EXTRA` 传成 `-E` |
| `include/image.mk` | 额外 dtb 的编译规则 |

### 为什么不用 `DEVICE_DTS_OVERLAY`（-O）

上游已有的 `-O` 生成的是**纯 dtb 片段**：没有 kernel、没有 loadables，靠
`bootm <addr>#<conf>#<extra>` 叠加启动。这颗 U-Boot 不解析第三段
（`fit_parse_conf` 只认 `[addr]#<conf>`，`fit_parse_subimage` 的第三段是 subimage 名），
于是它把 `mem8192` 当独立配置去启动，找不到 kernel，直接掉进 Web recovery。
`-E` 生成的配置自足，用标准的 `bootm <addr>#<name>` 就能起来。

---

## 2. 内核：BTF 与 DAED 需要的模块

DAED 依赖 BTF（`/sys/kernel/btf/vmlinux`），而 OpenWrt 的 BTF 开关在**顶层 Kconfig**
（`config/Config-kernel.in` 的 `KERNEL_DEBUG_INFO_BTF`），不在内核 config 里：

```
CONFIG_KERNEL_DEBUG_INFO_BTF=y
CONFIG_KERNEL_DEBUG_INFO_BTF_MODULES=y
# CONFIG_KERNEL_DEBUG_INFO_REDUCED is not set     ← 与 BTF 互斥，必须关
```

注意 `# CONFIG_KERNEL_DEBUG_INFO_REDUCED is not set` **不能**写在
`target/linux/airoha/an7581/config-6.18` 里：subtarget 配置是用 `scripts/kconfig.pl +`
合并的，而它在 `+` 模式下会跳过 `# ... is not set`，写了也没用。
只能落在顶层 `.config`（见 `zn515xg/config.diffconfig`）。

`target/linux/airoha/an7581/config-6.18` 里只加了三个内核模块选项（DAED 的依赖）：

```
CONFIG_NET_ACT_BPF=m
CONFIG_VETH=m
CONFIG_XDP_SOCKETS_DIAG=m
```

`CONFIG_NET_CLS_BPF` 在 generic config 里已经是 `=m`。**没有 `CONFIG_NET_SCH_BPF`
这个符号**（6.18 树里 `net/sched/sch_bpf.c` 不存在），写了会让 `make olddefconfig`
报 `(NEW)` 然后 syncconfig 失败。

---

## 3. 两个 LuCI 包

这两个包各自有独立仓库（`czghzh/luci-app-zn515xg-hw`、`czghzh/luci-app-zn515xg-mem`），
`package/` 下是便于整体构建的副本；改完记得两边同步。

| 包 | 说明 |
|---|---|
| `package/luci-app-zn515xg-hw` | 重做「状态 → 总览」：`15_hw.js` 硬件监控、`22_memstore.js` 内存与储存、`23_dhcpclients.js` 在线客户端（含 IPv6 与物理端口） |
| `package/luci-app-zn515xg-mem` | 「状态 → 硬件加速 → 内存」页面；三档切换器 + `/usr/sbin/515xg-memset` |

### 默认状态块是怎么去掉的（踩过的坑，别再试别的）

`luci-app-zn515xg-hw` 依赖四个 stock 块被移走，但**不能靠包 postinst**：
buildroot 往 rootfs 装包时用的是 `apk add ... --no-scripts`（`package/Makefile:146`），
postinst 根本不会执行。`apk add` 在活系统上没有这个参数，所以「手动装能生效、编进固件不生效」。

正确的落点是 `/etc/uci-defaults/`（`/etc/init.d/boot` 首次开机执行，早于 LuCI 起来）：

- `package/luci-app-zn515xg-hw/files/99-zn515xg-status` → `/etc/uci-defaults/99-zn515xg-status`
- postinst 保留，负责「活系统上 `apk add`」这条路径

也试过另外两条，都不行：

- 在 `files/` 覆盖层里放一个渲染返回 null 的同名 stub —— LuCI 的块列表是运行时
  `fs.list()` 枚举的，文件还在目录里就会被 `L.require()`，且浏览器会缓存旧模块；
- 直接从 `feeds/luci` 删文件 —— `feeds/` 是独立 git 仓库（且被 gitignore），
  改动进不了本仓库，`./scripts/feeds update` 就没了。

---

## 4. 本机 feed 补丁

`feeds/` 被 gitignore，所以对 feed 的修改放在 `zn515xg/patches/<feed>/`，
`./scripts/feeds update` 之后跑一次：

```sh
./zn515xg/apply-patches.sh
```

| 补丁 | 作用 |
|---|---|
| `pon-drivers/001-xpon-defer-sysfs-link.patch` | `airoha-xpon` probe 建 `/sys/class/net/pon0/xpon` 软链时，若 PON netdev 的 sysfs 节点尚未发布（`sysfs_create_link` 返回 `-EFAULT`），最多重试 1 秒而不是让整个 probe 失败。修前：`omci0`/`oam0` 不创建 → `ponctl`/`pondctl` 输出空 → LuCI 的 PON 页报「状态响应格式错误」。 |

---

## 5. 构建

```sh
./scripts/feeds update -a && ./scripts/feeds install -a
./zn515xg/apply-patches.sh
cat zn515xg/config.diffconfig >> .config    # 首次
make defconfig
make world -j$(nproc)
```

### 两个必须注意的点

**`make world` 之后要检查内核体积。** 当 rootfs 很大时（比如塞了几十个 MiB 的 apk），
initramfs 版内核会涨到上百 MiB 并把正常的 `$(KDIR)/Image` 覆盖掉，
于是 sysupgrade 的 `kernel-1` 变成几十 MiB。判据：

```sh
ls -l build_dir/target-*/linux-*/Image          # 应约 16.8 MiB
./zn515xg/fitls.py bin/targets/airoha/an7581/*sysupgrade.itb   # kernel-1 应约 7 MiB
```

本分支关掉了 `CONFIG_TARGET_ROOTFS_INITRAMFS`（见 `config.diffconfig`），
不再生成 `initramfs-recovery.itb`；恢复系统用 U-Boot 的网页恢复直接刷
`squashfs-sysupgrade.itb`。

**只跑 `make target/linux/install` 时不会重算校验和**，要手动补 `make checksum`，
否则 `sha256sums` 还停在上一版。

---

## 6. kmod 离线源

固件里 `/www/kmods/` 放一份已签名的 apk 仓库，设备上
`/etc/apk/repositories.d/customfeeds.list` 默认就指向 `http://127.0.0.1/kmods/packages.adb`。

`CONFIG_ALL_KMODS=y` 让所有 kmod 默认 `=m`（只编成 apk、不进固件），
再用脚本把它们收进 `files/www/kmods/`（`files/` 被 gitignore，不进仓库）：

```sh
./zn515xg/build-kmods-repo.sh      # 收集 kmod-*.apk → 生成签名索引 → 验签
```

fit 分区只有 64.3 MiB，全量 1204 个 kmod 是 57.4 MiB，装不下，脚本默认剔掉本板
物理上不可能用到的 15 个（mt7990/mt7992/mt7996/mt7925/mt7922 的 Wi-Fi 6E/7 固件、
iwlwifi、mlx5、oaf），剩 1189 个约 40.5 MiB。**不要写成 `kmod-mt79*`**，会误伤板载 mt7915。

设备上装包前先跑一次 `apk update`（`/var` 是 tmpfs，重启后索引缓存为空）。

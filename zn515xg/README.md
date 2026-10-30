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

### 2.1 BPF LSM：DAED 真正卡住的地方

只开 BTF 不够。DAED 的 `local_tcp_sockops`（`BPF_PROG_TYPE_SOCK_OPS`）调用
`bpf_get_current_task()`，而这个 helper 在 `kernel/bpf/verifier.c` 的
`check_sock_ops_func_proto()` 里**只在 `#ifdef CONFIG_BPF_LSM` 分支才放行**：

```
load program: invalid argument: program of this type cannot use helper bpf_get_current_task#35
```

外显症状很容易误判：`/etc/rc.d/S99daed` 已启用，但 procd 显示 `running:false`、
`exit_code:1`、incarnation 一路涨（crash loop）。此时内存、架构、BTF 都正常，
只有这一条。

**改这个开关要同时动三层，少一层就白改**：

| 层 | 位置 | 说明 |
|---|---|---|
| a | `target/linux/generic/config-6.18`（+ subtarget `config-6.18`） | 设 `CONFIG_SECURITY=y`、`CONFIG_BPF_LSM=y`、`CONFIG_SECURITYFS=y`，`CONFIG_LSM` 末尾加 `bpf` |
| b | **顶层 `.config` 的 `CONFIG_KERNEL_*`** | 最易漏，且是最终覆盖者 |
| c | `build_dir/target-*/linux-*/…/.config` | 只信这里，前两层都对了它才一定对 |

机制：`kernel-defaults.mk` 的 `Kernel/Configure/Default` 会把顶层 `.config` 里**所有**
`CONFIG_KERNEL_*` 转成 `CONFIG_*`**追加到 `.config.target` 末尾**。所以顶层
`# CONFIG_KERNEL_SECURITY is not set` 会把 target config 里的 `CONFIG_SECURITY=y` 盖掉。

诊断手法：`grep -c "^CONFIG_X=" .config.target` 得到 1 但最终不生效，
说明同名符号在 `.config.target` 里出现了两次（`scripts/kconfig.pl` 的 `m+` 模式后者胜）。

打开 `CONFIG_SECURITY=y` 还会点亮一整屏新菜单，非交互 `syncconfig` 遇到 `(NEW)` 符号
直接 abort（本次是 `SECURITY_IPE`）。必须先把新增的 `SECURITY_*` / `INTEGRITY` / `IMA` /
`EVM` / `DEFAULT_SECURITY_*` 显式 pin 成 `# ... is not set`，再 `make defconfig`。

配套还要在顶层打开（DAED 的 kprobe/uprobe/tracepoint 与 perf event array 依赖）：

```
CONFIG_KERNEL_AUDIT=y
CONFIG_KERNEL_SECURITY_NETWORK=y
CONFIG_KERNEL_BPF_EVENTS=y
CONFIG_KERNEL_KPROBES=y
CONFIG_KERNEL_KPROBE_EVENTS=y
CONFIG_KERNEL_FTRACE=y
CONFIG_KERNEL_PERF_EVENTS=y
```

以上顶层项都记在 `config.diffconfig` 里；`target/linux/*/config-6.18` 的改动直接在树里。

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
./zn515xg/build-kmods-repo.sh      # kmod-filter 裁剪 → 收集 → 生成签名索引 → 验签
```

### 裁剪：1204 → 614

`kmod-filter.py` 按**板载硬件画像**挑选，而不是简单拉黑几个型号：

| 依据 | 来源 |
|---|---|
| SoC | airoha / en7581 |
| Wi-Fi | MT7915E `14c3:790a` + MT7916 `14c3:7906`，跑 `mt7915e` + `mt76` |
| USB | xhci-mtk，已用 `usb-storage` + `uas` |
| PON | `airoha-pon-*`、`airoha-en7572` |
| 固件内置 | `kmods-builtin-ko.txt`，从设备 `/rom/lib/modules/<ver>/` 抓的 116 个 `.ko` |

选法是「白名单（平台 + 网络/存储/加密/基础子系统）+ 硬删除（其它平台无线固件、
其它厂商网卡、ATA 控制器、蓝牙/DVB/声卡）+ **依赖闭包**」，跑完必须 0 断链。
结果 614 个、14.3 MiB，rootfs 从 11.4 MB 涨到 25.2 MB，固件 33 MB。

早先的做法是只剔 15 个（mt7990/92/96、mt7925/92、iwlwifi、mlx5、oaf），留 1189 个、
40.5 MiB，也能刷（fit 分区 64.3 MiB），但塞了一堆本板永远用不到的驱动。
**注意别写成 `kmod-mt79*`**，会误伤板载的 mt7915。

### 签名：只签索引，不要签包

`packages.adb` 用根目录的 `private-key.pem` 签，对应设备固件自带的
`/etc/apk/keys/public-key.pem`，所以刷完机 `apk update` 直接就是可信源。

两条必须遵守的规则（都踩过）：

1. **不要对包执行 `apk adbsign`**。它会重写 v3 包，实测把 15102 字节的
   `kmod-veth` 写成 1040 字节，data 块直接丢了，装上去报 `ADB block error`。
2. `apk mkndx` 必须同时给 `--allow-untrusted`（让未签名包能进索引）和
   `--keys-dir`。**少给 `--keys-dir` 签名会静默丢失**：命令退出码仍是 0、
   索引正常生成，但里面没有 `# sig` 块。校验办法：
   `apk adbdump packages.adb | grep '^# sig'`。

### 三个连不通的源

`pon_drivers` / `pon_userspace` / `video` 三个 feed 在设备上 wget 一律 error 8
（`packages.adb: unexpected end of file`），所以 `.config` 里把它们由 `y` 改成 `m`：

```sh
CONFIG_FEED_video=m
CONFIG_FEED_pon_drivers=m
CONFIG_FEED_pon_userspace=m
```

`include/feeds.mk` 的 `$(if $(filter m,$(CONFIG_FEED_$(feed))),# )` 会在 `distfeeds.list`
里给这三行加 `# ` 注释掉。

**只能改 `y`→`m`，绝不能从 `feeds.conf` 里删掉这几行**：`pon_drivers` 提供
airoha 的驱动包，删了 feed 之后 `make world` 找不到包，固件会缺驱动直接变砖。

设备上装包前先跑一次 `apk update`（`/var` 是 tmpfs，重启后索引缓存为空）。

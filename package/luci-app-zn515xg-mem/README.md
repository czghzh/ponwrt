# luci-app-zn515xg-mem

ZNXT ZN515XG-D（Airoha AN7581）的「状态 → 硬件加速 → 内存」页面。

把开机时被划走的 DRAM 摊开给人看：哪些是硬件强制要的、哪些是可以商量的，以及两颗
QDMA 转发引擎的缓冲池到底占了多大。

## 装

```sh
apk add --allow-untrusted luci-app-zn515xg-mem-1.0.0-r1.apk
```

- 包是 `noarch` 纯文件包，510M 和 1G 两种内存版本通吃。
- 没有签名（签名私钥在原构建树里，不在本仓库），所以必须带 `--allow-untrusted`。
- 装完 **重新登录 LuCI**：rpcd 只在登录时读一次 ACL，不重登会报 Access denied。
- 卸载：`apk del luci-app-zn515xg-mem`，页面和菜单一并消失，不动任何系统文件。

## 这页显示什么

| 卡片 | 数据来源 |
| --- | --- |
| 物理内存 | 开机日志 `Memory: xK/yK available`，回退到 MemTotal 并标注「估算」 |
| 系统可用 | `/proc/meminfo` MemTotal |
| 硬件固定预留 | 设备树 `reserved-memory` 各区域求和 |
| 转发缓冲池 | `qdma0-buf` + `qdma1-buf` 之和；没有这两个节点时按驱动动态分配显示 |
| 内存分布 | 上面几项按物理内存比例画成一条色带 |
| 设备树预留 | 每个区域的地址、大小和用途，一行一个 |
| 转发池规划 | 选描述符深度 → 算出占用与差值，并给出对应的 DTS 片段 |

厂家的 `an7581.dtsi` 给两颗 QDMA 各留了 16384 槽（`rmem->size / buf_size` 反推），
而驱动在没有预留时的默认值是 `HW_DSCP_NUM = 2048`——**8 倍**。48 MiB 里 42 MiB 是白留的，
页面把这个倍数直接写在卡片上，而不是让人自己去按计算器。

数据全部运行时读取，页面里**没有任何写死的内存大小**——同一份固件/同一个 apk
要同时跑在 510M 和 1G 两个版本上，写死必然错一个。

## 必须说清楚的一件事：这页不能在线调

「选个数字就生效」在这个硬件上不成立：

- 有 `reserved-memory` 节点时，池深度 = `rmem->size / buf_size`（驱动
  `airoha_qdma_init_hfwd_queues()` 里 `div_u64`）；
- 没有节点时，池深度 = 驱动里编译期的 `HW_DSCP_NUM`；
- 两种情况最后都是把槽数写进 `REG_LMGR_INIT_CFG`，**probe 时一次性完成**，之后没有重配接口。

所以下面的选择器是**规划工具**：它算账、给设备树片段，改完仍需重编固件再刷。
页面不提供「保存并应用」，因为那会是个骗人的按钮。

## 实测数据（两台机器）

| | 510M 版 | 1G 版 |
| --- | --- | --- |
| 物理内存 | 512 MiB | 1024 MiB |
| MemTotal | 422.1 MiB | 924.4 MiB |
| 开机划走 | 91 MiB | 99.6 MiB |
| 其中硬件 no-map | 60 MiB | 60 MiB |
| atf / npu-binary | 2 / 10 MiB | 2 / 10 MiB |
| qdma0 / qdma1 | 32 / 16 MiB | 32 / 16 MiB |
| 内核与其它 | 29.9 MiB | 39.6 MiB |

同一个 60 MiB 的硬件预留，在 510M 机器上占物理内存的 **11.7%**，在 1G 机器上占 5.9%。

## 构成

```
root/usr/sbin/515xg-meminfo                         读取并汇总所有数字（单次 exec）
root/usr/share/luci/menu.d/luci-app-zn515xg-mem.json 菜单：状态 → 硬件加速内存
root/usr/share/rpcd/acl.d/luci-app-zn515xg-mem.json  只授权 exec 那个 helper
htdocs/luci-static/resources/view/zn515xg/mem.js     页面本体
```

helper 一次 exec 吐 `key=value`，页面只解析不二次读文件：`/proc/net/nf_conntrack`
那类伪文件经 rpcd 的 `file.read` 只能读到 4096 字节，且每多一条 ACL 就多一个装不上的
理由，所以统一走 exec。

## 版本

- 1.0.0-r2 把「8 倍超配」这件事摆到台面上：转发池卡片直接写 `16384 + 16384 槽，为驱动默认的 8.0×`，
  规划器顶部加「当前（设备树）48.0 MiB / 驱动默认 6.0 MiB」对照，选中 2048 档时明示可少占 42.0 MiB。
- 1.0.0-r1 首个版本。

## 许可

GPL-2.0-only

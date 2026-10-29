#
# luci-app-zn515xg-mem - Status -> Hardware acceleration memory
#
# Ships one LuCI view plus two helpers and one data file:
#
#   view/zn515xg/mem.js            the page: what the SoC carves out of DRAM
#                                  before the page allocator exists (atf,
#                                  npu-binary, qdma0-buf, qdma1-buf), with a
#                                  stacked distribution track, the per-region
#                                  rows, and a switcher for the QDMA
#                                  forwarding-pool profile.
#   usr/sbin/515xg-meminfo         reads /proc/meminfo, the boot "Memory:"
#                                  line and the reserved-memory dump; prints
#                                  key=value lines.  No DRAM size is hardcoded -
#                                  the same image runs on the 512 MiB and the
#                                  1 GiB variant.
#   usr/sbin/515xg-memset          status | set <slots> | init.  Writes the
#                                  U-Boot `bootconf` variable, and seeds the
#                                  U-Boot environment on a factory unit.
#   usr/share/zn515xg/ubootenv.script
#                                  the 48 variables dumped out of this board's
#                                  U-Boot image; used once by `memset init`.
#
# Why a helper for the switch: the pool depth is `reserved_size / buf_size` in
# airoha_qdma_init_hfwd_queues() and gets written into REG_LMGR_INIT_CFG once
# at probe - no sysfs, no module parameter, no devlink.  What can change is
# which FIT configuration U-Boot boots, via the `bootconf` variable, so the
# switch is an environment write plus a reboot.
#
include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-zn515xg-mem
PKG_VERSION:=1.0.0
PKG_RELEASE:=5

PKG_LICENSE:=GPL-2.0-only
PKG_MAINTAINER:=czghzh <czghzh@users.noreply.github.com>

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-zn515xg-mem
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=ZN515XG-D hardware acceleration memory page
  DEPENDS:=+luci-base +rpcd +rpcd-mod-file
  PKGARCH:=all
endef

define Package/luci-app-zn515xg-mem/description
  Status -> Hardware acceleration memory for the ZN515XG-D:
  shows the DRAM the SoC takes out before the page allocator exists
  (ATF, NPU firmware and the two QDMA hardware-forwarding buffer pools),
  the remaining distribution against MemTotal, and lets you switch the
  forwarding-pool profile between 4096 / 8192 / 16384 descriptors per
  engine.  The switch writes the U-Boot bootconf variable and takes effect
  on the next boot; no reflash and no driver change.
endef

# Plain scripts and JS only - without an explicit empty rule the default runs
# `make -C $(PKG_BUILD_DIR)` and dies with "no makefile found".
define Build/Compile
endef

define Package/luci-app-zn515xg-mem/install
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/zn515xg
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/zn515xg/mem.js \
		$(1)/www/luci-static/resources/view/zn515xg/mem.js
	$(INSTALL_DIR) $(1)/usr/sbin
	$(INSTALL_BIN) ./root/usr/sbin/515xg-meminfo $(1)/usr/sbin/515xg-meminfo
	$(INSTALL_BIN) ./root/usr/sbin/515xg-memset $(1)/usr/sbin/515xg-memset
	$(INSTALL_DIR) $(1)/usr/share/zn515xg
	$(INSTALL_DATA) ./root/usr/share/zn515xg/ubootenv.script \
		$(1)/usr/share/zn515xg/ubootenv.script
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-zn515xg-mem.json \
		$(1)/usr/share/rpcd/acl.d/luci-app-zn515xg-mem.json
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/luci-app-zn515xg-mem.json \
		$(1)/usr/share/luci/menu.d/luci-app-zn515xg-mem.json
endef

$(eval $(call BuildPackage,luci-app-zn515xg-mem))

#
# Copyright (C) 2006-2013 OpenWrt.org
#
# This is free software, licensed under the GNU General Public License v2.
# See /LICENSE for more information.
#
include $(TOPDIR)/rules.mk

PKG_NAME:=sed
PKG_VERSION:=4.10

PKG_SOURCE:=$(PKG_NAME)-$(PKG_VERSION).tar.gz
PKG_SOURCE_URL:=@GNU/$(PKG_NAME)
PKG_HASH:=4d179ffaf92ec4dcec541f7c032be1c3b9a1856f4970adb95a505221702f5277
PKG_CPE_ID:=cpe:/a:gnu:sed

export SED:=

HOST_BUILD_PARALLEL:=1
HOST_CONFIGURE_CACHE:=1

HOSTCC := $(HOSTCC_NOCACHE)
HOSTCXX := $(HOSTCXX_NOCACHE)

include $(INCLUDE_DIR)/host-build.mk

HOST_CONFIGURE_ARGS += \
	--disable-acl \
	--disable-nls \
	--enable-threads=posix \
	--disable-i18n \
	--without-selinux

# glibc >= 2.34 keeps socklen_t in <sys/socket.h> only, so sed 4.10's
# AC_TYPE_SOCKLEN_T probe misses it and its own fallback then collides with the
# already-included declaration ("conflicting types for 'getpeername'").
HOST_CONFIGURE_VARS += ac_cv_type_socklen_t=yes

define Host/Compile
	+$(MAKE) $(HOST_JOBS) -C $(HOST_BUILD_DIR) SHELL="$(BASH)"
endef

define Host/Install
	$(INSTALL_BIN) $(HOST_BUILD_DIR)/sed/sed $(STAGING_DIR_HOST)/bin/
endef

define Host/Clean
	rm -f $(STAGING_DIR_HOST)/bin/sed
endef

$(eval $(call HostBuild))

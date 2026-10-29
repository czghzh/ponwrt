#!/usr/bin/env python3
"""
fitls.py - 列出 FIT (.itb) 里的子镜像，并就地计算每个子镜像的 sha256。

用途：刷机后验明正身。设备侧 `sha256sum /dev/fit0` 得到的值应等于本工具
输出的 rootfs 子镜像 sha256；这样不依赖 uname / revision 也能证明板上跑的是
哪一个 .itb。

纯标准库，无外部依赖。FDT 规范见 Devicetree Specification v0.4 §5。

用法:
    ./fitls.py <file.itb>            # 列全部子镜像
    ./fitls.py <file.itb> --verify   # 顺便自检（data 落在文件范围内）
"""

import hashlib
import struct
import sys

FDT_MAGIC = 0xD00DFEED
FDT_BEGIN_NODE = 1
FDT_END_NODE = 2
FDT_PROP = 3
FDT_NOP = 4
FDT_END = 9


def parse_fdt(blob):
    """返回 (节点树, strings 表偏移)。节点为 dict: name/children/props。"""
    (magic, totalsize, off_struct, off_strings, _off_rsv,
     _ver, _lastcomp) = struct.unpack_from(">7I", blob, 0)
    if magic != FDT_MAGIC:
        raise ValueError(f"不是 FDT blob（magic={magic:#x}）")

    pos = off_struct
    stack = []
    root = None

    while True:
        (token,) = struct.unpack_from(">I", blob, pos)
        pos += 4

        if token == FDT_BEGIN_NODE:
            end = blob.index(b"\x00", pos)
            name = blob[pos:end].decode("utf-8", "replace")
            pos = (end + 1 + 3) & ~3  # 名字串按 4 字节对齐

            node = {"name": name, "props": {}, "children": []}
            if stack:
                stack[-1]["children"].append(node)
            else:
                root = node
            stack.append(node)

        elif token == FDT_END_NODE:
            stack.pop()

        elif token == FDT_PROP:
            length, nameoff = struct.unpack_from(">2I", blob, pos)
            pos += 8
            value = blob[pos:pos + length]
            pos = (pos + length + 3) & ~3

            end = blob.index(b"\x00", off_strings + nameoff)
            pname = blob[off_strings + nameoff:end].decode("ascii", "replace")
            stack[-1]["props"][pname] = value

        elif token == FDT_NOP:
            continue

        elif token == FDT_END:
            break

        else:
            raise ValueError(f"未知 token {token:#x} @ {pos - 4}")

    return root, totalsize


def walk(node, path=""):
    """深度优先遍历，产出 (路径, 节点)。"""
    cur = f"{path}/{node['name']}" if node["name"] else path
    yield cur, node
    for child in node["children"]:
        yield from walk(child, cur)


def u32(node, prop, default=None):
    raw = node["props"].get(prop)
    if raw is None:
        return default
    return struct.unpack(">I", raw[:4])[0]


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)

    path = sys.argv[1]
    verify = "--verify" in sys.argv

    with open(path, "rb") as fh:
        blob = fh.read()

    root, totalsize = parse_fdt(blob)

    print(f"文件      : {path}")
    print(f"大小      : {len(blob):,} 字节（FDT totalsize {totalsize:,}）")

    desc = root["props"].get("description")
    if desc:
        print(f"description: {desc.rstrip(chr(0).encode()).decode('utf-8', 'replace')}")
    print()

    images = None
    for cur, node in walk(root):
        if cur == "/images":
            images = node
            break

    if images is None:
        sys.exit("没有 /images 节点，这不是 FIT 镜像？")

    hdr = f"{'子镜像':<16}{'offset':>12}{'size':>12}  {'type':<12} sha256"
    print(hdr)
    print("-" * len(hdr))

    total = 0
    for img in images["children"]:
        name = img["props"].get("_name_fix") or img["name"]
        # 节点名常形如 rootfs-1，真正的标签在 properties 里
        label = name
        for pname in ("type",):
            pass

        off = u32(img, "data-position", 0)
        size = u32(img, "data-size", 0)
        itype = img["props"].get("type", b"").rstrip(b"\x00").decode("ascii", "replace")

        data = blob[off:off + size]
        digest = hashlib.sha256(data).hexdigest()
        total += size

        flag = ""
        if verify and (off + size > len(blob) or len(data) != size):
            flag = "  <== 越界!"

        print(f"{label:<16}{off:>12}{size:>12}  {itype:<12} {digest}{flag}")

    print("-" * len(hdr))
    print(f"子镜像数据合计: {total:,} 字节")
    print()
    print("提示: 设备侧 `sha256sum /dev/fit0` 应等于上面 rootfs 那行的 sha256。")


if __name__ == "__main__":
    main()

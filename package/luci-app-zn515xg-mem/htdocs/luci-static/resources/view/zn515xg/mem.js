'use strict';
'require view';
'require fs';

/*
 * ZNXT ZN515XG-D - "状态 -> 硬件加速 -> 内存" page.
 *
 * Layout follows the overview page this box already ships (see 15_hw.js /
 * 22_memstore.js): grey cards on --background-color-medium, 12px muted card
 * titles, 24px tabular-nums readings, 4px tracks.  Nothing here invents a new
 * visual language - the page reads as one more block of the same dashboard.
 *
 * Content: what the SoC takes out of DRAM before the page allocator exists.
 * The four device-tree regions are NO-MAP, so the kernel never maps them.  Two
 * of them (atf, npu-binary) are hard requirements - ATF is the EL3 secure
 * world, npu-binary holds the NPU firmware the PPE offload path runs on.  The
 * other two (qdma0-buf, qdma1-buf) are the QDMA hardware-forwarding buffer
 * pools, and their depth is a policy choice rather than a hardware constant.
 *
 * Everything is read at runtime through /usr/sbin/515xg-meminfo.  There is
 * deliberately no constant in this file that assumes a DRAM size: the same
 * firmware image and the same .apk run on the 512 MiB and the 1 GiB variant of
 * this board, and the page has to be right on both.
 *
 * The pool depth is `rmem->size / buf_size` in airoha_qdma_init_hfwd_queues()
 * and the result is written into REG_LMGR_INIT_CFG once, at probe - it cannot
 * change while the box is up, and there is no sysfs/devlink knob to nudge it.
 * What *can* change is which device tree the bootloader hands over: the FIT
 * this firmware ships carries three configurations (4096 / 8192 / 16384 slots
 * per engine) and U-Boot picks one from the `bootconf` variable.  So the
 * switcher below writes that variable and asks for a reboot - no reflash, no
 * driver change.
 *
 * The first switch needs a one-time seed of the U-Boot environment: on a
 * factory unit both ubootenv volumes are erased, U-Boot runs on its built-in
 * default and `boot_production` still reads `bootm $loadaddr` with no
 * configuration selector.  The page detects that and offers the seed.
 */

function css(name, fallback) {
	return 'var(--' + name + ', ' + fallback + ')';
}

var cCardBg = css('background-color-medium', '#f9f9f9');
var cBorder = css('border-color-low', '#eeeeee');
var cMuted  = css('text-color-medium', '#808080');
var cStrong = css('text-color-highest', '#000000');
var cTrack  = css('border-color-low', '#eeeeee');
var cCool   = css('success-color-high', 'rgb(0, 172, 89)');

var S_GRID  = 'display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px';
var S_GRID1 = 'display: grid; grid-template-columns: 1fr; gap: 10px';
var S_CARD  = 'background: ' + cCardBg + '; border: 1px solid ' + cBorder +
              '; border-radius: 6px; padding: 10px 12px; min-width: 0';
var S_TITLE = 'font-size: 12px; color: ' + cMuted + '; margin-bottom: 8px';
var S_BIG   = 'font-size: 24px; font-weight: 600; line-height: 1.15; color: ' + cStrong +
              '; font-variant-numeric: tabular-nums';
var S_UNIT  = 'font-size: 12px; color: ' + cMuted + '; margin-left: 3px';
var S_NOTE  = 'font-size: 11px; color: ' + cMuted + '; margin-top: 3px';
var S_ROW   = 'display: flex; align-items: baseline; justify-content: space-between; gap: 10px';
var S_LABEL = 'font-size: 12px; color: ' + cMuted;
var S_VALUE = 'font-size: 12px; color: ' + cStrong + '; font-variant-numeric: tabular-nums';
var S_MONO  = 'font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: ' + cMuted;

var MEMINFO = '/usr/sbin/515xg-meminfo';
var MEMSET  = '/usr/sbin/515xg-memset';

/* The three configurations the FIT actually carries.  `conf` is the value
 * bootconf must hold; config-1 is the FIT's default and keeps its bare name. */
var PROFILES = [
	{ slots: 4096,  kib: 12288, span: '8 + 4 MiB',   conf: 'config-1' },
	{ slots: 8192,  kib: 24576, span: '16 + 8 MiB',  conf: 'mem8192'  },
	{ slots: 16384, kib: 49152, span: '32 + 16 MiB', conf: 'mem16384' }
];

/* buf_size the driver uses: QDMA0 carries 2 KiB packets, QDMA1 1 KiB
 * (airoha_qdma_init_hfwd_queues(), REG_HW_FWD_DSCP_CFG). */
var QDMA0_BUF = 2048;
var QDMA1_BUF = 1024;

/* HW_DSCP_NUM in airoha_eth.h - the depth the driver picks when the device
 * tree does not carve out a region for it.  The vendor DTS reserves 16384
 * slots per engine here, i.e. 8x that. */
var DEF_DSCP = 2048;

var REGION_NOTE = {
	'atf':        'EL3 安全世界',
	'npu-binary': 'NPU 固件',
	'qdma0-buf':  '转发池',
	'qdma1-buf':  '转发池'
};

function fmtKiB(kib, digits) {
	var n = Number(kib);

	if (!isFinite(n) || n < 0)
		return '?';

	if (n >= 1024 * 1024)
		return (n / 1024 / 1024).toFixed(2) + ' GiB';

	if (n >= 1024)
		return (n / 1024).toFixed(digits == null ? 1 : digits) + ' MiB';

	return n + ' KiB';
}

function pct(part, whole) {
	return (whole > 0) ? Math.max(0, Math.min(100, Number(part) / Number(whole) * 100)) : 0;
}

function parse(res) {
	var out = { regions: [] };
	var lines = ((res && res.stdout) || '').split('\n');

	for (var i = 0; i < lines.length; i++) {
		var m = lines[i].match(/^([a-z0-9_]+)=(.*)$/);

		if (!m)
			continue;

		var rm = m[1].match(/^r(\d+)_(name|addr|end|kib)$/);

		if (rm) {
			var idx = Number(rm[1]);

			if (!out.regions[idx])
				out.regions[idx] = {};

			out.regions[idx][rm[2]] = m[2];
		}
		else {
			out[m[1]] = m[2];
		}
	}

	return out;
}

function readMem() {
	return L.resolveDefault(fs.exec(MEMINFO), {}).then(parse);
}

function readStatus() {
	return L.resolveDefault(fs.exec(MEMSET, [ 'status' ]), {}).then(parse);
}

function card(title, body) {
	return E('div', { 'style': S_CARD }, [
		E('div', { 'style': S_TITLE }, [ title ]),
		body
	]);
}

function reading(value, unit, note) {
	return E('div', {}, [
		E('div', {}, [
			E('span', { 'style': S_BIG }, [ value ]),
			unit ? E('span', { 'style': S_UNIT }, [ unit ]) : ''
		]),
		E('div', { 'style': S_NOTE }, [ note || '' ])
	]);
}

function row(label, value, extra) {
	return E('div', { 'style': S_ROW }, [
		E('span', { 'style': S_LABEL }, [ label ]),
		E('span', { 'style': S_VALUE }, [
			value,
			extra ? E('span', { 'style': S_NOTE + '; display: inline' }, [ ' ' + extra ]) : ''
		])
	]);
}

function legend(color, label) {
	return E('span', { 'style': 'white-space: nowrap' }, [
		E('span', {
			'style': 'display: inline-block; width: 9px; height: 9px; border-radius: 2px;' +
				' margin-right: 6px; background: ' + color
		}),
		label
	]);
}

return view.extend({
	load: function() {
		return Promise.all([ readMem(), readStatus() ]).then(function(r) {
			return { mem: r[0] || {}, st: r[1] || {} };
		});
	},

	render: function(data) {
		var d = (data && data.mem) || {},
		    st = (data && data.st) || {},
		    regions = (d.regions || []).filter(function(r) { return r && r.name; }),
		    phys = Number(d.phys_kb) || 0,
		    total = Number(d.mem_total_kb) || 0,
		    pool = Number(d.pool_kb) || 0,
		    mode = d.pool_mode || 'unknown',
		    approx = (d.src !== 'dmesg');

		var hw = 0, i;

		for (i = 0; i < regions.length; i++)
			hw += Number(regions[i].kib) || 0;

		/* pool depth per engine, derived from the region size the same way the
		 * driver does it: num_desc = rmem->size / buf_size */
		var poolKib = { 'qdma0-buf': 0, 'qdma1-buf': 0 };

		for (i = 0; i < regions.length; i++)
			if (poolKib[regions[i].name] != null)
				poolKib[regions[i].name] = Number(regions[i].kib) || 0;

		var slots0 = Math.round(poolKib['qdma0-buf'] * 1024 / QDMA0_BUF),
		    slots1 = Math.round(poolKib['qdma1-buf'] * 1024 / QDMA1_BUF),
		    /* what the driver allocates with no DTS region: HW_DSCP_NUM = 2048 */
		    defPool = (DEF_DSCP * (QDMA0_BUF + QDMA1_BUF)) / 1024,
		    mult = (mode == 'static' && defPool > 0) ? pool / defPool : 0;

		/* what the kernel kept for itself: image, page tables, vmemmap, SWIOTLB */
		var kernel = Math.max(0, phys - total - hw);

		/* ---- four readings, same card shape as 硬件监控 ---------------- */

		/* In dynamic mode the device tree reserves nothing, so `pool` is 0 - yet
		 * the driver still carves HW_DSCP_NUM slots out of system memory at
		 * probe time.  Reporting a flat "0 KiB" there reads as "there is no
		 * pool", which is the opposite of what is happening: the memory just
		 * comes from MemTotal instead of from a no-map carve-out.  So the card
		 * prices the depth the driver actually allocates and labels it as such.
		 * (Nothing can report the true allocation at runtime - the value goes
		 * into REG_LMGR_INIT_CFG once, in probe, and is never readable back.) */
		var poolShown = (mode == 'dynamic') ? defPool : pool,
		    poolNote = (mode == 'static')
				? (slots0 + ' + ' + slots1 + _(' 槽，为驱动默认的 ') + mult.toFixed(1) + '×')
				: (mode == 'dynamic')
					? (DEF_DSCP + ' + ' + DEF_DSCP + _(' 槽，驱动动态申请'))
					: _('未检测到');

		var readings = E('div', { 'style': S_GRID1 }, [
			E('div', { 'style': S_GRID }, [
				card(_('物理内存'), reading(fmtKiB(phys), '',
					approx ? _('按 MemTotal 估算') : _('开机日志实测'))),
				card(_('系统可用'), reading(fmtKiB(total), '', _('MemTotal')))
			]),
			E('div', { 'style': S_GRID }, [
				card(_('硬件固定预留'), reading(fmtKiB(hw), '', regions.length + _(' 个 no-map 区域'))),
				card(_('转发缓冲池'), reading(fmtKiB(poolShown), '', poolNote))
			])
		]);

		/* ---- distribution: one stacked track + a legend ---------------- */

		var segs = [], items = [];

		if (kernel > 0) {
			segs.push(E('div', {
				'style': 'width: ' + pct(kernel, phys).toFixed(2) + '%; background: #c3cad1',
				'title': _('内核与其它 ') + fmtKiB(kernel)
			}));

			items.push(legend('#c3cad1', _('内核与其它') + ' ' + fmtKiB(kernel)));
		}

		for (i = 0; i < regions.length; i++) {
			var r = regions[i],
			    kib = Number(r.kib) || 0,
			    color = (r.name.indexOf('qdma') === 0) ? '#e0a13a' : '#9aa3ad';

			segs.push(E('div', {
				'style': 'width: ' + pct(kib, phys).toFixed(2) + '%; min-width: 2px; background: ' + color,
				'title': r.name + ' ' + fmtKiB(kib)
			}));

			items.push(legend(color, r.name + ' ' + fmtKiB(kib)));
		}

		segs.push(E('div', {
			'style': 'width: ' + pct(total, phys).toFixed(2) + '%; background: ' + cCool,
			'title': _('系统可用 ') + fmtKiB(total)
		}));

		items.push(legend(cCool, _('系统可用') + ' ' + fmtKiB(total)));

		var distribution = card(_('内存分布'), E('div', {}, [
			E('div', {
				'style': 'display: flex; height: 10px; border-radius: 3px; overflow: hidden;' +
					' background: ' + cTrack
			}, segs),
			E('div', {
				'style': 'display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 10px;' +
					' font-size: 11px; color: ' + cMuted
			}, items)
		]));

		/* ---- device-tree regions, one row each (no table) -------------- */

		var regionRows = [];

		for (i = 0; i < regions.length; i++) {
			var rr = regions[i];

			var note = REGION_NOTE[rr.name] || '';

			if (rr.name === 'qdma0-buf' && slots0)
				note += ' · ' + slots0 + _(' 槽');
			else if (rr.name === 'qdma1-buf' && slots1)
				note += ' · ' + slots1 + _(' 槽');

			regionRows.push(E('div', { 'style': S_ROW }, [
				E('span', { 'style': S_LABEL }, [
					rr.name,
					E('span', { 'style': S_MONO + '; display: block' }, [ (rr.addr || '') + '–' + (rr.end || '') ])
				]),
				E('span', { 'style': S_VALUE }, [
					fmtKiB(rr.kib),
					E('span', { 'style': S_NOTE + '; display: inline' }, [ ' ' + note ])
				])
			]));
		}

		if (mode != 'static')
			regionRows.push(row(_('转发缓冲池'), fmtKiB(pool), _('运行时申请')));

		if (!regionRows.length)
			regionRows.push(E('div', { 'style': 'font-size: 13px; color: ' + cMuted }, [ _('未检测到预留区域') ]));

		var regionsCard = card(_('设备树预留'), E('div', { 'style': 'display: grid; gap: 8px' }, regionRows));

		/* ---- profile switcher ------------------------------------------ */

		/* What the running kernel actually carved out, which is the profile
		 * the bootloader selected last time - not what bootconf says it will
		 * be next time. */
		var curSlots = slots0 || (Number(st.bootconf_slots) || 0),
		    envSaved = (st.env_saved === 'yes'),
		    selReady = (st.selector === 'yes'),
		    needInit = (!envSaved || !selReady),
		    busy = false;

		var msgBox = E('div', { 'style': 'font-size: 12px; margin-top: 8px; min-height: 16px' });

		function say(text, isErr) {
			msgBox.textContent = text || '';
			msgBox.style.color = isErr ? 'var(--danger-color-high, #d32f2f)' : cMuted;
		}

		function apply(slots) {
			busy = true;
			say(_('正在写入 U-Boot 环境…'));
			fs.exec(MEMSET, [ 'set', String(slots) ]).then(function(res) {
				var r = parse(res || {});

				if (r.ok === 'yes') {
					curSlots = Number(r.bootconf_slots) || slots;
					say(_('已设为 ') + r.bootconf_slots + _(' 槽，重启后生效。'));
				}
				else {
					say(r.msg || _('写入失败'), true);
				}

				busy = false;
			}).catch(function() {
				say(_('写入失败'), true);
				busy = false;
			});
		}

		function initEnv() {
			busy = true;
			say(_('正在初始化 U-Boot 环境（每台设备只需一次）…'));
			fs.exec(MEMSET, [ 'init' ]).then(function(res) {
				var r = parse(res || {});

				if (r.ok === 'yes') {
					say(_('初始化完成，重启一次后即可自由切换档位。'));
				}
				else {
					say(r.msg || r.reason || _('初始化失败'), true);
				}

				busy = false;
			}).catch(function() {
				say(_('初始化失败'), true);
				busy = false;
			});
		}

		var choices = [];

		for (i = 0; i < PROFILES.length; i++) {
			(function(p) {
				var on = (curSlots === p.slots);

				choices.push(E('label', {
					'style': 'display: flex; align-items: center; gap: 9px; padding: 8px 10px;' +
						' border: 1px solid ' + (on ? cCool : cBorder) + '; border-radius: 6px;' +
						' background: ' + cCardBg + '; cursor: pointer'
				}, [
					E('input', {
						'type': 'radio',
						'name': 'zn515xg-mem-profile',
						'value': String(p.slots),
						'checked': on ? 'checked' : null
					}),
					E('span', { 'style': 'display: grid; gap: 1px' }, [
						E('span', { 'style': S_VALUE }, [ p.slots + _(' 槽') ]),
						E('span', { 'style': S_NOTE + '; display: inline' }, [
							p.span + ' · ' + fmtKiB(p.kib) + (on ? _(' · 当前') : '')
						])
					])
				]));
			})(PROFILES[i]);
		}

		var actions = E('div', { 'style': 'display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap' });

		if (needInit) {
			actions.appendChild(E('button', {
				'class': 'cbi-button cbi-button-action',
				'click': function() { if (!busy) initEnv(); }
			}, [ _('初始化 U-Boot 环境') ]));
		}
		else {
			actions.appendChild(E('button', {
				'class': 'cbi-button cbi-button-save',
				'click': function() {
					if (busy)
						return;

					var picked = document.querySelector('input[name="zn515xg-mem-profile"]:checked'),
					    n = picked ? Number(picked.value) : 0;

					if (!n) {
						say(_('请先选择一个档位'), true);
						return;
					}

					apply(n);
				}
			}, [ _('应用（重启后生效）') ]));
		}

		var switcher = card(_('转发池档位'), E('div', {}, [
			E('div', { 'style': S_ROW }, [
				E('span', { 'style': S_LABEL }, [ _('当前生效') ]),
				E('span', { 'style': S_VALUE }, [
					curSlots ? (curSlots + _(' 槽')) : _('未知'),
					E('span', { 'style': S_NOTE + '; display: inline' }, [
						' ' + (st.bootconf || '')
					])
				])
			]),
			E('div', { 'style': 'display: grid; gap: 8px; margin-top: 10px' }, choices),
			actions,
			msgBox,
			E('div', { 'style': S_NOTE }, [
				needInit
					? _('U-Boot 环境尚未初始化：切换靠 bootconf 变量，需先初始化一次。')
					: _('切换写入 bootconf，重启后由 bootloader 叠加对应设备树；越大的档位预留越多 DRAM。')
			])
		]));

		/* ---- page ------------------------------------------------------ */

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, [ _('硬件加速内存') ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('AN7581 在开机时划走的 DRAM，以及两颗 QDMA 转发引擎的缓冲池。档位可切换，重启生效')
			]),
			E('div', { 'style': 'display: grid; gap: 10px; margin-top: 12px' }, [
				readings,
				distribution,
				E('div', { 'style': S_GRID }, [ regionsCard, switcher ])
			])
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});

/**
 * lib/mods/preset.js — 能力模块：**装插件就带上「鲸师模式」预设**
 * ------------------------------------------------------------------
 * 为什么这件事归插件自己干（2026-09-27 事故的正面修法）：
 *   预设原先只由安装脚本的 1c 步落盘，于是"别人装的机器上没有预设"有三条独立死路
 *   （npm 包里没带 `preset/`、1c 不给 `-PackRoot` 就 SKIP、文档从没提过它）。
 *   把这一步挪进插件：**只要插件起来了，预设就一定在** —— 三条路一次性全堵上，
 *   而且宿主发现预设是**每次调用重读**的（不缓存）⇒ 本次就能在开会话时看到，不用重启。
 *
 * 为什么是启动期而不是一个按钮：主人（2026-09-27）的原话是"让别人安装的时候预设不见了"，
 *   要的是**装完就在**，不是"再教他点一下"。所以启动期自动装，且**幂等**
 *   （内容一致一个字节都不写）；主人手写的那份（没有生成标记）**一律不碰**。
 *
 * ⚠️ **选/建课程包之后还要再刷一次**（`lib/mods/pack.js` 调同一个 `ensurePresetForPack`）：
 *   启动期 packRoot 可能还没配 ⇒ 技能目录留空；不刷新的话新用户第一次看到的预设是 0 个技能。
 *
 * 落在哪：`<DSH_HOME>/.agent-presets/whale-mode/`（宿主扫的"可写那层"根）。
 *   本机专属覆盖走配置 `presetDir`；关掉自动装走配置 `installPreset: false`。
 *
 * ⚠️ 本模块**不注册工具、不挂路由** —— 它只落一个文件。渲染规则在 `lib/preset-install.js`
 *   （唯一实现，安装脚本与判据共用同一份，**不许抄第二份**）。
 */

import { ensurePresetForPack, PRESET_ID, presetStatus } from '../preset-install.js'

export const plugin = {
	id: 'preset',
	version: '0.1.0',
	tools: [], // 落文件，不动工具面

	install(hctx) {
		const dir = hctx?.paths?.presetDir
		if (!dir) {
			// 没配 = 主人用 `installPreset: false` 关掉了（或 DSH_HOME 没定出来）。
			// 两种都**只报一句**，不报错：预设缺了不影响插件别的能力。
			hctx?.log?.warn?.(
				'没有装「鲸师模式」预设（没定出目标目录）—— 想要就删掉配置里的 installPreset: false 再重启',
			)
			return
		}

		const r = ensurePresetForPack({
			dshHome: hctx?.paths?.dshHome,
			presetDir: dir,
			packRoot: hctx?.paths?.packRoot,
			log: (level, msg) => hctx?.log?.[level === 'warn' ? 'warn' : 'info']?.(msg),
		})
		const where = `「鲸师模式」预设 → ${r.dir}`
		switch (r.action) {
			case 'created':
				hctx?.log?.info?.(`已装 ${where}（技能目录 ${r.skillsDir ?? '留空'}）—— 开会话时就能选它`)
				break
			case 'refreshed':
				hctx?.log?.info?.(`已刷新 ${where}（技能目录 ${r.skillsDir ?? '留空'}）`)
				break
			case 'unchanged':
				hctx?.log?.info?.(`${where} 已是最新`)
				break
			case 'kept-hand-edited':
				hctx?.log?.warn?.(`${where} 是手写的（没有生成标记）—— 没动它`)
				break
			default:
				// 这里是**唯一的红灯**：模板不在（多半是包里漏了 preset/）或写盘失败。
				// 绝不静默 —— 预设缺席的症状是"选了鲸师模式但老师什么都不知道"，很难往这上面想。
				hctx?.log?.error?.(`装不上 ${where}：${r.reason ?? r.action}`)
		}

		// 反空转：报一句"到底在不在"，排障时不用再翻磁盘
		const st = presetStatus({ dir })
		if (!st.installed) hctx?.log?.warn?.(`复查：${PRESET_ID} 仍然不在 ${dir}`)
	},
}

export default { plugin }

/**
 * dsh-whale-sensei —— 浏览器半边（**lazy-CJS，零构建**）。
 *
 * 两个坐位：
 *   1. `settings.section`（顶层设置项）—— 只读状态卡「鲸师」；
 *   2. `conversation.input.left`（输入框左侧工具行）—— 开课入口「开一门新课」，
 *      点一下把 `entry.prompt`（开课协议，宿主侧 `lib/starter.js` 算好）`setDraft` 进输入框。
 *
 * 三条硬约束：
 * 1. **`id` 必须逐字等于 `package.json` 的 `name`**（dsh-whale-sensei）——不是 patch 的行 id。
 * 2. **不许出现 ESM 语法**。
 * 3. 只能 `require` 冻结基座（react / react-dom / @deepseek-ai/cordis /
 *    @deepseek-ai/dsh-client-store / @deepseek-ai/dsh-client-ui-slots /
 *    @deepseek-ai/dsh-client-ui-primitives / @deepseek-ai/dsh-client-ui-dockkit），
 *    别的包名必须写进 `package.json` 的 `dsh.client.external`。
 *
 * 生效条件（"改了没生效"的 90% 都在这儿）：**重启宿主进程 + 刷新页面**，两件都要做。
 *
 * 样式取向：**不自定义颜色/字号**，一律用宿主注入的语义令牌
 * （`--dsw-alias-label-*` / `--dsw-alias-border-l*` / `--dsw-alias-state-*-primary`）——
 * 自己造色一定和官方对不上，而且深浅色主题会崩。
 */

window.__ModuleLoader__.load({
	id: 'dsh-whale-sensei',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		//#region mod:status_card —— 设置页里的「鲸师」一节
		//
		// 坐位是 **`settings.section`**（顶层设置项，与「通用设置 / 模型 / 插件 / 表情包 /
		// 插件市场」并列的那个缝），格式照本机在用的两份实现抄：
		//     `{ name: 'settings.section', id, order, label }` + 组件
		//   · dsh-meme（表情包）用 `id: 'memes', order: 25, label: '表情包'`
		//   · dshmarket（插件市场）同款
		// ⚠️ **不要去抢标签页 slot `settings.plugins.tab`**（已被 configurable/all/family-plugins
		//    占满，复用别人的 id 会把它顶掉）；那是"插件页里的卡片"另一条缝，不是这一层。
		//
		// 数据从哪来：**浏览器半边拿不到 Agent 工具**，所以宿主侧挂了一条只读路由
		// `GET /api/whale/status`（`lib/mods/status.js`）。它是同源已认证请求，栅栏由基座继承。
		// **卡片里显示什么由宿主算好**（`sections`），这里只负责画 —— 于是"卡片内容"可离线判据。
		//
		// 有意的设计：这条路由**在没配 packRoot 时也回 200** —— 这一节存在的意义正是
		// 把"没配 packRoot ⇒ 所有 /api/whale/… 会 503"**当场显示出来**，而不是显示一个错误。
		//#endregion

		var react = require('react');
		// 官方原语：弹窗用 `Modal`、按钮用 `Button` —— **不自己造模态框**（自造的焦点/遮罩/Esc 行为
		// 一定和官方对不上）。本机多个第三方插件也 require 同一个包，不需要写进 dsh.client.external。
		var primitives = require('@deepseek-ai/dsh-client-ui-primitives');

		/** 状态 → 官方语义色（不自己造色） */
		var STATE_COLOR = {
			ok: 'var(--dsw-alias-state-success-primary)',
			warn: 'var(--dsw-alias-state-warn-primary)',
			error: 'var(--dsw-alias-state-error-primary)',
		};

		/**
		 * 按钮配方 —— **照抄 DSH 原生设置页**（原生页自己也用裸 button + CSS Modules，
		 * 见 dsh-client-ui-settings-models/lib/client.js 的 primaryButton / secondaryButton / dangerButton：
		 * 高度 36px、胶囊圆角 18px、padding 0 14px、字号 14px；行内动作用 28px / 圆角 14px / 字号 12px）。
		 *
		 * 为什么用 inline style：插件客户端不许引外部 CSS（零运行时依赖 + 不许跨包引用组件）。
		 * 代价是 **:hover 写不了** —— 所以"最显眼的那一个"（选择课程包目录）用官方
		 * `primitives.Button`（它的 hover / disabled / focus-visible 由宿主那份 CSS 提供），
		 * 行内小按钮才用这套 inline 配方。
		 */
		var BTN_SIZE = {
			md: { height: '36px', borderRadius: '18px', padding: '0 14px', fontSize: '14px', lineHeight: '22px' },
			sm: { height: '28px', borderRadius: '14px', padding: '0 10px', fontSize: '12px', lineHeight: '18px' },
		};

		/** @param {'primary'|'ghost'|'outline'|'danger'} kind @param {'md'|'sm'} [size] */
		function btn(kind, size) {
			var s = Object.assign({
				display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
				border: 'none', background: 'transparent',
				color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontFamily: 'inherit',
			}, BTN_SIZE[size || 'md']);
			if (kind === 'primary') {
				s.background = 'var(--dsw-alias-button-primary-fill)';
				s.color = 'var(--dsw-alias-label-primary-foreground)';
			} else if (kind === 'outline') {
				s.border = '.5px solid var(--dsw-alias-border-l3)';
			} else if (kind === 'danger') {
				s.color = 'var(--dsw-alias-state-error-primary)';
			} else if (kind === 'ghost') {
				s.color = 'var(--dsw-alias-label-secondary)';
			}
			return s;
		}

		/** 按钮进行中/不可用：原生是 `opacity:.4; cursor:default`（不是自己调色） */
		function btnOff(style) {
			return Object.assign({}, style, { opacity: 0.4, cursor: 'default' });
		}

		//#region mod:ui_kit —— 设置页的样式表 + 两个原语
		//
		// **为什么注入样式表而不是全内联**：内联 style 写不了 `:hover` / `:focus-visible` /
		// `@media (prefers-reduced-motion)` / `::-webkit-details-marker` —— 而"像不像 DSH 原生"
		// 恰好全在这四样上。本文件早有先例：侧栏两行走 `ensureEntryStyle()`（mod:sidebar_entry）。
		//
		// 三条硬约束（test/panel.mjs:681-685 机械地查）：
		//   1. **零裸色值**（hex 一个都不许有）；
		//   2. 令牌只许 `var(--dsw-(alias|static|specific)-*)` 三种前缀
		//      （所以 `--dsw-elevation-stroke` 不能用 —— 用它的展开式 `0 0 0 .5px var(--dsw-alias-border-l4)`，
		//        那正好是 elevation-stroke 的颜色来源）；
		//   3. **不用 id 选择器**（`#abc` 会被那条 hex 正则当成颜色）。
		//
		// 数值逐字抄自 DSH 真源（npm 包 `@deepseek-ai/dsh-client-ui-settings-plugin-inventory` 的`src/client/PluginInventorySettingsTab.module.css`；行配方在 `@deepseek-ai/dsh-client-ui-settings-general`）：
		//   · 折叠卡 = `ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.module.css`
		//   · 设置行 = `locale/src/client/LanguageRow.module.css` · `ui-theme/src/client/FontSizeRow.module.css`
		//   · 箭头   = 同一枚「向下」chevron（`IconChevronDownOutline14`，size 12），转法由祖先决定
		//#endregion
		var PANEL_STYLE_ID = 'dsh-whale-sensei-panel-css';
		
		var PANEL_CSS = [
			// 节容器：max-width 760 与 gap 14 都来自原生 `.section`（plugin-inventory:1-8）
			// ⚠️ **不写 `width:100%`** —— 块级元素本来就是满宽，而 panel.mjs 有一条**全文**断言
			//    `!/width:100%/`（它守的是侧栏那一行"撑满靠 align-self:stretch"），别去撞它。
			'.ws-section{max-width:760px;display:flex;flex-direction:column;gap:14px}',
		
			// 卡：bg-layer-3 + 圆角 14 + 描边环（原生 `.card`；打开时把环换淡，同原生 [data-open=true]）
			'.ws-card{min-width:0;background:var(--dsw-alias-bg-layer-3);border:0;border-radius:14px;overflow:hidden;',
			'box-shadow:0 0 0 .5px var(--dsw-alias-border-l4)}',
			'.ws-card[open]{box-shadow:0 0 0 .5px var(--dsw-alias-border-l1)}',
		
			// 卡头：原生 `.cardContent`（min-height 52 / padding 12px 14px / hover 有底 / focus 环）
			// 同样不写 width:100% —— `<summary>` 设了 `display:flex` 就是块级盒，本来就满宽。
			'.ws-cardHead{box-sizing:border-box;min-height:52px;color:inherit;font:inherit;text-align:left;',
			'cursor:pointer;background:0 0;border:0;display:flex;align-items:center;gap:8px;padding:12px 14px;list-style:none}',
			'.ws-cardHead::-webkit-details-marker{display:none}',
			'.ws-cardHead:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.ws-cardHead:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}',
			'.ws-cardTitle{flex:1 1 auto;min-width:0;font-size:14px;font-weight:600;line-height:20px;',
			'color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.ws-cardTrailing{flex:none;display:inline-flex;align-items:center;gap:7px;',
			'color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
			'.ws-cardBody{display:flex;flex-direction:column;gap:10px;padding:0 14px 12px}',
			'.ws-cardIntro{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
		
			// 箭头：一枚「向下」chevron；卡收起翻 180°朝上，组收起转 -90°朝右（两条约定逐字照原生）
			'.ws-chevron{flex:none;display:inline-flex;color:var(--dsw-alias-label-tertiary)}',
			'.ws-card:not([open]) > .ws-cardHead .ws-chevron{transform:rotate(180deg)}',
			'.ws-groupToggle[aria-expanded="false"] .ws-chevron{transform:rotate(-90deg)}',
			'.ws-sub:not([open]) > .ws-subHead .ws-chevron{transform:rotate(-90deg)}',
			'@media (prefers-reduced-motion: no-preference){.ws-chevron{transition:transform 140ms ease-in-out}}',
		
			// 组：gap 10 + 组间 .5px 顶边线（原生 `.group` / `.group + .group`）
			'.ws-group{display:flex;flex-direction:column;gap:10px}',
			'.ws-group + .ws-group{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:14px}',
			'.ws-groupTitleRow{display:flex;align-items:center;gap:8px;min-height:32px}',
			'.ws-groupToggle{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:8px;padding:0;',
			'background:0 0;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer}',
			'.ws-groupToggle:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
			'.ws-groupTitle{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}',
			'.ws-groupSub{display:flex;flex-wrap:wrap;gap:4px 8px;margin:-6px 0 0 20px;',
			'font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
			'.ws-groupBody{display:flex;flex-direction:column;gap:10px}',
		
			// 设置行：padding 16px 0 + .5px 底边线；卡内最后一行不带线（原生 `.row` / `.section > :last-child`）
			'.ws-row{display:flex;align-items:center;gap:8px;padding:16px 0;',
			'border-bottom:.5px solid var(--dsw-alias-border-l2)}',
			'.ws-row:last-child{border-bottom:none}',
			'.ws-rowText{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}',
			'.ws-rowTitle{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}',
			'.ws-rowDesc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
			'.ws-rowValue{flex:0 0 auto;margin-left:auto;text-align:right;font-size:14px;line-height:22px;',
			'color:var(--dsw-alias-label-tertiary);word-break:break-all}',
			'.ws-rowValue.is-ok{color:var(--dsw-alias-state-success-primary)}',
			'.ws-rowValue.is-warn{color:var(--dsw-alias-state-warn-primary)}',
			'.ws-rowValue.is-error{color:var(--dsw-alias-state-error-primary)}',
			'.ws-rowActions{flex:none;display:flex;align-items:center;gap:8px}',
			'.ws-actionsRow{display:flex;align-items:center;gap:8px;padding:12px 0 0}',
		'.ws-input{flex:1 1 auto;min-width:0;box-sizing:border-box;padding:3px 8px;font-size:14px;line-height:22px;',
		'font-family:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);',
		'border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;outline:none}',
		'.ws-hidden{display:none !important}',
		
			// 树/列表行：比设置行紧一档（10px，与组间距同量级）
			'.ws-treeRow{display:flex;align-items:center;gap:8px;padding:10px 0;',
			'border-bottom:.5px solid var(--dsw-alias-border-l2)}',
			'.ws-treeRow:last-child{border-bottom:none}',
			'.ws-treeName{flex:none;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}',
			'.ws-treeMeta{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
			'.ws-spacer{flex:1 1 auto}',
			'.ws-indent{margin-left:6px;padding-left:16px;border-left:1px solid var(--dsw-alias-border-l2)}',
		
			// 状态点（照原生 `.phaseDot` 的用法）
			'.ws-badge{display:inline-flex;align-items:center;gap:7px}',
		'.ws-dot{flex:none;display:inline-block;width:6px;height:6px;border-radius:50%}',
			'.ws-dot.is-ok{background:var(--dsw-alias-state-success-primary)}',
			'.ws-dot.is-warn{background:var(--dsw-alias-state-warn-primary)}',
			'.ws-dot.is-error{background:var(--dsw-alias-state-error-primary)}',
		
			// 注入原文块：字号归到 12/18，其余（圆角 8 / bg-base / 等宽 / maxHeight 200）逐字保留
			'.ws-code{box-sizing:border-box;margin:4px 0 0;padding:8px 10px;max-height:200px;overflow:auto;',
			'background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;',
			'font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;',
			'word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
		
			// 「跟老师说」：每一层各自一个，放在那一层末尾
			'.ws-ask{display:flex;flex-direction:column;gap:8px;padding-top:10px;',
			'border-top:.5px solid var(--dsw-alias-border-l2)}',
			'.ws-askTitle{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}',
			'.ws-askSub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
			'.ws-askRow{display:flex;align-items:flex-start;gap:8px}',
			'.ws-textarea{flex:1 1 auto;box-sizing:border-box;padding:8px 10px;resize:vertical;',
			'background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;',
			'font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);font-family:inherit}',
			'.ws-textarea:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}',
		
			// 组内再套一层折叠（固定做法那种"很长但不必常看"的块）
			'.ws-sub{display:block}',
			'.ws-subHead{list-style:none;cursor:pointer;display:flex;align-items:center;gap:6px;',
			'font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
			'.ws-subHead::-webkit-details-marker{display:none}',
			'.ws-subHead:hover{color:var(--dsw-alias-label-secondary)}',
			'.ws-subBody{display:flex;flex-direction:column;gap:6px;padding:4px 0 0 18px}',
		
			// 锁死集那一行（教学纪律）
			'.ws-locked{display:flex;flex-wrap:wrap;gap:4px 8px;font-size:12px;line-height:18px;',
			'color:var(--dsw-alias-label-tertiary)}',
		].join('');
		
		/** 样式只注入一次（按 id 判重）—— 与 `ensureEntryStyle()` 同一套路 */
		function ensurePanelStyle() {
			// 非浏览器环境（判据的桩里没有 document）直接退出 —— 别把噪音打成告警
			if (typeof document === 'undefined') return;
			var head = document.head || document.documentElement;
			if (!head || !document.getElementById(PANEL_STYLE_ID)) {
				if (!head) return;
				var style = document.createElement('style');
				style.id = PANEL_STYLE_ID;
				style.textContent = PANEL_CSS;
				head.appendChild(style);
			}
		}
		
		/**
		 * 唯一的箭头 —— 一枚**向下** chevron（照原生 `IconChevronDownOutline14`，size 12）。
		 * 转法由祖先的 CSS 决定：卡收起翻 180°朝上、组收起转 -90°朝右。
		 * **全页只此一处画箭头** —— `'▸' '▾' '▼' '▶'` 四个字符从此消失。
		 */
		function Chevron() {
			return react.createElement('span', { className: 'ws-chevron', 'aria-hidden': 'true' },
				react.createElement('svg', { viewBox: '0 0 16 16', width: 12, height: 12 },
					react.createElement('path', {
						d: 'M3.5 6 8 10.5 12.5 6',
						fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
					})));
		}
		
		/**
		 * 一张卡 = **原生 `<details>`**（照 DSH「插件配置」页的折叠卡）。
		 *
		 * **为什么不是自建组件**：`test/settings-catalog.mjs:555-557` 把 hook 槽位**写死了**
		 * （StatusPanel: useState(state)=0/useState(tick)=1/useState(pick)=2/useEffect=3），
		 * 给 StatusPanel 加任何一个 hook 都会让 63 条断言整体错位。
		 * `<details>` 自带开合状态、自带键盘可达、自带 `aria-expanded` 语义 —— 零 hook、零 state。
		 *
		 * `open` 只在**首次挂载**时由 React 写一次；之后用户自己开合，React 重渲染（props 没变）
		 * 不会去动 DOM，所以用户的展开状态不会被一次 fetch 打回原形。
		 */
		function Card(props) {
			var trailing = props.trailing == null ? '' : props.trailing;
			return react.createElement('details', {
				className: 'ws-card',
				open: props.open === true ? true : undefined,
			},
				react.createElement('summary', { className: 'ws-cardHead' },
					react.createElement('span', { className: 'ws-cardTitle' }, props.title),
					react.createElement('span', { className: 'ws-cardTrailing' }, trailing, react.createElement(Chevron, {}))),
				react.createElement('div', { className: 'ws-cardBody' }, props.body));
		}
		
		/**
		 * 一行：名字 + 值。
		 *
		 * 两种排法（原生 `.row` 的两种用法）：
		 *   · **单行式** —— 左标题 14px + 右值 14px（`margin-left:auto` 右对齐）；
		 *   · **两行式** —— 标题 14px 在上、值 12px 在下、左对齐。
		 * 什么时候走两行式（**机械判据，见 test/settings-layout.mjs**）：
		 *   值长度 > 36，**或**值看起来是个路径（盘符开头 / 以 `/` 或 `./` 开头）。
		 * 理由：长值右对齐会挤成一坨；而路径左对齐才好读。
		 */
		function isLongValue(v) {
			var s = v == null ? '' : String(v);
			return s.length > 36 || /^([A-Za-z]:[\\/]|\/|\.{1,2}\/)/.test(s);
		}
		
		/** @param {{name: string, value: any, state?: 'ok'|'warn'|'error'}} props */
		function Row(props) {
			var v = props.value == null ? '' : String(props.value);
			var cls = props.state ? (' is-' + props.state) : '';
			if (isLongValue(v)) {
				return react.createElement('div', { className: 'ws-row' },
					react.createElement('div', { className: 'ws-rowText' },
						react.createElement('div', { className: 'ws-rowTitle' }, props.name),
						react.createElement('div', { className: 'ws-rowDesc' + cls }, v)));
			}
			return react.createElement('div', { className: 'ws-row' },
				react.createElement('div', { className: 'ws-rowTitle' }, props.name),
				react.createElement('div', { className: 'ws-rowValue' + cls }, v));
		}
		
		/**
		 * 一小块：组标题（14px/400，与原生 `.groupTitle` 同规格）+ 若干行 + 可选的 `extra`。
		 *
		 * ⚠️ **不许读 `props.children`**：测试的 mini-React 是
		 * `createElement(type, p, ...kids) => { type, props: p, children: kids }` ——
		 * children 挂在**元素**上，不在 props 上。读 props.children 在真 React 能跑、
		 * 在判据里会被静默丢掉（最坏的一类漏）。所以一律走显式 prop：`body` / `extra`。
		 */
		function Section(props) {
			return react.createElement('div', { className: 'ws-group' },
				react.createElement('div', { className: 'ws-groupTitleRow' },
					react.createElement('span', { className: 'ws-groupTitle' }, props.title)),
				react.createElement('div', { className: 'ws-groupBody' },
					(props.rows || []).map(function (r, i) {
						return react.createElement(Row, { key: props.title + i, name: r.name, value: r.value, state: r.state });
					}),
					props.extra));
		}

		/**
		 * 服务端 section 标题 → 卡。**这是唯一的分派表**。
		 * 表里没有的标题落进 other（并进「插件信息」卡），不会静默消失。
		 * test/settings-layout.mjs 会拿 lib/mods/status.js 里出现的每一个标题来对这张表 —— 少一个就红。
		 */
		var SECTION_HOME = {
			'课程包': 'overview',
			'学生工作区': 'overview',
			'产物': 'health',
			'审计': 'health',
			'台账': 'health',
			'插件': 'plugin',
		};

		/**
		 * 「鲸师」这一节。
		 *
		 * ⚠️ 组件在**工厂作用域**里定义一次，不在 `slots.register` 的渲染回调里现造 ——
		 *    现造会让 React 每帧拿到新的组件类型，于是整棵子树被卸载重挂
		 *    （本机在表情包那份实现里量到过 20+ 次/秒，还会连带唤醒宿主里的 MutationObserver）。
		 */
		function StatusPanel() {
			var st = react.useState({ phase: 'loading' });
			var state = st[0];
			var setState = st[1];
			var tk = react.useState(0);
			var tick = tk[0];
			var setTick = tk[1];
			// 选课程包：{ busy, text, error } | null —— 从点按钮到有结果之间显示"在等你选"
			var pk = react.useState(null);
			var pick = pk[0];
			var setPick = pk[1];

			react.useEffect(function () {
				var alive = true;
				setState({ phase: 'loading' });
				try {
					fetch('/api/whale/status', { headers: { accept: 'application/json' } })
						.then(function (r) {
							// ⚠️ **先取文本再解析**：这条路由坏掉时回的是**空体**，
							//    直接 `r.json()` 抛的是 "Unexpected end of JSON input" ——
							//    那个报错指向 JSON，真因却在路由声明（缺 requestBody ⇒ 基座 400 空体）。
							//    所以把状态码与"空响应体"一起报出来，别让下一个人再顺着 JSON 找。
							return r.text().then(function (t) {
								if (!t) {
									var e1 = new Error('HTTP ' + r.status + ' 空响应体');
									e1.status = r.status;
									throw e1;
								}
								try {
									return JSON.parse(t);
								} catch (err) {
									var e2 = new Error('HTTP ' + r.status + ' 不是 JSON：' + t.slice(0, 60));
									e2.status = r.status;
									throw e2;
								}
							});
						})
						.then(function (d) { if (alive) setState({ phase: 'ok', data: d, at: new Date().toLocaleTimeString('zh-CN') }); })
						.catch(function (err) { if (alive) setState({ phase: 'err', why: String((err && err.message) || err) }); });
				} catch (err) {
					setState({ phase: 'err', why: String((err && err.message) || err) });
				}
				return function () { alive = false; };
			}, [tick]);

			/**
			 * 读一条 /api/whale/* 的响应：**先取文本再解析**，并且把两种"不是坏、是环境"的情形说成人话。
			 *   ① 空响应体 → 多半是宿主侧那条路由没显式声明 requestBody（基座会 400 空体）
			 *   ② 纯文本 "not found" → **宿主还没重启**：客户端刷新拿到了新界面，但宿主进程里
			 *      还是旧的模块表，新路由根本没注册。2026-09-23 现场踩过（点「选择课程包目录…」报
			 *      `Unexpected token 'o', "not found" is not valid JSON`，看着像功能坏了）。
			 */
			function readJsonOrExplain(r) {
				return r.text().then(function (t) {
					var body = (t || '').trim();
					if (!body) throw new Error('HTTP ' + r.status + ' 空响应体（宿主侧那条路由可能没声明 requestBody）');
					try {
						return JSON.parse(body);
					} catch (e) {
						if (/^not\s*found/i.test(body)) {
							throw new Error('宿主里还没有这条路由（回的是 "' + body.slice(0, 20) + '"）'
								+ ' —— 客户端改了只要刷新页面，宿主那半边改了必须重启宿主');
						}
						throw new Error('HTTP ' + r.status + ' 不是 JSON：' + body.slice(0, 60));
					}
				});
			}

			/**
			 * 选课程包目录：宿主弹**原生文件夹选择框**（浏览器拿不到绝对路径，所以这活只能宿主干）。
			 * 三种结果由服务端判：空目录 → 就地建好课程包；已经是课程包 → 直接用它；其它 → 拒绝并说明原因。
			 */
			function doPickPack() {
				if (pick && pick.busy) return;
				setPick({ busy: true, text: '已弹出系统文件夹选择框 —— 在那边选一个空文件夹（或已经是课程包的目录）…', error: null });
				fetch('/api/whale/pack/choose', {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					body: JSON.stringify({}),
				}).then(readJsonOrExplain).then(function (res) {
					if (res && res.ok) {
						setPick({
							busy: false,
							text: (res.mode === 'created' ? '已在这个空目录里建好课程包：' : '已选用课程包：') + res.dir
								+ (res.mode === 'created' ? '（' + (res.created || []).length + ' 个文件）' : '（一个字节都没动）')
								+ '　' + (res.config
									? '已写入 profile 配置，重启宿主后依然生效。'
									: '本次会话已生效' + (res.configError ? '；写配置没成：' + res.configError : '')),
							error: null,
						});
						setTick(tick + 1);
					} else {
						setPick({ busy: false, text: null, error: (res && res.error) || '选目录失败' });
					}
				})['catch'](function (err) {
					setPick({ busy: false, text: null, error: String((err && err.message) || err) });
				});
			}

			if (state.phase === 'loading') {
				return react.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' } }, '正在读课程包状态…');
			}
			if (state.phase === 'err') {
				return react.createElement('div', { style: { fontSize: '12px', lineHeight: '18px' } },
					'取不到状态：' + state.why + '。',
					react.createElement('div', { style: { paddingTop: '6px', color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' } },
						'这里读的是 GET /api/whale/status。若报 400 且响应体为空，'
						+ '多半是宿主侧那条路由没显式声明 requestBody（基座会把它当 streaming，'
						+ '给 GET 装 body 就抛）—— 见 lib/mods/status.js 的注释。'),
				);
			}

			var d = state.data || {};
			// 「dsh-whale-sensei v0.2.2 · 读取于 …」从"卡头一行小字"降级成**概览卡的 trailing**（12px 灰字）。
			// **两个操作按钮不在这儿** —— 它们是「课程包」那一块的动作，挂在那块的行下面（见 packActions）。
			var headText = (d.version ? 'v' + d.version : '')
				+ (state.at ? (d.version ? ' · ' : '') + '读取于 ' + state.at : '');

			/**
			 * 「课程包」那一块的两个操作。样式**照 DSH 通用设置页那颗原生选择器**
			 * （dsh-client-locale 的 `.selector`：36px 胶囊 / 圆角 18px / padding 0 14px /
			 * 底色 `--dsw-alias-bg-module-platform` / 字 14px `label-primary`）。
			 *
			 * 为什么不用组件库的 primary：深色主题下 `button-primary-fill` 是近黑实心，
			 * 贴在近黑的卡上反而**更不显眼**；原生那颗灰胶囊才是"看得见又不抢眼"的正解
			 * （2026-09-23 用户拿「工作区内修改」那颗当参照）。
			 * 代价：inline style 写不了 :hover（插件不许引外部 CSS）。
			 */
			function actionBtn(label, onClick, disabled) {
				return react.createElement('button', {
					type: 'button',
					disabled: !!disabled,
					onClick: onClick,
					style: {
						display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
						height: '36px', borderRadius: '18px', padding: '0 14px',
						fontSize: '14px', lineHeight: '22px', fontFamily: 'inherit',
						border: 'none', cursor: disabled ? 'default' : 'pointer',
						opacity: disabled ? 0.4 : 1,
						background: 'var(--dsw-alias-bg-module-platform)',
						color: 'var(--dsw-alias-label-primary)',
					},
				}, label);
			}

			var packActions = react.createElement('div', {
				key: 'pack-actions',
				style: { display: 'flex', gap: '8px', paddingTop: '12px' },
			},
				actionBtn(pick && pick.busy ? '选择中…' : '选择课程包目录…', doPickPack, !!(pick && pick.busy)),
				actionBtn('重新读取', function () { setTick(tick + 1); }, false),
			);

			// ── 服务端 6 个分区 → 5 张卡 ───────────────────────────────────────
			// 映射表里**没有的标题一律落进 other**，最后并进「插件信息」卡 —— **绝不静默丢弃**。
			// 完整性由 test/settings-layout.mjs 守着（它从 lib/mods/status.js 抽出全部标题来对）。
			var groups = { overview: [], health: [], plugin: [], other: [] };
			for (var i = 0; i < (d.sections || []).length; i++) {
				var s = d.sections[i];
				groups[SECTION_HOME[s.title] || 'other'].push(s);
			}
			var secOf = function (sec) {
				return react.createElement(Section, { key: 'sec-' + sec.title, title: sec.title, rows: sec.rows });
			};

			var cards = [];

			// 卡 1 · 概览 —— 版本/读取时间 + 课程包 + 学生工作区 + 两个动作按钮
			var overviewKids = [];
			if (pick && (pick.text || pick.error)) {
				overviewKids.push(react.createElement('div', {
					key: 'pick',
					className: 'ws-rowDesc',
					style: { color: pick.error ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)' },
				}, pick.error ? ('选课程包失败：' + pick.error) : pick.text));
			}
			if (!d.configured) {
				// 没配好时不渲染那些分区（没有真数据），但**入口不能丢** —— 引导块里放同一颗按钮
				overviewKids.push(react.createElement('div', {
					key: 'hint',
					className: 'ws-group',
				},
					react.createElement('div', { className: 'ws-groupTitleRow' },
						react.createElement('span', { className: 'ws-groupTitle' }, d.hint || '未配置 packRoot')),
					react.createElement('div', { className: 'ws-groupBody' },
						actionBtn(pick && pick.busy ? '选择中…' : '选一个空文件夹，就地建好课程包…', doPickPack, !!(pick && pick.busy)))));
			} else {
				// 分区照服务端给的原样画；**「课程包」那一块额外挂上两个操作**（选目录 / 重新读取）——
				// 它们是这一块的动作，所以在这块的行下面，而不是飘在卡头上。
				var packActionsPlaced = false;
				for (var oi = 0; oi < groups.overview.length; oi++) {
					var os = groups.overview[oi];
					if (os.title === '课程包') {
						packActionsPlaced = true;
						overviewKids.push(react.createElement(Section, { key: 'sec-' + os.title, title: os.title, rows: os.rows, extra: packActions }));
					} else {
						overviewKids.push(secOf(os));
					}
				}
				// 兜底：万一哪天服务端不再叫「课程包」，入口也不能丢（宁可多画一处，不许静默消失）
				if (!packActionsPlaced) overviewKids.push(packActions);
			}
			if (!overviewKids.length) {
				overviewKids.push(react.createElement('div', { key: 'empty', className: 'ws-rowDesc' }, '还没读到数据。'));
			}
			cards.push(react.createElement(Card, {
				key: 'overview', title: '概览', trailing: headText, open: false, body: overviewKids,
			}));

			// 卡 2 · 课程目录（组件自己画卡 —— 它的 trailing 计数只有它自己知道）
			cards.push(react.createElement(CatalogPanel, { key: 'catalog' }));
			cards.push(react.createElement(GroupPanel, { key: 'groups' }));
			// 卡 3 · 教学方式
			cards.push(react.createElement(TeachingPanel, { key: 'teaching' }));

			// 卡 4 · 内容体检（产物 + 审计 + 台账）—— 标题右侧挂一个状态点，一眼看得出干不干净
			if (groups.health.length) {
				var healthState = null;
				var healthText = '';
				for (var hi = 0; hi < groups.health.length; hi++) {
					if (groups.health[hi].title !== '审计') continue;
					var hr = (groups.health[hi].rows || [])[0];
					if (hr) { healthState = hr.state || 'ok'; healthText = hr.value || ''; }
				}
				cards.push(react.createElement(Card, {
					key: 'health', title: '内容体检', open: false,
					trailing: react.createElement('span', { className: 'ws-badge' },
						react.createElement('span', { className: 'ws-dot is-' + (healthState || 'ok') }),
						healthText),
					body: groups.health.map(secOf),
				}));
			}

			// 卡 5 · 插件信息（插件 + 映射表兜底进来的「其他」）
			var pluginKids = groups.plugin.map(secOf);
			for (var qi = 0; qi < groups.other.length; qi++) pluginKids.push(secOf(groups.other[qi]));
			if (pluginKids.length) {
				cards.push(react.createElement(Card, {
					key: 'plugin', title: '插件信息', trailing: d.version ? 'v' + d.version : '', open: false, body: pluginKids,
				}));
			}

			return react.createElement('div', { className: 'ws-section' }, cards);
		}

		//#region mod:catalog_card —— 设置页里的「课程目录」三棵树
		//
		// 挂在已有的 settings.section 里（不新开 slot）。
		// 数据从 GET /api/whale/catalog 拿；拿不到时按 status 卡的老规矩回一句人话。
		// 结构：知识圆圈 → 知识点 → 课程，可折叠。
		//#endregion

		//#region mod:group_card —— 设置页里的「知识组（中星）」
		//
		// 主人 2026-09-26：「前端后端这些中星是怎么创建的」＋「把分组功能单独提出来，
		// 做成一个单独分级，和课程目录一级」。
		// 中星 = `lessons/<圆圈>/halo.json` 的可选 `groups[]` —— 这块卡片就是它的增删改查入口。
		// 数据与「课程目录」同源（GET /api/whale/catalog，已经带出 circles[].groups 与 points）。
		//#endregion

		/** 「知识组」卡片：按圆圈分节；建组 / 改名 / 改成员 / 删组；改完轮询重建作业。 */
		function GroupPanel() {
			var st = react.useState({ phase: "loading", data: null, error: null });
			var state = st[0];
			var setState = st[1];
			var tk = react.useState(0);
			var tick = tk[0];
			var setTick = tk[1];
			var grpSt = react.useState(null);
			var grp = grpSt[0];
			var setGrp = grpSt[1];
			var msgSt = react.useState(null);
			var msg = msgSt[0];
			var setMsg = msgSt[1];

			// 折叠状态：卡片自己 open + 每个圆圈 circles[id]（主人 2026-09-26：「各层默认收起」）
			var uiSt = react.useState({ circles: {} });
			var ui = uiSt[0];
			var setUi = uiSt[1];

			function load() {
				setState({ phase: "loading", data: null, error: null });
				fetch("/api/whale/catalog", { headers: { accept: "application/json" } })
					.then(function (r) { return r.text(); })
					.then(function (t) {
						if (!t) throw new Error("HTTP 空响应体");
						try { return JSON.parse(t); } catch (e) { throw new Error("不是 JSON：" + t.slice(0, 60)); }
					})
					.then(function (d) {
						if (d.ok === true && d.configured !== false) setState({ phase: "ok", data: d, error: null });
						else setState({ phase: "ok", data: null, error: d.error || "未配置 packRoot" });
					})["catch"](function (err) {
						setState({ phase: "ok", data: null, error: String((err && err.message) || err) });
					});
			}
			react.useEffect(function () { load(); }, [tick]);

			/** 打开组编辑表单：`g` 为空 = 新建；给了 = 编辑那个组 */
			function openGroup(c, g) {
				setMsg(null);
				// 点「编辑 / 新建」时把卡片与这个圆圈都展开 —— 否则表单藏在收起的内容里，等于点了没反应
				setUi(function (s) {
					var n = Object.assign({}, s.circles);
					n[c.id] = true;
					return Object.assign({}, s, { circles: n });
				});
				setGrp({
					halo: c.id,
					id: g ? g.id : null,
					name: g ? g.name : "",
					points: g ? (g.points || []).slice() : [],
					saving: false,
					error: null,
				});
			}

			/** 勾选 / 取消一个知识点（一个点只能属于一个组，所以这里就是它唯一的归属） */
			function togglePoint(ptId) {
				setGrp(function (s) {
					if (!s) return s;
					var has = s.points.indexOf(ptId) !== -1;
					var next = has ? s.points.filter(function (x) { return x !== ptId; }) : s.points.concat([ptId]);
					return Object.assign({}, s, { points: next });
				});
			}

			/**
			 * 等重建作业跑完 —— 「数据同步」不能只回一句「正在重建」就完事：
			 * 星图（content.js / static.svg）是**产物**，作业跑完才算真同步。
			 * 作业只活在当前宿主进程里，查不到（宿主重启过）就静默停。
			 */
			function watchRebuild(halo, jobId) {
				if (!jobId) return;
				var tries = 0;
				function step() {
					tries++;
					if (tries > 150) { setMsg({ halo: halo, text: "星图重建还在后台跑 —— 稍后刷新星图页即可" }); return; }
					fetch("/api/whale/rebuild?id=" + encodeURIComponent(jobId), { headers: { accept: "application/json" } })
						.then(function (r) { return r.json(); })
						.then(function (d) {
							var job = d && d.job;
							if (!job) return;
							if (job.done) {
								setMsg({ halo: halo, text: job.failed
									? "星图重建有 " + job.failed + " 条脚本报错 —— 打开星图页看控制台"
									: "✅ 星图数据已同步（" + (job.total || 0) + " 条重建全绿）—— 刷新星图页即可看到" });
								setTick(tick + 1);
								return;
							}
							setTimeout(step, 700);
						})["catch"](function () { setTimeout(step, 1200); });
				}
				setTimeout(step, 700);
			}

			function saveGroup() {
				var s = grp;
				if (!s || s.saving) return;
				if (!s.name.trim()) { setGrp(Object.assign({}, s, { error: "组名不能为空" })); return; }
				setGrp(Object.assign({}, s, { saving: true, error: null }));
				var payload = { halo: s.halo, name: s.name.trim(), points: s.points };
				if (s.id) payload.id = s.id;
				fetch("/api/whale/group/save", {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify(payload),
				}).then(function (r) { return r.json(); }).then(function (d) {
					if (d && d.ok === true) {
						var moved = (d.moved || []).length;
						setMsg({ halo: s.halo, text: "已保存知识组「" + d.group.name + "」（" + d.group.points.length + " 个知识点）"
							+ (moved ? "；从别的组移出 " + moved + " 个" : "") });
						setGrp(null);
						setTick(tick + 1);
						watchRebuild(s.halo, d.rebuild && d.rebuild.jobId);
					} else {
						setGrp(function (cur) { return Object.assign({}, cur, { saving: false, error: (d && d.error) || "保存失败" }); });
					}
				})["catch"](function (err) {
					setGrp(function (cur) { return Object.assign({}, cur, { saving: false, error: String((err && err.message) || err) }); });
				});
			}

			function deleteGroup(halo, g) {
				setMsg(null);
				fetch("/api/whale/group/delete", {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({ halo: halo, id: g.id }),
				}).then(function (r) { return r.json(); }).then(function (d) {
					if (d && d.ok === true) {
						setMsg({ halo: halo, text: "已删除知识组「" + g.name + "」"
							+ ((d.freed || []).length ? "；" + d.freed.length + " 个知识点回到圆圈下" : "") });
						setTick(tick + 1);
						watchRebuild(halo, d.rebuild && d.rebuild.jobId);
					} else {
						setMsg({ halo: halo, text: "删除失败：" + ((d && d.error) || "未知原因") });
					}
				})["catch"](function (err) {
					setMsg({ halo: halo, text: "删除失败：" + String((err && err.message) || err) });
				});
			}

			// ── 渲染 ──
			if (state.phase === "loading") {
				return react.createElement("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px" } }, "正在读知识组…");
			}
			if (!state.data) {
				return react.createElement("div", { className: "ws-cardWrap" },
					react.createElement(Card, {
						title: "知识组",
						trailing: "",
						open: false,
						body: react.createElement("div", { className: "ws-rowDesc" }, state.error || "无法读取课程目录"),
					}));
			}

			var circles = state.data.circles || [];
			var total = 0;
			for (var ti = 0; ti < circles.length; ti++) total += (circles[ti].groups || []).length;

			var sections = [];
			for (var ci = 0; ci < circles.length; ci++) {
				(function (c) {
					var groupsOf = c.groups || [];
					var ptCount = (c.points || []).length;
					var rows = [];
					for (var gi = 0; gi < groupsOf.length; gi++) {
						(function (g) {
							var members = (g.points || []).join("、");
							rows.push(react.createElement("div", { key: "grp-" + g.id, className: "ws-treeRow" },
								react.createElement("span", { className: "ws-treeName" }, "★ " + g.name),
								react.createElement("span", { className: "ws-spacer" }),
								react.createElement("span", { className: "ws-treeMeta" },
									(g.points || []).length + " 个知识点" + (members ? "：" + members : "")),
								react.createElement("div", { className: "ws-rowActions" },
									react.createElement("button", {
										type: "button",
										onClick: function (e) { e.stopPropagation(); openGroup(c, g); },
										style: btn("ghost", "sm"),
									}, "编辑"),
									react.createElement("button", {
										type: "button",
										onClick: function (e) { e.stopPropagation(); deleteGroup(c.id, g); },
										style: btn("danger", "sm"),
									}, "删除"))));
						})(groupsOf[gi]);
					}
					rows.push(react.createElement("div", { key: "new", className: "ws-treeRow" },
						react.createElement("button", {
							type: "button",
							onClick: function (e) { e.stopPropagation(); openGroup(c, null); },
							style: btn("ghost", "sm"),
						}, "＋ 新建知识组")));

					// 编辑表单（一次只开一个；halo 不匹配就留给别的圆圈渲染）
					if (grp && grp.halo === c.id) {
						var choices = [];
						for (var pk = 0; pk < ptCount; pk++) {
							(function (pt) {
								// 裸 id：catalog 给的是 `math/alge`，而 halo.json 的 groups[].points 存的是 `alge`
								// —— 勾选 / 归属比较都必须用裸的，否则永远显示「未分组」、保存还会被拒（2026-09-26 实测）
								var bare = String(pt.id).indexOf(c.id + "/") === 0 ? String(pt.id).slice(c.id.length + 1) : String(pt.id);
								// 这个知识点现在归谁（一个点只能属于一个组；谁都不归 = 未分组）
								var owner = null;
								for (var gj = 0; gj < groupsOf.length; gj++) {
									if ((groupsOf[gj].points || []).indexOf(bare) !== -1) { owner = groupsOf[gj]; break; }
								}
								choices.push(react.createElement("label", {
									key: "pt-" + pt.id,
									style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", cursor: "pointer" },
								},
									react.createElement("input", {
										type: "checkbox",
										checked: grp.points.indexOf(bare) !== -1,
										disabled: grp.saving,
										onChange: function () { togglePoint(bare); },
									}),
									react.createElement("span", null,
										pt.name + "（" + pt.id + "）" + (owner ? "　现在：" + owner.name : "　未分组"))));
							})(c.points[pk]);
						}
						rows.push(react.createElement("div", {
							key: "form",
							style: {
								border: "1px dashed var(--dsw-alias-border-l2)", borderRadius: "8px",
								padding: "10px 12px", display: "grid", gap: "8px", marginTop: "6px",
							},
						},
							react.createElement("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" } },
								grp.id ? "编辑知识组" : "新建知识组"),
							react.createElement("input", {
								type: "text",
								placeholder: "组名（如「后端」）",
								value: grp.name,
								disabled: grp.saving,
								onChange: function (e) {
									var v = e.target.value;
									setGrp(function (s) { return Object.assign({}, s, { name: v }); });
								},
								style: {
									fontSize: "14px", fontFamily: "inherit", padding: "6px 10px",
									minWidth: 0, width: "100%", boxSizing: "border-box",
									border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "6px",
									background: "transparent", color: "inherit",
								},
							}),
							react.createElement("div", { style: { fontSize: "12px", color: "var(--dsw-alias-label-secondary)" } },
								"成员知识点（一个知识点只能属于一个组，保存时会从原来的组移出）"),
							react.createElement("div", { style: { display: "grid", gap: "4px" } }, choices),
							grp.error ? react.createElement("div", {
								style: { color: "var(--dsw-alias-state-error-primary)", fontSize: "12px" },
							}, grp.error) : null,
							react.createElement("div", { style: { display: "flex", gap: "8px" } },
								react.createElement("button", {
									type: "button",
									disabled: grp.saving,
									onClick: saveGroup,
									style: grp.saving ? btnOff(btn("primary", "sm")) : btn("primary", "sm"),
								}, grp.saving ? "保存中…" : "保存"),
								react.createElement("button", {
									type: "button",
									disabled: grp.saving,
									onClick: function () { setGrp(null); },
									style: btn("ghost", "sm"),
								}, "取消"))));
					}

					if (msg && msg.halo === c.id) {
						rows.push(react.createElement("div", { key: "msg", className: "ws-rowDesc" }, msg.text));
					}

					sections.push(react.createElement("div", { key: "sec-" + c.id, className: "ws-group" },
						react.createElement("div", { className: "ws-groupTitleRow" },
							react.createElement("button", {
								type: "button",
								className: "ws-groupToggle",
								"aria-expanded": ui.circles[c.id] ? "true" : "false",
								onClick: function () {
									setUi(function (s) {
										var n = Object.assign({}, s.circles);
										n[c.id] = !n[c.id];
										return Object.assign({}, s, { circles: n });
									});
								},
							},
								react.createElement(Chevron, { key: "chev" }),
								react.createElement("span", { className: "ws-groupTitle" }, c.name),
								react.createElement("span", { className: "ws-spacer" }),
								react.createElement("span", { className: "ws-treeMeta" },
									groupsOf.length + " 个组 · " + ptCount + " 个知识点"))),
						react.createElement("div", { className: "ws-groupBody" + (ui.circles[c.id] ? "" : " ws-hidden") },
							react.createElement("div", { className: "ws-indent" }, rows))));
				})(circles[ci]);
			}

			return react.createElement("div", { key: "groups", className: "ws-cardWrap" },
				react.createElement(Card, {
					title: "知识组",
					trailing: circles.length + " 圆圈 · " + total + " 组",
					open: false,
					body: [
						sections.length ? sections : react.createElement("div", { key: "empty", className: "ws-rowDesc" }, "课程包里还没有知识圆圈。"),
						react.createElement("div", { key: "actions", className: "ws-actionsRow" },
							react.createElement("button", {
								type: "button",
								onClick: function () { setTick(tick + 1); },
								style: btn("ghost", "sm"),
							}, "刷新")),
					],
				}));
		}

		/** 「课程目录」三棵树。组件在工厂作用域定义一次（不在渲染回调里现造）。 */
		function CatalogPanel() {
			var st = react.useState({ phase: 'loading', data: null, error: null });
			var state = st[0];
			var setState = st[1];
			var tk = react.useState(0);
			var tick = tk[0];
			var setTick = tk[1];
			// 展开/折叠状态：{ circleId: true/false }
			var expandedSt = react.useState({});
			var expanded = expandedSt[0];
			var setExpanded = expandedSt[1];
			// 改名状态：{ circleId: { editing: true, value: '...', saving: false } }
			var renameSt = react.useState({});
			var rename = renameSt[0];
			var setRename = renameSt[1];
			// 新建圆圈状态
			var newCircleSt = react.useState({ open: false, name: '', id: '', saving: false, error: null });
			var newCircle = newCircleSt[0];
			var setNewCircle = newCircleSt[1];
			// 删除确认弹窗：{ phase:'loading'|'confirm'|'error', circleId, circleName, plan, error, busy } | null
			// **删除一律先弹窗**（用户 2026-09-22 要求）—— 而且不是"确定要删吗"这种空话：
			// 先向服务端要一份 dryRun 的**真实清单**（几个文件、几门课、进度里要清哪几条），
			// 弹窗里逐条摆出来，用户看着清单点「确认删除」。
			var delSt = react.useState(null);
			var del = delSt[0];
			var setDel = delSt[1];
			// 删除结果横幅（含那 4 条重建命令）
			var noticeSt = react.useState(null);
			var notice = noticeSt[0];
			var setNotice = noticeSt[1];

			function loadCatalog() {
				setState({ phase: 'loading', data: null, error: null });
				fetch('/api/whale/catalog', { headers: { accept: 'application/json' } })
					.then(function (r) { return r.text(); })
					.then(function (t) {
						if (!t) throw new Error('HTTP 空响应体');
						try { return JSON.parse(t); } catch (e) { throw new Error('不是 JSON：' + t.slice(0, 60)); }
					})
					.then(function (d) {
						if (d.ok === true && d.configured !== false) {
							setState({ phase: 'ok', data: d, error: null });
						} else {
							setState({ phase: 'ok', data: null, error: d.error || '未配置 packRoot' });
						}
					})
					['catch'](function (err) {
						setState({ phase: 'ok', data: null, error: String((err && err.message) || err) });
					});
			}

			react.useEffect(function () { loadCatalog(); }, [tick]);

			function toggleCircle(id) {
				setExpanded(function (e) {
					var next = Object.assign({}, e);
					next[id] = !next[id];
					return next;
				});
			}

			function startRename(circleId, currentName) {
				var r = {};
				r[circleId] = { editing: true, value: currentName, saving: false, error: null };
				setRename(r);
			}

			function doRename(circleId) {
				var entry = rename[circleId];
				if (!entry || !entry.value.trim()) return;
				setRename(function (r) {
					var next = Object.assign({}, r);
					next[circleId] = Object.assign({}, next[circleId], { saving: true, error: null });
					return next;
				});
				fetch('/api/whale/circle/rename', {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					body: JSON.stringify({ id: circleId, name: entry.value.trim() }),
				}).then(function (r) { return r.json(); }).then(function (d) {
					if (d.ok) {
						setRename({});
						setTick(tick + 1);
					} else {
						setRename(function (r) {
							var next = Object.assign({}, r);
							next[circleId] = Object.assign({}, next[circleId], { saving: false, error: d.error || '改名失败' });
							return next;
						});
					}
				})['catch'](function (err) {
					setRename(function (r) {
						var next = Object.assign({}, r);
						next[circleId] = Object.assign({}, next[circleId], { saving: false, error: String((err && err.message) || err) });
						return next;
					});
				});
			}

			function doCreateCircle() {
				if (!newCircle.name.trim() || !newCircle.id.trim()) return;
				setNewCircle(function (s) { return Object.assign({}, s, { saving: true, error: null }); });
				fetch('/api/whale/circle', {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					body: JSON.stringify({ name: newCircle.name.trim(), id: newCircle.id.trim() }),
				}).then(function (r) { return r.json(); }).then(function (d) {
					if (d.ok) {
						setNewCircle({ open: false, name: '', id: '', saving: false, error: null });
						setTick(tick + 1);
					} else {
						setNewCircle(function (s) { return Object.assign({}, s, { saving: false, error: d.error || '创建失败' }); });
					}
				})['catch'](function (err) {
					setNewCircle(function (s) { return Object.assign({}, s, { saving: false, error: String((err && err.message) || err) }); });
				});
			}

			/**
			 * 打开删除弹窗。**先 dryRun 拿真实清单，拿到才弹** ——
			 * 弹窗里摆出"会删掉哪几个目录、几个文件、几门课、进度里清几条"，
			 * 而不是一句空洞的"确定要删除吗"。
			 */
			function openDelete(c) {
				setDel({ phase: 'loading', circleId: c.id, circleName: c.name, plan: null, error: null, busy: false });
				fetch('/api/whale/circle/delete', {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					body: JSON.stringify({ id: c.id, dryRun: true }),
				}).then(function (r) { return r.json(); }).then(function (d) {
					if (d && d.ok === true && d.plan) {
						setDel(function (s) { return Object.assign({}, s, { phase: 'confirm', plan: d.plan, error: null }); });
					} else {
						setDel(function (s) { return Object.assign({}, s, { phase: 'error', error: (d && d.error) || '预演失败' }); });
					}
				})['catch'](function (err) {
					setDel(function (s) { return Object.assign({}, s, { phase: 'error', error: String((err && err.message) || err) }); });
				});
			}

			/** 弹窗里点了「确认删除」—— 只有走到这里才会带 confirm:true（服务端也要求它） */
			function doDelete() {
				var cur = del;
				if (!cur || !cur.plan || cur.busy) return;
				setDel(function (s) { return Object.assign({}, s, { busy: true, error: null }); });
				fetch('/api/whale/circle/delete', {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					body: JSON.stringify({ id: cur.circleId, confirm: true }),
				}).then(function (r) { return r.json(); }).then(function (d) {
					if (d && d.ok === true) {
						setDel(null);
						setNotice({
							text: '已删除圆圈「' + cur.circleName + '」：课程包内 ' + d.files + ' 个文件'
								+ (d.lessons ? '（含 ' + d.lessons + ' 门课）' : '')
								+ (d.progressCleaned ? '；进度里清掉 ' + d.progressCleaned + ' 条' : ''),
							rebuild: d.needsRebuild || [],
						});
						setTick(tick + 1);
					} else {
						setDel(function (s) { return Object.assign({}, s, { busy: false, error: (d && d.error) || '删除失败' }); });
					}
				})['catch'](function (err) {
					setDel(function (s) { return Object.assign({}, s, { busy: false, error: String((err && err.message) || err) }); });
				});
			}

			// ── 渲染 ──

			if (state.phase === 'loading') {
				return react.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' } }, '正在读课程目录…');
			}
			if (!state.data) {
				return react.createElement('div', {
					style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '18px' },
				}, state.error || '无法读取课程目录');
			}

			var d = state.data;
			var circles = d.circles || [];
			var canCreate = d.canCreate === true;
			var items = [];

			/**
			 * 渲染**一个**圆圈块。
			 *
			 * ⚠️ 它**必须是一个函数**，不能是 `for` 循环体 —— 块里那些 onClick / onChange 闭包
			 *    是在**点击时**才去读 circle id 的，而 ES5 的 `for (var ci…)` 里 `var c` 是
			 *    **函数作用域共享**的：所有圆圈的行都会读到循环结束时最后那个 `c`。
			 *    2026-09-22 真机实测的 bug 就是这个 —— 点「数学」的展开，展开的却是「编程」
			 *    （`readdirSync().sort()` 之后 `programming` 排在最后，恰好是循环的最后一个）。
			 *    提取成函数 → 每次调用一份独立绑定，这类"闭包串台"结构上不再可能。
			 */
			function renderCircleBlock(c) {
				var ptCount = (c.points || []).length;
				var lCount = 0;
				for (var pi = 0; pi < ptCount; pi++) {
					lCount += ((c.points[pi] || {}).lessons || []).length;
				}
				var isExpanded = !!expanded[c.id];
				var rn = rename[c.id];
				var isEditing = rn && rn.editing;

				// 标题行 —— 照原生 .groupTitleRow：chevron + 名字 + 计数 + 行内动作（不再「框里套框」）
				var headRow = null;
				if (isEditing) {
					headRow = react.createElement('div', { className: 'ws-groupTitleRow' },
						react.createElement('input', {
							key: 'edit-input',
							type: 'text',
							value: rn.value,
							disabled: rn.saving,
							onChange: function (e) {
								var v = e.target.value;
								setRename(function (r) {
									var next = Object.assign({}, r);
									if (next[c.id] && next[c.id].editing) {
										next[c.id] = Object.assign({}, next[c.id], { value: v });
									}
									return next;
								});
							},
							className: 'ws-input',
						}),
						react.createElement('button', {
							key: 'edit-ok',
							type: 'button',
							disabled: rn.saving,
							onClick: function () { doRename(c.id); },
							style: rn.saving
								? btnOff(btn('primary', 'sm'))
								: Object.assign(btn('primary', 'sm'), { flex: 'none' }),
						}, rn.saving ? '…' : '确定'),
						react.createElement('button', {
							key: 'edit-cancel',
							type: 'button',
							disabled: rn.saving,
							onClick: function () { setRename({}); },
							style: Object.assign(btn('ghost', 'sm'), { flex: 'none' }),
						}, '取消'));
				} else {
					headRow = react.createElement('div', { className: 'ws-groupTitleRow' },
						react.createElement('button', {
							key: 'circle-' + c.id,
							type: 'button',
							className: 'ws-groupToggle',
							'aria-expanded': isExpanded ? 'true' : 'false',
							onClick: function () { toggleCircle(c.id); },
						},
							react.createElement(Chevron, { key: 'chev' }),
							react.createElement('span', { className: 'ws-groupTitle' }, c.name),
							react.createElement('span', { className: 'ws-spacer' }),
							react.createElement('span', { className: 'ws-treeMeta' },
								ptCount + ' 个知识点 · ' + lCount + ' 门课')),
						// 「改显示名 / 删除」从「独立一行」挪到行内右侧（照原生 .rowActions；**始终可见**，不靠 hover）
						react.createElement('div', { className: 'ws-rowActions' },
							react.createElement('button', {
								type: 'button',
								onClick: function (e) { e.stopPropagation(); startRename(c.id, c.name); },
								style: btn('ghost', 'sm'),
							}, '改显示名'),
							react.createElement('button', {
								type: 'button',
								onClick: function (e) { e.stopPropagation(); openDelete(c); },
								style: btn('danger', 'sm'),
							}, '删除')));
				}

				// 组体：知识点 / 课程。收起时给 .ws-hidden（不依赖 [hidden] 的默认样式）
				var bodyKids = [];
				if (isExpanded && !isEditing) {
					var indentKids = [];
					for (var pj = 0; pj < ptCount; pj++) {
						var pt = c.points[pj];
						var pLessons = (pt.lessons || []).length;
						var displayNext = pt.nextNumber - (pt.fileBase || 0);
						indentKids.push(react.createElement('div', {
							key: 'point-' + pt.id,
							className: 'ws-treeRow',
						},
							react.createElement('span', { className: 'ws-treeName' }, pt.name),
							react.createElement('span', { className: 'ws-spacer' }),
							react.createElement('span', { className: 'ws-treeMeta' },
								'已 ' + pLessons + ' 课 · 下一课 第 ' + displayNext + ' 课'
							),
						));

						// 展开：渲染课程
						var lessons = pt.lessons || [];
						var lessonKids = [];
						for (var li = 0; li < lessons.length; li++) {
							var lesson = lessons[li];
							lessonKids.push(react.createElement('div', {
								key: 'lesson-' + lesson.id,
								className: 'ws-treeRow',
							}, react.createElement('span', { className: 'ws-treeName' }, lesson.number + '. ' + lesson.title)));
						}
						if (lessonKids.length) {
							indentKids.push(react.createElement('div', { key: 'lessons-' + pt.id, className: 'ws-indent' }, lessonKids));
						}
					}
					bodyKids.push(react.createElement('div', { key: 'indent', className: 'ws-indent' }, indentKids));
				}

				// 改名错误信息
				if (isEditing && rn && rn.error) {
					bodyKids.push(react.createElement('div', {
						key: 'rename-err',
						className: 'ws-rowDesc',
						style: { color: 'var(--dsw-alias-state-error-primary)' },
					}, rn.error));
				}

				// 包成一个「组」—— .ws-group + .ws-group 会自动加组间分隔线
				return react.createElement('div', { key: 'circle-block-' + c.id, className: 'ws-group' },
					headRow,
					react.createElement('div', {
						key: 'body',
						className: 'ws-groupBody' + (isEditing || isExpanded ? '' : ' ws-hidden'),
					}, bodyKids));
			}

			for (var ci = 0; ci < circles.length; ci++) {
				items.push(renderCircleBlock(circles[ci]));
			}

			// canCreate 时底部显示「新建圆圈」
			var newCircleForm = null;
			if (canCreate) {
				if (newCircle.open) {
					newCircleForm = react.createElement('div', {
						key: 'new-circle-form',
						style: {
							border: '1px dashed var(--dsw-alias-border-l2)', borderRadius: '8px',
							padding: '10px 12px', display: 'grid', gap: '8px',
						},
					},
						react.createElement('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, '新建知识圆圈'),
						react.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '8px' } },
							react.createElement('input', {
								type: 'text',
								placeholder: '显示名（如「数学」）',
								value: newCircle.name,
								disabled: newCircle.saving,
								onChange: function (e) { setNewCircle(function (s) { return Object.assign({}, s, { name: e.target.value }); }); },
								style: {
									fontSize: '14px', fontFamily: 'inherit', padding: '6px 10px',
									minWidth: 0, width: '100%', boxSizing: 'border-box',
									color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)',
									border: '.5px solid var(--dsw-alias-border-l2)', borderRadius: '8px', outline: 'none',
								},
							}),
							react.createElement('input', {
								type: 'text',
								placeholder: '目录 id（如 math）',
								value: newCircle.id,
								disabled: newCircle.saving,
								onChange: function (e) { setNewCircle(function (s) { return Object.assign({}, s, { id: e.target.value }); }); },
								style: {
									fontSize: '14px', fontFamily: 'inherit', padding: '6px 10px',
									minWidth: 0, width: '100%', boxSizing: 'border-box',
									color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)',
									border: '.5px solid var(--dsw-alias-border-l2)', borderRadius: '8px', outline: 'none',
								},
							}),
						),
						react.createElement('div', { style: { display: 'flex', gap: '6px', justifyContent: 'flex-end' } },
							react.createElement('button', {
								type: 'button',
								onClick: function () { setNewCircle({ open: false, name: '', id: '', saving: false, error: null }); },
								style: btn('ghost', 'sm'),
							}, '取消'),
							react.createElement('button', {
								type: 'button',
								disabled: newCircle.saving || !newCircle.name.trim() || !newCircle.id.trim(),
								onClick: doCreateCircle,
								style: newCircle.saving || !newCircle.name.trim() || !newCircle.id.trim()
									? btnOff(btn('primary', 'sm'))
									: btn('primary', 'sm'),
							}, newCircle.saving ? '创建中…' : '创建'),
						),
						newCircle.error ? react.createElement('div', {
							style: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
						}, newCircle.error) : null,
					);
				} else {
					// 建入口用**主按钮**（原来那个虚线小框太不显眼 —— 与原生设置页的「添加」按钮同规格）
					newCircleForm = react.createElement('div', {
						key: 'new-circle-btn',
						style: { display: 'flex', justifyContent: 'flex-start', paddingTop: '2px' },
					},
						react.createElement('button', {
							type: 'button',
							style: btn('primary', 'sm'),
							onClick: function () { setNewCircle(function (s) { return Object.assign({}, s, { open: true }); }); },
						}, '+ 新建圆圈'));
				}
			}

			/**
			 * 删除确认弹窗。固定浮层 —— 宿主设置页里没有可复用的弹窗原语，
			 * 而这一条是**不可恢复**的操作，必须挡住整页（不能做成行内小提示）。
			 */
			function renderDeleteModal() {
				var plan = del.plan;
				var lineStyle = { fontSize: '12px', lineHeight: 1.8, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' };
				var body = [];
				body.push(react.createElement('div', {
					key: 'title',
					style: { fontSize: '14px', fontWeight: '600', color: 'var(--dsw-alias-label-primary)', marginBottom: '6px' },
				}, '删除知识圆圈「' + del.circleName + '」'));

				if (del.phase === 'loading') {
					body.push(react.createElement('div', { key: 'loading', style: lineStyle }, '正在读出会被删掉的内容…'));
				} else if (!plan) {
					body.push(react.createElement('div', { key: 'err', style: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' } }, del.error || '预演失败'));
				} else {
					body.push(react.createElement('div', { key: 'dirs', style: lineStyle },
						'课程包内目录：' + plan.dirs.map(function (x) { return x.path + '（' + x.files + ' 个文件）'; }).join('、')));
					body.push(react.createElement('div', { key: 'ls', style: lineStyle },
						'课程：' + plan.lessons + ' 门' + (plan.lessonIds.length ? '　' + plan.lessonIds.join('、') : '')));
					if (plan.progressIds.length) {
						body.push(react.createElement('div', { key: 'pg', style: lineStyle },
							'进度文件 ' + plan.progressFile + ' 里会清掉 ' + plan.progressIds.length + ' 条：' + plan.progressIds.join('、')));
					}
					if (plan.codeDirs.length) {
						body.push(react.createElement('div', { key: 'code', style: lineStyle },
							'学生代码不动（不在本操作内，请自行处理）：' + plan.codeDirs.join('、')));
					}
					if (plan.lessons > 0) {
						body.push(react.createElement('div', { key: 'exp', style: lineStyle },
							'注意：code/ 下的 EXPECT.json 若还声明着这些课，重建后闸门会报"课次冲突"，需手工删那几条。'));
					}
					body.push(react.createElement('div', {
						key: 'warn',
						style: { fontSize: '12px', lineHeight: 1.7, marginTop: '6px', color: 'var(--dsw-alias-state-error-primary)' },
					}, '删除后不可恢复。删完要在课程包里跑一遍重建（' + plan.rebuild.length + ' 条命令），否则闸门会因为产物陈旧报红。'));
				}

				if (del.error && plan) {
					body.push(react.createElement('div', { key: 'err2', style: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)', marginTop: '6px' } }, del.error));
				}

				body.push(react.createElement('div', {
					key: 'btns',
					style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '14px' },
				},
					react.createElement('button', {
						type: 'button',
						onClick: function () { setDel(null); },
						style: btn('ghost', 'md'),
					}, '取消'),
					react.createElement('button', {
						type: 'button',
						disabled: !plan || del.busy,
						onClick: doDelete,
						style: !plan || del.busy
							? btnOff(btn('danger', 'md'))
							: Object.assign(btn('danger', 'md'), {
								background: 'var(--dsw-alias-state-error-primary)',
								color: 'var(--dsw-alias-label-primary-foreground)',
							}),
					}, del.busy ? '删除中…' : '确认删除')
				));

				return react.createElement('div', {
					key: 'delete-modal',
					style: {
						position: 'fixed', inset: '0', zIndex: 4000,
						background: 'rgba(0,0,0,0.45)', display: 'flex',
						alignItems: 'center', justifyContent: 'center',
					},
				},
					react.createElement('div', {
						style: {
							width: 'min(520px, 92vw)', maxHeight: '80vh', overflow: 'auto',
							background: 'var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base))',
							border: '.5px solid var(--dsw-alias-border-l2)', borderRadius: '12px',
							padding: '16px 18px', boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
						},
					}, body)
				);
			}

			/** 删除后的结果横幅：说清删了什么 + 那 4 条重建命令（照抄服务端返回，不在这里另造） */
			var noticeEl = null;
			if (notice) {
				var kids = [react.createElement('div', {
					key: 't',
					style: { fontSize: '12px', color: 'var(--dsw-alias-label-primary)', marginBottom: notice.rebuild.length ? '4px' : '0' },
				}, notice.text)];
				for (var ni = 0; ni < notice.rebuild.length; ni++) {
					kids.push(react.createElement('div', {
						key: 'r' + ni,
						style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', fontFamily: 'ui-monospace, monospace', lineHeight: '18px' },
					}, notice.rebuild[ni]));
				}
				noticeEl = react.createElement('div', {
					key: 'notice',
					style: {
						border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px',
						padding: '8px 12px', display: 'grid', gap: '0px',
					},
				}, kids);
			}

			var totalPoints = 0;
			var totalLessons = 0;
			for (var ti = 0; ti < circles.length; ti++) {
				totalPoints += (circles[ti].points || []).length;
				for (var tj = 0; tj < (circles[ti].points || []).length; tj++) {
					totalLessons += ((circles[ti].points[tj] || {}).lessons || []).length;
				}
			}

			return react.createElement('div', { key: 'catalog', className: 'ws-cardWrap' },
				react.createElement(Card, {
					title: '课程目录',
					trailing: circles.length + ' 圆圈 · ' + totalPoints + ' 知识点 · ' + totalLessons + ' 门课',
					open: false,
					body: [
						items.length ? items : react.createElement('div', { key: 'empty', className: 'ws-rowDesc' }, '课程包里还没有知识圆圈。'),
						newCircleForm,
						noticeEl,
						react.createElement('div', { key: 'actions', className: 'ws-actionsRow' },
							react.createElement('button', {
								type: 'button',
								onClick: function () { setTick(tick + 1); },
								style: btn('ghost', 'sm'),
							}, '刷新')),
					],
				}),
				// 删除弹窗挂在**卡外面**：它是整帧浮层（.ws-card 有 overflow:hidden，别把浮层塞进去）
				del ? renderDeleteModal() : null,
			);
		}

		//#region mod:teaching_card —— 设置页里的「教学方式」
		//
		// 主人 2026-09-25 定的形态：**每个圆圈的参数都能在设置里对 agent 说** ——
		// 学生说出自己的要求 → agent 按那个圆圈的可调项改参数 → **改完给他看**。
		//
		// 这一块**不改参数**：点「发给老师」只是把宿主拼好的一段正文（`POST /api/whale/teaching/request`）
		// 塞进当前会话，真正的改动由鲸师走 `whale_teaching op=propose/write`（先预览、他点头才落盘）。
		// 为什么不让设置页直接写：落盘口只能有一个（`recordTeaching()`）——
		// 否则参数会有两套校验、两条版本线。`_board/01-鲸师.md:312` 的「读 / 提议 / 确认写」就是为这个立的。
		//
		// 显示的是两样：**现行取值**（含"这一项是谁定的"）与**注入原文**
		// （`injectionBlock` 那一份，与老师真收到的**逐字节同源**，不是另写一段"差不多"的）。
		//#endregion

		/** 不可变地改一个键（客户端半边照保守写法来，不用计算属性名） */
		function setAt(obj, key, val) {
			var o = Object.assign({}, obj);
			o[key] = val;
			return o;
		}

		/** 现行参数的一行：名字 + 那句指令 + 这一项是谁定的（与 Row 同一套行配方，不再另立一套） */
		function TeachingRow(props) {
			var r = props.row;
			var fromText = r.from === 'own' ? '这一层定的' : (r.from === 'global' ? '继承全局层' : '还没定过');
			return react.createElement('div', { className: 'ws-row' },
				react.createElement('div', { className: 'ws-rowText' },
					react.createElement('div', { className: 'ws-rowTitle' }, r.label),
					react.createElement('div', { className: 'ws-rowDesc' },
						(r.directives || []).join(' ') || '（这一项没有生效指令 —— 台账里没写、档位默认也没有）')),
				react.createElement('span', {
					className: 'ws-treeMeta',
					style: r.from === 'own' ? { color: 'var(--dsw-alias-state-success-primary)' } : undefined,
				}, fromText));
		}

		/**
		 * 「教学方式」这一块。
		 *
		 * ⚠️ 组件在**工厂作用域**定义一次（同 StatusPanel / CatalogPanel 的规矩）——
		 *    在渲染回调里现造会让 React 每帧重挂整棵子树。
		 */
		function TeachingPanel() {
			var st = react.useState({ phase: 'loading', data: null, error: null });
			var state = st[0];
			var setState = st[1];
			// 「跟老师说」的草稿 / 发送态：按层键（全局层是 '*'，圆圈就是圆圈 id）
			var dr = react.useState({});
			var drafts = dr[0];
			var setDrafts = dr[1];
			var sd = react.useState({});
			var sends = sd[0];
			var setSends = sd[1];
			// 折叠：默认全展开（学生要"看得见"），点标题才收起
			var op = react.useState({});
			var collapsed = op[0];
			var setCollapsed = op[1];

			function load() {
				setState({ phase: 'loading', data: null, error: null });
				fetch('/api/whale/teaching', { headers: { accept: 'application/json' } })
					.then(function (r) { return r.text(); })
					.then(function (t) {
						if (!t) throw new Error('HTTP 空响应体');
						try { return JSON.parse(t); } catch (e) { throw new Error('不是 JSON：' + t.slice(0, 60)); }
					})
					.then(function (d) {
						if (d.ok === true && d.configured !== false) {
							setState({ phase: 'ok', data: d, error: null });
						} else {
							setState({ phase: 'ok', data: null, error: d.error || '未配置 packRoot' });
						}
					})
					['catch'](function (err) {
						setState({ phase: 'err', data: null, error: String((err && err.message) || err) });
					});
			}

			react.useEffect(function () { load(); }, []);

			/** 把这一层的一句话交给老师：宿主拼正文 → 塞进当前会话（拼装规则只有宿主一份） */
			function tellTeacher(key) {
				var text = String(drafts[key] || '').trim();
				if (!text) {
					setSends(function (s) { return setAt(s, key, { note: '先写一句你想让老师怎么教', state: 'error' }); });
					return;
				}
				setSends(function (s) { return setAt(s, key, { busy: true, note: null }); });
				fetch('/api/whale/teaching/request', {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					body: JSON.stringify({ circle: key, request: text }),
				}).then(readJson).then(function (d) {
					if (!d || d.ok !== true || !d.text) {
						var why = (d && d.error) ? d.error : '宿主没拼出正文';
						setSends(function (s) { return setAt(s, key, { note: why, state: 'error' }); });
						return;
					}
					if (pushToComposer(d.text)) {
						setDrafts(function (s) { return setAt(s, key, ''); });
						setSends(function (s) { return setAt(s, key, { note: '已发给老师 —— 他会先把改动预览给你看，你点头才改。', state: 'ok' }); });
					} else if (copyPrompt(d.text)) {
						setSends(function (s) { return setAt(s, key, { note: '拿不到输入框，正文已复制到剪贴板：粘进去按回车即可', state: 'warn' }); });
					} else {
						setSends(function (s) { return setAt(s, key, { note: '拿不到输入框，也复制不了 —— 宿主版本可能变了', state: 'error' }); });
					}
				})['catch'](function (err) {
					setSends(function (s) { return setAt(s, key, { note: '发送失败：' + String((err && err.message) || err), state: 'error' }); });
				});
			}

			/** 一层（全局层 / 某个圆圈）的整块 —— 普通渲染函数，不当组件用（避免每帧新类型） */
			function renderLayer(layer, isGlobal) {
				var key = layer.circle;
				// **各层默认收起**（用户 2026-09-26 拍板）：`collapsed[key]` 是 `undefined` 时算收起，
				// 只有显式记成 `false` 才是展开。原来写的是 `=== true`，那等于"默认展开"。
				// 判据钉在 test/settings-teaching.mjs（渲染级：每个层体都带 ws-hidden）。
				var isCollapsed = collapsed[key] !== false;
				var rows = (layer.items || []).filter(function (r) { return (r.directives || []).length > 0; });
				var mine = (layer.tunables || []).filter(function (t) { return t.home === 'circle'; });
				var theirs = (layer.tunables || []).filter(function (t) { return t.home === 'global'; });
				var send = sends[key] || {};
				var summary = isGlobal
					? '学科中立 · 对所有圆圈生效'
					: (layer.orphan
						? '课程包里已经没有这个圆圈了（台账里还留着记录）'
						: (!layer.hasSpec
							? '还没定过教学方式'
							: ((layer.own || []).length ? ((layer.own || []).length + ' 项是它自己定的') : '沿用全局层')));

				// 层头 —— 照原生 .groupTitleRow：chevron + 层名 + 右侧摘要
				var headRow = react.createElement('div', { className: 'ws-groupTitleRow' },
					react.createElement('button', {
						key: 'toggle',
						type: 'button',
						className: 'ws-groupToggle',
						'aria-expanded': isCollapsed ? 'false' : 'true',
						onClick: function () { setCollapsed(function (s) { return setAt(s, key, !isCollapsed); }); },
					},
						react.createElement(Chevron, { key: 'chev' }),
						react.createElement('span', { className: 'ws-groupTitle' }, layer.name),
						react.createElement('span', { className: 'ws-spacer' }),
						react.createElement('span', {
							className: 'ws-treeMeta',
							style: layer.orphan ? { color: 'var(--dsw-alias-state-warn-primary)' } : undefined,
						}, summary)));

				var kids = [];

				// 现行参数（一行一条，与设置页其它行同一套配方）。
				// ⚠️ **不要再套一层 .ws-groupBody** —— 这一层的根（下面的 layer- 那个 div）已经是层体了，
				// 套两层会让"层体"数翻倍（2026-09-26 判据当场抓到）。
				if (rows.length) {
					rows.forEach(function (r) { kids.push(react.createElement(TeachingRow, { key: r.id, row: r })); });
				} else {
					kids.push(react.createElement('div', { key: 'empty', className: 'ws-rowDesc' }, '这一层还没有任何生效参数。'));
				}

				// 可调项：学生得知道**能提什么要求**（可调项由 spec 声明，这里只转述，不自己编）
				kids.push(react.createElement('div', { key: 'tun', className: 'ws-groupSub' },
					isGlobal
						? ('可调：' + theirs.map(function (t) { return t.label; }).join(' / '))
						: (layer.hasSpec
							? ('这个圆圈自己还能调：' + (mine.length ? mine.map(function (t) { return t.label; }).join(' / ') : '（还没声明）')
								+ '　｜　全局层：' + theirs.map(function (t) { return t.label; }).join(' / '))
							: '这个圆圈还没声明可调项 —— 直接跟老师说就行，他会先给它定一套再改取值。')));

				// 固定做法（kind=guide）：**学生改不了**，但它是这个圆圈教法的另一半 ——
				// 不显示的话学生会以为"这个圆圈什么都没定"（P2 加的）。
				// 内容长（第一条就四行），所以套一层 <details> 默认收起，标题里写清条数与"不在可调集里"。
				if (!isGlobal) {
					var guide = layer.guide || [];
					var guideBody = guide.length
						? guide.map(function (g) {
							return react.createElement('div', { key: g.title },
								react.createElement('div', { className: 'ws-rowTitle' }, g.title),
								react.createElement('div', { className: 'ws-rowDesc' }, g.lines.join(' ')));
						})
						: react.createElement('div', { className: 'ws-rowDesc' }, '（还没有 —— 跟老师说一句，他会先给你看预览）');
					kids.push(react.createElement('details', { key: 'guide', className: 'ws-sub' },
						react.createElement('summary', { className: 'ws-subHead' },
							react.createElement(Chevron, { key: 'chev' }),
							'这个圆圈的固定做法（' + guide.length + ' 条，不在可调集里，改它等于换这个圆圈的教法）'),
						react.createElement('div', { className: 'ws-subBody' }, guideBody)));
				}

				// 注入原文 —— **老师真收到的就是这一段**（与 injectionBlock 逐字节同源）
				kids.push(react.createElement('div', { key: 'inj' },
					react.createElement('div', { className: 'ws-rowDesc' }, '老师下次生成课程时，实际会收到这一段：'),
					react.createElement('pre', { className: 'ws-code' }, layer.block || '（空）')));

				// 自由补充：如实说它去哪 —— 它进**备课上下文**（whale_brief），不在这段注入里
				if ((layer.freeText || []).length) {
					kids.push(react.createElement('div', { key: 'free', className: 'ws-rowDesc' },
						'自由补充（出现在老师的备课上下文里，不在上面那段注入里）：'
						+ layer.freeText.map(function (f) { return f.text; }).join('；')));
				}

				// 「跟老师说」—— **每一层各自一个**（照原方案的摆法），放在这一层的最末尾
				kids.push(react.createElement('div', { key: 'ask', className: 'ws-ask' },
					react.createElement('div', { className: 'ws-askTitle' },
						'跟老师说',
						react.createElement('span', { className: 'ws-askSub' },
							' · 改的是这一层（' + (isGlobal ? '全局层' : layer.name) + '）· 最多 300 字')),
					react.createElement('div', { className: 'ws-askRow' },
						react.createElement('textarea', {
							rows: 2,
							value: drafts[key] || '',
							maxLength: 300,
							disabled: send.busy === true,
							placeholder: isGlobal
								? '例：讲慢一点 / 多用图 / 术语少用英文'
								: '例：讲慢一点 / 多用图 / 先给最小复现再讲原理',
							onChange: function (e) {
								var v = e.target.value;
								setDrafts(function (s) { return setAt(s, key, v); });
							},
							className: 'ws-textarea',
						}),
						react.createElement('button', {
							onClick: function () { tellTeacher(key); },
							disabled: send.busy === true,
							style: send.busy === true ? btnOff(btn('outline', 'sm')) : btn('outline', 'sm'),
						}, send.busy === true ? '发送中…' : '发给老师')),
					react.createElement('div', { className: 'ws-rowDesc' },
						'写进 learning-records/teaching.jsonl 的「' + (isGlobal ? '全局层（*）' : layer.name) + '」小节 —— 老师先给预览，你点头才写')));

				if (send.note) {
					kids.push(react.createElement('div', {
						key: 'note',
						className: 'ws-rowDesc',
						style: {
							color: send.state === 'ok' ? STATE_COLOR.ok : (send.state === 'error' ? STATE_COLOR.error : STATE_COLOR.warn),
						},
					}, send.note));
				}

				return react.createElement('div', { key: 'layer-' + key, className: 'ws-group' },
					headRow,
					react.createElement('div', {
						key: 'body',
						className: 'ws-groupBody' + (isCollapsed ? ' ws-hidden' : ''),
					}, kids));
			}

			var body = null;
			if (state.phase === 'loading') {
				body = [react.createElement('div', { key: 'loading', className: 'ws-rowDesc' }, '正在读教学台账…')];
			} else if (state.error) {
				body = [react.createElement('div', {
					key: 'err', className: 'ws-rowDesc',
					style: { color: 'var(--dsw-alias-state-error-primary)' },
				}, state.error)];
			} else if (state.data) {
				var d = state.data;
				body = [
					react.createElement('p', { key: 'intro', className: 'ws-cardIntro' },
						'每一层都能单独跟老师说 —— 老师先给预览，你点头才写进 learning-records/teaching.jsonl 的那一层小节。'),
					renderLayer(d.global, true),
					(d.circles || []).map(function (c) { return renderLayer(c, false); }),
					react.createElement('div', { key: 'locked', className: 'ws-locked' },
						'🔒 教学纪律（不在可调项里，你说改也不改）：' + (d.locked || []).map(function (l) { return l.label; }).join(' / ')),
				];
				if ((d.problems || []).length) {
					body.push(react.createElement('div', {
						key: 'problems', className: 'ws-rowDesc', style: { color: STATE_COLOR.warn },
					}, '台账里有 ' + d.problems.length + ' 条读不干净的记录（没丢，但没生效）：' + d.problems.slice(0, 2).join('；')));
				}
				body.push(react.createElement('div', { key: 'actions', className: 'ws-actionsRow' },
					react.createElement('button', { onClick: load, style: btn('ghost', 'sm') }, '刷新'),
					// 最小修法（用户 2026-09-26 点名）：**不改行为**，只把「要手点一下」说清楚。
					// 为什么需要它：这个面板只在挂载时 fetch 一次，老师落盘之后页面上还是旧值。
					react.createElement('span', { key: 'refresh-hint', className: 'ws-rowDesc' },
						'老师落盘之后点这里看新值 —— 这个面板只在打开时读一次。')));
			}

			return react.createElement('div', { key: 'teaching', className: 'ws-cardWrap' },
				react.createElement(Card, {
					title: '教学方式',
					trailing: state.data ? ('全局层 + ' + ((state.data.circles || []).length) + ' 个圆圈') : '',
					open: false,
					body: body,
				}));
		}

		/** 把这一节挂到设置页。整段包 try/catch —— 浏览器半边**绝不许**把宿主界面搞崩。 */
		function applyStatusCard(ctx) {
			try {
				if (!ctx.slots || typeof ctx.slots.register !== 'function') return;
				ctx.slots.inject('settings.section', function () {
					return ctx.slots.register(
						{ name: 'settings.section', id: 'whale-sensei', order: 30, label: '鲸师' },
						StatusPanel,
					);
				});
			} catch (err) {
				console.warn('[dsh-whale-sensei] 设置节挂载失败：', err);
			}
			// 样式表**单独**包一层 try/catch，且放在坐位注册**之后** ——
			// 测试的假 DOM 没有 head，抛了也绝不能影响注册（panel.mjs 会检查注册结果）。
			try {
				ensurePanelStyle();
			} catch (err) {
				console.warn('[dsh-whale-sensei] 设置页样式注入失败：', err);
			}
		}

		//#region mod:entry_button —— 侧栏「新课程」（原生「新建会话」下面那一行）
		//
		// **为什么不是 slot**：DSH 侧栏对外**没有**可注册的缝 ——
		//   · `sidebar.panellist` 是"面板切换器"（点它会 selectPanel(id)，我的行会变成假面板）；
		//   · `sidebar.workspaces` / `sidebar` 是 single 且已被官方占用；
		//   · 其余 sidebar.* 都是 brand / settings / footer 那一圈，不在"新建会话"下面。
		// 所以照本机已装的「技能中心」（`@linxin666/dsh-client-ui-skill-explorer`）同一个做法：
		// **往侧栏 DOM 里插一行纯 DOM 按钮**，位置在原生「新建会话」那一行之后，并挂
		// MutationObserver 自愈（React 重渲染把它冲掉时立刻插回，同帧完成、不闪）。
		// 纯 DOM（不是 React 树）是刻意的：它永远不会干扰宿主的 reconciliation。
		//
		// 样式**逐字对齐原生 `button.newSession`**：38px 高 / 圆角 12 / `.5px` 边框 /
		// `--dsw-alias-button-elevated-fill` 底 / 14px-500 / 图标+文字，hover 用
		// `--dsw-alias-button-floating-hover`；侧栏收起时变成 36×36 的图标按钮（与原生 rail 变体一致）。
		//
		// **点了之后**：开一张**原生弹窗**（`primitives.Modal`，注册在 `shell.overlay`），
		// 问「学什么 + 做课必要信息」（**不问摸底** —— 摸底是发出去之后 agent 按协议第③步单独问的那一轮），
		// 弹窗的「发送」键才是启动键：把拼好的「开课请求」正文塞进输入框并**回车发出去**。
		//
		// **话术不在这个文件里**：字段表、模板、四步协议都由宿主侧 `lib/starter.js` 算好，
		// 走 `/api/whale/starter`（GET 发载荷 / POST 拼正文）。客户端只收集 `values`。
		//
		// **正文怎么进对话**：侧栏那行与弹窗都拿不到 slot 的 props，而往输入框写字的唯一官方通道是
		// composer 侧坐位注入的 `inputActions`（`setDraft` + `submit`）。所以这里保留一个
		// **不渲染任何东西**的坐位 `conversation.input.left`（`ComposerBridge`），只负责把它接出来。
		// 拿不到就退化成复制到剪贴板 —— **绝不静默失败**。
		//#endregion

		var ENTRY_SLOT = 'conversation.input.left';
		var ENTRY_ATTR = 'data-dsh-whale-entry';
		var ENTRY_STYLE_ID = 'dsh-whale-entry-style';
		var ENTRY_LABEL = '新课程';
		var ENTRY_TITLE = '新课程：填一张表，我把「开课请求」发给你（先查资料 → 问掌握程度 → 再写课）';

		/**
		 * 行内图标：一本摊开的书（16×16 线性，`currentColor`）。
		 * 与官方图标同一套画法（viewBox 16 / stroke 1.3 / round 端点），但在 18px 下渲染。
		 */
		var ENTRY_ICON = '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" '
			+ 'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
			+ '<path d="M8 3.2C6.6 2 4.5 2 3 2v10.5c1.5 0 3.6 0 5 1.3 1.4-1.3 3.5-1.3 5-1.3V2c-1.5 0-3.6 0-5 1.2z"/>'
			+ '<path d="M8 3.2v10.6"/></svg>';

		/** 侧栏那一行的样式：几何逐字抄原生 `.newSession`，颜色一律走宿主语义令牌（不自己造色） */
		var ENTRY_CSS = [
			// ⚠️ **不写 `width:100%`**：原生按钮靠 flex 的 `align-self:stretch` 撑满（再减左右各 2px 外边距），
			//    写 `width:100%` 会让总宽 = 容器内宽 + 4px 外边距 ⇒ 比「新会话」宽 4px（2026-09-21 现场量到）。
			'[' + ENTRY_ATTR + ']{box-sizing:border-box;flex:none;align-self:stretch;display:flex;align-items:center;',
			'justify-content:center;gap:6px;height:38px;margin:0 2px 8px;padding:8px 16px;',
			'border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;',
			'background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);',
			'font-family:inherit;font-size:14px;font-weight:500;line-height:22px;cursor:pointer;overflow:hidden}',
			'[' + ENTRY_ATTR + ']:hover{background:var(--dsw-alias-button-floating-hover)}',
			'[' + ENTRY_ATTR + ']:disabled{cursor:default}',
			'[' + ENTRY_ATTR + '] .dsh-whale-entry-label{white-space:nowrap;max-width:200px;overflow:hidden;text-overflow:ellipsis}',
			'[' + ENTRY_ATTR + '] .dsh-whale-entry-icon{flex:none;display:inline-flex;align-items:center;justify-content:center}',
			'[' + ENTRY_ATTR + '] .dsh-whale-entry-icon svg{display:block;width:14px;height:14px}',
			// 侧栏收起（rail）：与原生 newSession 的收起变体一致 —— 36×36、无边无底、只留图标（图标回到 18px）
			'[data-sidebar-collapsed] [' + ENTRY_ATTR + '],',
			'[data-dsh-frame][data-sidebar-collapsed] [' + ENTRY_ATTR + ']',
			'{width:36px;height:36px;gap:0;margin:0 0 12px;padding:0;border-color:transparent;',
			'background:transparent;align-self:flex-start}',
			'[data-sidebar-collapsed] [' + ENTRY_ATTR + '] .dsh-whale-entry-label,',
			'[data-dsh-frame][data-sidebar-collapsed] [' + ENTRY_ATTR + '] .dsh-whale-entry-label{display:none}',
			'[data-sidebar-collapsed] [' + ENTRY_ATTR + '] .dsh-whale-entry-icon svg,',
			'[data-dsh-frame][data-sidebar-collapsed] [' + ENTRY_ATTR + '] .dsh-whale-entry-icon svg{width:18px;height:18px}',
		].join('');

		//#region mod:pack_entry —— 侧栏第二行「课程中心」（插在「新课程」正下方）
		//
		// **位置**：主人 2026-09-25 定 —— 放「新课程」**下**。
		// **样式**：主人 2026-09-25 定 —— **参考「技能中心」**（`@linxin666/dsh-client-ui-skill-explorer`），
		//   **不要**做成「新课程」那种按钮样。下面的几何是从技能中心那一行的 CSS 逐条搬来的
		//   （它 `lib/client.js:315` 的 `.cBrkua_entry*`），只换类名与作用域：
		//     36px 高 / **无边框** / 圆角 8 / 透明底 / hover 才上 `--dsw-alias-interactive-bg-hover` /
		//     图标 24×24 容器 + 18×18 svg / 13px / `padding:0 10px` / `gap:8px`；
		//     收起态是**圆形**（`border-radius:50%`）36×36 居中 —— 与「新课程」的方形变体刻意不同。
		//   ⚠️ **宽度必须与技能中心一致**（2026-09-25 主人现场看截图指出"歪了"）：
		//     技能中心写 `width:100%`，这里用 `align-self:stretch`（**横向 margin 为 0 时两者等价**）
		//     + `margin:0 0 8px`。第一版抄的是「新课程」那行的 `margin:0 2px 8px`
		//     ⇒ 比技能中心**窄 4px、左边缘偏右 2px** —— 视觉上就是"两行没对齐"。
		//     **横向一律不加 margin**；底边距保留（那是给下一行留的间距）。
		//
		// **点了之后**：`POST /api/whale/pack/open` → 宿主确保**课程包自己的**预览服务在跑
		//   （先探活、没起就**在宿主进程内**起，见 `lib/pack-server.js`）→ 回 `{ url }` → 打开星图。
		// ⚠️ `window.open` 必须**同步**调（先开一张空白页，拿到 url 再改它的 `location`）——
		//   等 fetch 回来再 open 会被浏览器的弹窗拦截器吃掉（点击手势已经过期）。
		//#endregion
		var PACK_ENTRY_ATTR = 'data-dsh-whale-pack-entry';
		var PACK_ENTRY_STYLE_ID = 'dsh-whale-pack-entry-style';
		var PACK_ENTRY_LABEL = '课程中心';
		var PACK_ENTRY_TITLE = '课程中心：打开星图（会自动起课程包自己的服务）';
		/** 行内图标：一颗星（16×16 线性 —— 与「新课程」那本摊开的书同一套画法：viewBox 16 / stroke 1.3 / round） */
		var PACK_ENTRY_ICON = '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" '
			+ 'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
			+ '<path d="M8 1.9l1.85 3.85 4.15.55-3.05 2.9.75 4.1L8 11.4l-3.7 1.9.75-4.1L2 6.3l4.15-.55z"/></svg>';
		/** 逐条对齐「技能中心」那一行（对照表见上面 #region） */
		var PACK_ENTRY_CSS = [
			'[' + PACK_ENTRY_ATTR + ']{box-sizing:border-box;align-self:stretch;display:flex;align-items:center;',
			'gap:8px;height:36px;margin:0 0 8px;padding:0 10px;border:none;border-radius:8px;background:0 0;',
			'color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;line-height:1;',
			'cursor:pointer;white-space:nowrap;overflow:hidden}',
			'[' + PACK_ENTRY_ATTR + ']:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'[' + PACK_ENTRY_ATTR + ']:disabled{cursor:default}',
			'[' + PACK_ENTRY_ATTR + '] .dsh-whale-pack-entry-label{text-overflow:ellipsis;overflow:hidden}',
			'[' + PACK_ENTRY_ATTR + '] .dsh-whale-pack-entry-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px}',
			'[' + PACK_ENTRY_ATTR + '] .dsh-whale-pack-entry-icon svg{display:block;width:18px;height:18px}',
			// 收起（rail）：圆形、居中、只留图标 —— 技能中心的收起态就是这么写的
			'[data-sidebar-collapsed] [' + PACK_ENTRY_ATTR + '],',
			'[data-dsh-frame][data-sidebar-collapsed] [' + PACK_ENTRY_ATTR + ']',
			'{border-radius:50%;justify-content:center;width:36px;height:36px;margin:0 auto 12px;padding:0}',
			'[data-sidebar-collapsed] [' + PACK_ENTRY_ATTR + '] .dsh-whale-pack-entry-label,',
			'[data-dsh-frame][data-sidebar-collapsed] [' + PACK_ENTRY_ATTR + '] .dsh-whale-pack-entry-label{display:none}',
		].join('');

		/** 读 HTTP 响应体：**先取文本再解析**，空体/非 JSON 的报错要说清是哪一种（route 坏掉时回的是空体） */
		function readJson(r) {
			return r.text().then(function (t) {
				if (!t) {
					var e1 = new Error('HTTP ' + r.status + ' 空响应体');
					e1.status = r.status;
					throw e1;
				}
				// 404 有专门的话术：宿主还没装载这条路由（宿主侧改动**必须重启宿主**才生效，
				// 刷新页面只能更新浏览器半边）。原文 "not found" 会让人以为是路径写错了。
				if (r.status === 404) {
					var e404 = new Error('HTTP 404 —— 宿主还没装载这条路由（宿主侧改动需要重启宿主，刷新页面只更新客户端半边）');
					e404.status = 404;
					throw e404;
				}
				try {
					return JSON.parse(t);
				} catch (err) {
					var e2 = new Error('HTTP ' + r.status + ' 不是 JSON：' + t.slice(0, 60));
					e2.status = r.status;
					throw e2;
				}
			});
		}

		/** 拉一次开课入口载荷（弹窗的字段与模板）；拿不到就抛，让弹窗说出为什么 */
		function readStarter() {
			return fetch('/api/whale/starter', { headers: { accept: 'application/json' } })
				.then(readJson)
				.then(function (d) {
					if (!d || !d.entry || !d.entry.form) {
						throw new Error('宿主没发 entry.form（lib/mods/starter.js 没挂上？）');
					}
					return d;
				});
		}

		/** 把学生填的 values 交给宿主拼成「开课请求」正文（拼装规则只有宿主一份） */
		function postStarter(values) {
			return fetch('/api/whale/starter', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ values: values }),
			}).then(readJson);
		}

		/** 退路：复制到剪贴板（拿不到 inputActions 时用），再不行就弹一个可全选的框 */
		function copyPrompt(text) {
			try {
				if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
					var p = navigator.clipboard.writeText(text);
					if (p && typeof p['catch'] === 'function') p['catch'](function () {});
					return true;
				}
			} catch (err) { /* 落到下面的 prompt 退路 */ }
			try {
				window.prompt('复制这段开课协议，粘进输入框：', text);
				return true;
			} catch (err) {
				return false;
			}
		}

		//#region composer 桥 —— 只把 inputActions 接出来，不渲染任何东西

		/** 当前挂载的 composer 输入面（`inputActions`）。侧栏那一行靠它把文本写进输入框。 */
		var composerActions = null;

		/**
		 * 一个**不渲染任何东西**的坐位，唯一职责是把宿主给 composer 侧坐位注入的
		 * `inputActions` 接出来（`setDraft` / `submit`）。
		 *
		 * 为什么需要它：侧栏那一行是纯 DOM 注入，React 的 slot props 传不到它手上。
		 * 组件在**工厂作用域**定义一次（不在渲染回调里现造），否则 React 每帧重挂载。
		 */
		function ComposerBridge(props) {
			if (props && props.inputActions) composerActions = props.inputActions;
			return null;
		}

		function applyComposerBridge(ctx) {
			try {
				if (!ctx.slots || typeof ctx.slots.register !== 'function') return;
				ctx.slots.inject(ENTRY_SLOT, function () {
					return ctx.slots.register(
						{ name: ENTRY_SLOT, id: 'whale-bridge', order: 90, label: ENTRY_LABEL },
						ComposerBridge,
					);
				});
			} catch (err) {
				console.warn('[dsh-whale-sensei] composer 桥挂载失败：', err);
			}
		}

		/**
		 * 把一段正文写进输入框并按回车 —— **composer 送出通道的唯一实现**。
		 *
		 * 两条路都走它：① `send()` 的「开课请求」；② 建点成功后宿主随回执带来的
		 * 「生成知识点地图」指令（`mapPrompt`）。客户端不拼话术，也不复制第二份送出逻辑。
		 *
		 * @param {string} text 正文（**原样送出**，不裁剪 —— 判据要求送出的文本逐字等于宿主给的）
		 * @returns {boolean} 送出去没有（false = 拿不到输入框，调用方走退路）
		 */
		function pushToComposer(text) {
			var ia = composerActions;
			if (ia && typeof ia.setDraft === 'function') {
				ia.setDraft(text);
				// `setDraft` 是 Lexical 的 discrete 同步更新，`submit` 读的就是更新后的投影；
				// 仍放到下一帧，避免和 React 这次提交挤在同一个 tick 里。
				window.setTimeout(function () {
					try {
						if (typeof ia.submit === 'function') ia.submit();
					} catch (err) {
						console.warn('[dsh-whale-sensei] 提交失败，正文已留在输入框，按回车即可', err);
					}
				}, 0);
				return true;
			}
			return false;
		}

		//#endregion

		//#region 侧栏那一行（纯 DOM + 自愈）

		/** 侧栏外壳根节点（就是那个 flex column）；宿主还没渲染出来时返回 null */
		function sidebarShell() {
			var column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
			if (!column) return null;
			var logo = column.querySelector('[class*="logoRow"]');
			return (logo && logo.parentElement) || column.firstElementChild || null;
		}

		/** 原生「新建会话」按钮：新版嵌在 logoRow 里，老版是直接子节点 */
		function newSessionButton(root) {
			var nested = root.querySelector('button[class*="newSession"]');
			if (nested) return nested;
			for (var i = 0; i < root.children.length; i++) {
				if (root.children[i].tagName === 'BUTTON') return root.children[i];
			}
			return null;
		}

		/** 样式只注入一次（按 id 判重）—— 两行各一份（几何不同，别合成一份） */
		function ensureEntryStyle() {
			var head = document.head || document.documentElement;
			if (!document.getElementById(ENTRY_STYLE_ID)) {
				var style = document.createElement('style');
				style.id = ENTRY_STYLE_ID;
				style.textContent = ENTRY_CSS;
				head.appendChild(style);
			}
			if (!document.getElementById(PACK_ENTRY_STYLE_ID)) {
				var style2 = document.createElement('style');
				style2.id = PACK_ENTRY_STYLE_ID;
				style2.textContent = PACK_ENTRY_CSS;
				head.appendChild(style2);
			}
		}

		/**
		 * 短暂反馈：换文案 + 上色，1.8 秒后自己变回来。
		 * `back` = 变回来时的 `{ label, title }` —— **两行的文案不同**，所以必须由调用方给（原来硬写 ENTRY_LABEL）。
		 */
		function flashRow(row, label, text, color, back) {
			var b = back || { label: ENTRY_LABEL, title: ENTRY_TITLE };
			label.textContent = text;
			row.title = text;
			try { row.style.color = color || ''; } catch (err) { /* 样式失败不该影响功能 */ }
			window.setTimeout(function () {
				label.textContent = b.label;
				row.title = b.title;
				try { row.style.color = ''; } catch (err) { /* 同上 */ }
				row.disabled = false;
			}, 1800);
		}

		//#region 开课弹窗（原生 Modal + 宿主算好的字段表）
		//
		// 弹窗状态就一条：**开/关**。侧栏那一行是纯 DOM，弹窗是 React 树 —— 两边靠这个极小的
		// 模块级发布订阅说话（不引入第二套状态机）。
		var dialogOpen = false;
		var dialogListeners = [];
		/** 弹窗组件真的挂上了没有：没挂上（宿主没有 shell.overlay）时侧栏那行退回"直接填草稿" */
		var dialogReady = false;

		function setDialogOpen(open) {
			dialogOpen = !!open;
			for (var i = 0; i < dialogListeners.length; i++) {
				try { dialogListeners[i](dialogOpen); } catch (err) { /* 一个订阅者坏了不该影响别的 */ }
			}
		}

		/** 弹窗组件订阅开/关；组件在工厂作用域定义一次（不在渲染回调里现造） */
		function useDialogOpen() {
			var st = react.useState(dialogOpen);
			var open = st[0];
			var set = st[1];
			react.useEffect(function () {
				var fn = function (v) { set(v); };
				dialogListeners.push(fn);
				set(dialogOpen);
				return function () {
					var i = dialogListeners.indexOf(fn);
					if (i >= 0) dialogListeners.splice(i, 1);
				};
			}, []);
			return open;
		}

		/** 宿主侧标了 `multiline` 的字段用 textarea，其余用 input */
		function FieldInput(props) {
			var field = props.field;
			var common = {
				id: 'whale-field-' + field.id,
				value: props.value,
				placeholder: field.hint || '',
				disabled: props.disabled,
				onChange: function (e) { props.onChange(field.id, e.target.value); },
				style: {
					width: '100%',
					boxSizing: 'border-box',
					fontFamily: 'inherit',
					fontSize: '13px',
					lineHeight: '20px',
					color: 'var(--dsw-alias-label-primary)',
					background: 'var(--dsw-alias-bg-base)',
					border: '1px solid var(--dsw-alias-border-l2)',
					borderRadius: '8px',
					padding: '7px 10px',
					outline: 'none',
				},
			};
			return field.multiline
				? react.createElement('textarea', Object.assign({}, common, { rows: 2, style: Object.assign({}, common.style, { resize: 'vertical' }) }))
				: react.createElement('input', Object.assign({}, common, { type: 'text' }));
		}

		/**
		 * 开课弹窗：**官方 Modal**（`primitives.Modal`）—— 遮罩、Esc、焦点陷阱都用宿主那一套，
		 * 不自己造模态框。流程契约来自 `GET /api/whale/starter`（宿主侧 `lib/starter.js`）。
		 *
		 * **两屏**向导（2026-09-24 F1c）：
		 *   ① 选知识圆圈
		 *   ② 选知识点 —— **点卡片 = 一键到位**：先问门禁（`GET /api/whale/gate`），
		 *      放行就直接把开课请求发出去；拦住就地展开「还不能新开下一课」提示条（不发）。
		 *
		 * 「发送」是启动键：POST 拼装 → `setDraft` → 下一帧 `submit()`（进程里就是回车那一下）。
		 * 原第 ③ 屏「填表单」连同服务端的 `FORM_FIELDS` 一起删了 —— 终点改由三段流程的②段收。
		 */
		function CourseDialog() {
			var open = useDialogOpen();
			var st = react.useState({
				phase: 'idle',
				entry: null,
				values: {},
				why: null,
				// 向导状态
				// ⚠️ **只有两屏**（2026-09-24 F1c）：0=选圆圈, 1=选知识点。
				//    第 3 屏「填表单」连同服务端的 FORM_FIELDS 一起删了 —— 点知识点卡片 = 一键到位。
				step: 0,
				// 门禁判词（**按点缓存**）：卡片三态与"能不能发"都读它，来源 `GET /api/whale/gate`
				gates: {},
				blocked: false,     // 当前这张卡被门禁拦住 → 就地展开提示条（不发指令）
				detecting: false,   // 「重新检测」进行中（过程态要有，否则等待会被读成卡死）
				catalog: null,
				selectedCircle: null,
				selectedPoint: null,
				catalogWhy: null,
				// 新建圆圈/知识点状态
				newCircle: { open: false, name: '', id: '', saving: false, error: null },
				newPoint: { open: false, name: '', id: '', saving: false, error: null },
				// 重建横幅（**本组件自己的**，不借别的组件的 notice）
				rebuild: null,
			});
			var state = st[0];
			var setState = st[1];

			// 挂载即登记"弹窗可用"（侧栏那行据此决定：开弹窗，还是退回直接填草稿）
			react.useEffect(function () {
				dialogReady = true;
				return function () { dialogReady = false; };
			}, []);

			// 每次打开都重新拉一次载荷（字段/模板可能改过；也顺手把 tracks 刷新）
			react.useEffect(function () {
				if (!open) return;
				var alive = true;
				setState(function (s) {
					return Object.assign({}, s, {
						phase: 'loading',
						entry: null,
						values: {},
						why: null,
						step: 0,
						catalog: null,
						selectedCircle: null,
						selectedPoint: null,
						catalogWhy: null,
						newCircle: { open: false, name: '', id: '', saving: false, error: null },
						newPoint: { open: false, name: '', id: '', saving: false, error: null },
						rebuild: null,
					});
				});
				// 同时拉 starter 和 catalog
				Promise.all([
					readStarter(),
					fetch('/api/whale/catalog', { headers: { accept: 'application/json' } })
						.then(readJson)
						['catch'](function (err) { return { ok: false, why: String((err && err.message) || err) }; }),
				]).then(function (results) {
					if (!alive) return;
					var starter = results[0];
					var cat = results[1];
					var catalogWhy = null;
					// catalog 可能失败或没配 packRoot
					if (!cat || cat.ok !== true) {
						catalogWhy = (cat && cat.error) || (cat && cat.why) || '无法读取课程包目录';
					} else if (cat.configured === false) {
						catalogWhy = cat.error || '未配置 packRoot';
					}
					// 没有 catalog 数据时**留在第 1 屏**并说明原因（表单屏已删，没有能"跳过去"的地方）
					var step = 0;
					setState(function (s) {
						return Object.assign({}, s, {
							phase: 'ready',
							entry: starter.entry,
							values: {},
							why: starter.configured === false ? starter.hint : null,
							step: step,
							catalog: cat && cat.ok === true ? cat : null,
							selectedCircle: null,
							selectedPoint: null,
							catalogWhy: catalogWhy,
						});
					});
				})['catch'](function (err) {
					if (alive) setState(function (s) {
						return Object.assign({}, s, {
							phase: 'err',
							entry: null,
							values: {},
							why: String((err && err.message) || err),
						});
					});
				});
				return function () { alive = false; };
			}, [open]);

			function setValue(id, v) {
				setState(function (s) {
					var values = Object.assign({}, s.values);
					values[id] = v;
					return Object.assign({}, s, { values: values, why: null });
				});
			}

			function selectCircle(circle) {
				setState(function (s) {
					return Object.assign({}, s, {
						selectedCircle: circle,
						selectedPoint: null,
						blocked: false,
						step: 1,
					});
				});
				loadGates(circle);
			}

			/**
			 * 点知识点卡片 = **一键到位**（v3 §1.1）。
			 *
			 * 原来这里只把 step 推到 2（填表单屏）、还要再点一次「发送」；表单屏已删（2026-09-24 F1c），
			 * 所以这里自己把流程跑完：**放行判定先于指令发送**（v3 §2.3）——
			 * 门禁放行就直接发；拦住就**不发**、就地展开提示条（v3 §3.2）。
			 */
			function selectPoint(point) {
				var g = state.gates[point.id];
				if (!g || g.allowed !== true) {
					// 拦住（含「未检测」，fail-closed）：不发指令，就地展开提示条
					setState(function (s) {
						return Object.assign({}, s, { selectedPoint: point, blocked: true, why: null });
					});
					return;
				}
				setState(function (s) {
					return Object.assign({}, s, { selectedPoint: point, blocked: false });
				});
				// ⚠️ 不能直接 send()：它读的是**本次渲染闭包里的 state**（那时还没有 selectedPoint）。
				//    放到下一帧并把选中项显式传进去，两边都不依赖时序。
				window.setTimeout(function () { send({ selectedPoint: point }); }, 0);
			}

			function goBack() {
				setState(function (s) {
					if (s.step === 1) {
						return Object.assign({}, s, { step: 0, selectedCircle: null, selectedPoint: null, blocked: false });
					}
					return s;
				});
			}

			/** 空列表出口：没有知识点时**直接开课**（归属留空）—— 表单屏已删，没有第 3 屏可跳了 */
			function skipToForm() {
				setState(function (s) {
					return Object.assign({}, s, { selectedCircle: null, selectedPoint: null, blocked: false });
				});
				window.setTimeout(function () { send({ selectedCircle: null, selectedPoint: null }); }, 0);
			}

			/**
			 * 拉门禁判词（**读侧**：GET 一律 probe:false，不会写快照）。
			 *
			 * 为什么要有这一步：卡片三态要「每个知识点上一课的挑战过没过」（v3 §1.2），
			 * 而放行判定必须**先于指令发送**（v3 §2.3）—— 所以进屏 2 就把这一圈的点都问一遍。
			 * 拉不到（没配 packRoot / 网络失败）⇒ 该点没有判词 ⇒ 卡片按「未检测」渲染（fail-closed，不猜放行）。
			 */
			function loadGates(circle) {
				var list = (circle && circle.points) || [];
				list.forEach(function (p) {
					askGate(p.id, false)["catch"](function () { /* 单个点失败不阻塞别的点 */ });
				});
			}

			/** 问一个点的判词；probe=true 时**重判一次**（POST，会写快照 —— 那是「重新检测」的动作） */
			function askGate(pointId, probe) {
				var url = "/api/whale/gate?point=" + encodeURIComponent(pointId);
				var init = { headers: { accept: "application/json" } };
				if (probe) {
					init = {
						method: "POST",
						headers: { "content-type": "application/json", accept: "application/json" },
						body: JSON.stringify({ point: pointId, probe: 1 }),
					};
				}
				return fetch(url, init).then(readJson).then(function (d) {
					setState(function (s) {
						var gates = Object.assign({}, s.gates);
						// 拉不到就**存 null**（= 未检测），不要留着旧判词骗人
						gates[pointId] = (d && d.ok && d.configured && d.verdict)
							? { verdict: d.verdict, prereq: d.prereq || null, allowed: d.allowed === true }
							: null;
						return Object.assign({}, s, { gates: gates, detecting: false });
					});
					return d;
				});
			}

			/**
			 * 卡片三态（v3 §1.2）。判词来自 /api/whale/gate；**没拿到就按「未检测」**渲染
			 * —— fail-closed（未检测不放行），但**不报错、不白屏**（v3 §4.1）。
			 */
			function gateState(g) {
				if (!g) return { kind: "unknown", badge: "⚠️", note: "上一课挑战未检测", bad: true };
				if (g.allowed === true) {
					// 无判据放行（防死锁）要把告警显示出来；needsReview 不阻塞但也该看得见
					// ⚠️ 两种"放行"**不是一回事**，别共用一句话（P1-11）：no-criteria = 没写判据；
					//    unknown-lesson = 课次 id 在快照里对不上（修法是核对 id / 刷新快照）。
					//    共用一句会把「id 写错」的人指去"补判据" —— 那正是这次要消灭的错指引。
					if (g.verdict && g.verdict.warning) {
						return {
							kind: "open", badge: null, bad: true,
							note: g.verdict.code === "unknown-lesson"
								? "课次 id 对不上：判据快照里没有这门课（核对 id，或刷新一次判据快照）"
								: "该课未声明判据（已按无闸放行）",
						};
					}
					var nr = (g.verdict && g.verdict.needsReview) || [];
					return { kind: "open", badge: null, note: nr.length ? nr.length + " 项需人工确认（不阻塞）" : null, bad: false };
				}
				if (g.prereq && g.prereq.ok === false) {
					return { kind: "blocked", badge: "🔒", note: "前置知识点还有课没学完", bad: true };
				}
				if (g.verdict && g.verdict.code === "criteria-not-met") {
					return {
						kind: "blocked", badge: "🔒", bad: true,
						note: "上一课挑战未完成（" + (g.verdict.achieved || 0) + "/" + (g.verdict.total || 0) + "）",
					};
				}
				return { kind: "unknown", badge: "⚠️", note: "上一课挑战未检测", bad: true };
			}
			/**
			 * 「还不能新开下一课」提示条（v3 §3.2）：**就地展开**，不用 alert、不白屏。
			 * 明细逐条列 #编号 + 产出/hint；needsReview 单列；前置缺课单列。
			 * 动作只给**真的能用**的：「重新检测」（POST probe=1，会重研判据快照）。
			 * 「去补挑战」现在给不了 —— 客户端没有"打开课程包页面"的机制（2026-09-24 实测确认），
			 * 与其摆一个点了没反应的按钮，不如把是**哪一课**、**差哪几题**写清楚。
			 */
			function renderBlockedBar(p, g) {
				var kids = [
					react.createElement('div', {
						key: 't',
						style: { fontSize: '12px', fontWeight: '500', color: 'var(--dsw-alias-state-warn-primary)' },
					}, '还不能新开下一课'),
				];
				if (!g) {
					kids.push(react.createElement('div', {
						key: 'nx',
						style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
					}, '上一课的挑战未检测（拿不到判据快照）。点「重新检测」重扫一次。'));
				} else {
					var v = g.verdict || {};
					if (v.lesson) {
						kids.push(react.createElement('div', {
							key: 'l',
							style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
						}, '上一课：' + v.lesson + (v.total ? '（可机判 ' + (v.achieved || 0) + '/' + v.total + '）' : '')));
					}
					if (g.prereq && g.prereq.ok === false) {
						kids.push(react.createElement('div', {
							key: 'pq',
							style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
						}, '前置知识点还有课没学完：' + (g.prereq.missing || []).join('、')));
					}
					(v.missing || []).forEach(function (m, i) {
						kids.push(react.createElement('div', {
							key: 'm' + i,
							style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 },
						}, '#' + m.no + ' ' + (m.deliverable || '') + (m.hint ? '（' + m.hint + '）' : '')));
					});
					var nr = v.needsReview || [];
					if (nr.length) {
						kids.push(react.createElement('div', {
							key: 'nr',
							style: { fontSize: '11px', color: 'var(--dsw-alias-label-caption)' },
						}, '另有 ' + nr.length + ' 项需人工确认（不阻塞）：#' + nr.join(' #')));
					}
				}
				kids.push(react.createElement('div', { key: 'a', style: { display: 'flex', gap: '8px', marginTop: '2px' } },
					react.createElement(primitives.Button, {
						variant: 'outline',
						disabled: state.detecting,
						onClick: function (e) {
							// 别让点击冒泡到卡片（那会再走一遍 selectPoint）
							if (e && e.stopPropagation) e.stopPropagation();
							setState(function (s2) { return Object.assign({}, s2, { detecting: true }); });
							askGate(p.id, true).catch(function () {
								setState(function (s2) { return Object.assign({}, s2, { detecting: false }); });
							});
						},
					}, state.detecting ? '正在重新检测…' : '重新检测'),
				));
				return react.createElement('div', {
					key: 'blocked',
					style: {
						marginTop: '8px', padding: '8px 10px', borderRadius: '6px',
						border: '1px solid var(--dsw-alias-border-l2)',
						background: 'var(--dsw-alias-bg-base)',
						display: 'grid', gap: '4px',
					},
				}, kids);
			}

			/** 重新拉 catalog 并更新 state（用于新建圆圈/知识点成功后） */
			function reloadCatalog(afterFn) {
				fetch('/api/whale/catalog', { headers: { accept: 'application/json' } })
					.then(readJson)
					.then(function (cat) {
						if (cat && cat.ok === true && cat.configured !== false) {
							setState(function (s) {
								var updated = Object.assign({}, s, { catalog: cat });
								return afterFn ? afterFn(updated, cat) : updated;
							});
						}
					})['catch'](function () { /* catalog 刷新失败不阻塞 */ });
			}

			/**
			 * 重建是**异步**的（服务端起完作业就返回），所以这里轮询到它跑完为止。
			 *
			 * 为什么要这一步：服务端已经把三入口接上重建了，可页面上原先**什么都看不到** ——
			 * 那"重建失败"就退化成"页面一言不发"，正是这个项目最忌讳的静默
			 * （板子 01-鲸师.md:366 的验收判据：某条脚本失败 → 页面能看到"产物是旧的"+是哪条）。
			 * ⚠️ 横幅必须挂在 **CourseDialog 自己的 state.rebuild** 上，**不许借删除弹窗那个 `notice`** ——
			 * 那是**另一个组件**的状态，`setNotice` / `setTick` 在本组件作用域里根本不存在。
			 * 2026-09-24 现场踩过：写成 `setNotice(...)` 会当场 `setNotice is not defined`，
			 * **建圆圈那一步整个炸掉**（用户实测报的就是这个）。组件间借状态是这儿最容易犯的错。
			 *
			 * 三种收场都要说清，**没有一种是"嗯，好了"**：
			 *   · 全缺脚本（新包常见）→ 说清缺哪些，不假装已重建
			 *   · 跑完且全过 → "产物已更新 ✓"
			 *   · 有脚本失败 → 把**是哪条**和告警原文一起摆出来（warn 色）
			 */
			var rebuildTimer = null;
			function setRebuild(text, lines, bad) {
				setState(function (s) {
					return Object.assign({}, s, { rebuild: { text: text, lines: lines || [], bad: !!bad } });
				});
			}
			function watchRebuild(rb, subject) {
				if (!rb) return;
				if (!rb.jobId) {
					setRebuild(subject + '已建。' + (rb.note || '没有任何重建脚本可跑'), rb.missing || [], true);
					return;
				}
				var scripts = rb.scripts || [];
				setRebuild(subject + '已建，正在重建产物…（0/' + scripts.length + '）', scripts, false);
				if (rebuildTimer) window.clearInterval(rebuildTimer);
				var poll = function () {
					fetch('/api/whale/rebuild?id=' + encodeURIComponent(rb.jobId), { headers: { accept: 'application/json' } })
						.then(function (r) { return r.json(); })
						.then(function (d) {
							var j = d && d.job;
							if (!j) { window.clearInterval(rebuildTimer); rebuildTimer = null; return; }
							if (!j.done) {
								setRebuild(subject + '已建，正在重建产物…（' + (j.index + 1) + '/' + j.total + '：' + (j.current || '') + '）', j.scripts, false);
								return;
							}
							window.clearInterval(rebuildTimer);
							rebuildTimer = null;
							if (j.rebuild && j.rebuild.ok) {
								setRebuild(subject + '已建，产物已更新 ✓', [], false);
							} else {
								setRebuild(
									subject + '已建，但产物可能是旧的 —— ' + ((j.warnings || []).join('；') || '有一条脚本没跑过'),
									(j.rebuild && j.rebuild.failed) || [],
									true,
								);
							}
						})['catch'](function () { /* 查不动就留上一轮横幅，下一次轮询再试（不刷屏） */ });
				};
				poll();
				rebuildTimer = window.setInterval(poll, 900);
			}

			/** 新建圆圈：POST → 重拉 catalog → 自动选中新建的圆圈进第②屏 */
			function doCreateCircle() {
				if (!state.newCircle.name.trim() || !state.newCircle.id.trim()) return;
				setState(function (s) { return Object.assign({}, s, { newCircle: Object.assign({}, s.newCircle, { saving: true, error: null }) }); });
				fetch('/api/whale/circle', {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					body: JSON.stringify({ name: state.newCircle.name.trim(), id: state.newCircle.id.trim() }),
				}).then(function (r) { return r.json(); }).then(function (d) {
					if (d.ok) {
						// 成功：重拉 catalog，自动选中新建的圆圈
						// 建完**自己起重建**（服务端接的），这里把进度与失败摆到页面上
						watchRebuild(d.rebuild, '圆圈「' + state.newCircle.name.trim() + '」');
						var newId = d.id;
						reloadCatalog(function (updated, cat) {
							var circles = (cat && cat.circles) || [];
							var found = circles.find(function (c) { return c.id === newId; });
							return Object.assign({}, updated, {
								newCircle: { open: false, name: '', id: '', saving: false, error: null },
								step: found ? 1 : 0,
								selectedCircle: found || null,
							});
						});
					} else {
						setState(function (s) { return Object.assign({}, s, { newCircle: Object.assign({}, s.newCircle, { saving: false, error: d.error || '创建失败' }) }); });
					}
				})['catch'](function (err) {
					setState(function (s) { return Object.assign({}, s, { newCircle: Object.assign({}, s.newCircle, { saving: false, error: String((err && err.message) || err) }) }); });
				});
			}

			/** 新建知识点：POST → 重拉 catalog → 自动选中新建的知识点进第③屏 */
			function doCreatePoint() {
				var circle = state.selectedCircle;
				if (!circle || !state.newPoint.name.trim() || !state.newPoint.id.trim()) return;
				setState(function (s) { return Object.assign({}, s, { newPoint: Object.assign({}, s.newPoint, { saving: true, error: null }) }); });
				fetch('/api/whale/point', {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					body: JSON.stringify({ circle: circle.id, name: state.newPoint.name.trim(), id: state.newPoint.id.trim() }),
				}).then(function (r) { return r.json(); }).then(function (d) {
					if (d.ok) {
						// 成功：重拉 catalog，自动选中新建的知识点
						watchRebuild(d.rebuild, '知识点「' + state.newPoint.name.trim() + '」');
						var newId = d.id; // e.g. "math/algebra"
						var newPointId = newId.split('/').pop();
						reloadCatalog(function (updated, cat) {
							var circles = (cat && cat.circles) || [];
							var foundCircle = circles.find(function (c) { return c.id === circle.id; });
							var foundPoint = foundCircle ? (foundCircle.points || []).find(function (p) { return p.id === newPointId; }) : null;
							return Object.assign({}, updated, {
								newPoint: { open: false, name: '', id: '', saving: false, error: null },
								selectedCircle: foundCircle || circle,
								// 表单屏已删（2026-09-24 F1c）：建完**留在选知识点这一屏**，
								// 新建的那个点已经在刷新后的列表里 —— 点它的卡片才是「一键到位」
								step: 1,
								selectedPoint: null,
								blocked: false,
							});
						});
						// 新点也要有判词（首课 → 放行），否则它的卡片会停在「未检测」
						window.setTimeout(function () { askGate(d.id, false)['catch'](function () {}); }, 0);
						// 建点成功 → 自动把「为它生成知识点地图（大纲）」的指令送进会话。
						// 正文是宿主拼好、随回执带来的（`mapPrompt`）—— 客户端只递、不拼（话术只有一份：lib/starter.js）。
						// 硬规矩：没拿到 mapPrompt（失败回执 / 旧宿主）**一个字都不送**；一次建点只送一条，
						// 重试与重建轮询都不碰 composer、不会再送。与 selectPoint 同款时序：放到下一帧再送。
						var mapPromptText = (d && typeof d.mapPrompt === 'string') ? d.mapPrompt : '';
						if (mapPromptText.trim()) {
							window.setTimeout(function () { pushToComposer(mapPromptText); }, 0);
						}
					} else {
						setState(function (s) { return Object.assign({}, s, { newPoint: Object.assign({}, s.newPoint, { saving: false, error: d.error || '创建失败' }) }); });
					}
				})['catch'](function (err) {
					setState(function (s) { return Object.assign({}, s, { newPoint: Object.assign({}, s.newPoint, { saving: false, error: String((err && err.message) || err) }) }); });
				});
			}

			/**
			 * @param {object} [over] 覆盖这次发送用的 state（一键到位那条路在**下一帧**才发，
			 *        那时闭包里的 state 还没有 selectedPoint —— 显式传进来，不靠时序）
			 */
			function send(over) {
				var snap = over ? Object.assign({}, state, over) : state;
				var entry = snap.entry;
				if (!entry || snap.phase === 'sending') return;
				setState(function (s) { return Object.assign({}, s, { phase: 'sending', why: null }); });
				// 准备 POST 数据，如果有选中的圆圈/知识点，带上归属信息
				var postData = { values: snap.values };
				if (snap.selectedCircle && snap.selectedPoint) {
					postData.circle = snap.selectedCircle.name;
					postData.point = snap.selectedPoint.name;
					postData.pointId = snap.selectedPoint.id;
				}
				fetch('/api/whale/starter', {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					body: JSON.stringify(postData),
				}).then(readJson).then(function (d) {
					if (!d.ok) {
						setState(function (s) { return Object.assign({}, s, { phase: 'ready', why: d.error || '宿主拒绝了这次拼装' }); });
						return;
					}
					var text = d.text;
					if (pushToComposer(text)) {
						console.log('[dsh-whale-sensei] 新课程：已发送（' + text.length + ' 字）');
						setDialogOpen(false);
						setState(function (s) { return Object.assign({}, s, { phase: 'ready', entry: entry, values: {}, why: null }); });
					} else if (copyPrompt(text)) {
						setState(function (s) { return Object.assign({}, s, { phase: 'ready', why: '拿不到输入框，正文已复制到剪贴板：粘进去按回车即可' }); });
					} else {
						setState(function (s) { return Object.assign({}, s, { phase: 'ready', why: '拿不到输入框，也复制不了 —— 宿主版本可能变了' }); });
					}
				})['catch'](function (err) {
					setState(function (s) { return Object.assign({}, s, { phase: 'ready', why: '发送失败：' + String((err && err.message) || err) }); });
				});
			}

			var entry = state.entry;
			var form = entry && entry.form;

			// 根据当前 step 渲染内容
			var bodyContent = null;

			if (state.phase === 'loading') {
				bodyContent = react.createElement('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' } }, '正在读开课载荷…');
			} else if (state.phase === 'err') {
				bodyContent = react.createElement('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-state-error-primary)' } }, state.why);
			} else if (state.step === 0 && state.catalog) {
				// 步骤 ①：选知识圆圈
				var circles = state.catalog.circles || [];
				bodyContent = react.createElement('div', { style: { display: 'grid', gap: '12px' } },
					state.catalogWhy ? react.createElement('div', {
						style: { fontSize: '12px', color: 'var(--dsw-alias-state-warn-primary)', lineHeight: 1.6 },
					}, state.catalogWhy) : null,
					circles.length > 0 ? react.createElement('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, '选择一个知识圆圈：') : null,
					circles.map(function (c) {
						var pointCount = (c.points || []).length;
						var lessonCount = (c.points || []).reduce(function (sum, p) { return sum + (p.lessons || []).length; }, 0);
						return react.createElement('div', {
							key: c.id,
							style: {
								padding: '10px 12px',
								border: '1px solid var(--dsw-alias-border-l2)',
								borderRadius: '8px',
								cursor: 'pointer',
								background: 'var(--dsw-alias-bg-base)',
							},
							onClick: function () { selectCircle(c); },
						},
							react.createElement('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)', fontWeight: '500' } }, c.name),
							react.createElement('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '4px' } },
								pointCount + ' 个知识点 · ' + lessonCount + ' 门课'
							),
						);
					}),
					circles.length === 0 ? react.createElement('div', {
						style: {
							padding: '10px 12px',
							border: '1px solid var(--dsw-alias-border-l2)',
							borderRadius: '8px',
							cursor: 'pointer',
							background: 'var(--dsw-alias-bg-base)',
							fontSize: '13px', color: 'var(--dsw-alias-label-secondary)',
						},
						onClick: skipToForm,
					}, '这里还没有圆圈 → 直接填表开课（归属留空）') : null,
					state.catalog.canCreate ? (function () {
						var nc = state.newCircle;
						if (nc.open) {
							return react.createElement('div', {
								key: 'new-circle-form',
								style: {
									border: '1px dashed var(--dsw-alias-border-l2)', borderRadius: '8px',
									padding: '10px 12px', display: 'grid', gap: '8px',
								},
							},
								react.createElement('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, '新建知识圆圈'),
								react.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '8px' } },
									react.createElement('input', {
										type: 'text', placeholder: '显示名（如「数学」）', value: nc.name, disabled: nc.saving,
										onChange: function (e) { setState(function (s) { return Object.assign({}, s, { newCircle: Object.assign({}, s.newCircle, { name: e.target.value }) }); }); },
										style: { fontSize: '13px', fontFamily: 'inherit', padding: '6px 10px', minWidth: 0, width: '100%', boxSizing: 'border-box', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', outline: 'none' },
									}),
									react.createElement('input', {
										type: 'text', placeholder: '目录 id（如 math）', value: nc.id, disabled: nc.saving,
										onChange: function (e) { setState(function (s) { return Object.assign({}, s, { newCircle: Object.assign({}, s.newCircle, { id: e.target.value }) }); }); },
										style: { fontSize: '13px', fontFamily: 'inherit', padding: '6px 10px', minWidth: 0, width: '100%', boxSizing: 'border-box', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', outline: 'none' },
									}),
								),
								react.createElement('div', { style: { display: 'flex', gap: '6px', justifyContent: 'flex-end' } },
									react.createElement('button', {
										type: 'button', disabled: nc.saving,
										onClick: function () { setState(function (s) { return Object.assign({}, s, { newCircle: { open: false, name: '', id: '', saving: false, error: null } }); }); },
										style: { fontSize: '12px', padding: '4px 12px', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit' },
									}, '取消'),
									react.createElement('button', {
										type: 'button', disabled: nc.saving || !nc.name.trim() || !nc.id.trim(),
										onClick: doCreateCircle,
										style: { fontSize: '12px', padding: '4px 12px', background: 'var(--dsw-alias-state-success-primary)', color: 'var(--dsw-alias-label-on-primary)', border: 'none', borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit' },
									}, nc.saving ? '创建中…' : '创建'),
								),
								nc.error ? react.createElement('div', {
									style: { fontSize: '11px', color: 'var(--dsw-alias-state-error-primary)' },
								}, nc.error) : null,
							);
						}
						return react.createElement('div', {
							key: 'new-circle-btn',
							style: {
								padding: '10px 12px',
								border: '1px dashed var(--dsw-alias-border-l2)',
								borderRadius: '8px',
								cursor: 'pointer',
								color: 'var(--dsw-alias-label-secondary)',
								fontSize: '13px',
							},
							onClick: function () { setState(function (s) { return Object.assign({}, s, { newCircle: Object.assign({}, s.newCircle, { open: true }) }); }); },
						}, '+ 新建圆圈');
					})() : null,
				);
			} else if (state.step === 1 && state.selectedCircle) {
				// 步骤 ②：选知识点
				var points = state.selectedCircle.points || [];
				bodyContent = react.createElement('div', { style: { display: 'grid', gap: '12px' } },
					points.length > 0 ? react.createElement('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
						'在「' + state.selectedCircle.name + '」中选择一个知识点：'
					) : null,
					points.map(function (p) {
						var lessonCount = (p.lessons || []).length;
						var displayNext = p.nextNumber - (p.fileBase || 0);
						// ⚠️ `state.gates` 用 `|| {}` 兜底：本组件的初始 state 里一定有它，
						//    但测试的合成 state 可能没有 —— 少这一层就会在渲染期炸（2026-09-24 实测）
						var g = (state.gates || {})[p.id];
						var gs = gateState(g);
						var isThisOne = state.selectedPoint && state.selectedPoint.id === p.id;
						return react.createElement('div', {
							key: p.id,
							style: {
								padding: '10px 12px',
								border: '1px solid var(--dsw-alias-border-l2)',
								borderRadius: '8px',
								cursor: 'pointer',
								background: 'var(--dsw-alias-bg-base)',
								// 需补挑战 / 未检测 → 置灰；但**仍可点**（点了就地展开提示条，不是死按钮）
								opacity: gs.kind === 'open' ? 1 : 0.65,
							},
							onClick: function () { selectPoint(p); },
						},
							react.createElement('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)', fontWeight: '500' } },
								(gs.badge ? gs.badge + ' ' : '') + p.name
							),
							react.createElement('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '4px' } },
								'已 ' + lessonCount + ' 课 · 下一课 第 ' + displayNext + ' 课'
							),
							gs.note ? react.createElement('div', {
								style: {
									fontSize: '11px', marginTop: '4px',
									color: gs.bad ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-caption)',
								},
							}, gs.note) : null,
							// 提示条：**只有这张卡被点过且被拦住**时才就地展开（v3 §3.2：不用 alert）
							(isThisOne && state.blocked) ? renderBlockedBar(p, g) : null,
						);
					}),
					points.length === 0 ? react.createElement('div', {
						style: {
							padding: '10px 12px',
							border: '1px solid var(--dsw-alias-border-l2)',
							borderRadius: '8px',
							cursor: 'pointer',
							background: 'var(--dsw-alias-bg-base)',
							fontSize: '13px', color: 'var(--dsw-alias-label-secondary)',
						},
						onClick: skipToForm,
					}, '这里还没有知识点 → 直接填表开课（归属留空）') : null,
					state.catalog.canCreate ? (function () {
						var np = state.newPoint;
						if (np.open) {
							return react.createElement('div', {
								key: 'new-point-form',
								style: {
									border: '1px dashed var(--dsw-alias-border-l2)', borderRadius: '8px',
									padding: '10px 12px', display: 'grid', gap: '8px',
								},
							},
								react.createElement('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, '新建知识点'),
								react.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '8px' } },
									react.createElement('input', {
										type: 'text', placeholder: '显示名（如「代数」）', value: np.name, disabled: np.saving,
										onChange: function (e) { setState(function (s) { return Object.assign({}, s, { newPoint: Object.assign({}, s.newPoint, { name: e.target.value }) }); }); },
										style: { fontSize: '13px', fontFamily: 'inherit', padding: '6px 10px', minWidth: 0, width: '100%', boxSizing: 'border-box', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', outline: 'none' },
									}),
									react.createElement('input', {
										type: 'text', placeholder: '目录 id（如 algebra）', value: np.id, disabled: np.saving,
										onChange: function (e) { setState(function (s) { return Object.assign({}, s, { newPoint: Object.assign({}, s.newPoint, { id: e.target.value }) }); }); },
										style: { fontSize: '13px', fontFamily: 'inherit', padding: '6px 10px', minWidth: 0, width: '100%', boxSizing: 'border-box', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', outline: 'none' },
									}),
								),
								react.createElement('div', { style: { display: 'flex', gap: '6px', justifyContent: 'flex-end' } },
									react.createElement('button', {
										type: 'button', disabled: np.saving,
										onClick: function () { setState(function (s) { return Object.assign({}, s, { newPoint: { open: false, name: '', id: '', saving: false, error: null } }); }); },
										style: { fontSize: '12px', padding: '4px 12px', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit' },
									}, '取消'),
									react.createElement('button', {
										type: 'button', disabled: np.saving || !np.name.trim() || !np.id.trim(),
										onClick: doCreatePoint,
										style: { fontSize: '12px', padding: '4px 12px', background: 'var(--dsw-alias-state-success-primary)', color: 'var(--dsw-alias-label-on-primary)', border: 'none', borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit' },
									}, np.saving ? '创建中…' : '创建'),
								),
								np.error ? react.createElement('div', {
									style: { fontSize: '11px', color: 'var(--dsw-alias-state-error-primary)' },
								}, np.error) : null,
							);
						}
						return react.createElement('div', {
							key: 'new-point-btn',
							style: {
								padding: '10px 12px',
								border: '1px dashed var(--dsw-alias-border-l2)',
								borderRadius: '8px',
								cursor: 'pointer',
								color: 'var(--dsw-alias-label-secondary)',
								fontSize: '13px',
							},
							onClick: function () { setState(function (s) { return Object.assign({}, s, { newPoint: Object.assign({}, s.newPoint, { open: true }) }); }); },
						}, '+ 新建知识点');
					})() : null,
				);
			}
			// 警告信息（why 或 catalogWhy 任一有值就显示，catalog 拿不到时原因也要可见）
			var warningText = state.why || state.catalogWhy || null;
			var warningContent = state.phase !== 'err' && warningText ? react.createElement('div', {
				style: { fontSize: '12px', color: 'var(--dsw-alias-state-warn-primary)', lineHeight: 1.6, marginTop: '8px' },
			}, warningText) : null;

			// 底部按钮
			var footerContent = react.createElement('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
				// 第 ②、③ 屏显示「上一步」（第 ① 屏不需要）
				state.step >= 1 ? react.createElement(primitives.Button, {
					variant: 'outline',
					disabled: state.phase === 'sending',
					onClick: goBack,
				}, '上一步') : null,
				react.createElement(primitives.Button, {
					variant: 'outline',
					disabled: state.phase === 'sending',
					onClick: function () { setDialogOpen(false); },
				}, (form && form.cancelLabel) || '取消'),

			);

			// 重建横幅（本组件自己的 state.rebuild）：跑完要说清"产物已更新"，失败要把是哪条摆出来
			var rebuildEl = state.rebuild ? react.createElement('div', {
				key: 'rebuild',
				style: {
					fontSize: '12px', lineHeight: 1.7, marginTop: '8px',
					color: state.rebuild.bad ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-secondary)',
				},
			},
				react.createElement('div', null, state.rebuild.text),
				(state.rebuild.lines || []).map(function (l, i) {
					return react.createElement('div', {
						key: 'rbline' + i,
						style: {
							fontFamily: 'ui-monospace, monospace', fontSize: '11px',
							color: 'var(--dsw-alias-label-tertiary)', marginTop: '2px',
						},
					}, String(l));
				})
			) : null;

			var body = react.createElement('div', { style: { display: 'grid', gap: '12px' } },
				bodyContent,
				rebuildEl,
				warningContent,
			);

			return react.createElement(primitives.Modal, {
				open: !!open,
				onClose: function () { setDialogOpen(false); },
				title: (form && form.title) || ENTRY_LABEL,
				description: form ? form.intro : null,
				closeLabel: '关闭',
				footer: footerContent,
			}, body);
		}

		/** 弹窗挂到 `shell.overlay`（官方"整帧浮层"缝：kind list / root 作用域 / 当前零占用） */
		function applyCourseDialog(ctx) {
			try {
				if (!ctx.slots || typeof ctx.slots.register !== 'function') return;
				ctx.slots.inject('shell.overlay', function () {
					return ctx.slots.register(
						{ name: 'shell.overlay', id: 'whale-new-course-dialog', order: 60, label: ENTRY_LABEL },
						CourseDialog,
					);
				});
			} catch (err) {
				console.warn('[dsh-whale-sensei] 开课弹窗挂载失败：', err);
			}
		}
		//#endregion

		/**
		 * 侧栏那一行点一下：**开弹窗**（「发送」键才是启动键）。
		 * 弹窗还没挂上（宿主没给 `shell.overlay`）时退回老路：把协议直接填进输入框 / 复制。
		 */
		function startNewCourse(row, label) {
			if (row.disabled) return;
			if (dialogReady) {
				console.log('[dsh-whale-sensei] 新课程：开弹窗');
				setDialogOpen(true);
				return;
			}
			row.disabled = true;
			label.textContent = '正在准备…';
			console.log('[dsh-whale-sensei] 新课程：没有 shell.overlay，退回直接填草稿');
			readStarter().then(function (d) {
				var ia = composerActions;
				if (ia && typeof ia.setDraft === 'function') {
					ia.setDraft(d.entry.prompt);
					flashRow(row, label, '已送进输入框 ✓', 'var(--dsw-alias-state-success-primary)');
				} else if (copyPrompt(d.entry.prompt)) {
					flashRow(row, label, '已复制，去粘贴 ✓', 'var(--dsw-alias-state-success-primary)');
				} else {
					flashRow(row, label, '取不到开课协议 ✗', 'var(--dsw-alias-state-error-primary)');
				}
			})['catch'](function (err) {
				console.warn('[dsh-whale-sensei] 新课程：拉协议失败', err);
				row.title = '取不到开课协议：' + String((err && err.message) || err);
				flashRow(row, label, '取不到开课协议 ✗', 'var(--dsw-alias-state-error-primary)');
			});
		}

		/** 造那一行（还没插进 DOM） */
		function createEntryRow() {
			var row = document.createElement('button');
			row.type = 'button';
			row.setAttribute(ENTRY_ATTR, '');
			row.setAttribute('data-dsh-plugin', 'whale-sensei');
			row.setAttribute('data-dsh-part', 'sidebar-entry');
			row.setAttribute('aria-label', ENTRY_LABEL);
			row.setAttribute('title', ENTRY_TITLE);
			var icon = document.createElement('span');
			icon.className = 'dsh-whale-entry-icon';
			icon.setAttribute('aria-hidden', 'true');
			icon.innerHTML = ENTRY_ICON;
			var label = document.createElement('span');
			label.className = 'dsh-whale-entry-label';
			label.textContent = ENTRY_LABEL;
			row.appendChild(icon);
			row.appendChild(label);
			row.addEventListener('click', function () { startNewCourse(row, label); });
			return { row: row, label: label };
		}

		/**
		 * 侧栏第二行点一下：确保课程包服务在跑 → 打开星图。
		 * ⚠️ 空白页**同步**开（保住点击手势），拿到 url 再改它的 `location`；失败就把它关掉 ——
		 *   等 fetch 回来再 `window.open` 会被弹窗拦截器吃掉。
		 */
		function startOpenPack(row, label) {
			if (row.disabled) return;
			var back = { label: PACK_ENTRY_LABEL, title: PACK_ENTRY_TITLE };
			row.disabled = true;
			label.textContent = '正在起服务…';
			var win = null;
			try { win = window.open('', '_blank'); } catch (err) { win = null; }
			fetch('/api/whale/pack/open', {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: '{}',
			}).then(readJson).then(function (d) {
				if (!d || !d.ok || !d.url) {
					var why = (d && d.error) || '打不开课程包';
					if (win) { try { win.close(); } catch (err) { /* 已经关了 */ } }
					console.warn('[dsh-whale-sensei] 课程中心失败：' + why);
					row.title = why;
					flashRow(row, label, '打不开课程包 ✗', 'var(--dsw-alias-state-error-primary)', back);
					return;
				}
				if (win) { try { win.location.href = d.url; } catch (err) { win = null; } }
				if (!win) window.open(d.url, '_blank', 'noopener');
				flashRow(row, label, d.started ? '已起服务并打开 ✓' : '已打开 ✓', 'var(--dsw-alias-state-success-primary)', back);
			})['catch'](function (err) {
				if (win) { try { win.close(); } catch (e2) { /* 已经关了 */ } }
				var why = '打不开课程包：' + String((err && err.message) || err);
				console.warn('[dsh-whale-sensei] ' + why);
				row.title = why;
				flashRow(row, label, '打不开课程包 ✗', 'var(--dsw-alias-state-error-primary)', back);
			});
		}

		/** 造第二行（「课程中心」）—— 结构与「新课程」那行同形，只有标记 / 类名 / 文案 / 动作不同 */
		function createPackEntryRow() {
			var row = document.createElement('button');
			row.type = 'button';
			row.setAttribute(PACK_ENTRY_ATTR, '');
			row.setAttribute('data-dsh-plugin', 'whale-sensei');
			row.setAttribute('data-dsh-part', 'sidebar-entry');
			row.setAttribute('aria-label', PACK_ENTRY_LABEL);
			row.setAttribute('title', PACK_ENTRY_TITLE);
			var icon = document.createElement('span');
			icon.className = 'dsh-whale-pack-entry-icon';
			icon.setAttribute('aria-hidden', 'true');
			icon.innerHTML = PACK_ENTRY_ICON;
			var label = document.createElement('span');
			label.className = 'dsh-whale-pack-entry-label';
			label.textContent = PACK_ENTRY_LABEL;
			row.appendChild(icon);
			row.appendChild(label);
			row.addEventListener('click', function () { startOpenPack(row, label); });
			return { row: row, label: label };
		}

		/** 应该插在谁后面：原生「新建会话」那一行（新版嵌在 logoRow 里，老版是直接子节点） */
		function placementBase(root) {
			var button = newSessionButton(root);
			if (!button) return null;
			var logoRow = typeof button.closest === 'function' ? button.closest('[class*="logoRow"]') : null;
			return (logoRow && logoRow.parentElement === root) ? logoRow : button;
		}

		/**
		 * 把 `row` 放到 `prev` 的**正下方**。
		 *
		 * ⚠️ 位置要**反复断言**，不能只在插入那一刻算一次：别的插件（技能中心）是**后**插入的，
		 * 它的锚点是"新会话的下一个兄弟节点" —— 那正好是我们的行，于是它会插到我们上面去
		 * （2026-09-21 现场：任何一次重渲染后的顺序都变成 新会话 → 技能中心 → 新课程）。
		 * 所以这里每次被调用都检查 `previousElementSibling` 是不是 `prev`，不是就挪回去。
		 * 不会来回打架：对方只在"自己的行不见了"时才动手，我们挪位置不会让它消失。
		 *
		 * @param {Element} root 侧栏那一列
		 * @param {Element} row 要放的行
		 * @param {Element} prev 放在谁下面（第一行 = 「新建会话」那一行；第二行 = 「新课程」那一行）
		 * @returns {boolean} 放好了没有（宿主还没给按钮时为 false，等下一轮自愈）
		 */
		function placeRowAfter(root, row, prev) {
			if (!prev) return false;
			if (row.parentElement === root && row.previousElementSibling === prev) return true;
			root.insertBefore(row, prev.nextElementSibling);
			return true;
		}

		/**
		 * 按「新建会话 → 新课程 → 课程中心」**链式**摆好两行。
		 * @returns {boolean} 都放好了没有
		 */
		function placeEntryRows(root, rows) {
			var prev = placementBase(root);
			if (!prev) return false;
			for (var i = 0; i < rows.length; i++) {
				if (!placeRowAfter(root, rows[i], prev)) return false;
				prev = rows[i];
			}
			return true;
		}

		/**
		 * 挂载侧栏那**两行**，并自愈。
		 *
		 * ⚠️ 两个 observer 缺一不可（第一次就是缺了 body 那个而**静默什么都没发生**）：
		 *   · `apply()` 跑得**比侧栏渲染早** —— 那时 `sidebarShell()` 还是 null。
		 *     所以未插上时要挂一个 **body observer** 重试（技能中心靠的是同一招：
		 *     "subscribeBodyInvalidations"）。
		 *   · 插上之后，宿主 React 重渲染会把这行冲掉，靠 **root observer** 立刻插回。
		 * @returns {Function} disposer（去掉两行、断开两个 observer）
		 */
		function mountSidebarEntry() {
			if (typeof document === 'undefined') return function () {};
			// 幂等：**两行都在**才不重复注（缺哪一行都要补齐，所以判据是"都在"）
			if (document.querySelector('[' + ENTRY_ATTR + ']') && document.querySelector('[' + PACK_ENTRY_ATTR + ']')) return function () {};
			ensureEntryStyle();

			var rows = [createEntryRow().row, createPackEntryRow().row];
			var root = null;
			var placed = false;
			var rootObserver = null;
			var bodyObserver = null;

			function allIn(t) {
				for (var i = 0; i < rows.length; i++) if (!t.contains(rows[i])) return false;
				return true;
			}

			function watchBody() {
				if (bodyObserver || typeof MutationObserver === 'undefined') return;
				if (!document.body) return;
				bodyObserver = new MutationObserver(function () { if (!placed) tryPlace(); });
				bodyObserver.observe(document.body, { childList: true, subtree: true });
			}

			function stopBodyWatch() {
				if (!bodyObserver) return;
				bodyObserver.disconnect();
				bodyObserver = null;
			}

			function tryPlace() {
				if (root && !root.isConnected) {
					if (rootObserver) rootObserver.disconnect();
					rootObserver = null;
					root = null;
					placed = false;
				}
				if (placed) {
					if (document.body && allIn(document.body)) return;
					if (rootObserver) rootObserver.disconnect();
					rootObserver = null;
					root = null;
					placed = false;
				}
				if (!root) root = sidebarShell();
				if (!root) { watchBody(); return; }
				placed = placeEntryRows(root, rows);
				if (!placed) { watchBody(); return; }
				stopBodyWatch();
				if (!rootObserver) {
					rootObserver = new MutationObserver(function () {
						if (!root || !root.isConnected) { placed = false; tryPlace(); return; }
						if (!allIn(root)) {
							placed = placeEntryRows(root, rows);
							if (!placed) tryPlace();
							return;
						}
						// 位置断言：别人（技能中心等）插到我上面时，立刻挪回「新会话」正下方
						placeEntryRows(root, rows);
					});
				}
				rootObserver.observe(root, { childList: true, subtree: true });
			}

			tryPlace();
			return function () {
				try { if (rootObserver) rootObserver.disconnect(); } catch (err) { /* 已经断了 */ }
				try { if (bodyObserver) bodyObserver.disconnect(); } catch (err) { /* 已经断了 */ }
				for (var i = 0; i < rows.length; i++) { try { rows[i].remove(); } catch (err) { /* 已经没了 */ } }
			};
		}

		function applySidebarEntry(ctx) {
			try {
				if (typeof document === 'undefined') return;
				var dispose = mountSidebarEntry();
				if (typeof ctx.effect === 'function') {
					ctx.effect(function () { return dispose; }, 'whale-sensei: 侧栏两行入口（新课程 / 课程中心）');
				}
			} catch (err) {
				console.warn('[dsh-whale-sensei] 侧栏入口挂载失败：', err);
			}
		}

		//#endregion

		/**
		 * 客户端入口。
		 * @param {object} ctx 可用面：ctx.effect / ctx.slots / ctx.settingsScope / ctx.locale / ctx.get(name)
		 */
		function apply(ctx) {
			applyStatusCard(ctx);
			applyComposerBridge(ctx);
			applyCourseDialog(ctx);
			applySidebarEntry(ctx);
		}

		exports.apply = apply;
		// 客户端**服务名**清单（不是包名）。只用 slots —— 多写会因缺服务而整个半边不激活。
		exports.inject = ['slots'];

		return module.exports;
	},
});

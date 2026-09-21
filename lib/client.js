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
		// 把"没配 packRoot ⇒ 所有 /api/whale/* 会 503"**当场显示出来**，而不是显示一个错误。
		//#endregion

		var react = require('react');

		/** 状态 → 官方语义色（不自己造色） */
		var STATE_COLOR = {
			ok: 'var(--dsw-alias-state-success-primary)',
			warn: 'var(--dsw-alias-state-warn-primary)',
			error: 'var(--dsw-alias-state-error-primary)',
		};

		/** 一行：名字 + 值。名字窄、值宽，两栏对齐。 */
		function Row(props) {
			return react.createElement('div', {
				style: { display: 'grid', gridTemplateColumns: '82px 1fr', gap: '10px', padding: '3px 0', alignItems: 'baseline' },
			},
				react.createElement('span', {
					style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '18px' },
				}, props.name),
				react.createElement('span', {
					style: {
						color: props.state ? STATE_COLOR[props.state] : 'var(--dsw-alias-label-primary)',
						fontSize: '13px', lineHeight: '19px', wordBreak: 'break-all',
					},
				}, props.value),
			);
		}

		/** 一小块：小标题 + 若干行；块与块之间用一条极淡的分隔线 */
		function Section(props) {
			return react.createElement('div', {
				style: { borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '10px' },
			},
				react.createElement('div', {
					style: { color: 'var(--dsw-alias-label-caption)', fontSize: '11px', letterSpacing: '0.06em', paddingBottom: '5px' },
				}, props.title),
				(props.rows || []).map(function (r, i) {
					return react.createElement(Row, { key: props.title + i, name: r.name, value: r.value, state: r.state });
				}),
			);
		}

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

			if (state.phase === 'loading') {
				return react.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px' } }, '正在读课程包状态…');
			}
			if (state.phase === 'err') {
				return react.createElement('div', { style: { fontSize: '13px', lineHeight: 1.7 } },
					'取不到状态：' + state.why + '。',
					react.createElement('div', { style: { paddingTop: '6px', color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' } },
						'这里读的是 GET /api/whale/status。若报 400 且响应体为空，'
						+ '多半是宿主侧那条路由没显式声明 requestBody（基座会把它当 streaming，'
						+ '给 GET 装 body 就抛）—— 见 lib/mods/status.js 的注释。'),
				);
			}

			var d = state.data || {};
			var head = react.createElement('div', {
				style: { display: 'flex', alignItems: 'baseline', gap: '10px', paddingBottom: '4px' },
			},
				react.createElement('span', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: '13px' } }, 'dsh-whale-sensei'),
				react.createElement('span', { style: { color: 'var(--dsw-alias-label-caption)', fontSize: '12px' } }, d.version ? 'v' + d.version : ''),
				react.createElement('span', { style: { flex: '1 1 auto' } }),
				react.createElement('span', { style: { color: 'var(--dsw-alias-label-caption)', fontSize: '11px' } }, state.at ? '读取于 ' + state.at : ''),
				react.createElement('button', {
					type: 'button',
					onClick: function () { setTick(tick + 1); },
					style: {
						background: 'transparent', border: '1px solid var(--dsw-alias-border-l2)',
						color: 'var(--dsw-alias-label-secondary)', borderRadius: '6px',
						padding: '1px 10px', fontSize: '12px', cursor: 'pointer', fontFamily: 'inherit',
					},
				}, '重新读取'),
			);

			var body = [];
			if (!d.configured) {
				body.push(react.createElement('div', {
					key: 'hint',
					style: {
						border: '1px solid var(--dsw-alias-state-warn-primary)', borderRadius: '8px',
						padding: '10px 12px', color: 'var(--dsw-alias-state-warn-primary)',
						fontSize: '13px', lineHeight: 1.7,
					},
				}, d.hint || '未配置 packRoot'));
			} else {
				for (var i = 0; i < (d.sections || []).length; i++) {
					var s = d.sections[i];
					body.push(react.createElement(Section, { key: s.title, title: s.title, rows: s.rows }));
				}
			}

			return react.createElement('div', { style: { display: 'grid', gap: '12px' } }, head, body);
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
		// **文本怎么进输入框**：侧栏这行是纯 DOM，拿不到 slot 的 props；而往输入框写字的唯一
		// 官方通道是 composer 侧坐位注入的 `inputActions.setDraft(text)`。所以这里保留一个
		// **不渲染任何东西**的坐位 `conversation.input.left`（`ComposerBridge`），只负责把
		// `inputActions` 接出来。拿不到就退化成复制到剪贴板 —— **绝不静默失败**。
		//
		// 协议全文**不在这个文件里**：宿主侧 `lib/starter.js` 算好，随
		// `GET /api/whale/status` 的 `entry` 一起发下来；**点了才拉一次**（不用它做渲染，
		// 免得每次开会话都跑一遍全量审计）。`submit()` 我们**故意不用**：只填草稿，
		// 让人自己回车，避免误发。
		//#endregion

		var ENTRY_SLOT = 'conversation.input.left';
		var ENTRY_ATTR = 'data-dsh-whale-entry';
		var ENTRY_STYLE_ID = 'dsh-whale-entry-style';
		var ENTRY_LABEL = '新课程';
		var ENTRY_TITLE = '新课程：把开课协议送进输入框（先查资料 → 问掌握程度 → 再生成课程）';

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

		/** 拉一次开课入口载荷；拿不到就抛（让按钮说出为什么，而不是什么都不发生） */
		function readEntry() {
			return fetch('/api/whale/status', { headers: { accept: 'application/json' } })
				.then(function (r) {
					return r.text().then(function (t) {
						if (!t) {
							var e1 = new Error('HTTP ' + r.status + ' 空响应体');
							e1.status = r.status;
							throw e1;
						}
						try {
							return JSON.parse(t);
						} catch (err) {
							throw new Error('HTTP ' + r.status + ' 不是 JSON：' + t.slice(0, 60));
						}
					});
				})
				.then(function (d) {
					var entry = d && d.entry;
					if (!entry || !entry.prompt) {
						throw new Error('状态里没有 entry.prompt（宿主侧 lib/starter.js 没发出来？）');
					}
					return entry;
				});
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

		/** 样式只注入一次（按 id 判重） */
		function ensureEntryStyle() {
			if (document.getElementById(ENTRY_STYLE_ID)) return;
			var style = document.createElement('style');
			style.id = ENTRY_STYLE_ID;
			style.textContent = ENTRY_CSS;
			(document.head || document.documentElement).appendChild(style);
		}

		/** 短暂反馈：换文案 + 上色，1.8 秒后自己变回来 */
		function flashRow(row, label, text, color) {
			label.textContent = text;
			row.title = text;
			try { row.style.color = color || ''; } catch (err) { /* 样式失败不该影响功能 */ }
			window.setTimeout(function () {
				label.textContent = ENTRY_LABEL;
				row.title = ENTRY_TITLE;
				try { row.style.color = ''; } catch (err) { /* 同上 */ }
				row.disabled = false;
			}, 1800);
		}

		/** 点一下：拉协议 → 写进输入框（拿不到就复制） */
		function startNewCourse(row, label) {
			if (row.disabled) return;
			row.disabled = true;
			label.textContent = '正在准备…';
			// 这几行日志是有意留的：这一行是**纯 DOM 注入**，出问题时没有 React 的报错可看，
			// 只能靠控制台里的 `[dsh-whale-sensei]` 说话（2026-09-21 现场就是靠它定位的）。
			console.log('[dsh-whale-sensei] 新课程：开始拉开课协议…');
			readEntry().then(function (entry) {
				console.log('[dsh-whale-sensei] 新课程：拿到协议（' + String(entry.prompt || '').length + ' 字），inputActions=' + (composerActions ? '有' : '无'));
				var ia = composerActions;
				if (ia && typeof ia.setDraft === 'function') {
					ia.setDraft(entry.prompt);
					flashRow(row, label, '已送进输入框 ✓', 'var(--dsw-alias-state-success-primary)');
				} else if (copyPrompt(entry.prompt)) {
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

		/** 应该插在谁后面：原生「新建会话」那一行（新版嵌在 logoRow 里，老版是直接子节点） */
		function placementBase(root) {
			var button = newSessionButton(root);
			if (!button) return null;
			var logoRow = typeof button.closest === 'function' ? button.closest('[class*="logoRow"]') : null;
			return (logoRow && logoRow.parentElement === root) ? logoRow : button;
		}

		/**
		 * 把行放到「新建会话」**正下方**（用户明确要求的位置）。
		 *
		 * ⚠️ 位置要**反复断言**，不能只在插入那一刻算一次：别的插件（技能中心）是**后**插入的，
		 * 它的锚点是"新会话的下一个兄弟节点" —— 那正好是我们的行，于是它会插到我们上面去
		 * （2026-09-21 现场：任何一次重渲染后的顺序都变成 新会话 → 技能中心 → 新课程）。
		 * 所以这里每次被调用都检查 `previousElementSibling` 是不是 base，不是就挪回去。
		 * 不会来回打架：对方只在"自己的行不见了"时才动手，我们挪位置不会让它消失。
		 * @returns {boolean} 放好了没有（宿主还没给按钮时为 false，等下一轮自愈）
		 */
		function placeEntryRow(root, row) {
			var base = placementBase(root);
			if (!base) return false;
			if (row.parentElement === root && row.previousElementSibling === base) return true;
			root.insertBefore(row, base.nextElementSibling);
			return true;
		}

		/**
		 * 挂载侧栏那一行，并自愈。
		 *
		 * ⚠️ 两个 observer 缺一不可（第一次就是缺了 body 那个而**静默什么都没发生**）：
		 *   · `apply()` 跑得**比侧栏渲染早** —— 那时 `sidebarShell()` 还是 null。
		 *     所以未插上时要挂一个 **body observer** 重试（技能中心靠的是同一招：
		 *     "subscribeBodyInvalidations"）。
		 *   · 插上之后，宿主 React 重渲染会把这行冲掉，靠 **root observer** 立刻插回。
		 * @returns {Function} disposer（去掉行、断开两个 observer）
		 */
		function mountSidebarEntry() {
			if (typeof document === 'undefined') return function () {};
			if (document.querySelector('[' + ENTRY_ATTR + ']')) return function () {};
			ensureEntryStyle();

			var made = createEntryRow();
			var row = made.row;
			var label = made.label;
			var root = null;
			var placed = false;
			var rootObserver = null;
			var bodyObserver = null;

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
					if (document.body && document.body.contains(row)) return;
					if (rootObserver) rootObserver.disconnect();
					rootObserver = null;
					root = null;
					placed = false;
				}
				if (!root) root = sidebarShell();
				if (!root) { watchBody(); return; }
				placed = placeEntryRow(root, row);
				if (!placed) { watchBody(); return; }
				stopBodyWatch();
				if (!rootObserver) {
					rootObserver = new MutationObserver(function () {
						if (!root || !root.isConnected) { placed = false; tryPlace(); return; }
						if (!root.contains(row)) {
							placed = placeEntryRow(root, row);
							if (!placed) tryPlace();
							return;
						}
						// 位置断言：别人（技能中心等）插到我上面时，立刻挪回「新会话」正下方
						placeEntryRow(root, row);
					});
				}
				rootObserver.observe(root, { childList: true, subtree: true });
			}

			tryPlace();
			return function () {
				try { if (rootObserver) rootObserver.disconnect(); } catch (err) { /* 已经断了 */ }
				try { if (bodyObserver) bodyObserver.disconnect(); } catch (err) { /* 已经断了 */ }
				try { row.remove(); } catch (err) { /* 已经没了 */ }
			};
		}

		function applySidebarEntry(ctx) {
			try {
				if (typeof document === 'undefined') return;
				var dispose = mountSidebarEntry();
				if (typeof ctx.effect === 'function') {
					ctx.effect(function () { return dispose; }, 'whale-sensei: 侧栏「新课程」入口');
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
			applySidebarEntry(ctx);
		}

		exports.apply = apply;
		// 客户端**服务名**清单（不是包名）。只用 slots —— 多写会因缺服务而整个半边不激活。
		exports.inject = ['slots'];

		return module.exports;
	},
});

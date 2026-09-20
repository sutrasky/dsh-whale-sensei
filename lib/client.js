/**
 * dsh-whale-sensei —— 浏览器半边（**lazy-CJS，零构建**）。
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

		/**
		 * 客户端入口。
		 * @param {object} ctx 可用面：ctx.effect / ctx.slots / ctx.settingsScope / ctx.locale / ctx.get(name)
		 */
		function apply(ctx) {
			applyStatusCard(ctx);
		}

		exports.apply = apply;
		// 客户端**服务名**清单（不是包名）。只用 slots —— 多写会因缺服务而整个半边不激活。
		exports.inject = ['slots'];

		return module.exports;
	},
});

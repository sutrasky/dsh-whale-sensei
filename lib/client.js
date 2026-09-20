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
 * 本文件默认**不注册任何 UI**：不需要浏览器半边的插件，删掉 lib/client.js、
 * `exports` 里的 `./client`、以及 `dsh.client` 三段即可（插件可以只活半边）。
 */

window.__ModuleLoader__.load({
	id: 'dsh-whale-sensei',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		//#region 基座引用（用不到就不要 require，少一个引用少一处版本漂移）
		// var react = require('react')
		// var primitives = require('@deepseek-ai/dsh-client-ui-primitives')
		//#endregion

		//#region 挂载示例：侧边栏/浮层（打开前先想清楚要不要——UI 是可选的）
		//
		// function mount(ctx) {
		// 	ctx.effect(() => {
		// 		try {
		// 			if (!document.body) return () => {}
		// 			const el = document.createElement('div')
		// 			el.id = 'whale-sensei-root'
		// 			document.body.appendChild(el)
		// 			return () => el.remove()
		// 		} catch (err) {
		// 			console.warn('[dsh-whale-sensei] 挂载失败：', err)   // 绝不许把宿主界面搞崩
		// 			return () => {}
		// 		}
		// 	}, 'dsh-whale-sensei: 挂载')
		// }
		//#endregion

		//#region 设置卡片示例（要 UI 可编辑的设置时用这一套）
		//
		// 官方标签页 slot `settings.plugins.tab` 已被 configurable/all/family-plugins 占满，
		// **复用别人的 id 会顶掉它** ⇒ 不要抢标签页，往 keyed slot `settings.plugin.item` 注册：
		// **键 = 宿主注册的 settings 命名空间**，靠键配对，撞键在结构上不可能。
		//
		// var NS = 'whale-sensei'
		//
		// function Card() { return react.createElement('li', { className: 'YyYd_a_card' }, 'dsh-whale-sensei') }
		//
		// function mountSettings(ctx) {
		// 	ctx.slots.inject('settings.plugin.item', () =>
		// 		ctx.slots.register(
		// 			{ name: 'settings.plugin.item', id: 'whale-sensei', key: NS, order: 30, inject: () => ({}) },
		// 			Card,
		// 		),
		// 	)
		// }
		//
		// 与宿主对齐的两件事：宿主用 `ctx.inject(['settings'], sctx => sctx.settings.register(NS, {...}))`
		// 注册同名命名空间；并把 `exports.__settingsNamespace = NS` 留在下面，让 kit 的 D4 自动比对。
		//#endregion

		/**
		 * 客户端入口。
		 * @param {object} ctx 可用面：ctx.effect / ctx.slots / ctx.settingsScope / ctx.locale / ctx.get(name)
		 */
		function apply(ctx) {
			// 打开上面的示例时在这里调用；不需要 UI 就保持空实现。
			// mount(ctx)
			// if (ctx.slots) mountSettings(ctx)
		}

		exports.apply = apply;
		// 客户端**服务名**清单（不是包名）。用到哪个写哪个；多写会因缺服务而整个半边不激活。
		exports.inject = [];

		return module.exports;
	},
});

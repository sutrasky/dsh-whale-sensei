# DSH 原生风格速查（插件 UI 用）

> **用途**：写 DSH 插件的界面时，照这份做出来的东西才像"宿主原生的"，而不是自己发明一套。
> **来源**：2026-09-23 从 DSH 实现仓里**逐字**抽出来的（不是照着眼睛估的）。
> **本机位置**（换机器要重新定位）：
> `C:\Users\bouyer\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`
>
> ⚠️ 这份文档**故意不进 `package.json` 的 `files`**：里面写着本机绝对路径。
> 哪天有人把它加进 `files`，`alien-env` 的静态守卫会当场判红（那是对的）。

---

## 0. 一句话总纲

**宿主是"令牌 + 组件库"两层**：

| 层 | 用什么 | 说明 |
|---|---|---|
| 颜色 / 边框 / 文字层级 | `--dsw-alias-*` / `--dsw-static-*` 令牌 | 由 `dsh-client-ui-theme` 全局注入到 `body`（深色是 `body[data-ds-dark-theme]` 覆盖）——**插件零额外 CSS 工作** |
| 交互原子（Button / Modal / Tag / Switch / Menu / Tooltip / Toast / …） | `require('@deepseek-ai/dsh-client-ui-primitives')` | 宿主已全局注入它的 CSS，插件**不要**再引样式表 |
| 页面骨架（面板 / 左导航 / 分区 / 行） | 没有组件，**自己排**，但照下面的配方 | 原生页自己也是"裸 button + CSS Modules" |

> 原生设置页**两者混用**：壳与绝大多数行用裸 `<button>` + CSS Modules；只有**头部动作**与**弹窗 footer** 用组件库 `Button`。所以"手搓 + 令牌"并不丢人，反而是原生做法。

---

## 1. 令牌表（亮色定义；深色由 `body[data-ds-dark-theme]` 覆盖）

| 令牌 | 值（亮色） | 用在哪 |
|---|---|---|
| `--dsw-alias-bg-base` / `bg-layer-1..3` | bluish-00 | 页面底 / 层级背景 |
| `--dsw-alias-bg-module-platform` | bluish-60 | **选择器胶囊的底**（那颗"工作区内修改"） |
| `--dsw-alias-border-l2` | `#0000001a` | **行分隔线**（`.5px`） |
| `--dsw-alias-border-l3` | `#0000001f` | 次按钮描边 / focus 环 |
| `--dsw-alias-border-l4` | `#00000029` | 更重的描边 |
| `--dsw-alias-label-primary` | bluish-1000 | 正文 / 行标题 / 分区标题 |
| `--dsw-alias-label-secondary` | bluish-700 | 次文字 |
| `--dsw-alias-label-tertiary` | bluish-600 | 说明文字 / 值 |
| `--dsw-alias-label-primary-foreground` | bluish-00 | 实心按钮上的字 |
| `--dsw-alias-interactive-bg-hover` | `#2631480f` | hover 底（幽灵/胶囊） |
| `--dsw-alias-interactive-bg-hover-solid` | bluish-75 | hover 底（描边按钮） |
| `--dsw-alias-interactive-bg-hover-danger` | `#ec13130d` | 危险按钮 hover |
| `--dsw-alias-interactive-bg-active` | `#2631481a` | 按下态 |
| `--dsw-alias-button-primary-fill` | = brand-primary（bluish-1000） | 主按钮底 |
| `--dsw-alias-button-primary-hover` | bluish-750 | 主按钮 hover |
| `--dsw-alias-state-error-primary` | red-600 | 错误 / 危险 |
| `--dsw-alias-state-success-primary` | green-500 | 成功 |
| `--dsw-alias-state-warn-label` | amber-600 | 警告文字 |

> ⚠️ **深色主题注意**：`button-primary-fill` 在深色下是**近黑实心**，贴在近黑的卡上**反而更不显眼**。
> 深色里要"看得见但不抢眼"的按钮，用**胶囊选择器**那颗（`bg-module-platform`），别用 primary。

---

## 2. 组件配方（逐字，可直接抄）

### 2.1 设置面板（整个设置页的壳）

```css
.panel { background: var(--dsw-alias-bg-layer-2); width: 800px; max-width: calc(100vw - 48px);
         height: min(800px, 100vh - 48px); box-shadow: var(--dsw-elevation-prominent);
         border-radius: 32px; display: flex }
.nav   { flex-direction: column; flex: none; gap: 18px; width: 188px; padding: 22px 12px 0; display: flex }
.navTitle { color: var(--dsw-alias-label-primary); padding: 0 12px;
            font-size: 16px; font-weight: 500; line-height: 24px }
.navCell { height: 40px; color: var(--dsw-alias-label-primary); text-align: left; background: 0 0;
           border: none; border-radius: 12px; align-items: center; gap: 8px;
           padding: 9px 16px 9px 12px; font-size: 14px; line-height: 22px; display: flex }
.navCell:hover  { background: var(--dsw-specific-sidebar-nav-item-hover) }
.navCell.active { background: var(--dsw-specific-sidebar-nav-item-active) }
.header  { justify-content: space-between; align-items: flex-start; gap: 8px; height: 54px;
           padding: 20px 14px 8px 10px; display: flex }
.options { flex: 1; min-height: 0; padding: 0 24px 24px; overflow-y: auto }
.close   { width: 28px; height: 28px; border-radius: 28px; background: 0 0; border: none }
.close:hover { background: var(--dsw-alias-interactive-bg-hover) }
```

### 2.2 分区（section）

```css
.section { max-width: 720px; flex-direction: column; gap: 12px; display: flex }
.title   { color: var(--dsw-alias-label-primary); margin: 0; font-size: 16px; font-weight: 500; line-height: 24px }
.intro   { color: var(--dsw-alias-label-tertiary); margin: 0; font-size: 14px; line-height: 22px }
```

### 2.3 一行设置项（label + 值/控件）——**这是最常用的那条**

```css
.row { border-bottom: .5px solid var(--dsw-alias-border-l2); align-items: center; gap: 8px;
       padding: 16px 0; display: flex }
.rowText { flex-direction: column; flex: 1; gap: 4px; min-width: 0; padding-right: 48px; display: flex }
.rowTitle { color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 400; line-height: 22px }
.rowDesc  { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px }
/* 分区里最后一行不要分隔线 */
.section > :last-child { border-bottom: none }
```

### 2.4 选择器胶囊（就是你截图里那颗「工作区内修改」）

```css
.selector { background: var(--dsw-alias-bg-module-platform); height: 36px; font: inherit;
            color: var(--dsw-alias-label-primary); cursor: pointer; border: none; border-radius: 18px;
            align-items: center; gap: 12px; padding: 0 14px; font-size: 14px; line-height: 22px;
            display: inline-flex }
.selector:hover { background: var(--dsw-alias-interactive-bg-hover) }
```

### 2.5 按钮四档（原生页自绘版；组件库 Button 同款观感）

```css
/* 共同 */
.btn { box-sizing: border-box; height: 36px; font: inherit; cursor: pointer; border: none;
       border-radius: 18px; justify-content: center; align-items: center; gap: 4px;
       padding: 0 14px; font-size: 14px; line-height: 22px; display: inline-flex }
.btn:disabled { opacity: .4; cursor: default }
.btn:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); outline: none }

.btn--primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground) }
.btn--primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover) }
.btn--secondary, .btn--add { border: .5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-primary); background: 0 0 }
.btn--secondary:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid) }
.btn--danger { color: var(--dsw-alias-state-error-primary); background: 0 0 }
.btn--danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger) }
.btn--ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover) }

/* 行内小号：28px / 圆角 14px / 12px */
.rowActions .btn { height: 28px; border-radius: 14px; padding: 0 10px; font-size: 12px; line-height: 18px }

/* 幽灵文字按钮（"恢复默认"那种） */
.reset { font: inherit; color: var(--dsw-alias-label-secondary); cursor: pointer; background: 0 0;
         border: none; padding: 0; font-size: 12px; line-height: 1.5 }
.reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary) }
```

### 2.6 组件库 Button / Modal（逐字 API）

```js
const { Button } = require('@deepseek-ai/dsh-client-ui-primitives')
// variant: 'primary' | 'ghost' | 'outline' | 'toolbar'（默认 ghost）
// size:    'md'（36px 胶囊） | 'sm'（28px 紧凑）
// 没有显式 disabled prop —— 走原生 button 属性透传
Button({ variant: 'outline', size: 'sm', disabled: busy, onClick: fn }, '文案')

// Modal：closeLabel 在非 headless 时**必填**（文案由调用点自己给，组件不读宿主 locale）
Modal({ open, onClose, title, description, closeLabel: '关闭', footer }, children)
```

---

## 3. 设置页的挂载契约（插件该挂哪儿）

| slot | 用途 | owner props |
|---|---|---|
| `settings.section` | **整页一节**（本插件用的就是这个，`id: 'whale-sensei'`, `label: '鲸师'`） | `{ close() }` |
| `settings.general.item` | 往"通用设置"里加**一行**（自己画 label/值/写入路径） | 有意为空 |
| `settings.plugin.item` | 第三方插件设置卡（按 settings namespace 派发） | 有意为空 |

```js
ctx.slots.inject('settings.section', () => ctx.slots.register(
  { name: 'settings.section', id: 'whale-sensei', order: 30, label: '鲸师' }, Panel))
```

---

## 4. 本插件已经落地的配方（`lib/client.js`，可直接复用）

| 东西 | 在哪 | 规格 |
|---|---|---|
| `btn(kind, size)` | `lib/client.js` 工厂作用域 | 四档 kind（primary/ghost/outline/danger）× 两档 size（md 36/18/14、sm 28/14/12），照 §2.5 |
| `btnOff(style)` | 同上 | 禁用态 = 原生 `opacity:.4; cursor:default` |
| `actionBtn(label, onClick, disabled)` | `lib/client.js` | **胶囊选择器**那档（§2.4）：`bg-module-platform` / 36px / 18px / 0 14px —— 深色主题下比 primary 显眼 |
| `Row` / `Section` | 同上 | 照 §2.3 / §2.2 |
| 卡片头部 | `StatusPanel` | 只放"这是什么 + 什么时候读的"；**动作按钮挂在它所属的分区里**，不飘在卡头 |

### 三条踩过的坑

1. **inline style 写不了 `:hover`**（插件不许引外部 CSS）→ 要 hover 就得用 `primitives.Button`，或注入一小段 `<style>`。本插件当前：主操作手搓胶囊（无 hover），弹窗 footer 用组件库 Button（有 hover）。
2. **深色主题下 `button-primary-fill` 近黑**，贴深色卡反而看不见 → 用胶囊选择器。
3. **改客户端只要刷新页面；改宿主那半边必须重启宿主**。没重启时宿主对没注册的 `/api/whale/*` 回纯文本 `not found`，前端 `JSON.parse` 会炸成 `Unexpected token 'o', "not found" is not valid JSON`（2026-09-23 现场踩过；插件现在会说人话，并有一行「模块表」提示宿主过期）。

---

## 5. 下次要核对什么

DSH 升级后，这份文档的**令牌名**与**组件库导出**可能变。核对三步：

1. 打开 `node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js`，搜 `design_platform_css_default`，比对令牌表；
2. 打开 `@deepseek-ai/dsh-client-ui-primitives` 的 `lib/types/index.d.ts`，比对导出清单与 `ButtonVariant`；
3. 打开 `@deepseek-ai/dsh-client-ui-settings-general/lib/client.js`，比对面板/导航/行的 CSS Modules 串。

> 这三处就是本文件 §1/§2/§3 的**唯一真源**。

---
name: whale-qa
description: 答疑闭环：学生提问的提交 / 拉取 / 写回 / 归档四个口，回答必须长在课程页的 qa-box 上而不是只在聊天里说，以及提问台账的留痕规矩。
disable-model-invocation: true
user-invocable: false
---

# whale-qa · 答疑

结论先行：**答案的家是页面上的框**。只在聊天里答过的问题，学生下次复习时会再撞同一堵墙 —— 那就等于没答。每页课都带一个 Ask Box（角落的小控件），学生把没懂的东西写进去；本技能把它变成课程的一部分。

## 闭环四口
1. **提交**（页面侧两条路 + 一条兜底）：插件宿主路由 `/api/whale/ask`（POST 提交 / GET 拉取），或包内收集服务 `node tools/ask-server.js`（页面 POST `http://127.0.0.1:8788/ask`，追加一行 JSON 进 `questions/pending.jsonl`）。服务没跑时页面退化为把格式化提示词复制到剪贴板、学生贴进对话 —— **闭环永远不许依赖服务在跑**。
2. **拉取**：每轮开始读 `questions/pending.jsonl`（append-only，序号在 `questions/seq.txt`），并保持 `whale_ask action=watch` 挂着。那是宿主原生后台 job：新提问高于高水位时它退出、宿主叫醒你，不需要子进程、不需要每答一条重挂一次。
3. **写回**：找到困惑**真正产生**的那一节，把答案嫁接进 `lessons/src/NNNN-*.html` 再重建。生成页不许改 —— 下次构建覆盖，答案就没了。插入这段：
   ```html
   <div class="qa-box" id="q0003">
     <div class="qa-box__q">
       <span class="qa-box__tag">❓ 你的疑问 #0003</span>
       学生的原话，不要改写
     </div>
     <div class="qa-box__a">
       <span class="qa-box__tag">💡 解答</span>
       解答正文
     </div>
   </div>
   ```
   然后在 `assets/questions-data.js` 登记：`id` `date` `lesson` `question` `answer` `page` `anchor` `section` `terms` `status: 'answered'`。工具口是 `whale_ask action=answer`（`id` 四位编号 + `answer` 纯文本 + `answerHtml` 必填）：只追加不覆盖已答台账，写完 require 自检、失败逐字节回滚。
4. **归档**：`node tools/drain-questions.js` 把这条从 `questions/pending.jsonl` 挪进 `questions/processed.jsonl`（`whale_ask action=answer` 会顺手跑归档，并跑 `tools/build-notes.js` 重建 `reference/NOTES.html`、`tools/build-lessons.js` 重建课程页）。**只有已登记进台账的才会被归档** —— 清队列永远丢不了问题，`GET /health` 也因此报的是真实积压。
5. **回给他确切位置**：课次、章节、框 id、可点的链接。

包侧重建链（手写路径时自己跑全）：`node assets/build-questions.js`（重建 `QUESTIONS.md`，带目录表）→ `node tools/build-lessons.js && node assets/check-terms.js`（重建页面，然后验证页面与锚点真存在）→ `node tools/drain-questions.js`。

## 规则（每条带判据）
- **台账只收学生真提过的问题**：示例问题一个都不许造进去 —— 台账里有他没问过的问题，他就分不清哪些是自己的，一份「困惑记录」被写成小说。
- **空台账就空着**：`QUESTIONS.md` 显示「还没有疑问」+ 怎么提交。空 = 就绪，不是坏了。
- 页面 `id` 与台账 `anchor` **逐字符一致**（`q0003`，不带横线）—— 这条审计存在是因为它漂过一次。
- `qa-box__q` 保留**学生原话**：改写会毁掉「到底哪里困惑」的证据。
- 问的是工作区不是学科（「页面看着旧」）也记账：`page: null`，只在 `QUESTIONS.md` 答 —— 不是每条问题都配一个页面框。
- 同一个困惑第二次出现 = 该改这一课，不是再加一个框。
- 框是青紫（`--qa-*` 令牌），刻意与蓝 / 绿 / 橙提示框区分，好让学生在长页上一眼找到自己的问题。
- 答疑也是学情证据：写记录时按 `whale-record` 的规矩留痕。

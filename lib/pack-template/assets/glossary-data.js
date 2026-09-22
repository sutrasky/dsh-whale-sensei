/**
 * glossary-data.js — 名词解释的【唯一数据源】（骨架 / 新工作区从这里开始）
 * ------------------------------------------------------------------
 * 浏览器：<script src="../assets/glossary-data.js"></script> 之后用 window.GLOSSARY
 * Node  ：require('./glossary-data.js') —— 由 build-glossary.js 生成 GLOSSARY.md
 *
 * 这门课的所有专业名词都登记在这里，一个都不许漏。
 * 新增名词只改这一个文件，然后运行：
 *     node assets/build-glossary.js     # 重新生成带目录的 GLOSSARY.md
 *     node assets/check-terms.js        # 自检键名 / 代码块误标 / 死链 / 完整性 / 注解规范写法
 *
 * 字段说明（悬停小窗按此顺序显示）：
 *   label    页面上显示的名字
 *   category 归类（GLOSSARY.md 按此分组 + 生成目录）
 *   official ① 官方定义 —— 一句话，正式术语 + 英文全称（如适用），准确优先
 *   short    ② 大白话 —— 一句话，让人一眼看懂；这一行里不许再出现别的术语
 *   analogy  ③ 生活类比 —— 来自日常生活的画面，用来记住它
 *   code     ④ 规范写法 —— 可直接照抄的最小代码示例，多行写成模板字符串（反引号）。
 *            【凡 label 以 @ 开头的注解都必须写这一段】，check-terms.js 会强制检查：
 *            注解类名词缺 code 直接报错。定义和类比都不告诉学生「这行怎么写」，
 *            而卡住的学生最需要的就是能照抄的代码。
 *   lesson   首次出现在第几课
 *
 * ⚠️ code 里只写代码和 // 注释，不要写 HTML（小窗用 textContent 渲染，会原样显示尖括号）；
 *    每行控制在 64 列以内（中文按 2 列计），超了小窗会出现横向滚动条。
 *
 * 标注方式：把 data-term 直接写在 <code> 上——glossary.css 里有 code.term 规则，
 *    保证等宽字体不被名词的衬线体覆盖：
 *        <code data-term="pathvariable">@PathVariable</code>
 *    同一个名词在每一页各自算「第一次出现」，所以它可以在第1课的挑战提示里给悬窗，
 *    同时在第2课的正文里也给悬窗，互不影响。
 *
 * 写法示例（照这个标准写，写完把示例删掉，本文件必须保持 0 个词条）：
 *
 *   get: {
 *     label: 'GET',
 *     category: 'HTTP 方法',
 *     official: 'HTTP GET 方法，语义为安全且幂等地获取目标资源的当前表示，不应产生副作用。',
 *     short: '我要看，不要改。浏览器地址栏输入网址回车，发出去的就是 GET，它只读取数据。',
 *     analogy: '像隔着玻璃看展品：看多少遍，展品都不会变。',
 *     lesson: '第2课'
 *   },
 *
 *   pathvariable: {
 *     label: '@PathVariable',
 *     category: 'Spring 注解',
 *     official: '@PathVariable，Spring MVC 注解，用于将 URI 模板变量绑定到方法参数。',
 *     short: '从 URL 路径里挖出一段文字，当作方法参数。',
 *     analogy: '像从「3 号楼 502 室」这个地址里，单独取出「502」。',
 *     code: `// {name} 是占位符；参数名与它同名即可拿到值
 * @GetMapping("/hello/{name}")
 * public String hello(@PathVariable String name) {
 *     return "Hello, " + name + "!";
 * }`,
 *     lesson: '第2课'
 *   }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GLOSSARY = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  return {
    // 在这里按分类顺序添加名词……
  };
});

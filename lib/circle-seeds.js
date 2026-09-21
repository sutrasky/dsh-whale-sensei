/**
 * lib/circle-seeds.js — 常见大方向种子表 + 圆圈建议
 * ------------------------------------------------------------------
 * 只读、纯函数。给 `/api/whale/catalog` 的 `suggest` 字段用。
 *
 * 设计：
 *   · keywords 里可含中英文小写形式（用户会用「Vue 3」或「vue3」都行）；
 *   · 已存在的圆圈用它自己的 name 覆盖 seed 的 name（用户可能改过名）；
 *   · 一个都没命中 → 返回空 id，**不猜、不拼音** —— 做不到就明说。
 */

/** @type {Array<{id: string, name: string, keywords: string[]}>} */
export const SEEDS = [
  {
    id: 'programming',
    name: '编程',
    keywords: [
      '编程', '程序', '代码', '开发', '框架', 'api', '后端', '前端',
      'java', 'spring', 'vue', 'js', 'python', '数据库', 'sql', '算法',
      '测试', '部署', 'node', 'typescript', 'rust', 'go', 'c++',
      'html', 'css', 'react', 'angular', 'docker', 'kubernetes', 'linux',
      'git', '微服务', '设计模式', '数据结构', '中间件', '消息队列',
    ],
  },
  {
    id: 'math',
    name: '数学',
    keywords: [
      '数学', '微积分', '线代', '线性代数', '概率', '统计', '离散',
      '微分', '积分', '矩阵', '方程', '拓扑', '数论', '组合', '图论',
    ],
  },
  {
    id: 'physics',
    name: '物理',
    keywords: [
      '物理', '力学', '电磁', '光学', '量子', '热力学', '相对论',
      '粒子', '场论', '天体', '流体',
    ],
  },
  {
    id: 'language',
    name: '语言',
    keywords: [
      '英语', '日语', '语言', '单词', '语法', '口语', '听力', '阅读',
      '写作', '翻译', '雅思', '托福', 'gre',
    ],
  },
  {
    id: 'design',
    name: '设计',
    keywords: [
      '设计', 'ui', 'ux', '视觉', '配色', '排版', '交互', '平面',
      '品牌', '图标', '插画', 'figma', 'sketch', 'ps', 'photoshop',
    ],
  },
]

/**
 * 根据话题关键词推荐一个圆圈。
 *
 * @param {string} topic  用户输入的话题（如「Vue 3 组合式 API」）
 * @param {Array<{id: string, name: string}>} existingCircles 课程包里已有的圆圈
 * @returns {{ id: string, name: string, reason: string, isNew: boolean }}
 */
export function suggestCircle(topic, existingCircles = []) {
  const lower = String(topic).toLowerCase()
  const existingMap = new Map(existingCircles.map((c) => [c.id, c]))

  let bestId = ''
  let bestCount = 0

  for (const seed of SEEDS) {
    let count = 0
    for (const kw of seed.keywords) {
      if (lower.includes(kw)) count++
    }
    if (count > bestCount) {
      bestCount = count
      bestId = seed.id
    }
  }

  // 一个都没命中
  if (bestCount === 0) {
    return { id: '', name: '', reason: '没认出属于哪个大方向，请自己填目录 id', isNew: true }
  }

  const seed = SEEDS.find((s) => s.id === bestId)
  const existing = existingMap.get(bestId)

  if (existing) {
    // 已存在：用课程包里的 name（用户可能改过）
    return { id: bestId, name: existing.name, reason: '关键词命中', isNew: false }
  }

  // 不存在
  return { id: bestId, name: seed.name, reason: '关键词命中（该圆圈还没建）', isNew: true }
}

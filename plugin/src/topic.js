// 任务分类（规则版）：给「分工统计」用的 topic 标签。
// 以后可以换成 judge 模型判断，这里先保证稳定、可解释、零成本。
const RULES = [
  {
    topic: 'code',
    re: /(代码|函数|脚本|编译|报错|异常|测试|重构|接口|bug|typescript|javascript|python|node|npm|git)/i,
  },
  {
    topic: 'doc',
    re: /(文档|报告|总结|方案|word|excel|ppt|pdf|表格|排版|写一[份个篇])/i,
  },
  {
    topic: 'research',
    re: /(查一下|搜索|搜一下|调研|资料|研究|看看这个|读一下|解释一下|是什么)/i,
  },
  {
    topic: 'file',
    re: /(文件|目录|文件夹|复制|移动|改名|重命名|整理|压缩|解压|删除|清理|备份|路径)/i,
  },
  {
    topic: 'chat',
    re: /^(你好|在吗|谢谢|哈哈|在不在|早|晚安)/,
  },
]

export const TOPICS = ['file', 'research', 'code', 'doc', 'chat', 'other']

export function classifyTopic(text) {
  const s = String(text || '').trim()
  if (!s) return 'other'
  for (const rule of RULES) {
    if (rule.re.test(s)) return rule.topic
  }
  return 'other'
}
